// Compress PDF (engine/compress.js): images shrunk to the level's resolution for the space they
// fill (followed through transforms, form XObjects and reuse), stored again as JPEG (grey ones in
// one component, soft masks kept), text and drawings untouched, never bigger, the original kept
// when nothing can be saved (but never for a PDF that had a password). Checked by reading the
// results back with pdf-lib (image sizes, filters, colour spaces, masks), pdf.js (text) and by
// rendering before and after with pdf.js and comparing pixels.
//
//   node tests/compress.test.mjs
import { withPage, assert, saveOutput, fixture } from './harness.mjs';
import {
  PDFDocument, PDFName, PDFDict, PDFRef, PDFStream, PDFRawStream, PDFHexString, StandardFonts,
  decodePDFRawStream,
} from '../site/app/js/lib/pdf-lib.js';
import { zlibSync } from '../site/app/js/lib/fflate.js';
import {
  savedPercent, targetSize, maxDimensionFor, defaultCompressName, LEVELS, compressNotes, compressDetail,
} from '../site/app/js/engine/compress.js';
import { UserError, CancelledError } from '../site/app/js/core/errors.js';
import {
  lzwDecode, runLengthDecode, asciiHexDecode, ascii85Decode, predictorSink, unfilterPng, decodeAll, filtersOf,
} from '../site/app/js/engine/compress/filters.js';
import { scanContent, OP_SAVE, OP_RESTORE, OP_TRANSFORM, OP_DRAW } from '../site/app/js/engine/compress/content.js';
import { colourSpaceOf, examine } from '../site/app/js/engine/compress/image.js';
import { transformsAgree, jpegForDecoding } from '../site/app/js/engine/compress/jpeg-source.js';
import { encodeGrayJpeg, filterRow } from '../site/app/js/engine/images/encode.js';
import { parseJpeg, withExifOrientation } from '../site/app/js/engine/images/jpeg.js';
import { runSync } from '../site/app/js/engine/images/canvas.js';

const A4 = [595.2756, 841.8898];
const near = (a, b, tolerance, msg) => assert(Math.abs(a - b) <= tolerance, `${msg}: ${a} vs ${b}`);
const same = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const N = (k) => PDFName.of(k);

// --- The app's CompressionTest (savedPercent) and the sizes images are kept at -----------------
{
  assert(savedPercent(1000, 1000) === null, 'no saving');
  assert(savedPercent(1000, 995) === null, 'under 1% does not count');
  assert(savedPercent(1000, 990) === 1, '1%');
  assert(savedPercent(1000, 500) === 50, '50%');
  assert(savedPercent(0, 0) === null, 'empty');
  assert(savedPercent(1000, 1200) === null, 'bigger');

  // The levels: the app's PdfCompression (200, 150, 100 dpi; JPEG quality 85, 68, 48).
  same(Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, [v.dpi, v.quality]])), { less: [200, 85], recommended: [150, 68], extreme: [100, 48] }, 'levels');

  // The app's cap: an A4 PDF at Recommended keeps at most A4's long side at 150 dpi (1753.9,
  // so 1753 pixels), at Extreme 1169; a Letter page at Less 2200; never more than 4000.
  assert(maxDimensionFor(A4[1], 150) === 1753, 'A4 at 150 dpi');
  assert(maxDimensionFor(792, 200) === 2200, 'Letter at 200 dpi');
  assert(maxDimensionFor(A4[1], 100) === 1169, 'A4 at 100 dpi');
  assert(maxDimensionFor(14400, 200) === 4000, 'at most 4000 pixels');
  assert(maxDimensionFor(0, 150) === 1, 'at least one pixel');

  // compressShrinksBigJpegs: photos filling an A4 page come out at most 1754 pixels long, their
  // shape kept. Drawn over the whole page the space they fill asks for no more than that.
  for (const [w, h] of [[5200, 4000], [3000, 2000]]) {
    const extent = Math.max(A4[0] / w, A4[1] / h);
    const [tw, th] = targetSize(w, h, extent, 150, 1754);
    assert(Math.max(tw, th) <= 1754, `${w}x${h} became ${tw}x${th}`);
    near(tw / th, w / h, 0.01, `${w}x${h} keeps its shape`);
  }
  // Drawn 4 x 2.67 inches: 600 x 400 at 150 dpi, 800 x 533 at 200, 400 x 266 at 100.
  same(targetSize(3000, 2000, 288 / 3000, 150, 1754), [600, 400], 'drawn small, Recommended');
  same(targetSize(3000, 2000, 288 / 3000, 200, 2339), [800, 533], 'drawn small, Less');
  same(targetSize(3000, 2000, 288 / 3000, 100, 1169), [400, 266], 'drawn small, Extreme');
  // Never enlarged; unknown placements (extent 0) only get the app's cap.
  same(targetSize(500, 400, 10, 150, 1754), [500, 400], 'never enlarged');
  same(targetSize(4000, 3000, 0, 150, 1754), [1754, 1315], 'unknown placement: the app\'s cap');
  same(targetSize(3, 3, 0.0001, 150, 1754), [1, 1], 'at least a pixel');

  assert(defaultCompressName({ name: 'Report.pdf' }) === 'Report_compressed', 'default name');
  assert(defaultCompressName({ name: '' }) === 'Usugami_compressed', 'default name without one');
  console.log('ok sizes and levels');
}

// --- What the result screen and the messages say (the app's ResultScreen and runCompress) -------
{
  const file = (originalSize, size, keptOriginal = false) => ({ originalSize, bytes: new Uint8Array(size), keptOriginal });
  same(compressDetail(file(1000, 380)), { key: 'compressed_from', originalSize: 1000, percent: 62 }, '62% smaller');
  same(compressDetail(file(1000, 1000, true)), { key: 'original_kept' }, 'original kept');
  same(compressDetail(file(1000, 996)), null, 'a password PDF no smaller: nothing under it');
  // One PDF.
  same(compressNotes([{ name: 'a.pdf', result: file(1000, 500) }]), [], 'smaller: nothing to say');
  same(compressNotes([{ name: 'a.pdf', result: file(1000, 1000, true) }]), [{ key: 'pdf_no_reduction', args: [] }], 'kept');
  same(compressNotes([{ name: 'a.pdf', result: file(1000, 1003) }]), [{ key: 'pdf_not_smaller', args: [] }], 'had a password, no smaller');
  same(compressNotes([{ name: 'a.pdf', error: new UserError('pdf_import_failed') }]), [{ key: 'pdf_import_failed', args: [] }], 'its error');
  same(compressNotes([{ name: 'a.pdf', error: new TypeError('x') }]), [{ key: 'pdf_process_failed', args: [] }], 'anything else');
  same(compressNotes([{ name: 'a.pdf', error: new CancelledError() }]), [], 'cancelled');
  // Several: those that failed, then those with a password that came out no smaller; kept ones say so under their names.
  same(compressNotes([
    { name: 'scan.pdf', result: file(1000, 300) },
    { name: 'compact.pdf', result: file(1000, 1000, true) },
    { name: 'broken.pdf', error: new UserError('pdf_import_failed') },
    { name: 'locked.pdf', result: file(1000, 1000) },
    { name: 'locked 2.pdf', result: file(1000, 1001) },
  ]), [
    { key: 'batch_failed', count: 1, args: [1, 'broken.pdf'] },
    { key: 'batch_not_smaller', count: 2, args: [2, 'locked.pdf, locked 2.pdf'] },
  ], 'several');
  console.log('ok notes');
}

// --- Filters -----------------------------------------------------------------------------------

/** LZW as PDF writes it (9 to 12 bits, a clear code now and then, early change), for the tests. */
function lzwEncode(data, early = true) {
  const e = early ? 1 : 0;
  const bytes = [];
  let acc = 0;
  let count = 0;
  const put = (code, bits) => {
    acc = (acc << bits) | code;
    count += bits;
    while (count >= 8) {
      bytes.push((acc >>> (count - 8)) & 0xff);
      count -= 8;
    }
    acc &= (1 << count) - 1;
  };
  let table = new Map();
  let next = 258;
  let bits = 9;
  const widthFor = (n) => {
    let b = 9;
    while (b < 12 && n + e > (1 << b)) b++;
    return b;
  };
  put(256, 9);
  let w = -1;
  for (const b of data) {
    if (w < 0) {
      w = b;
      continue;
    }
    const key = w * 256 + b;
    if (table.has(key)) {
      w = table.get(key);
      continue;
    }
    bits = widthFor(next);
    put(w, bits);
    table.set(key, next++);
    w = b;
    if (next >= 4000) {
      bits = widthFor(next);
      put(w, bits);
      put(256, widthFor(next + 1));
      table = new Map();
      next = 258;
      w = -1;
    }
  }
  if (w >= 0) {
    put(w, widthFor(next));
    next++;
  }
  put(257, widthFor(next));
  if (count) put(0, 8 - count);
  return Uint8Array.from(bytes);
}

{
  // PDF 32000-1's own LZW example.
  same(Buffer.from(lzwDecode(Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01])).bytes).toString('latin1'), '-----A---B', 'LZW example');
  // Round trips, long enough for 12-bit codes and table clears; checked against pdf-lib's decoder too.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16;
  for (const size of [1, 2, 300, 5000, 70000]) {
    const data = Uint8Array.from({ length: size }, (_, i) => (i % 97 < 60 ? i % 7 : random() & 0x3f));
    const encoded = lzwEncode(data);
    const r = lzwDecode(encoded);
    assert(r.complete && r.bytes.length === size && r.bytes.every((v, i) => v === data[i]), `LZW round trip of ${size}`);
    const doc = await PDFDocument.create();
    const theirs = decodePDFRawStream(PDFRawStream.of(doc.context.obj({ Filter: 'LZWDecode' }), encoded)).decode();
    assert(theirs.length === size && theirs.every((v, i) => v === data[i]), `pdf-lib reads our LZW of ${size} the same`);
  }
  const cut = lzwDecode(lzwEncode(Uint8Array.from({ length: 4000 }, (_, i) => i & 0xff)).subarray(0, 1000));
  assert(!cut.complete && cut.bytes.length > 0, 'cut LZW gives what it can');

  same(Array.from(runLengthDecode(Uint8Array.from([2, 1, 2, 3, 254, 9, 128, 5])).bytes), [1, 2, 3, 9, 9, 9], 'RunLength');
  same(Buffer.from(asciiHexDecode(Buffer.from('48 65 6c\n6C 6F7>ignored'))).toString('latin1'), 'Hellop', 'ASCIIHex, odd digit');
  same(Buffer.from(ascii85Decode(Buffer.from('87cURD]i,"Ebo80~>')).bytes).toString('latin1'), 'Hello World!', 'ASCII85');
  same(Array.from(ascii85Decode(Buffer.from('<~z!!~>')).bytes), [0, 0, 0, 0, 0], 'ASCII85 z and a short group');

  // PNG predictors, every row filter, through a sink fed a byte at a time.
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const width = 37;
  const height = 9;
  const raw = Uint8Array.from({ length: width * 3 * height }, (_, i) => (i * 13 + (i >> 5) * 7) & 0xff);
  const rows = [];
  let prior = new Uint8Array(width * 3);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(width * 3));
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * width * 3, (y + 1) * width * 3);
    filterRow(row, prior, 3, candidates);
    const type = y % 5; // each filter in turn, not only the best
    rows.push(type, ...candidates[type]);
    prior = row;
  }
  const params = ctx.obj({ Predictor: 12, Colors: 3, BitsPerComponent: 8, Columns: width });
  const got = [];
  const sink = predictorSink(ctx, params, { push: (r) => { got.push(...r); return false; } });
  for (const b of rows) sink.push(Uint8Array.of(b));
  assert(sink.finish(), 'whole rows');
  assert(got.length === raw.length && got.every((v, i) => v === raw[i]), 'PNG predictors undone');
  let threw = false;
  try {
    unfilterPng(9, new Uint8Array(3), new Uint8Array(3), new Uint8Array(3), 1);
  } catch {
    threw = true;
  }
  assert(threw, 'an unknown PNG filter is an error');

  // TIFF predictor 2, 8 and 4 bits, through Flate.
  const tiff8 = Uint8Array.from([10, 20, 30, 1, 1, 1, 2, 2, 2]); // differences
  const flat8 = await decodeAll(ctx, zlibSync(tiff8), filtersOf(ctx, ctx.obj({ Filter: 'FlateDecode', DecodeParms: { Predictor: 2, Colors: 3, Columns: 3 } })));
  same(Array.from(flat8.bytes), [10, 20, 30, 11, 21, 31, 13, 23, 33], 'TIFF predictor, 8 bits');
  const tiff4 = Uint8Array.from([0x31, 0x11]); // 3, +1, +1, +1 in 4-bit samples
  const flat4 = await decodeAll(ctx, zlibSync(tiff4), filtersOf(ctx, ctx.obj({ Filter: 'Fl', DecodeParms: { Predictor: 2, Colors: 1, BitsPerComponent: 4, Columns: 4 } })));
  same(Array.from(flat4.bytes), [0x34, 0x56], 'TIFF predictor, 4 bits (and the short filter name)');

  // A chain: ASCIIHex around Flate; damaged Flate gives what it could.
  const hello = new TextEncoder().encode('q 1 0 0 1 0 0 cm Q '.repeat(200));
  const hex = new TextEncoder().encode(Buffer.from(zlibSync(hello)).toString('hex') + '>');
  const chain = await decodeAll(ctx, hex, filtersOf(ctx, ctx.obj({ Filter: ['ASCIIHexDecode', 'FlateDecode'] })));
  assert(chain.complete && Buffer.from(chain.bytes).equals(Buffer.from(hello)), 'ASCIIHex then Flate');
  const z = zlibSync(Uint8Array.from({ length: 200000 }, (_, i) => (i * 7) & 0xff));
  const damaged = await decodeAll(ctx, z.subarray(0, z.length >> 1), filtersOf(ctx, ctx.obj({ Filter: 'FlateDecode' })));
  assert(!damaged.complete && damaged.bytes.length > 0 && damaged.bytes.length < 200000, 'cut Flate: what could be read');
  let tooBig = false;
  try {
    await decodeAll(ctx, zlibSync(new Uint8Array(1 << 22)), filtersOf(ctx, ctx.obj({ Filter: ['FlateDecode', 'ASCIIHexDecode'] })), { maxBytes: 1 << 20 });
  } catch (e) {
    tooBig = e.name === 'StreamError';
  }
  assert(tooBig, 'a stream inflating past the limit is refused');
  console.log('ok filters');
}

// --- Content streams: only q, Q, cm and Do count, whatever surrounds them -----------------------
{
  const scan = (text) => runSync(scanContent(typeof text === 'string' ? Buffer.from(text, 'latin1') : text));
  same(scan('q 2 0 0 3 10 20 cm /Im1 Do Q'), [OP_SAVE, OP_TRANSFORM, 2, 0, 0, 3, 10, 20, OP_DRAW, 'Im1', OP_RESTORE], 'plain');
  same(scan('q 1 0 0 1 0 0 cm (q Q 1 2 3 4 5 6 cm /X Do \\) ) Tj % /Y Do\nQ'), [OP_SAVE, OP_TRANSFORM, 1, 0, 0, 1, 0, 0, OP_RESTORE], 'strings and comments hide operators');
  same(scan('[1 2 3 4 5 6] 0 d <</A 1>> BDC /Im#20A Do'), [OP_DRAW, 'Im A'], 'arrays, dictionaries, # in names');
  same(scan('.5 -0 0 -.5 +1 2. cm'), [OP_TRANSFORM, 0.5, -0, 0, -0.5, 1, 2], 'numbers as viewers read them');
  same(scan('1 0 0 cm /A Do'), [OP_DRAW, 'A'], 'a cm short of numbers is ignored');
  // Inline image data holding "EI", "Do" and binary bytes.
  const inline = Buffer.concat([
    Buffer.from('q BI /W 4 /H 4 /BPC 8 /CS /G ID '),
    Buffer.from([0x45, 0x49, 0x00, 0xff, 0x20, 0x45, 0x49, 0x01, 0x2f, 0x58, 0x20, 0x44, 0x6f, 0x20, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from('\nEI Q /Im2 Do'),
  ]);
  same(scan(inline), [OP_SAVE, OP_RESTORE, OP_DRAW, 'Im2'], 'inline image data skipped');
  const withLength = Buffer.concat([Buffer.from('BI /W 2 /H 1 /L 2 ID '), Buffer.from('EI'), Buffer.from(' EI /A Do')]);
  same(scan(withLength), [OP_DRAW, 'A'], 'inline image skipped by its length');
  same(scan(new Uint8Array(0)), [], 'empty');
  same(scan('(unterminated /X Do'), [], 'an unterminated string runs to the end');
  console.log('ok content');
}

// --- Colour spaces and what is kept as it is -----------------------------------------------------
{
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const icc = (n) => ctx.register(ctx.flateStream(new Uint8Array(200), { N: n }));
  const cs = (v) => {
    const r = colourSpaceOf(ctx, ctx.obj(v));
    return r && [r.components, r.deviceRgb, !!r.palette];
  };
  same(cs('DeviceGray'), [1, false, false], 'DeviceGray');
  same(cs('DeviceRGB'), [3, true, false], 'DeviceRGB');
  same(cs('DeviceCMYK'), [4, false, false], 'DeviceCMYK');
  same(cs(['ICCBased', icc(3)]), [3, false, false], 'ICCBased 3');
  same(cs(['ICCBased', icc(1)]), [1, false, false], 'ICCBased 1');
  same(cs(['Indexed', 'DeviceRGB', 1, PDFHexString.of('ff000000ff00')]), [1, false, true], 'Indexed');
  same(cs(['Indexed', 'DeviceRGB', 1]), null, 'Indexed needs a table');
  same(cs(['Indexed', 'DeviceRGB', 300, PDFHexString.of('00')]), null, 'Indexed with too many colours');
  same(cs(['Indexed', ['Indexed', 'DeviceRGB', 1, PDFHexString.of('00')], 1, PDFHexString.of('00')]), null, 'Indexed of Indexed');
  same(cs(['Separation', 'Spot', 'DeviceGray', { FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 }]), [1, false, false], 'Separation');
  same(cs(['DeviceN', ['C', 'M'], 'DeviceCMYK', {}]), [2, false, false], 'DeviceN');
  same(cs(['Lab', { WhitePoint: [0.95, 1, 1.09] }]), [3, false, false], 'Lab');
  same(cs('Pattern'), null, 'Pattern');
  same(cs('CS0'), null, 'a resource name');
  console.log('ok colour spaces');
}

// --- JPEGs as viewers read them, and what is left as it is ---------------------------------------
{
  // EXIF (with its orientation), an ICC profile and a comment are taken out before decoding;
  // JFIF, the Adobe marker, the tables and the scan stay.
  const plain = encodeGrayJpeg({ width: 16, height: 8, pixels: new Uint8Array(128).fill(90) }, 90);
  const turned = withExifOrientation(plain, 6);
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), Buffer.from(body)]);
  const adobe = segment(0xee, [...Buffer.from('Adobe'), 0, 100, 0, 0, 0, 0, 1]);
  const extra = Buffer.concat([segment(0xe2, [...Buffer.from('ICC_PROFILE\0'), 1, 1, 9, 9, 9]), segment(0xfe, [...Buffer.from('a comment')]), adobe]);
  const busy = new Uint8Array(Buffer.concat([turned.subarray(0, 2), extra, turned.subarray(2)]));
  const clean = jpegForDecoding(busy);
  const text = Buffer.from(clean).toString('latin1');
  assert(!text.includes('Exif') && !text.includes('ICC_PROFILE') && !text.includes('a comment') && text.includes('Adobe'), 'EXIF, ICC and comments out, Adobe kept');
  same([parseJpeg(clean).width, parseJpeg(clean).height], [16, 8], 'still the same JPEG');
  assert(Buffer.from(clean.subarray(clean.length - plain.length + 2)).equals(Buffer.from(plain.subarray(2))), 'tables and scan as they were');

  // Whether a three-component JPEG's colours are YCbCr: browsers and viewers must agree.
  const jpeg = (o) => ({ components: 3, componentIds: [1, 2, 3], hasJfifMarker: false, adobeTransform: -1, ...o });
  assert(transformsAgree(jpeg({}), undefined), 'plain YCbCr');
  assert(transformsAgree(jpeg({ hasJfifMarker: true }), 1), 'JFIF');
  assert(transformsAgree(jpeg({ adobeTransform: 0 }), undefined), 'Adobe, untransformed RGB');
  assert(transformsAgree(jpeg({ componentIds: [82, 71, 66] }), undefined), 'components named R, G, B');
  assert(!transformsAgree(jpeg({}), 0), '/ColorTransform 0 where browsers would transform');
  assert(!transformsAgree(jpeg({ hasJfifMarker: true, adobeTransform: 0 }), undefined), 'JFIF and an Adobe marker that disagree');
  assert(transformsAgree(jpeg({ components: 1 }), 0), 'grey: nothing to agree on');

  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const stream = (dict, size = 5000) => PDFRawStream.of(ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode', ...dict }), new Uint8Array(size));
  const reason = (dict, size) => {
    const r = examine(ctx, stream(dict, size));
    return r.ok ? 'ok' : r.reason;
  };
  same(reason({}), 'ok', 'an ordinary image');
  same(reason({}, 2047), 'small', "under 2048 bytes (the app's rule)");
  same(reason({ BitsPerComponent: 1, ColorSpace: 'DeviceGray' }), 'one bit', 'bilevel');
  same(reason({ ImageMask: true }), 'stencil mask', 'a stencil mask');
  same(reason({ Mask: [0, 1, 0, 1, 0, 1] }), 'colour key mask', 'colour key masking');
  same(reason({ SMask: ctx.register(ctx.stream(new Uint8Array(4), { Matte: [0, 0, 0] })) }), 'matte', 'a matte');
  same(reason({ Filter: 'JPXDecode' }), 'filter JPXDecode', 'JPEG 2000');
  same(reason({ Filter: ['FlateDecode', 'DCTDecode'], ColorSpace: 'DeviceCMYK' }), 'jpeg components', 'CMYK JPEG');
  same(reason({ ColorSpace: 'Pattern' }), 'colour space', 'a pattern');
  same(reason({ Width: 20000, Height: 20000 }), 'too many pixels', 'too many pixels');
  same(reason({ Decode: [0, 1] }), 'decode', 'a short Decode');
  same(reason({ SMask: ctx.register(ctx.stream(new Uint8Array(4), {})), Decode: [1, 0, 1, 0, 1, 0] }), 'ok', 'a soft mask and a Decode');
  console.log('ok what is kept');
}

// --- Fixtures ----------------------------------------------------------------------------------

let seed = 12345;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Photo-like RGB samples: smooth colour with a little grain, which Flate stores badly and JPEG well. */
function photo(width, height, grain = 10) {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = (random() - 0.5) * grain;
      out[i++] = Math.max(0, Math.min(255, Math.round(255 * x / width + n)));
      out[i++] = Math.max(0, Math.min(255, Math.round(128 + 100 * Math.sin(y / 40) + n)));
      out[i++] = Math.max(0, Math.min(255, Math.round(255 * (1 - y / height) + n)));
    }
  }
  return out;
}

/** Grey samples: a gradient with rings and grain. */
function greyPhoto(width, height, grain = 10) {
  const out = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.hypot(x - width / 2, y - height / 2);
      out[i++] = Math.max(0, Math.min(255, Math.round(128 + 90 * Math.cos(r / 30) * (x / width) + (random() - 0.5) * grain)));
    }
  }
  return out;
}

const register = (doc, contents, dict) => doc.context.register(PDFRawStream.of(doc.context.obj(dict), contents));
const flateImage = (doc, samples, dict) => doc.context.register(doc.context.flateStream(samples, { Type: 'XObject', Subtype: 'Image', ...dict }));
const jpegImage = (doc, jpeg, dict) => register(doc, jpeg, { Type: 'XObject', Subtype: 'Image', Filter: 'DCTDecode', BitsPerComponent: 8, ...dict });

/** Adds `content` to the page with the XObjects it names. */
function draw(doc, page, content, xobjects = {}) {
  for (const [name, ref] of Object.entries(xobjects)) page.node.setXObject(N(name), ref);
  page.node.addContentStream(doc.context.register(doc.context.flateStream(content)));
}

async function caption(doc, page, text, y = 40) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 60, y, size: 12, font });
}

/** Every image a page shows (through form XObjects too): name, its object number, and its facts. */
function imagesOf(doc, pageIndex) {
  const ctx = doc.context;
  const out = [];
  const seen = new Set();
  const walk = (resources, path) => {
    if (!(resources instanceof PDFDict) || seen.has(resources)) return;
    seen.add(resources);
    const xobjects = resources.lookup(N('XObject'));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [key, ref] of xobjects.entries()) {
      const s = ctx.lookup(ref);
      if (!(s instanceof PDFStream)) continue;
      const d = s.dict;
      const value = (k) => {
        const v = d.get(N(k));
        return v instanceof PDFRef ? v.tag : v?.toString();
      };
      if (value('Subtype') === '/Form') {
        walk(d.lookup(N('Resources')), path + key.decodeText() + '/');
        continue;
      }
      out.push({
        name: path + key.decodeText(),
        tag: ref.tag,
        width: d.lookup(N('Width')).asNumber(),
        height: d.lookup(N('Height')).asNumber(),
        filter: value('Filter'),
        colourSpace: value('ColorSpace'),
        smask: value('SMask'),
        mask: value('Mask'),
        decode: value('Decode'),
        bpc: d.lookup(N('BitsPerComponent'))?.asNumber(),
        data: s.getContents(),
      });
    }
  };
  walk(doc.getPages()[pageIndex].node.Resources(), '');
  return out;
}

const byName = (list) => Object.fromEntries(list.map((i) => [i.name, i]));

// In the page: JPEGs made by the browser, rendering with pdf.js, comparing renders, reading text.
const pageHelpers = `
window.__c = {
  lib() {
    return import(new URL('app/js/lib/pdfjs.js', document.baseURI.replace(/app\\/fonts\\/.*$/, '')).href);
  },
  b64(u) {
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  },
  unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); },
  /** A colour JPEG the browser makes of a drawing: 'photo' (gradient and circles) or 'noise'. */
  async jpeg(kind, width, height, quality) {
    const c = new OffscreenCanvas(width, height);
    const g = c.getContext('2d');
    if (kind === 'grey') {
      const gr = g.createRadialGradient(width / 2, height / 2, 10, width / 2, height / 2, width / 1.5);
      gr.addColorStop(0, '#fff');
      gr.addColorStop(0.5, '#333');
      gr.addColorStop(1, '#bbb');
      g.fillStyle = gr;
      g.fillRect(0, 0, width, height);
      g.fillStyle = '#000';
      g.font = (height / 10) + 'px sans-serif';
      for (let i = 0; i < 6; i++) g.fillText('Grey page ' + i, width / 10, height * (i + 1) / 7);
    } else if (kind === 'noise') {
      const img = g.createImageData(width, height);
      let s = 1;
      for (let i = 0; i < img.data.length; i += 4) {
        s = (s * 1103515245 + 12345) >>> 0; img.data[i] = s >>> 24;
        s = (s * 1103515245 + 12345) >>> 0; img.data[i + 1] = s >>> 24;
        s = (s * 1103515245 + 12345) >>> 0; img.data[i + 2] = s >>> 24;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    } else {
      const gr = g.createLinearGradient(0, 0, width, height);
      gr.addColorStop(0, '#2040ff');
      gr.addColorStop(1, '#ffe020');
      g.fillStyle = gr;
      g.fillRect(0, 0, width, height);
      for (let i = 0; i < 40; i++) {
        g.beginPath();
        g.arc(width * ((i % 8) + 0.5) / 8, height * (Math.floor(i / 8) + 0.5) / 5, height / 14, 0, 7);
        if (i % 2) { g.fillStyle = '#e02020'; g.fill(); } else { g.strokeStyle = '#e02020'; g.lineWidth = 12; g.stroke(); }
      }
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
    return this.b64(new Uint8Array(await blob.arrayBuffer()));
  },
  async open(b64, password) {
    const { openPdfJs } = await this.lib();
    return openPdfJs(this.unb64(b64), password ? { password } : {});
  },
  async text(b64, password) {
    const pdf = await this.open(b64, password);
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      out.push(tc.items.map((t) => t.str).join(' '));
    }
    await pdf.loadingTask.destroy();
    return out;
  },
  async render(b64, index, scale, password) {
    const pdf = await this.open(b64, password);
    const p = await pdf.getPage(index + 1);
    const viewport = p.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await p.render({ canvas, viewport }).promise;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    await pdf.loadingTask.destroy();
    return data;
  },
  /**
   * How alike page 'index' of two PDFs looks: the mean difference of each channel over the page
   * (or the PDF rectangle 'area' = [left, bottom, right, top]) and the share of pixels differing
   * by more than 'far' after averaging over 3 x 3 pixels (so a JPEG's grain doesn't count).
   */
  async compare(a, b, { index = 0, scale = 1, area = null, far = 40, passwords = [] } = {}) {
    const x = await this.render(a, index, scale, passwords[0]);
    const y = await this.render(b, index, scale, passwords[1]);
    if (x.width !== y.width || x.height !== y.height) return { mean: 255, farShare: 1, bias: 255 };
    const w = x.width, h = x.height;
    let x0 = 0, y0 = 0, x1 = w, y1 = h;
    if (area) {
      x0 = Math.max(0, Math.floor(area[0] * scale)); x1 = Math.min(w, Math.ceil(area[2] * scale));
      y0 = Math.max(0, Math.floor(h - area[3] * scale)); y1 = Math.min(h, Math.ceil(h - area[1] * scale));
    }
    let sum = 0, n = 0, farCount = 0, cells = 0;
    const signed = [0, 0, 0];
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * w + xx) * 4;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(x.data[i + c] - y.data[i + c]);
        signed[c] += y.data[i + c] - x.data[i + c];
      }
      n += 3;
    }
    for (let yy = y0 + 1; yy < y1 - 1; yy += 3) for (let xx = x0 + 1; xx < x1 - 1; xx += 3) {
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        let sa = 0, sb = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const i = ((yy + dy) * w + xx + dx) * 4 + c;
          sa += x.data[i]; sb += y.data[i];
        }
        worst = Math.max(worst, Math.abs(sa - sb) / 9);
      }
      cells++;
      if (worst > far) farCount++;
    }
    // bias: how far the average colour moved, the worst channel.
    return { mean: sum / n, farShare: farCount / Math.max(1, cells), bias: Math.max(...signed.map((v) => Math.abs(v) / (n / 3))) };
  },
  /** The colour at PDF point (x, y) of page 'index'. */
  async pixel(b64, index, x, y, scale = 1) {
    const d = await this.render(b64, index, scale);
    const i = (Math.floor(d.height - y * scale) * d.width + Math.floor(x * scale)) * 4;
    return [d.data[i], d.data[i + 1], d.data[i + 2]];
  },
};
`;

/** Runs compressPdf in the page. Errors come back as { error: { name, key, wrong } }. */
async function compress(page, url, input, options = {}, { cancelAt } = {}) {
  const r = await page.evaluate(async ({ base, input, options, cancelAt }) => {
    const { compressPdf } = await import(new URL('app/js/engine/compress.js', base).href);
    const bytes = window.__c.unb64(input.bytes);
    const controller = new AbortController();
    const progress = [];
    try {
      const out = await compressPdf({ ...input, bytes }, options, {
        signal: controller.signal,
        onProgress: (done, total) => {
          progress.push([done, total]);
          if (cancelAt != null && done >= cancelAt) controller.abort();
        },
      });
      return { ...out, bytes: window.__c.b64(out.bytes), progress, same: out.bytes !== bytes };
    } catch (e) {
      return { error: { name: e.name, key: e.key, wrong: e.wrong, message: String(e.message) }, progress };
    }
  }, { base: url, input: { ...input, bytes: b64(input.bytes) }, options, cancelAt });
  if (!r.error) r.bytes = new Uint8Array(Buffer.from(r.bytes, 'base64'));
  return r;
}


/** Helpers bound to a page that has pageHelpers in it. */
function inPage(page, url) {
  const call = (fn, ...args) => page.evaluate(({ fn, args }) => window.__c[fn](...args), { fn, args });
  return {
    jpeg: async (kind, w, h, q) => new Uint8Array(Buffer.from(await call('jpeg', kind, w, h, q), 'base64')),
    text: (bytes, password) => call('text', b64(bytes), password),
    compare: (a, b, opts = {}) => call('compare', b64(a), b64(b), opts),
    pixel: (bytes, index, x, y, scale = 1) => call('pixel', b64(bytes), index, x, y, scale),
    compress: (input, options, extra) => compress(page, url, input, options, extra),
  };
}

/** Renders alike: little difference on average, few places far apart, the average colour where it was. */
const looksAlike = (r, msg, mean = 6, farShare = 0.02, bias = 2) => assert(r.mean <= mean && r.farShare <= farShare && r.bias <= bias,
  `${msg}: looks different (mean ${r.mean.toFixed(2)}, far ${(r.farShare * 100).toFixed(2)}%, colour moved ${r.bias.toFixed(2)})`);
const ok = (out, msg) => assert(!out.error, `${msg}: ${JSON.stringify(out.error)}`);

/** A one-page PDF from `build(doc, page)`. */
async function onePage(build, size = A4) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(size);
  await build(doc, page);
  return doc.save();
}

/** Fixtures that need the browser's JPEG encoder; made once (in Chromium) and shared by every browser. */
async function makeJpegs(c) {
  return {
    photo: await c.jpeg('photo', 3000, 2000, 0.95),
    noise: await c.jpeg('noise', 1600, 2000, 0.95),
    greyRgb: await c.jpeg('grey', 2000, 2600, 0.95),
    small: await c.jpeg('photo', 400, 300, 0.4),
  };
}

/** The photo drawn 4 x 2.67 inches with a caption under it. */
const photoPdf = (jpegs) => onePage(async (doc, page) => {
  const im = jpegImage(doc, jpegs.photo, { Width: 3000, Height: 2000, ColorSpace: 'DeviceRGB' });
  draw(doc, page, 'q 288 0 0 192 50 500 cm /Im0 Do Q', { Im0: im });
  await caption(doc, page, 'Keep this selectable caption');
});

/** A colour image with a round soft mask over a green square, and a grey image beside it. */
const alphaPdf = () => onePage(async (doc, page) => {
  const size = 1500;
  const alpha = new Uint8Array(size * size);
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
    const r = Math.hypot(x - size / 2, y - size / 2);
    alpha[i] = Math.max(0, Math.min(255, Math.round((size * 0.45 - r) * 4)));
  }
  const smask = flateImage(doc, alpha, { Width: size, Height: size, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
  const colour = flateImage(doc, photo(size, size, 30), { Width: size, Height: size, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask, Interpolate: true });
  const grey = flateImage(doc, greyPhoto(2000, 1500, 30), { Width: 2000, Height: 1500, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
  draw(doc, page, '0 0.5 0 rg 40 400 400 400 re f q 360 0 0 360 60 420 cm /Im0 Do Q q 288 0 0 216 150 80 cm /Im1 Do Q', { Im0: colour, Im1: grey });
});

const refOf = (tag) => PDFRef.of(Number(tag.split(' ')[0]), Number(tag.split(' ')[1]));

let jpegs;

await withPage(async (page, url) => {
  await page.goto(url + 'app/fonts/OFL.txt');
  await page.evaluate(pageHelpers);
  const c = inPage(page, url);
  jpegs = await makeJpegs(c);

  // --- A photo drawn small, at each level: sized for its space, text kept --------------------
  {
    const source = await photoPdf(jpegs);
    await saveOutput('compress-photo.pdf', source);
    for (const [level, w, h] of [['less', 800, 533], ['recommended', 600, 400], ['extreme', 400, 266]]) {
      const out = await c.compress({ name: 'photo.pdf', bytes: source }, { level });
      ok(out, level);
      assert(out.name === 'photo_compressed.pdf', `named after the PDF: ${out.name}`);
      assert(!out.keptOriginal && out.originalSize === source.length && out.pageCount === 1, `${level}: result facts`);
      assert(out.imagesReduced === 1, `${level}: one image reduced`);
      assert(out.bytes.length < source.length / 4, `${level}: much smaller (${out.bytes.length} from ${source.length})`);
      const back = await PDFDocument.load(out.bytes);
      const [img] = imagesOf(back, 0);
      same([img.width, img.height], [w, h], `${level}: the image's size for 4 inches at ${LEVELS[level].dpi} dpi`);
      assert(img.filter === '/DCTDecode' && img.colourSpace === '/DeviceRGB', `${level}: a colour JPEG`);
      assert(parseJpeg(img.data).components === 3, `${level}: three components`);
      assert((await c.text(out.bytes))[0].includes('Keep this selectable caption'), `${level}: the caption is still text`);
      // Extreme softens the thin rings most (they are under two pixels wide at 100 dpi).
      looksAlike(await c.compare(source, out.bytes, { area: [50, 500, 338, 692] }), `${level}: the photo`, level === 'extreme' ? 12 : 8, 0.03);
      looksAlike(await c.compare(source, out.bytes), `${level}: the page`, 2, 0.01);
      await saveOutput(`compress-photo-${level}.pdf`, out.bytes);
    }
    const named = await c.compress({ name: 'photo.pdf', bytes: source }, { level: 'extreme', name: ' a/b ' });
    assert(named.name === 'a_b.pdf', `name made safe: ${named.name}`);
    console.log('ok photo at each level');
  }

  // --- The app's noise "scan" (PdfToolsDeviceTest): Extreme keeps at most A4 at 100 dpi -------
  {
    const source = await onePage(async (doc, page) => {
      const im = jpegImage(doc, jpegs.noise, { Width: 1600, Height: 2000, ColorSpace: 'DeviceRGB' });
      draw(doc, page, 'q 495 0 0 650 50 70 cm /Im0 Do Q', { Im0: im });
      await caption(doc, page, 'Keep this selectable caption');
    });
    for (const level of ['less', 'recommended', 'extreme']) {
      const out = await c.compress({ name: 'Scan.pdf', bytes: source }, { level, name: 'Report' });
      ok(out, `scan ${level}`);
      assert(out.name === 'Report.pdf', 'named as asked');
      assert(out.bytes.length <= source.length && !out.keptOriginal, `scan ${level}: smaller`);
      assert((await c.text(out.bytes))[0].includes('Keep this selectable caption'), `scan ${level}: caption`);
      const [img] = imagesOf(await PDFDocument.load(out.bytes), 0);
      const rows = (650 / 72) * LEVELS[level].dpi;
      assert(Math.abs(img.height - rows) < 1.5 && Math.abs(img.width / img.height - 0.8) < 0.01, `scan ${level}: ${img.width}x${img.height} for 9 inches at ${LEVELS[level].dpi} dpi`);
      if (level === 'extreme') {
        assert(img.height <= 1169, 'at most A4\'s long side at 100 dpi');
        assert(out.bytes.length < source.length / 2, 'the scan shrank');
      }
    }
    console.log('ok noise scan');
  }

  // --- Grey images: a one-component JPEG, and an RGB JPEG of a grey page, both stored grey ------
  {
    const greyJpeg = encodeGrayJpeg({ width: 2400, height: 2400, pixels: greyPhoto(2400, 2400, 8) }, 95);
    const source = await onePage(async (doc, page) => {
      const a = jpegImage(doc, greyJpeg, { Width: 2400, Height: 2400, ColorSpace: 'DeviceGray' });
      const b = jpegImage(doc, jpegs.greyRgb, { Width: 2000, Height: 2600, ColorSpace: 'DeviceRGB' });
      draw(doc, page, 'q 216 0 0 216 40 580 cm /A Do Q q 200 0 0 260 300 500 cm /B Do Q', { A: a, B: b });
    });
    const out = await c.compress({ name: 'grey.pdf', bytes: source }, { level: 'recommended' });
    ok(out, 'grey');
    const imgs = byName(imagesOf(await PDFDocument.load(out.bytes), 0));
    same([imgs.A.width, imgs.A.height, imgs.A.colourSpace, imgs.A.filter], [450, 450, '/DeviceGray', '/DCTDecode'], 'grey JPEG, 3 inches at 150 dpi');
    assert(parseJpeg(imgs.A.data).components === 1, 'one component');
    same([imgs.B.width, imgs.B.height, imgs.B.colourSpace], [416, 541, '/DeviceGray'], 'RGB JPEG of a grey page, stored grey');
    assert(parseJpeg(imgs.B.data).components === 1, 'one component for the grey RGB one');
    looksAlike(await c.compare(source, out.bytes), 'grey images', 3, 0.02);
    console.log('ok grey');
  }

  // --- Transparency: the soft mask is kept as it is, the colour shrunk; grey Flate image too ----
  {
    const source = await alphaPdf();
    const before = await PDFDocument.load(source);
    const was = byName(imagesOf(before, 0));
    const out = await c.compress({ name: 'alpha.pdf', bytes: source }, { level: 'recommended' });
    ok(out, 'alpha');
    assert(out.bytes.length < source.length / 3, `alpha: smaller (${out.bytes.length} from ${source.length})`);
    const after = await PDFDocument.load(out.bytes);
    const now = byName(imagesOf(after, 0));
    same([now.Im0.width, now.Im0.height, now.Im0.filter, now.Im0.colourSpace], [750, 750, '/DCTDecode', '/DeviceRGB'], 'colour part: 5 inches at 150 dpi');
    assert(now.Im0.smask && now.Im0.smask === was.Im0.smask, 'the same soft mask');
    const mask = after.context.lookup(refOf(now.Im0.smask));
    assert(mask instanceof PDFStream && Buffer.from(mask.getContents()).equals(Buffer.from(before.context.lookup(refOf(was.Im0.smask)).getContents())), 'its data as it was');
    assert(after.context.lookup(refOf(now.Im0.smask)).dict.lookup(N('Width')).asNumber() === 1500, 'at its own size');
    same([now.Im1.width, now.Im1.height, now.Im1.filter, now.Im1.colourSpace], [600, 450, '/DCTDecode', '/DeviceGray'], 'grey Flate image: a grey JPEG');
    // Outside the circle the green square shows through; inside, the picture.
    const corner = await c.pixel(out.bytes, 0, 66, 426);
    assert(corner[1] > 100 && corner[0] < 40 && corner[2] < 40, `transparent corner shows green: ${corner}`);
    const centre = await c.pixel(out.bytes, 0, 240, 600);
    const centreBefore = await c.pixel(source, 0, 240, 600);
    assert(centre.every((v, i) => Math.abs(v - centreBefore[i]) < 24), `centre as before: ${centre} vs ${centreBefore}`);
    looksAlike(await c.compare(source, out.bytes), 'alpha page', 4, 0.02);
    await saveOutput('compress-alpha.pdf', source);
    await saveOutput('compress-alpha-recommended.pdf', out.bytes);
    console.log('ok transparency');
  }

  // --- Reuse, form XObjects and annotation appearances: the largest size shown counts ----------
  {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const [p1, p2, p3] = [doc.addPage(A4), doc.addPage(A4), doc.addPage(A4)];
    // X is on a layer and in the structure tree: both must stay with it; its metadata goes, as in the app.
    const layer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText('Photos') }));
    const xmp = ctx.register(ctx.flateStream('<x:xmpmeta/>', { Type: 'Metadata', Subtype: 'XML' }));
    const X = flateImage(doc, photo(1200, 1200, 20), { Width: 1200, Height: 1200, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, OC: layer, StructParent: 7, Metadata: xmp });
    const Y = flateImage(doc, photo(1200, 1200, 20), { Width: 1200, Height: 1200, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const Z = flateImage(doc, photo(1600, 1000, 20), { Width: 1600, Height: 1000, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const W = flateImage(doc, photo(1000, 1000, 20), { Width: 1000, Height: 1000, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const form = (content, matrix, xobjects) => ctx.register(ctx.flateStream(content, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Matrix: matrix, Resources: { XObject: xobjects },
    }));
    // X: an inch on every page, on page 3 through a form that halves what it is given.
    const F = form('/X Do', [0.5, 0, 0, 0.5, 0, 0], { X });
    // Y: only inside a form inside a form, 2 inches in all.
    const inner = form('q 1 0 0 1 0 0 cm /Y Do Q', [1, 0, 0, 1, 0, 0], { Y });
    const G = form('q 2 0 0 2 0 0 cm /Inner Do Q', [1, 0, 0, 1, 0, 0], { Inner: inner });
    draw(doc, p1, 'q 72 0 0 72 100 600 cm /X Do Q q 1 0 0 1 0 0 cm q 72 0 0 45 100 300 cm /Z Do Q Q q 72 0 0 72 300 600 cm /W Do Q', { X, Z, W });
    draw(doc, p2, 'q 72 0 0 72 100 600 cm /X Do Q q 360 0 0 225 100 100 cm /Z Do Q', { X, Z });
    draw(doc, p3, 'q 144 0 0 144 100 600 cm /F Do Q q 72 0 0 72 300 100 cm /G Do Q', { F, G });
    // W: an inch on page 1, but its page's annotation shows it 400 points wide.
    const ap = ctx.register(ctx.flateStream('q 1 0 0 1 0 0 cm /W Do Q', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { W } },
    }));
    p1.node.set(N('Annots'), ctx.obj([ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 500, 500], AP: { N: ap } })]));
    const source = await doc.save();
    const out = await c.compress({ name: 'reused.pdf', bytes: source }, { level: 'recommended' });
    ok(out, 'reused');
    const back = await PDFDocument.load(out.bytes);
    const pages = [0, 1, 2].map((i) => byName(imagesOf(back, i)));
    same([pages[0].X.width, pages[0].X.height], [150, 150], 'X: an inch at 150 dpi');
    assert(pages[0].X.tag === pages[1].X.tag && pages[1].X.tag === pages[2]['F/X'].tag, 'one copy of X for every page and the form');
    const xDict = back.context.lookup(refOf(pages[0].X.tag)).dict;
    assert(xDict.get(N('OC'))?.tag === layer.tag && xDict.lookup(N('StructParent')).asNumber() === 7 && !xDict.has(N('Metadata')), 'layer and structure kept, metadata dropped');
    same([pages[2]['G/Inner/Y'].width, pages[2]['G/Inner/Y'].height], [300, 300], 'Y: 2 inches through two forms');
    same([pages[0].Z.width, pages[0].Z.height], [750, 468], 'Z: the larger of its two sizes (5 inches)');
    assert(pages[0].Z.tag === pages[1].Z.tag, 'one copy of Z');
    same([pages[0].W.width, pages[0].W.height], [833, 833], 'W: as large as the annotation shows it');
    assert(out.imagesReduced === 4, `four images: ${out.imagesReduced}`);
    for (let i = 0; i < 3; i++) looksAlike(await c.compare(source, out.bytes, { index: i }), `reused page ${i + 1}`, 3, 0.02);
    console.log('ok reuse, forms and annotations');
  }

  // --- Other ways images are stored: each read as a viewer reads it, kept in its colour space ---
  {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const page = doc.addPage(A4);
    const palette = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) palette.set([i, 255 - i, (i * 3) & 255], i * 3);
    const indexes = new Uint8Array(1500 * 1500);
    for (let y = 0, i = 0; y < 1500; y++) for (let x = 0; x < 1500; x++, i++) indexes[i] = (Math.floor((x + y) / 12) + Math.floor(random() * 2)) & 255;
    const rgb16 = (() => {
      const p = photo(1000, 1000, 20);
      const out = new Uint8Array(p.length * 2);
      for (let i = 0; i < p.length; i++) {
        out[2 * i] = p[i];
        out[2 * i + 1] = (p[i] * 37) & 255;
      }
      return out;
    })();
    const grey4 = (() => {
      const g = greyPhoto(2000, 2000, 30);
      const out = new Uint8Array(1000 * 2000);
      for (let i = 0; i < out.length; i++) out[i] = ((g[2 * i] >> 4) << 4) | (g[2 * i + 1] >> 4);
      return out;
    })();
    const lzwRgb = (() => {
      const p = photo(1200, 1200, 20);
      // TIFF predictor 2: each sample as its difference from the one to its left.
      const d = new Uint8Array(p.length);
      for (let y = 0; y < 1200; y++) for (let k = 0; k < 3600; k++) {
        const i = y * 3600 + k;
        d[i] = k < 3 ? p[i] : (p[i] - p[i - 3]) & 255;
      }
      return lzwEncode(d);
    })();
    const hexFlate = new TextEncoder().encode(Buffer.from(zlibSync(photo(800, 800, 30))).toString('hex') + '>');
    const runLength = (() => {
      const g = greyPhoto(1000, 1000, 2);
      const out = [];
      for (let i = 0; i < g.length; i += 128) {
        const chunk = g.subarray(i, i + 128);
        out.push(chunk.length - 1, ...chunk);
      }
      out.push(128);
      return Uint8Array.from(out);
    })();
    const cmyk = (() => {
      const p = photo(1200, 1200, 20);
      const out = new Uint8Array(1200 * 1200 * 4);
      for (let i = 0, j = 0; i < p.length; i += 3, j += 4) {
        const k = 255 - Math.max(p[i], p[i + 1], p[i + 2]);
        out[j] = Math.max(0, 255 - p[i] - k);
        out[j + 1] = Math.max(0, 255 - p[i + 1] - k);
        out[j + 2] = Math.max(0, 255 - p[i + 2] - k);
        out[j + 3] = k;
      }
      return out;
    })();
    const spot = encodeGrayJpeg({ width: 1600, height: 1200, pixels: greyPhoto(1600, 1200, 4) }, 95);
    const separation = ['Separation', 'Spot', 'DeviceRGB', { FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [0.8, 0.1, 0.3], N: 1 }];
    const bits = new Uint8Array(300 * 2400).map(() => Math.floor(random() * 256));
    const iccProfile = ctx.register(ctx.flateStream(new Uint8Array(4000).map(() => Math.floor(random() * 256)), { N: 3, Alternate: 'DeviceRGB' }));
    const images = {
      Indexed: flateImage(doc, indexes, { Width: 1500, Height: 1500, BitsPerComponent: 8, ColorSpace: ['Indexed', 'DeviceRGB', 255, PDFHexString.of(Buffer.from(palette).toString('hex'))] }),
      Rgb16: flateImage(doc, rgb16, { Width: 1000, Height: 1000, BitsPerComponent: 16, ColorSpace: 'DeviceRGB' }),
      Grey4: flateImage(doc, grey4, { Width: 2000, Height: 2000, BitsPerComponent: 4, ColorSpace: 'DeviceGray' }),
      Inverted: flateImage(doc, greyPhoto(1600, 1600, 20), { Width: 1600, Height: 1600, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Decode: [1, 0] }),
      Lzw: register(doc, lzwRgb, { Type: 'XObject', Subtype: 'Image', Width: 1200, Height: 1200, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'LZWDecode', DecodeParms: { Predictor: 2, Colors: 3, Columns: 1200 } }),
      Hex: register(doc, hexFlate, { Type: 'XObject', Subtype: 'Image', Width: 800, Height: 800, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: ['ASCIIHexDecode', 'FlateDecode'] }),
      Rle: register(doc, runLength, { Type: 'XObject', Subtype: 'Image', Width: 1000, Height: 1000, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Filter: 'RunLengthDecode' }),
      Cmyk: flateImage(doc, cmyk, { Width: 1200, Height: 1200, BitsPerComponent: 8, ColorSpace: 'DeviceCMYK' }),
      Spot: jpegImage(doc, spot, { Width: 1600, Height: 1200, ColorSpace: separation }),
      Icc: flateImage(doc, photo(1000, 1000, 30), { Width: 1000, Height: 1000, BitsPerComponent: 8, ColorSpace: ['ICCBased', iccProfile] }),
      // Left as they are:
      Bits: flateImage(doc, bits, { Width: 2400, Height: 2400, BitsPerComponent: 1, ColorSpace: 'DeviceGray' }),
      Keyed: flateImage(doc, photo(800, 800, 40), { Width: 800, Height: 800, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Mask: [0, 20, 0, 20, 0, 20] }),
      Matte: flateImage(doc, photo(800, 800, 40), {
        Width: 800, Height: 800, BitsPerComponent: 8, ColorSpace: 'DeviceRGB',
        SMask: flateImage(doc, new Uint8Array(800 * 800).fill(200), { Width: 800, Height: 800, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Matte: [1, 1, 1] }),
      }),
      NotCmyk: jpegImage(doc, jpegs.photo, { Width: 3000, Height: 2000, ColorSpace: 'DeviceCMYK' }),
      WrongSize: jpegImage(doc, jpegs.photo, { Width: 2000, Height: 2000, ColorSpace: 'DeviceRGB' }),
      Tiny: flateImage(doc, new Uint8Array(40 * 40 * 3).fill(90), { Width: 40, Height: 40, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' }),
      Jpx: register(doc, new Uint8Array(50000).fill(1), { Type: 'XObject', Subtype: 'Image', Width: 1000, Height: 1000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' }),
      Stencil: flateImage(doc, bits, { Width: 2400, Height: 2400, BitsPerComponent: 1, ImageMask: true }),
      Cut: register(doc, zlibSync(photo(1000, 1000, 30)).subarray(0, 600000), { Type: 'XObject', Subtype: 'Image', Width: 1000, Height: 1000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }),
    };
    // Each drawn 2 inches wide (the spot colour 2 x 1.5), in a grid.
    const names = Object.keys(images);
    const at = (i) => [20 + (i % 4) * 145, 680 - Math.floor(i / 4) * 150];
    let content = '';
    names.forEach((n, i) => {
      const [x, y] = at(i);
      if (n === 'Spot') content += `q 144 0 0 108 ${x} ${y} cm /${n} Do Q `;
      else if (n === 'Stencil') content += `q 0 0 1 rg 144 0 0 144 ${x} ${y} cm /${n} Do Q `;
      else content += `q 144 0 0 144 ${x} ${y} cm /${n} Do Q `;
    });
    draw(doc, page, content, images);
    const source = await doc.save();
    await saveOutput('compress-kinds.pdf', source);
    const was = byName(imagesOf(await PDFDocument.load(source), 0));
    const out = await c.compress({ name: 'kinds.pdf', bytes: source }, { level: 'recommended' });
    ok(out, 'kinds');
    await saveOutput('compress-kinds-recommended.pdf', out.bytes);
    const now = byName(imagesOf(await PDFDocument.load(out.bytes), 0));
    const facts = (i) => [i.width, i.height, i.filter, i.colourSpace, i.decode ?? null];
    same(facts(now.Indexed), [300, 300, '/DCTDecode', '/DeviceRGB', null], 'Indexed: its base colours');
    same(facts(now.Rgb16), [300, 300, '/DCTDecode', '/DeviceRGB', null], '16 bits');
    same(facts(now.Grey4), [300, 300, '/DCTDecode', '/DeviceGray', null], '4-bit grey');
    same(facts(now.Inverted), [300, 300, '/DCTDecode', '/DeviceGray', '[ 1 0 ]'], 'Decode kept');
    same(facts(now.Lzw), [300, 300, '/DCTDecode', '/DeviceRGB', null], 'LZW with TIFF predictor');
    same(facts(now.Hex), [300, 300, '/DCTDecode', '/DeviceRGB', null], 'ASCIIHex then Flate');
    same(facts(now.Rle), [300, 300, '/DCTDecode', '/DeviceGray', null], 'RunLength');
    same(facts(now.Cmyk), [300, 300, '/FlateDecode', '/DeviceCMYK', null], 'CMYK: shrunk, stored losslessly');
    assert(now.Spot.width === 300 && now.Spot.height === 225 && now.Spot.filter === '/DCTDecode' && now.Spot.colourSpace.startsWith('[ /Separation /Spot'), `spot colour kept: ${facts(now.Spot)}`);
    assert(now.Icc.width === 300 && now.Icc.colourSpace === was.Icc.colourSpace, `ICC profile kept: ${facts(now.Icc)}`);
    for (const n of ['Bits', 'Keyed', 'Matte', 'NotCmyk', 'WrongSize', 'Tiny', 'Jpx', 'Stencil', 'Cut']) {
      assert(now[n].tag === was[n].tag && Buffer.from(now[n].data).equals(Buffer.from(was[n].data)), `${n} left as it was`);
    }
    // Drawn as before: every image in its place, in its colours (but those pdf.js can't show either way).
    for (const [i, n] of names.entries()) {
      if (n === 'Jpx' || n === 'Cut' || n === 'Icc') continue;
      const [x, y] = at(i);
      const area = n === 'Spot' ? [x, y, x + 144, y + 108] : [x, y, x + 144, y + 144];
      looksAlike(await c.compare(source, out.bytes, { area }), `kinds: ${n}`, 10, 0.05);
    }
    console.log('ok kinds of images');
  }

  // --- Nothing to compress: the original as it was --------------------------------------------
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage(A4);
    let content = '0.2 0.3 0.8 RG 0.5 w ';
    for (let i = 0; i < 6000; i++) content += `${(random() * 595).toFixed(2)} ${(random() * 842).toFixed(2)} m ${(random() * 595).toFixed(2)} ${(random() * 842).toFixed(2)} l S `;
    const small = jpegImage(doc, jpegs.small, { Width: 400, Height: 300, ColorSpace: 'DeviceRGB' });
    const tiny = flateImage(doc, new Uint8Array(30 * 30 * 3).fill(200), { Width: 30, Height: 30, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
    draw(doc, page, content + ' q 288 0 0 216 100 100 cm /Small Do Q q 30 0 0 30 10 10 cm /Tiny Do Q', { Small: small, Tiny: tiny });
    await caption(doc, page, 'ALREADY COMPACT', 800);
    const source = await doc.save();
    const out = await c.compress({ name: 'compact.pdf', bytes: source }, { level: 'less' });
    ok(out, 'compact');
    assert(out.keptOriginal, 'an already compact PDF can\'t get smaller');
    assert(Buffer.from(out.bytes).equals(Buffer.from(source)), 'the original, as it was');
    assert(out.originalSize === source.length && out.name === 'compact_compressed.pdf' && out.imagesReduced === 0, 'facts');
    assert(out.same, 'a copy, not the input itself');
    console.log('ok nothing to compress');
  }

  // --- Passwords: always saved again, without one ---------------------------------------------
  {
    const locked = async (bytes, userPassword) => {
      const d = await PDFDocument.load(bytes);
      await d.encrypt({ userPassword, ownerPassword: 'owner' });
      return d.save();
    };
    const lockedPhoto = await locked(await photoPdf(jpegs), 'secret');
    const vector = await onePage(async (doc, page) => {
      await caption(doc, page, 'ALPHA ONE');
      draw(doc, page, '1 0 0 RG 10 10 m 500 800 l S');
    });
    const lockedText = await locked(vector, 'secret');
    // Big enough that dropping the encryption dictionary alone saves under 1%.
    const ownerOnly = await locked(await onePage(async (doc, page) => {
      let content = '0 0 1 RG ';
      for (let i = 0; i < 20000; i++) content += `${(random() * 595).toFixed(2)} ${(random() * 842).toFixed(2)} m ${(random() * 595).toFixed(2)} ${(random() * 842).toFixed(2)} l S `;
      draw(doc, page, content);
      await caption(doc, page, 'ALPHA ONE');
    }), '');

    const missing = await c.compress({ name: 'locked.pdf', bytes: lockedPhoto }, {});
    assert(missing.error?.name === 'PasswordError' && !missing.error.wrong, `no password: ${JSON.stringify(missing.error)}`);
    const wrong = await c.compress({ name: 'locked.pdf', bytes: lockedPhoto, password: 'guess' }, {});
    assert(wrong.error?.name === 'PasswordError' && wrong.error.wrong, `wrong password: ${JSON.stringify(wrong.error)}`);

    const out = await c.compress({ name: 'locked.pdf', bytes: lockedPhoto, password: 'secret' }, { level: 'recommended' });
    ok(out, 'locked photo');
    const back = await PDFDocument.load(out.bytes); // throws if it still had a password
    assert(!back.context.trailerInfo.Encrypt && !Buffer.from(out.bytes).toString('latin1').includes('/Encrypt'), 'no password any more');
    assert(!out.keptOriginal && out.bytes.length < lockedPhoto.length / 4, 'compressed');
    same([imagesOf(back, 0)[0].width, imagesOf(back, 0)[0].height], [600, 400], 'its image reduced');
    assert((await c.text(out.bytes))[0].includes('Keep this selectable caption'), 'its text');

    const text = await c.compress({ name: 'locked.pdf', bytes: lockedText, password: 'secret' }, { level: 'less' });
    ok(text, 'locked text');
    assert(!text.keptOriginal, 'a PDF with a password is never kept as it was');
    await PDFDocument.load(text.bytes);
    assert((await c.text(text.bytes))[0].includes('ALPHA ONE'), 'its text, without the password');

    // Real AES-256 and RC4 encryption (the Flatten PDF fixtures, locked with "secret").
    for (const name of ['flatten-locked.pdf', 'flatten-locked-rc4.pdf']) {
      const real = new Uint8Array(await fixture(name));
      const r = await c.compress({ name, bytes: real, password: 'secret' }, { level: 'recommended' });
      ok(r, name);
      const opened = await PDFDocument.load(r.bytes);
      assert(!r.keptOriginal && !opened.context.trailerInfo.Encrypt && opened.getPageCount() === (await PDFDocument.load(real, { password: 'secret' })).getPageCount(), `${name}: saved without its password`);
    }

    // Locked only against changes (no password to open it): kept as it was when nothing is saved, as in the app.
    const owner = await c.compress({ name: 'owner.pdf', bytes: ownerOnly }, { level: 'less' });
    ok(owner, 'owner password only');
    assert(owner.keptOriginal && Buffer.from(owner.bytes).equals(Buffer.from(ownerOnly)), `no password to open it: the original kept (${owner.keptOriginal}, ${owner.bytes.length} from ${ownerOnly.length})`);
    console.log('ok passwords');
  }

  // --- Damaged and hostile PDFs -----------------------------------------------------------------
  {
    const junk = await c.compress({ name: 'junk.pdf', bytes: new TextEncoder().encode('%PDF-1.4 nothing else') }, {});
    assert(junk.error?.name === 'UserError' && junk.error.key === 'pdf_import_failed', `not a PDF: ${JSON.stringify(junk.error)}`);

    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const p1 = doc.addPage(A4);
    const p2 = doc.addPage(A4);
    const big = jpegImage(doc, jpegs.photo, { Width: 3000, Height: 2000, ColorSpace: 'DeviceRGB' });
    // Page 1's drawing can't be read (an unknown filter): its image gets the app's limit, A4 at 150 dpi.
    p1.node.setXObject(N('Big'), big);
    p1.node.set(N('Contents'), ctx.register(PDFRawStream.of(ctx.obj({ Filter: 'NoSuchDecode' }), new TextEncoder().encode('q 72 0 0 48 0 0 cm /Big Do Q'))));
    // Page 2: a form that draws itself, a thousand nested q's, an image inside the form.
    const self = ctx.nextRef();
    const inside = flateImage(doc, photo(1000, 1000, 30), { Width: 1000, Height: 1000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
    ctx.assign(self, ctx.flateStream('q 0.5 0 0 0.5 0 0 cm /Self Do Q /In Do', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { Self: self, In: inside } },
    }));
    draw(doc, p2, 'q '.repeat(1000) + '144 0 0 144 100 100 cm /S Do ' + 'Q '.repeat(1200) + ' 1 0 0 cm (unclosed', { S: self });
    const source = await doc.save();
    const out = await c.compress({ name: 'damaged.pdf', bytes: source }, { level: 'recommended' });
    ok(out, 'damaged parts');
    const back = await PDFDocument.load(out.bytes);
    const bigNow = imagesOf(back, 0)[0];
    same([bigNow.width, bigNow.height], [1753, 1168], 'drawn where it can\'t be followed: the app\'s limit');
    const insideNow = byName(imagesOf(back, 1))['S/In'];
    same([insideNow.width, insideNow.height], [300, 300], 'inside a form that draws itself: 2 inches');
    console.log('ok damaged and hostile');
  }

  // --- Progress and cancelling ------------------------------------------------------------------
  {
    const source = await alphaPdf();
    const out = await c.compress({ name: 'alpha.pdf', bytes: source }, {});
    ok(out, 'progress');
    const total = out.progress[0][1];
    same(out.progress[0], [0, total], 'starts at 0');
    same(out.progress[out.progress.length - 1], [total, total], 'ends at the total');
    assert(total === 1 + 2 + 1, `a page, two images, saving: ${total}`);
    assert(out.progress.every(([d], i) => i === 0 || d >= out.progress[i - 1][0]), 'never goes back');
    const cancelled = await c.compress({ name: 'alpha.pdf', bytes: source }, {}, { cancelAt: 1 });
    assert(cancelled.error?.name === 'CancelledError', `cancelled: ${JSON.stringify(cancelled.error)}`);
    const bad = await page.evaluate(async (base) => {
      const { compressPdf } = await import(new URL('app/js/engine/compress.js', base).href);
      try {
        await compressPdf({ name: 'x.pdf', bytes: new Uint8Array(10) }, { level: 'huge' });
        return null;
      } catch (e) {
        return e.name;
      }
    }, url);
    assert(bad === 'RangeError', 'an unknown level is a programming error');
    console.log('ok progress and cancelling');
  }

  // --- Responsiveness: a big Flate image is read in pieces, the page paints meanwhile ------------
  {
    const source = await onePage(async (doc, page) => {
      const im = flateImage(doc, photo(4000, 3000, 30), { Width: 4000, Height: 3000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
      draw(doc, page, 'q 500 0 0 375 40 300 cm /Im0 Do Q', { Im0: im });
    });
    const r = await page.evaluate(async ({ base, bytes }) => {
      const { compressPdf } = await import(new URL('app/js/engine/compress.js', base).href);
      const input = window.__c.unb64(bytes);
      const long = [];
      const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) long.push(Math.round(e.duration)); });
      try { observer.observe({ type: 'longtask' }); } catch { /* not in every browser */ }
      await new Promise((r) => requestAnimationFrame(r));
      let last = performance.now();
      let worst = 0;
      let running = true;
      const tick = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      const out = await compressPdf({ name: 'big.pdf', bytes: input }, {});
      running = false;
      observer.disconnect();
      return { worst, ms: performance.now() - t0, size: out.bytes.length, long };
    }, { base: url, bytes: b64(source) });
    assert(r.worst < 400, `the page painted at least every 400 ms (worst ${r.worst.toFixed(0)} ms, ${r.ms.toFixed(0)} ms in all; long tasks ${r.long})`);
    console.log(`ok responsive (worst frame ${r.worst.toFixed(0)} ms, ${r.ms.toFixed(0)} ms for 12 MP)`);
  }
});

// --- Firefox and WebKit: their JPEG decoding and canvas paths ------------------------------------
for (const browser of ['firefox', 'webkit']) {
  await withPage(async (page, url) => {
    await page.goto(url + 'app/fonts/OFL.txt');
    await page.evaluate(pageHelpers);
    const c = inPage(page, url);
    const source = await photoPdf(jpegs);
    const out = await c.compress({ name: 'photo.pdf', bytes: source }, { level: 'recommended' });
    ok(out, `${browser} photo`);
    const [img] = imagesOf(await PDFDocument.load(out.bytes), 0);
    same([img.width, img.height, img.filter], [600, 400, '/DCTDecode'], `${browser}: photo size`);
    looksAlike(await c.compare(source, out.bytes, { area: [50, 500, 338, 692] }), `${browser}: photo`, 8, 0.03);
    const alpha = await alphaPdf();
    const a = await c.compress({ name: 'alpha.pdf', bytes: alpha }, { level: 'recommended' });
    ok(a, `${browser} alpha`);
    const now = byName(imagesOf(await PDFDocument.load(a.bytes), 0));
    same([now.Im0.width, now.Im1.colourSpace], [750, '/DeviceGray'], `${browser}: alpha and grey`);
    looksAlike(await c.compare(alpha, a.bytes), `${browser}: alpha page`, 4, 0.02);
    console.log(`ok ${browser}`);
  }, { browser });
}

console.log('compress: all tests passed');
