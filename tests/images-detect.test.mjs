// Image import, page detection and cropping (site/app/js/engine/images/: decode.js, outline.js,
// crop.js and their helpers). The pure parts run here in Node, with the app's own unit tests
// ported (ImageFileTypeTest, WebpTest, AreasTest, ImageTransformTest, PageCropTest,
// PageOutlineTest on the same synthetic photos, TestImages); the parts that need a browser run in
// Chromium, WebKit and Firefox, with the app's device tests' checks (ImageTypesDeviceTest on its
// test images, CropDeviceTest on its page photo).
//
//   node tests/images-detect.test.mjs            everything
//   node tests/images-detect.test.mjs node       only the Node part
import * as zlib from 'node:zlib';
import { withPage, assert, fixture } from './harness.mjs';
import { imageFileType, isLossyOpaqueWebp } from '../site/app/js/engine/images/image-type.js';
import * as Areas from '../site/app/js/engine/images/areas.js';
import * as T from '../site/app/js/engine/images/image-transform.js';
import * as Q from '../site/app/js/engine/images/crop-quad.js';
import { findPage, findPageInLuma, byBrightness, shrink, otsu, largestQuad, convexHull } from '../site/app/js/engine/images/outline.js';
import { readImageInfo, strippedJpeg, strippedPng, withoutExifOrientation } from '../site/app/js/engine/images/image-meta.js';
import { photoName, isUnnamedPhoto } from '../site/app/js/engine/images/decode.js';
import { startingCorners, shownQuad, uprightQuad } from '../site/app/js/engine/images/crop.js';
import { Photo, corners, turned, KotlinRandom, pagePhoto, PAGE_PHOTO } from './fixtures/images/page-photos.mjs';

const only = process.argv[2];
const results = [];

async function test(name, fn) {
  const started = performance.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Math.round(performance.now() - started)} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  FAIL ${name}\n       ${e.stack?.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

const near = (a, b, tolerance, what) => assert(Math.abs(a - b) <= tolerance, `${what}: ${a}, expected ${b} ± ${tolerance}`);
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const contains = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));

// ---- Test files built here ----

/**
 * EXIF data (big-endian TIFF) as a phone writes it: orientation, camera make, when it was taken
 * and where (GPS).
 */
function tiffExif({ orientation = 1, taken = '2023:07:14 09:08:07', make = 'Pixel 9 Pro' } = {}) {
  const b = [];
  const u16 = (v) => b.push((v >> 8) & 255, v & 255);
  const u32 = (v) => b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const makeLength = make.length + 1;
  const ifd0Size = 2 + 12 * 4 + 4;
  const makeAt = 8 + ifd0Size;
  const exifAt = makeAt + makeLength + (makeLength & 1);
  const dateAt = exifAt + 18;
  const gpsAt = dateAt + 20;
  const latitudeAt = gpsAt + 30;
  b.push(0x4d, 0x4d);
  u16(42);
  u32(8);
  u16(4);
  u16(0x010f); u16(2); u32(makeLength); u32(makeAt);
  u16(0x0112); u16(3); u32(1); u16(orientation); u16(0);
  u16(0x8769); u16(4); u32(1); u32(exifAt);
  u16(0x8825); u16(4); u32(1); u32(gpsAt);
  u32(0);
  for (const c of make) b.push(c.charCodeAt(0));
  b.push(0);
  if (makeLength & 1) b.push(0);
  u16(1); u16(0x9003); u16(2); u32(20); u32(dateAt); u32(0);
  for (const c of taken) b.push(c.charCodeAt(0));
  b.push(0);
  u16(2);
  u16(1); u16(2); u32(2); b.push(0x4e, 0, 0, 0);
  u16(2); u16(5); u32(3); u32(latitudeAt);
  u32(0);
  for (const v of [48, 1, 51, 1, 24, 1]) u32(v);
  return Uint8Array.from(b);
}

/** A JPEG marker segment: FF marker, 2-byte length, payload (TestImages.segment). */
function segment(marker, payload) {
  const length = payload.length + 2;
  return cat(Uint8Array.of(0xff, marker, length >> 8, length & 255), payload);
}

/** `jpeg` with `segments` right after its SOI (TestImages.withSegments). */
function withSegments(jpeg, ...segments) {
  return cat(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));
}

const exifSegment = (options) => segment(0xe1, cat(bytesOf('Exif\0\0'), tiffExif(options)));
const xmpSegment = () => segment(0xe1, bytesOf('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>48,51N</exif:GPSLatitude></x:xmpmeta>'));
const commentSegment = () => segment(0xfe, bytesOf('Shot on a Pixel 9 Pro at home'));
const iccSegment = () => segment(0xe2, cat(bytesOf('ICC_PROFILE\0'), Uint8Array.of(1, 1), new Uint8Array(40)));
/** What a phone puts after a motion photo's JPEG: the video. */
const motionVideo = () => cat(Uint8Array.of(0, 0, 0, 24), bytesOf('ftypmp42'), new Uint8Array(500).fill(7));

/** A PNG chunk with its checksum. */
function pngChunk(type, data) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(bytesOf(type), 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, zlib.crc32(cat(bytesOf(type), data)));
  return cat(head, data, crc);
}

/** `png` with `chunks` right after its IHDR. */
function withPngChunks(png, ...chunks) {
  const ihdrEnd = 8 + 12 + 13;
  return cat(png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd));
}

/** A WebP file of `chunks` (WebpTest.webp). */
function webp(...chunks) {
  return cat(bytesOf('RIFF'), new Uint8Array(4), bytesOf('WEBP'), ...chunks);
}

/** A WebP chunk (WebpTest.chunk): name, size, and `size` bytes padded to an even length. */
function webpChunk(name, size, first = 0) {
  const data = new Uint8Array(size + (size & 1));
  if (data.length) data[0] = first;
  const head = cat(bytesOf(name), Uint8Array.of(size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255));
  return cat(head, data);
}

/** The box a HEIF, AVIF or MP4 file starts with, listing `major` and then `compatible`. */
function ftyp(major, ...compatible) {
  const size = 16 + 4 * compatible.length;
  return cat(Uint8Array.of(0, 0, 0, size), bytesOf('ftyp' + major), new Uint8Array(4), bytesOf(compatible.join('')), new Uint8Array(8));
}

// =====================================================================================
// Node: the app's unit tests
// =====================================================================================

console.log('Node');

// ImageFileTypeTest
await test('ImageFileType: pictures are told by their first bytes', () => {
  assert(imageFileType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)) === 'jpeg', 'jpeg');
  assert(imageFileType(Uint8Array.of(0x89, 80, 78, 71, 13, 10, 26, 10, 0)) === 'png', 'png');
  assert(imageFileType(bytesOf('RIFF\0\0\0\0WEBPVP8 ')) === 'webp', 'webp');
  assert(imageFileType(bytesOf('GIF89a\x01\0')) === 'gif', 'gif');
  assert(imageFileType(bytesOf('BM\0\0\0\0\0\0\0\x006\0\0\0(\0\0\0')) === 'bmp', 'bmp');
  // As an iPhone saves a photo, as a HEIF file of HEIF's brand only, and as AVIF files list theirs.
  assert(imageFileType(ftyp('heic', 'mif1', 'heic')) === 'heif', 'heic');
  assert(imageFileType(ftyp('mif1', 'mif1')) === 'heif', 'mif1');
  assert(imageFileType(ftyp('avif', 'avif', 'mif1', 'miaf', 'MA1B')) === 'avif', 'avif');
  assert(imageFileType(ftyp('mif1', 'mif1', 'avif')) === 'avif', 'avif listed after mif1');
});

await test('ImageFileType: other files are none', () => {
  assert(imageFileType(new Uint8Array(0)) === null, 'empty');
  assert(imageFileType(ftyp('isom', 'isom', 'iso2', 'mp41')) === null, 'a video');
  assert(imageFileType(bytesOf('RIFF\0\0\0\0WAVEfmt ')) === null, 'a sound');
  assert(imageFileType(bytesOf('BMW cars and other things')) === null, 'text starting BM');
  assert(imageFileType(bytesOf('II*\0\x08\0\0\0')) === null, 'a TIFF');
  // A box size that runs past the bytes read lists only the brands within them.
  assert(imageFileType(cat(Uint8Array.of(0x7f, 0xff, 0xff, 0xff), bytesOf('ftypisom'))) === null, 'long box');
});

await test('ImageFileType: the app\'s test images', async () => {
  const expected = { 'turned.heic': 'heif', 'turned.avif': 'avif', 'photo.webp': 'webp', 'clear.webp': 'webp', 'drawing.gif': 'gif', 'drawing.bmp': 'bmp' };
  for (const [name, type] of Object.entries(expected)) {
    const b = new Uint8Array(await fixture('images/' + name));
    assert(imageFileType(b.subarray(0, 64)) === type, name);
  }
});

// WebpTest
await test('Webp: lossy photos are told', () => {
  assert(isLossyOpaqueWebp(webp(webpChunk('VP8 ', 30))), 'simple');
  // Extended, with a colour profile (odd-sized, so padded) and EXIF data before the picture.
  assert(isLossyOpaqueWebp(webp(webpChunk('VP8X', 10, 0x28), webpChunk('ICCP', 3001), webpChunk('VP8 ', 30), webpChunk('EXIF', 40))), 'extended');
});

await test('Webp: lossless, see-through and animated are not', () => {
  assert(!isLossyOpaqueWebp(webp(webpChunk('VP8L', 30))), 'lossless');
  assert(!isLossyOpaqueWebp(webp(webpChunk('VP8X', 10, 0x10), webpChunk('ALPH', 12), webpChunk('VP8 ', 30))), 'alpha flag');
  assert(!isLossyOpaqueWebp(webp(webpChunk('VP8X', 10), webpChunk('ALPH', 12), webpChunk('VP8 ', 30))), 'alpha chunk');
  assert(!isLossyOpaqueWebp(webp(webpChunk('VP8X', 10, 0x02), webpChunk('ANIM', 6), webpChunk('ANMF', 40))), 'animated');
  assert(!isLossyOpaqueWebp(webp(webpChunk('VP8X', 10), webpChunk('VP8L', 30))), 'extended lossless');
});

await test('Webp: other or cut short files are not', () => {
  assert(!isLossyOpaqueWebp(new Uint8Array(0)), 'empty');
  assert(!isLossyOpaqueWebp(bytesOf('RIFF\0\0\0\0WAVEfmt ')), 'wave');
  // The picture's chunk lies beyond the bytes read.
  assert(!isLossyOpaqueWebp(webp(webpChunk('VP8X', 10), webpChunk('ICCP', 1_000_000).slice(0, 400))), 'beyond');
  // A chunk size that runs past the end of any file.
  assert(!isLossyOpaqueWebp(cat(webp(webpChunk('VP8X', 10)), bytesOf('ICCP'), Uint8Array.of(255, 255, 255, 255))), 'huge chunk');
});

// AreasTest
await test('Areas: an area moved and moved back is where it was', () => {
  // Turned a quarter, stretched and moved, as a scan drawn on a turned page is.
  const m = [0, 2, -3, 0, 400, 10];
  const area = [0.25, 0, 0.5, 1];
  const moved = Areas.mapped(m, area);
  [397, 10.5, 400, 11].forEach((v, i) => near(moved[i], v, 1e-4, 'mapped ' + i));
  const back = Areas.mapped(Areas.inverted(m), moved);
  area.forEach((v, i) => near(back[i], v, 1e-4, 'back ' + i));
  assert(Areas.inverted([1, 2, 2, 4, 0, 0]) === null, "squashed flat, it can't be undone");
});

await test('Areas: overlaps and what lies within', () => {
  assert(JSON.stringify(Areas.intersection([0, 0, 10, 8], [5, 5, 20, 20])) === '[5,5,10,8]', 'overlap');
  assert(Areas.intersection([0, 0, 10, 10], [10, 0, 20, 10]) === null, "touching edges don't overlap");
  const page = [200, 0, 400, 200];
  assert(Areas.inside([199.5, 0, 300, 200.5], page, 1), 'inside with slack');
  assert(!Areas.inside([0, 0, 200, 200], page, 1), 'outside');
});

// ImageTransformTest
await test('ImageTransform: every orientation and rotation places every pixel correctly', () => {
  const storedWidth = 4;
  const storedHeight = 3;
  const stored = Array.from({ length: storedHeight }, (_, r) => Array.from({ length: storedWidth }, (_, c) => r * storedWidth + c));
  const rotateCw = (img) => {
    const h = img.length;
    const w = img[0].length;
    return Array.from({ length: w }, (_, r) => Array.from({ length: h }, (_, c) => img[h - 1 - c][r]));
  };
  const referenceExif = (img, o) => {
    const h = img.length;
    const w = img[0].length;
    switch (o) {
      case 1: return img.map((row) => row.slice());
      case 2: return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => img[r][w - 1 - c]));
      case 3: return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => img[h - 1 - r][w - 1 - c]));
      case 4: return Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => img[h - 1 - r][c]));
      case 5: return Array.from({ length: w }, (_, r) => Array.from({ length: h }, (_, c) => img[c][r]));
      case 6: return rotateCw(img);
      case 7: return Array.from({ length: w }, (_, r) => Array.from({ length: h }, (_, c) => img[h - 1 - c][w - 1 - r]));
      case 8: return Array.from({ length: w }, (_, r) => Array.from({ length: h }, (_, c) => img[c][w - 1 - r]));
      default: throw new Error('bad orientation');
    }
  };
  const find = (img, value) => {
    for (let r = 0; r < img.length; r++) for (let c = 0; c < img[r].length; c++) if (img[r][c] === value) return [r, c];
    throw new Error('not found');
  };
  for (let exif = 1; exif <= 8; exif++) {
    for (const rotation of [0, 90, 180, 270]) {
      let expected = referenceExif(stored, exif);
      for (let k = 0; k < rotation / 90; k++) expected = rotateCw(expected);
      const shownH = expected.length;
      const shownW = expected[0].length;
      const t = T.transformOf(exif, rotation);
      assert((shownW !== storedWidth) === T.swapsAxes(t), `swap exif=${exif} rot=${rotation}`);
      const [x0, y0, w, h] = [10, 20, shownW * 2, shownH * 3];
      const m = T.pdfMatrix(t, x0, y0, w, h);
      // The canvas matrix draws the stored pixels where the shown image has them.
      const cm = T.canvasMatrix(t, storedWidth, storedHeight);
      for (let row = 0; row < storedHeight; row++) {
        for (let col = 0; col < storedWidth; col++) {
          const u = (col + 0.5) / storedWidth;
          const v = 1 - (row + 0.5) / storedHeight;
          const x = m[0] * u + m[2] * v + m[4];
          const y = m[1] * u + m[3] * v + m[5];
          const [er, ec] = find(expected, stored[row][col]);
          near(x, x0 + (ec + 0.5) / shownW * w, 1e-9, `x exif=${exif} rot=${rotation} px=(${col},${row})`);
          near(y, y0 + h * (1 - (er + 0.5) / shownH), 1e-9, `y exif=${exif} rot=${rotation} px=(${col},${row})`);
          const cx = cm[0] * (col + 0.5) + cm[2] * (row + 0.5) + cm[4];
          const cy = cm[1] * (col + 0.5) + cm[3] * (row + 0.5) + cm[5];
          near(cx, ec + 0.5, 1e-9, `canvas x exif=${exif} rot=${rotation}`);
          near(cy, er + 0.5, 1e-9, `canvas y exif=${exif} rot=${rotation}`);
        }
      }
    }
  }
});

await test('ImageTransform: rotation normalises angles', () => {
  assert(T.sameTransform(T.rotation(270), T.rotation(-90)), '270 = -90');
  assert(T.sameTransform(T.IDENTITY, T.rotation(360)), '360');
  assert(T.sameTransform(T.fromExif(6), T.rotation(90)), 'exif 6');
  assert(T.sameTransform(T.fromExif(3), T.rotation(180)), 'exif 3');
  assert(T.sameTransform(T.fromExif(8), T.rotation(270)), 'exif 8');
  assert(T.sameTransform(T.IDENTITY, T.fromExif(0)), 'exif 0');
  assert(T.sameTransform(T.IDENTITY, T.fromExif(9)), 'exif 9');
  for (let o = 1; o <= 8; o++) assert(T.sameTransform(T.then(T.fromExif(o), T.inverse(T.fromExif(o))), T.IDENTITY), 'inverse ' + o);
});

// PageCropTest
const quad = (...xy) => Q.quadOf(...xy);
const sameQuad = (expected, actual, tolerance = 1e-5) => {
  for (let i = 0; i < 4; i++) {
    near(actual[i].x, expected[i].x, tolerance, `x of corner ${i}`);
    near(actual[i].y, expected[i].y, tolerance, `y of corner ${i}`);
  }
};
const samePoint = (p, x, y, what) => {
  near(p.x, x, 1e-6, what + ' x');
  near(p.y, y, 1e-6, what + ' y');
};

await test('PageCrop: corners are ordered clockwise from the top-left', () => {
  const page = quad(0.2, 0.1, 0.9, 0.15, 0.85, 0.9, 0.1, 0.8);
  // Dragged past each other, or found in another order.
  sameQuad(page, Q.ordered([page[2], page[0], page[3], page[1]]));
  sameQuad(page, Q.ordered(page.slice().reverse()));
  sameQuad(page, Q.ordered(page));
});

await test('PageCrop: turning and turning back keeps the corners', () => {
  const page = quad(0.2, 0.1, 0.9, 0.15, 0.85, 0.9, 0.1, 0.8);
  for (const degrees of [0, 90, 180, 270]) {
    const turn = T.rotation(degrees);
    const shown = Q.ordered(Q.transformed(page, turn));
    sameQuad(page, Q.ordered(Q.transformed(shown, T.inverse(turn))));
  }
  // A quarter turn clockwise: the top-left corner goes to the top right.
  samePoint(Q.transformed(page, T.rotation(90))[Q.TOP_LEFT], 0.9, 0.2, 'turned top-left');
  sameQuad(Q.WHOLE, Q.ordered(Q.transformed(Q.WHOLE, T.rotation(90))));
});

await test('PageCrop: only a convex shape with real sides is a page', () => {
  assert(Q.isUsable(Q.WHOLE, 100, 100), 'whole');
  assert(Q.isUsable(quad(0.2, 0.1, 0.9, 0.15, 0.85, 0.9, 0.1, 0.8), 1000, 1000), 'page');
  // Counter-clockwise is still a page.
  assert(Q.isUsable(Q.WHOLE.slice().reverse(), 100, 100), 'counter-clockwise');
  // Two corners swapped: the sides cross.
  assert(!Q.isUsable(quad(0, 0, 1, 1, 1, 0, 0, 1), 100, 100), 'crossed');
  // A corner pushed inside: an arrow head, not a page.
  assert(!Q.isUsable(quad(0, 0, 1, 0, 0.3, 0.3, 0, 1), 100, 100), 'arrow head');
  // Three corners in a line.
  assert(!Q.isUsable(quad(0, 0, 0.5, 0, 1, 0, 0, 1), 100, 100), 'in a line');
  // Sides shorter than 16 pixels.
  assert(!Q.isUsable(quad(0.5, 0.5, 0.51, 0.5, 0.51, 0.51, 0.5, 0.51), 1000, 1000), 'tiny');
  assert(Q.isUsable(quad(0.5, 0.5, 0.51, 0.5, 0.51, 0.51, 0.5, 0.51), 4000, 4000), 'tiny on a large image');
});

await test('PageCrop: corners stay on the image', () => {
  const moved = Q.movedCorner(Q.WHOLE, Q.TOP_LEFT, -0.1, 0.2);
  samePoint(moved[Q.TOP_LEFT], 0, 0.2, 'moved');
  samePoint(Q.withCorner(Q.inset(0.1), Q.BOTTOM_RIGHT, 1.5, 3)[Q.BOTTOM_RIGHT], 1, 1, 'with');
  samePoint(moved[Q.TOP_RIGHT], 1, 0, 'other corner');
});

await test('PageCrop: a dragged side moves across with its corners on the sides beside', () => {
  // Narrower at the top, on a 1000 × 2000 image: the top side dragged up 100 pixels (and along
  // itself, which doesn't count) takes its corners up the slanting sides, closer together.
  const page = quad(0.3, 0.2, 0.7, 0.2, 0.9, 0.8, 0.1, 0.8);
  const moved = Q.movedSide(page, Q.TOP_SIDE, 0.05, -0.05, 1000, 2000);
  sameQuad(quad(0.3 + 0.2 / 12, 0.15, 0.7 - 0.2 / 12, 0.15, 0.9, 0.8, 0.1, 0.8), moved);
});

await test('PageCrop: a side dragged along itself stays, in pixels not fractions', () => {
  const page = quad(0.1, 0.1, 0.6, 0.1, 0.9, 0.9, 0.1, 0.9);
  sameQuad(page, Q.movedSide(page, Q.RIGHT_SIDE, 0.03, 0.08, 2000, 1000));
});

await test('PageCrop: a side moves straight across when a side beside is nearly parallel', () => {
  const page = quad(0.5, 0.3, 0.9, 0.3, 0.9, 0.9, 0, 0.32);
  sameQuad(quad(0.5, 0.35, 0.9, 0.35, 0.9, 0.9, 0, 0.32), Q.movedSide(page, Q.TOP_SIDE, 0, 0.05, 1000, 1000));
});

await test('PageCrop: a side moves straight across when a corner would leave the image, and stays on it', () => {
  const page = quad(0.05, 0.05, 0.95, 0.05, 0.7, 0.9, 0.3, 0.9);
  sameQuad(quad(0.05, 0, 0.95, 0, 0.7, 0.9, 0.3, 0.9), Q.movedSide(page, Q.TOP_SIDE, 0, -0.1, 1000, 1000));
  // The bottom side, moved down a little, slides along the sides as usual.
  const down = Q.movedSide(page, Q.BOTTOM_SIDE, 0, 0.02, 1000, 1000);
  near(down[Q.BOTTOM_RIGHT].y, 0.92, 1e-5, 'bottom right y');
  assert(down[Q.BOTTOM_RIGHT].x < 0.7 && down[Q.BOTTOM_LEFT].x > 0.3, 'slid along');
});

await test('PageCrop: a quarter turn names each corner for where it lands', () => {
  const page = quad(0.2, 0.1, 0.9, 0.15, 0.85, 0.9, 0.1, 0.8);
  const t = Q.turned(page, 90);
  samePoint(t[Q.TOP_RIGHT], 0.9, 0.2, 'top-left lands top right');
  sameQuad(Q.ordered(Q.transformed(page, T.rotation(90))), t);
  sameQuad(page, Q.turned(t, -90));
  sameQuad(page, Q.turned(Q.turned(page, 180), 180));
  sameQuad(Q.turned(page, -90), Q.turned(page, 270));
});

await test('PageCrop: whole and inset', () => {
  assert(Q.isWhole(Q.WHOLE), 'whole');
  assert(Q.isWhole(quad(0.001, 0, 1, 0.0005, 0.999, 1, 0, 1)), 'nearly whole');
  assert(!Q.isWhole(Q.inset(Q.INSET)), 'inset');
  sameQuad(quad(0.08, 0.08, 0.92, 0.08, 0.92, 0.92, 0.08, 0.92), Q.inset(0.08));
});

await test('PageCrop: the straightened page is shaped by its edges and as large as the longest', () => {
  assert(String(Q.outputSize(quad(0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9), 1000, 2000)) === '800,1600', 'rectangle');
  // Photographed at a slant: the bottom edge is 900 pixels, the top 500, the sides 1020 long.
  const [w, h] = Q.outputSize(quad(0.25, 0, 0.75, 0, 0.95, 0.5, 0.05, 0.5), 1000, 2000);
  assert(w === 900, 'width ' + w);
  near(h, 1020 * 900 / 700, 1, 'height');
  // A tilted square keeps its shape.
  assert(String(Q.outputSize(quad(0.5, 0.1, 0.9, 0.5, 0.5, 0.9, 0.1, 0.5), 1000, 1000)) === '566,566', 'tilted square');
});

await test('PageCrop: a large page is shrunk to the long side', () => {
  assert(String(Q.outputSize(Q.WHOLE, 8000, 6000)) === '3000,2250', '8000 × 6000');
  assert(String(Q.outputSize(Q.WHOLE, 4000, 8000)) === '1500,3000', '4000 × 8000');
  assert(String(Q.outputSize(Q.WHOLE, 1000, 2000, 3000)) === '1000,2000', 'small');
  // Never less than a pixel.
  assert(String(Q.outputSize(quad(0, 0, Math.fround(0.0001), 0, Math.fround(0.0001), 1, 0, 1), 100, 100_000)) === '1,3000', 'sliver');
});

await test('PageCrop: corners on the stored photo follow its EXIF orientation', () => {
  // Stored 400 × 300, shown upright 300 × 400 (turned a quarter clockwise, EXIF 6).
  const page = quad(0.1, 0.2, 0.9, 0.2, 0.9, 0.8, 0.1, 0.8);
  const stored = Q.storedCorners(page, T.fromExif(6), 400, 300);
  [80, 270, 80, 30, 320, 30, 320, 270].forEach((v, i) => near(stored[i], v, 1e-3, 'corner ' + i));
  const same = Q.storedCorners(page, T.fromExif(1), 300, 400);
  near(same[0], 30, 1e-3, 'upright x');
  near(same[1], 80, 1e-3, 'upright y');
  const mirrored = Q.storedCorners(page, T.fromExif(2), 300, 400);
  near(mirrored[0], 270, 1e-3, 'mirrored x');
  near(mirrored[1], 80, 1e-3, 'mirrored y');
  for (let orientation = 1; orientation <= 8; orientation++) {
    const upright = T.fromExif(orientation);
    const w = T.swapsAxes(upright) ? 300 : 400;
    const h = T.swapsAxes(upright) ? 400 : 300;
    const points = Q.storedCorners(page, upright, w, h);
    const back = Q.transformed([0, 1, 2, 3].map((i) => ({ x: points[2 * i] / w, y: points[2 * i + 1] / h })), upright);
    sameQuad(page, back);
  }
});

await test('PageCrop: the crop screen\'s turned view and where its corners start', () => {
  const page = quad(0.2, 0.1, 0.9, 0.15, 0.85, 0.9, 0.1, 0.8);
  // As MainViewModel.CropSession shows and takes back corners on an image turned in the editor.
  for (const turn of [0, 90, 180, 270, -90]) sameQuad(page, uprightQuad(shownQuad(page, turn), turn));
  const shown = shownQuad(page, 90);
  near(shown[Q.TOP_RIGHT].x, 1 - page[0].y, 1e-6, 'top-left shows top right');
  near(shown[Q.TOP_RIGHT].y, page[0].x, 1e-6, 'top-left shows top right');
  const found = startingCorners({ quad: page, confidence: 0.9, confident: true });
  assert(found.foundPage && found.corners === page, 'found');
  const guess = startingCorners({ quad: page, confidence: 0.3, confident: false });
  assert(!guess.foundPage, 'a guess is not found');
  sameQuad(Q.inset(0.08), guess.corners);
  sameQuad(Q.inset(0.08), startingCorners(null).corners);
});

// TestImages / PageOutlineTest
await test('Kotlin\'s Random, for the same test photos as the app\'s', () => {
  const r = new KotlinRandom(1);
  assert(Array.from({ length: 8 }, () => r.nextIntIn(-10, 11)).join(' ') === '-10 -10 0 2 8 7 -3 8', 'seed 1');
  const r7 = new KotlinRandom(7);
  assert(Array.from({ length: 4 }, () => r7.nextIntIn(5, 30)).join(' ') === '16 19 28 21', 'seed 7');
  near(r7.nextDoubleIn(0, 2 * Math.PI), 2.2834371095736987, 1e-15, 'nextDouble');
});

const find = (photo) => (photo.deskColour ? findPage(photo.rgba(), photo.width, photo.height) : findPageInLuma(photo.luma(), photo.width, photo.height));

/** Each corner found within `tolerance` of the photo's long side from where the page's is. */
function assertFound(photo, tolerance = 0.012, expected = photo.corners) {
  const outline = find(photo);
  assert(outline, 'No page found');
  const long = Math.max(photo.width, photo.height);
  for (let i = 0; i < 4; i++) {
    const dx = (outline.quad[i].x - expected[i].x) * photo.width;
    const dy = (outline.quad[i].y - expected[i].y) * photo.height;
    assert(Math.hypot(dx, dy) / long <= tolerance, `Corner ${i} at ${JSON.stringify(outline.quad[i])}, the page's at ${JSON.stringify(expected[i])}`);
  }
  assert(outline.confident, 'Confidence ' + outline.confidence);
  return outline;
}

function assertNotConfident(photo) {
  const outline = find(photo);
  assert(outline == null || !outline.confident, 'Found ' + JSON.stringify(outline));
}

const NO_PAGE = corners(-1, -1, -0.9, -1, -0.9, -0.9, -1, -0.9);
const whiteDesk = (x, y) => 240 - 5 * x - 5 * y;

await test('PageOutline: finds an upright page', () => assertFound(new Photo(600, 800, corners(0.2, 0.15, 0.8, 0.15, 0.8, 0.85, 0.2, 0.85))));

await test('PageOutline: finds a tilted page', () => {
  assertFound(new Photo(600, 800, turned(0.5, 0.5, 0.62, 0.8, 12, 600, 800)));
  assertFound(new Photo(800, 600, turned(0.48, 0.52, 0.45, 0.55, -25, 800, 600), { seed: 2 }));
});

await test('PageOutline: finds a page photographed at a slant', () => {
  assertFound(new Photo(600, 800, corners(0.27, 0.2, 0.73, 0.18, 0.9, 0.88, 0.1, 0.9)));
  assertFound(new Photo(800, 600, corners(0.1, 0.12, 0.85, 0.25, 0.82, 0.75, 0.12, 0.9), { seed: 3 }));
});

await test('PageOutline: finds a page half in shadow', () => {
  const shadow = (x) => (x < 0.4 ? 0.62 : x < 0.5 ? 0.62 + (x - 0.4) / 0.1 * 0.38 : 1);
  assertFound(new Photo(600, 800, corners(0.15, 0.1, 0.85, 0.12, 0.88, 0.9, 0.12, 0.88), { shade: shadow }));
  assertFound(new Photo(600, 800, corners(0.2, 0.1, 0.8, 0.1, 0.8, 0.9, 0.2, 0.9), { shade: (_, y) => 1.05 - 0.4 * y, seed: 4 }));
});

await test('PageOutline: finds a page with a folded corner', () => {
  assertFound(new Photo(600, 800, corners(0.2, 0.15, 0.8, 0.15, 0.8, 0.85, 0.2, 0.85), { fold: 0.12 }), 0.02);
});

await test('PageOutline: other things on the table don\'t move the corners', () => {
  const things = (x, y) => (x >= 0.86 && x <= 0.9 && y >= 0.2 && y <= 0.7 ? 235 : (x - 0.1) ** 2 + (y - 0.92) ** 2 < 0.004 ? 200 : null);
  assertFound(new Photo(600, 800, corners(0.2, 0.15, 0.78, 0.16, 0.8, 0.82, 0.22, 0.84), { extra: things }));
});

await test('PageOutline: finds the page on a large photo', () => {
  assertFound(new Photo(1500, 2000, corners(0.22, 0.18, 0.8, 0.14, 0.84, 0.86, 0.18, 0.84), { noise: 14, seed: 5 }));
});

await test('PageOutline: a page running off the photo is not sure', () => {
  assertNotConfident(new Photo(600, 800, corners(0.3, 0.2, 0.85, 0.25, 1.15, 1.1, 0.25, 0.9)));
  assertNotConfident(new Photo(600, 800, corners(-0.02, -0.02, 1.02, -0.02, 1.02, 1.02, -0.02, 1.02)));
});

await test('PageOutline: nothing like a page is not sure', () => {
  assertNotConfident(new Photo(600, 800, NO_PAGE));
  assertNotConfident(new Photo(600, 800, corners(0.45, 0.45, 0.55, 0.45, 0.55, 0.55, 0.45, 0.55)));
  const plate = (x, y) => ((x - 0.5) ** 2 + (y - 0.5) ** 2 * 0.5625 < 0.1 ? 230 : null);
  assertNotConfident(new Photo(600, 800, NO_PAGE, { extra: plate }));
  assert(findPageInLuma(new Uint8Array(300 * 400).fill(128), 300, 400) === null, 'a flat grey image');
  assert(findPage(new Uint8ClampedArray(7 * 7 * 4), 7, 7) === null, 'too small to look at');
});

await test('PageOutline: finds a page on a brighter table', () => {
  assertFound(new Photo(600, 800, corners(0.2, 0.15, 0.8, 0.15, 0.8, 0.85, 0.2, 0.85), { paper: 190, table: 240, noise: 6 }));
});

await test('PageOutline: finds a white page on a white desk', () => {
  assertFound(new Photo(600, 800, turned(0.5, 0.5, 0.6, 0.75, 8, 600, 800), { paper: 236, desk: whiteDesk, shadow: 16, noise: 5 }));
  assertFound(new Photo(800, 600, corners(0.25, 0.15, 0.78, 0.2, 0.88, 0.85, 0.12, 0.8), { paper: 236, desk: whiteDesk, shadow: 16, noise: 5, seed: 2 }));
});

await test('PageOutline: finds a white page in shadow on a white desk', () => {
  const hand = (_, y) => (y < 0.35 ? 0.7 : y < 0.45 ? 0.7 + (y - 0.35) / 0.1 * 0.3 : 1);
  assertFound(new Photo(600, 800, corners(0.18, 0.12, 0.82, 0.14, 0.8, 0.88, 0.2, 0.86), { paper: 236, desk: whiteDesk, shadow: 16, noise: 5, shade: hand, seed: 3 }));
});

await test('PageOutline: the sides lie just inside the page', () => {
  const photos = [
    new Photo(600, 800, turned(0.5, 0.5, 0.6, 0.75, -4, 600, 800), { paper: 236, desk: () => 205, shadow: 40, noise: 4, soft: 1, seed: 3 }),
    new Photo(800, 600, corners(0.2, 0.18, 0.8, 0.14, 0.83, 0.85, 0.17, 0.82), { noise: 4, seed: 2 }),
  ];
  for (const photo of photos) {
    const { quad: q } = assertFound(photo);
    const luma = photo.luma();
    for (let side = 0; side < 4; side++) {
      const a = q[side];
      const b = q[(side + 1) % 4];
      let sum = 0;
      for (let k = 10; k <= 90; k++) {
        const x = Math.trunc((a.x + (b.x - a.x) * k / 100) * photo.width);
        const y = Math.trunc((a.y + (b.y - a.y) * k / 100) * photo.height);
        sum += luma[y * photo.width + x];
      }
      const average = sum / 81;
      assert(average >= photo.paper - 5, `Side ${side} at ${average}, the paper ${photo.paper}`);
    }
  }
});

await test('PageOutline: finds a page on a light grey desk', () => {
  const photo = new Photo(600, 800, corners(0.2, 0.12, 0.8, 0.15, 0.78, 0.88, 0.22, 0.85), { paper: 228, desk: () => 214, noise: 6, seed: 4 });
  const brightness = byBrightness(shrink(photo.luma(), photo.width, photo.height));
  assert(brightness == null || !brightness.confident, 'by brightness alone ' + JSON.stringify(brightness));
  assertFound(photo);
});

await test('PageOutline: finds a page on a light textured desk', () => {
  const grain = (x, y) => 205 + 12 * Math.sin(y * 140 + 4 * Math.sin(x * 9)) + 6 * Math.sin(x * 410 + y * 230);
  assertFound(new Photo(600, 800, turned(0.48, 0.5, 0.58, 0.72, -10, 600, 800), { paper: 232, desk: grain, shadow: 10, noise: 8, seed: 5 }));
});

await test('PageOutline: finds a white page on a pale blue desk by its colour', () => {
  const photo = new Photo(600, 800, corners(0.2, 0.15, 0.8, 0.13, 0.82, 0.86, 0.18, 0.84), { paper: 232, deskColour: [214, 237, 255], noise: 5, seed: 6 });
  assertFound(photo);
  // Its brightness alone doesn't show it.
  const rgba = photo.rgba();
  const luma = new Uint8Array(photo.width * photo.height);
  for (let i = 0; i < luma.length; i++) luma[i] = (rgba[4 * i] * 77 + rgba[4 * i + 1] * 150 + rgba[4 * i + 2] * 29) >> 8;
  const grey = findPageInLuma(luma, photo.width, photo.height);
  assert(grey == null || !grey.confident, 'in grey ' + JSON.stringify(grey));
});

await test('PageOutline: lines on a bare light table are not a page', () => {
  const grout = (at, period) => (((at % period) + period) % period) < 6;
  const tiles = (x, y) => (grout(x * 600 - 24, 270) || grout(y * 800 - 80, 330) ? 150 : 226);
  assertNotConfident(new Photo(600, 800, NO_PAGE, { desk: tiles, noise: 6 }));
});

await test('PageOutline: the search is quick on a busy photo', () => {
  const busy = (x, y) => (y > 0.8 && y < 0.98 && x > 0.04 && x < 0.96 && (x * 30) % 1 < 0.8 && (y * 40) % 1 < 0.8 ? 50 : 215);
  const photo = new Photo(1200, 1600, turned(0.5, 0.4, 0.55, 0.6, 7, 1200, 1600), { paper: 236, desk: busy, shadow: 16, noise: 8 });
  const luma = photo.luma();
  findPageInLuma(luma, photo.width, photo.height);
  const started = performance.now();
  const outline = findPageInLuma(luma, photo.width, photo.height);
  const millis = performance.now() - started;
  assert(millis < 400, millis + ' ms');
  assert(outline && outline.confident, JSON.stringify(outline));
});

await test('PageOutline: the search stays quick with straight edges every way', () => {
  const size = 800;
  const random = new KotlinRandom(2);
  const sticks = new Uint8Array(size * size).fill(224);
  for (let k = 0; k < 180; k++) {
    const angle = random.nextDoubleIn(0, Math.PI);
    const cx = random.nextDoubleIn(0, size);
    const cy = random.nextDoubleIn(0, size);
    for (let step = -240; step <= 240; step++) {
      for (let across = -1; across <= 1; across++) {
        const x = Math.round(cx + step * 0.5 * Math.cos(angle) - across * Math.sin(angle));
        const y = Math.round(cy + step * 0.5 * Math.sin(angle) + across * Math.cos(angle));
        if (x >= 0 && x < size && y >= 0 && y < size) sticks[y * size + x] = 40;
      }
    }
  }
  const plainPage = new Photo(size, size, corners(0.2, 0.15, 0.8, 0.15, 0.8, 0.85, 0.2, 0.85)).luma();
  // The quickest of a few runs once the JIT has compiled the search for both, counted in this
  // process's processor time, as the app's test counts its thread's: on a busy machine the clock
  // also counts the time other work takes the processor away.
  const cpu = () => {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  };
  for (let i = 0; i < 4; i++) {
    findPageInLuma(plainPage, size, size);
    findPageInLuma(sticks, size, size);
  }
  const millis = (luma) => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = cpu();
      for (let i = 0; i < 5; i++) findPageInLuma(luma, size, size);
      best = Math.min(best, cpu() - started);
    }
    return best;
  };
  const plain = millis(plainPage);
  const busy = millis(sticks);
  assert(busy <= 3 * Math.max(plain, 50), `${busy} ms, a plain page ${plain} ms, five searches each`);
});

await test('PageOutline: a size too large to count is refused', () => {
  let threw = false;
  try {
    findPage(new Uint8ClampedArray(65536 * 4), 65536, 65537);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, 'refused');
});

await test('PageOutline: a keyboard is not a page', () => {
  const keys = (x, y) => {
    const column = (x - 0.08) / 0.07;
    const row = (y - 0.3) / 0.075;
    return column >= 0 && column <= 12 && row >= 0 && row <= 5 && column % 1 < 0.8 && row % 1 < 0.8 ? 50 : 215;
  };
  assertNotConfident(new Photo(800, 600, NO_PAGE, { desk: keys, noise: 6 }));
});

const polygonArea = (points) => {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
};

await test('PageOutline: the largest quadrilateral on a hull is found', () => {
  const random = new KotlinRandom(7);
  for (let k = 0; k < 40; k++) {
    const n = random.nextIntIn(5, 30);
    const angles = Array.from({ length: n }, () => random.nextDoubleIn(0, 2 * Math.PI)).sort((a, b) => a - b);
    const points = angles.map((a) => ({ x: Math.fround(100 + 80 * Math.cos(a)), y: Math.fround(100 + 50 * Math.sin(a)) }));
    const hull = convexHull(points);
    if (hull.length < 5) continue;
    const fast = polygonArea(largestQuad(hull).map((i) => hull[i % hull.length]));
    let best = 0;
    for (let a = 0; a < hull.length; a++) for (let b = a + 1; b < hull.length; b++) for (let c = b + 1; c < hull.length; c++) for (let d = c + 1; d < hull.length; d++) {
      best = Math.max(best, polygonArea([hull[a], hull[b], hull[c], hull[d]]));
    }
    near(fast, best, best * 1e-6, 'area');
  }
});

await test('PageOutline: Otsu splits two shades', () => {
  const t = otsu(Int32Array.from({ length: 1000 }, (_, i) => (i < 600 ? 60 + (i % 7) : 200 + (i % 9))));
  assert(t >= 66 && t <= 199, String(t));
  assert(otsu(Int32Array.from({ length: 1000 }, (_, i) => 128 + (i % 3))) === null, 'flat');
});

await test('PageOutline: the search runs on a small copy', () => {
  const small = shrink(Uint8Array.from({ length: 1600 * 1200 }, (_, i) => i % 256), 1600, 1200);
  assert(small.width === 400 && small.height === 300, `${small.width} × ${small.height}`);
  // A size that doesn't divide evenly keeps its last pixels.
  const odd = shrink(new Uint8Array(1001 * 10).fill(9), 1001, 10);
  assert(odd.width === 334, 'odd width ' + odd.width);
  assert(odd.levels[odd.levels.length - 1] === 9, 'last level');
  assert(shrink(new Uint8Array(300 * 200), 300, 200).width === 300, 'small stays');
});

await test('PageOutline: a hostile picture finishes quickly', () => {
  // Noise, stripes and a checkerboard: no crash, no long search.
  const random = new KotlinRandom(11);
  const w = 1000;
  const h = 750;
  for (const make of [() => random.nextIntIn(0, 256), (i) => ((i % w) % 2 ? 0 : 255), (i) => (((i % w) >> 3) + ((i / w) >> 3)) % 2 * 255]) {
    const luma = Uint8Array.from({ length: w * h }, (_, i) => make(i));
    const started = performance.now();
    findPageInLuma(luma, w, h);
    assert(performance.now() - started < 1500, 'took ' + (performance.now() - started) + ' ms');
  }
});

// What a file says about its picture, and its metadata taken out.
await test('Image info: EXIF orientation, date taken and size, from JPEG, PNG and WebP', () => {
  const sof = segment(0xc0, Uint8Array.of(8, 0x01, 0x2c, 0x01, 0x90, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1));
  const jpeg = cat(Uint8Array.of(0xff, 0xd8), exifSegment({ orientation: 6 }), sof, Uint8Array.of(0xff, 0xd9));
  const info = readImageInfo(jpeg, 'jpeg');
  assert(info.width === 400 && info.height === 300, `size ${info.width} × ${info.height}`);
  assert(info.orientation === 6, 'orientation ' + info.orientation);
  assert(info.taken && info.taken.getFullYear() === 2023 && info.taken.getMonth() === 6 && info.taken.getDate() === 14 &&
    info.taken.getHours() === 9 && info.taken.getMinutes() === 8 && info.taken.getSeconds() === 7, 'taken ' + info.taken);
  const ihdr = pngChunk('IHDR', Uint8Array.of(0, 0, 0, 20, 0, 0, 0, 10, 8, 6, 0, 0, 0));
  const png = cat(Uint8Array.of(0x89, 80, 78, 71, 13, 10, 26, 10), ihdr, pngChunk('eXIf', tiffExif({ orientation: 3 })), pngChunk('IEND', new Uint8Array(0)));
  const pngInfo = readImageInfo(png, 'png');
  assert(pngInfo.width === 20 && pngInfo.height === 10 && pngInfo.orientation === 3 && pngInfo.alpha, JSON.stringify(pngInfo));
  const vp8x = webpChunk('VP8X', 10, 0x08);
  vp8x.set([99, 0, 0, 49, 0, 0], 12);
  const exifChunk = cat(bytesOf('EXIF'), new Uint8Array(4), tiffExif({ orientation: 8 }));
  new DataView(exifChunk.buffer).setUint32(4, exifChunk.length - 8, true);
  const w = readImageInfo(webp(vp8x, exifChunk), 'webp');
  assert(w.width === 100 && w.height === 50 && w.orientation === 8, JSON.stringify(w));
});

await test('Image info: HEIC and AVIF turned by a property of their own', async () => {
  for (const name of ['turned.heic', 'turned.avif']) {
    const b = new Uint8Array(await fixture('images/' + name));
    const info = readImageInfo(b, name.endsWith('heic') ? 'heif' : 'avif');
    assert(info.width === 128 && info.height === 64, name + ' size');
    assert(info.turnedByFile && info.orientation === 1, name + ' turned by the file, its EXIF not counted');
  }
  assert(readImageInfo(new Uint8Array(await fixture('images/turned.heic')), 'heif').exifAt > 0, 'the HEIC has EXIF');
});

await test('Image info: damaged and crafted headers give what can be read, quickly', async () => {
  const random = new KotlinRandom(5);
  const started = performance.now();
  for (const name of ['turned.heic', 'turned.avif', 'photo.webp', 'clear.webp', 'drawing.gif', 'drawing.bmp']) {
    const good = new Uint8Array(await fixture('images/' + name));
    const type = imageFileType(good);
    for (let k = 0; k < 300; k++) {
      const b = good.slice(0, random.nextIntIn(0, good.length + 1));
      for (let m = 0; m < 6; m++) if (b.length) b[random.nextIntIn(0, b.length)] = random.nextIntIn(0, 256);
      const info = readImageInfo(b, type);
      assert(info.orientation >= 1 && info.orientation <= 8, 'orientation');
      withoutExifOrientation(b, type, info);
      strippedJpeg(b);
      strippedPng(b);
    }
  }
  // A JPEG whose segments claim huge lengths, a PNG claiming a gigantic size.
  assert(strippedJpeg(cat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff), new Uint8Array(10))) === null, 'jpeg cut short');
  const huge = readImageInfo(cat(Uint8Array.of(0x89, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', Uint8Array.of(0, 0, 0xea, 0x60, 0, 0, 0xea, 0x60, 8, 2, 0, 0, 0))), 'png');
  assert(huge.width === 60000 && huge.height === 60000, 'size read');
  assert(performance.now() - started < 3000, 'quick');
});

await test('Metadata: a JPEG keeps its picture and colour profile, and loses EXIF, XMP, comments and a motion photo\'s video', () => {
  const sof = segment(0xc0, Uint8Array.of(8, 0, 16, 0, 16, 1, 1, 0x11, 0));
  const scan = cat(segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)), Uint8Array.of(1, 2, 0xff, 0, 3, 0xff, 0xd0, 4));
  const jfif = segment(0xe0, bytesOf('JFIF\0\x01\x02\0\0\x01\0\x01\0\0'));
  const jpeg = cat(Uint8Array.of(0xff, 0xd8), jfif, exifSegment(), xmpSegment(), iccSegment(), commentSegment(), sof, scan, Uint8Array.of(0xff, 0xd9), motionVideo());
  const out = strippedJpeg(jpeg);
  assert(out, 'stripped');
  for (const hidden of ['Exif', 'Pixel', 'xap/1.0', 'GPS', 'Shot on', 'ftyp']) assert(!contains(out, hidden), 'still has ' + hidden);
  assert(contains(out, 'ICC_PROFILE') && contains(out, 'JFIF'), 'colour profile and JFIF kept');
  const expected = cat(Uint8Array.of(0xff, 0xd8), jfif, iccSegment(), sof, scan, Uint8Array.of(0xff, 0xd9));
  assert(Buffer.from(out).equals(Buffer.from(expected)), 'the picture byte for byte');
});

await test('Metadata: a PNG keeps its picture and loses its text, EXIF and time', () => {
  const ihdr = pngChunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0));
  const idat = pngChunk('IDAT', Uint8Array.of(0x78, 1, 1, 4, 0, 0xfb, 0xff, 0, 0xff, 0, 0, 3, 0, 1));
  const png = cat(Uint8Array.of(0x89, 80, 78, 71, 13, 10, 26, 10), ihdr, pngChunk('tEXt', bytesOf('Comment\0at home, 48.85N')),
    pngChunk('eXIf', tiffExif()), pngChunk('tIME', new Uint8Array(7)), pngChunk('iTXt', bytesOf('XML:com.adobe.xmp\0\0\0\0\0GPS')), pngChunk('sRGB', Uint8Array.of(0)), idat, pngChunk('IEND', new Uint8Array(0)), bytesOf('trailing'));
  const out = strippedPng(png);
  for (const hidden of ['tEXt', 'eXIf', 'tIME', 'iTXt', 'GPS', 'trailing', 'at home']) assert(!contains(out, hidden), 'still has ' + hidden);
  assert(contains(out, 'sRGB') && contains(out, 'IDAT') && contains(out, 'IEND'), 'picture kept');
});

await test('Metadata: EXIF orientation can be hidden from decoders, and the PNG stays valid', () => {
  const jpeg = cat(Uint8Array.of(0xff, 0xd8), exifSegment({ orientation: 6 }), Uint8Array.of(0xff, 0xd9));
  const info = readImageInfo(jpeg, 'jpeg');
  const hidden = withoutExifOrientation(jpeg, 'jpeg', info);
  assert(readImageInfo(hidden, 'jpeg').orientation === 1 && jpeg.length === hidden.length, 'jpeg');
  const ihdr = pngChunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0));
  const png = cat(Uint8Array.of(0x89, 80, 78, 71, 13, 10, 26, 10), ihdr, pngChunk('eXIf', tiffExif({ orientation: 3 })), pngChunk('IEND', new Uint8Array(0)));
  const pngHidden = withoutExifOrientation(png, 'png', readImageInfo(png, 'png'));
  assert(readImageInfo(pngHidden, 'png').orientation === 1, 'png orientation hidden');
  // Its checksum was made again.
  const at = 8 + 25;
  const length = new DataView(pngHidden.buffer).getUint32(at);
  const crc = new DataView(pngHidden.buffer).getUint32(at + 8 + length);
  assert(crc === zlib.crc32(pngHidden.subarray(at + 4, at + 8 + length)), 'crc');
});

await test('Names: a photo without a name is named by when it was taken', () => {
  const taken = new Date(2024, 4, 1, 13, 45, 12);
  for (const n of ['image.jpg', 'image (2).jpg', '1000000163.jpg', '1714567890123.jpeg', 'IMAGE.PNG', '', '1000000163']) assert(isUnnamedPhoto(n), n);
  for (const n of ['IMG_2041.HEIC', 'Scan_20240501_134512.jpg', 'holiday.png', 'image of a cat.jpg', 'PXL_20240501_134512345.jpg']) assert(!isUnnamedPhoto(n), n);
  assert(photoName('1000000163.jpg', taken) === 'Photo_20240501_134512.jpg', photoName('1000000163.jpg', taken));
  assert(photoName('image.HEIC', taken) === 'Photo_20240501_134512.HEIC', 'extension kept');
  assert(photoName('1000000163', taken) === 'Photo_20240501_134512', 'no extension');
  assert(photoName('IMG_2041.HEIC', taken) === 'IMG_2041.HEIC', 'a real name stays');
  assert(photoName('folder/receipt.jpg', taken) === 'receipt.jpg', 'last path part');
  assert(photoName('image.jpg', null, new Date(2025, 0, 2, 3, 4, 5)) === 'Photo_20250102_030405.jpg', 'else now');
});

// =====================================================================================
// Browsers
// =====================================================================================

/** Loads the engine in the page, with helpers for passing bytes and reading pixels. */
async function setUp(page, url) {
  await page.goto(url + 'app/js/engine/images/image-type.js');
  await page.evaluate(async (base) => {
    window.fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    window.toB64 = (b) => {
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    };
    window.canvasOf = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    window.encode = async (canvas, type, quality) => new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, type, quality))).arrayBuffer());
    window.pixels = async (bytes, type) => {
      const b = await createImageBitmap(new Blob([bytes], { type }));
      const c = canvasOf(b.width, b.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(b, 0, 0);
      const data = g.getImageData(0, 0, b.width, b.height).data;
      return { width: b.width, height: b.height, data, at: (x, y) => Array.from(data.subarray(4 * (y * b.width + x), 4 * (y * b.width + x) + 4)) };
    };
    // A picture in four colours, top-left red, top-right green, bottom-left blue, bottom-right yellow.
    window.quarters = (w, h) => {
      const c = canvasOf(w, h);
      const g = c.getContext('2d');
      const colours = ['#f00', '#0f0', '#00f', '#ff0'];
      [[0, 0], [w / 2, 0], [0, h / 2], [w / 2, h / 2]].forEach(([x, y], i) => {
        g.fillStyle = colours[i];
        g.fillRect(x, y, w / 2, h / 2);
      });
      return c;
    };
    window.colourName = ([r, g, b]) => (r > 180 && g < 80 && b < 80 ? 'red' : r < 80 && g > 180 && b < 80 ? 'green' : r < 80 && g < 80 && b > 180 ? 'blue' : r > 180 && g > 180 && b < 80 ? 'yellow' : `${r},${g},${b}`);
    window.D = await import(base + 'decode.js');
    window.C = await import(base + 'crop.js');
    window.E = await import(base + '../../core/errors.js');
  }, new URL('app/js/engine/images/', url).href);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function browserTests(browser) {
  console.log(`\n${browser}`);
  await withPage(async (page, url, context) => {
    const workers = [];
    const requests = [];
    page.on('worker', (w) => workers.push(w.url()));
    context.on('request', (r) => requests.push(r.url()));
    await setUp(page, url);
    const avif = await page.evaluate(() => D.canDecodeAvif());

    await test(`${browser}: libheif is loaded only for a HEIC photo`, async () => {
      for (const name of ['photo.webp', 'drawing.gif']) {
        const status = await page.evaluate(async ({ name, data }) => (await D.importImage({ name, bytes: fromB64(data) })).status, { name, data: b64(await fixture('images/' + name)) });
        assert(status === 'added', name);
      }
      assert(!requests.some((u) => u.includes('libheif')), 'libheif fetched for other images');
    });

    // ImageTypesDeviceTest: HEIC, AVIF, WebP, BMP and GIF stored as JPEG or PNG, upright.
    await test(`${browser}: the app's test images are stored as JPEG or PNG, upright`, async () => {
      const expected = {
        'turned.heic': { format: 'jpeg', size: '64x128', red: [59, 4] },
        'turned.avif': { format: 'jpeg', size: '64x128', red: [59, 4] },
        'photo.webp': { format: 'jpeg', size: '128x64', red: [4, 4] },
        'clear.webp': { format: 'png', size: '128x64', red: [4, 4], clear: [100, 50] },
        'drawing.gif': { format: 'png', size: '128x64', red: [4, 4] },
        'drawing.bmp': { format: 'png', size: '128x64', red: [4, 4] },
      };
      for (const [name, want] of Object.entries(expected)) {
        const got = await page.evaluate(async ({ name, data, want }) => {
          const r = await D.importImage({ name, bytes: fromB64(data), lastModified: 0 });
          if (r.status !== 'added') return { status: r.status };
          const im = r.image;
          const px = await pixels(im.bytes, im.type);
          return {
            status: r.status, name: im.name, format: im.format, type: im.type, size: `${im.width}x${im.height}`, decoded: `${px.width}x${px.height}`,
            red: px.at(...want.red), clear: want.clear ? px.at(...want.clear) : null, sourceType: im.sourceType,
          };
        }, { name, data: b64(await fixture('images/' + name)), want });
        if (name.endsWith('.avif') && !avif) {
          // This browser has no AVIF decoder (WebKit on Windows): skipped as the app skips it
          // on Android 11, with a message naming the types this browser reads.
          assert(got.status === 'unsupported', `${name}: ${got.status}`);
          continue;
        }
        assert(got.status === 'added', `${name}: ${got.status}`);
        assert(got.format === want.format && got.type === 'image/' + want.format, `${name}: stored as ${got.format}`);
        assert(got.size === want.size && got.decoded === want.size, `${name}: ${got.size}, decoded ${got.decoded}`);
        assert(got.red[0] > 180 && got.red[1] < 80, `${name}: red in the stored top-left corner, now at ${want.red}: ${got.red}`);
        if (want.clear) assert(got.clear[3] === 0, `${name}: transparency kept ${got.clear}`);
        assert(got.name === name, 'name');
      }
    });

    await test(`${browser}: HEIC photos are decoded by libheif in a worker where the browser can't`, async () => {
      const native = await page.evaluate(async (data) => {
        try {
          (await createImageBitmap(new Blob([fromB64(data)], { type: 'image/heic' }))).close();
          return true;
        } catch {
          return false;
        }
      }, b64(await fixture('images/turned.heic')));
      if (!native) {
        assert(workers.some((w) => w.endsWith('/heif-worker.js')), 'heif worker started: ' + workers.join(', '));
        assert(requests.some((u) => u.endsWith('/vendor/libheif/libheif-bundle.mjs')), 'libheif loaded from this site');
      }
      // Cut short, it can't be read: no hang, no crash.
      const cut = await page.evaluate(async (data) => (await D.importImage({ name: 'cut.heic', bytes: fromB64(data).slice(0, 500) })).status, b64(await fixture('images/turned.heic')));
      assert(cut === 'failed', 'cut short: ' + cut);
    });

    await test(`${browser}: a TIFF, a damaged JPEG and a crafted PNG are left out with the app's messages`, async () => {
      const got = await page.evaluate(async () => {
        const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0, ...new Array(60).fill(0)]);
        const damaged = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(400).fill(0x5a)]);
        // A PNG claiming 60000 × 60000 pixels: not decoded at all.
        const crafted = Uint8Array.from([0x89, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0xea, 0x60, 0, 0, 0xea, 0x60, 8, 2, 0, 0, 0, 0, 0, 0, 0]);
        const started = performance.now();
        const r = await D.importImages([{ name: 'scan.tiff', bytes: tiff }, { name: 'a.jpg', bytes: damaged }, { name: 'b.png', bytes: crafted }]);
        return { images: r.images.length, unsupported: r.unsupported, failed: r.failed, messages: r.messages, ms: performance.now() - started };
      });
      assert(got.images === 0 && got.unsupported === 1 && got.failed === 2, JSON.stringify(got));
      const unsupportedKey = avif ? 'msg_skipped_unsupported' : 'web_skipped_unsupported_no_avif';
      assert(JSON.stringify(got.messages) === JSON.stringify([{ key: unsupportedKey, count: 1 }, { key: 'msg_failed_import', count: 2 }]), JSON.stringify(got.messages));
      assert(got.ms < 3000, 'quick: ' + got.ms);
    });

    await test(`${browser}: every EXIF orientation comes out upright, with no metadata left`, async () => {
      for (let orientation = 1; orientation <= 8; orientation++) {
        const exif = b64(exifSegment({ orientation }));
        const extra = b64(cat(xmpSegment(), commentSegment()));
        const video = b64(motionVideo());
        const got = await page.evaluate(async ({ exif, extra, video }) => {
          const jpeg = await encode(quarters(160, 100), 'image/jpeg', 0.95);
          const bytes = new Uint8Array([...jpeg.subarray(0, 2), ...fromB64(exif), ...fromB64(extra), ...jpeg.subarray(2), ...fromB64(video)]);
          const r = await D.importImage({ name: 'image.jpg', bytes, lastModified: 0 });
          const im = r.image;
          const px = await pixels(im.bytes, im.type);
          const text = String.fromCharCode(...im.bytes);
          const w = px.width;
          const h = px.height;
          return {
            name: im.name, size: `${im.width}x${im.height}`, decoded: `${w}x${h}`, format: im.format,
            tl: colourName(px.at(5, 5)), tr: colourName(px.at(w - 6, 5)), bl: colourName(px.at(5, h - 6)), br: colourName(px.at(w - 6, h - 6)),
            hidden: ['Exif', 'Pixel', 'xap/1.0', 'Shot on', 'ftyp'].filter((s) => text.includes(s)),
            ends: Array.from(im.bytes.subarray(-2)),
          };
        }, { exif, extra, video });
        // Where the stored top-left (red) and top-right (green) corners show (ImageTransformTest).
        const lands = { 1: ['tl', 'tr'], 2: ['tr', 'tl'], 3: ['br', 'bl'], 4: ['bl', 'br'], 5: ['tl', 'bl'], 6: ['tr', 'br'], 7: ['br', 'tr'], 8: ['bl', 'tl'] }[orientation];
        const size = orientation >= 5 ? '100x160' : '160x100';
        assert(got.size === size && got.decoded === size, `orientation ${orientation}: ${got.size}, decoded ${got.decoded}`);
        assert(got[lands[0]] === 'red' && got[lands[1]] === 'green', `orientation ${orientation}: ${JSON.stringify(got)}`);
        assert(got.hidden.length === 0, `orientation ${orientation}: still has ${got.hidden}`);
        assert(got.ends.join() === '255,217', `orientation ${orientation}: ends ${got.ends}`);
        assert(got.name === 'Photo_20230714_090807.jpg', `orientation ${orientation}: named ${got.name}`);
        assert(got.format === 'jpeg', 'jpeg');
      }
    });

    await test(`${browser}: an upright JPEG is kept as it is, less its metadata`, async () => {
      const got = await page.evaluate(async ({ exif }) => {
        const jpeg = await encode(quarters(160, 100), 'image/jpeg', 0.9);
        const bytes = new Uint8Array([...jpeg.subarray(0, 2), ...fromB64(exif), ...jpeg.subarray(2)]);
        const im = (await D.importImage({ name: 'IMG_0001.JPG', bytes })).image;
        const a = await pixels(jpeg, 'image/jpeg');
        const b = await pixels(im.bytes, im.type);
        let same = a.data.length === b.data.length;
        for (let i = 0; same && i < a.data.length; i++) same = a.data[i] === b.data[i];
        return { same, length: im.bytes.length, original: jpeg.length, name: im.name, exif: String.fromCharCode(...im.bytes).includes('Exif') };
      }, { exif: b64(exifSegment({ orientation: 1 })) });
      assert(got.same, 'the same pixels');
      assert(got.length === got.original && !got.exif, `${got.length} bytes, the JPEG had ${got.original}`);
      assert(got.name === 'IMG_0001.JPG', 'name');
    });

    await test(`${browser}: a PNG turned by EXIF is stored upright as a PNG, without its text`, async () => {
      const got = await page.evaluate(async ({ chunks }) => {
        const png = await encode(quarters(160, 100), 'image/png');
        const extra = fromB64(chunks);
        const bytes = new Uint8Array([...png.subarray(0, 33), ...extra, ...png.subarray(33)]);
        const im = (await D.importImage({ name: 'drawing.png', bytes })).image;
        const px = await pixels(im.bytes, im.type);
        const text = String.fromCharCode(...im.bytes);
        return { format: im.format, size: `${im.width}x${im.height}`, tl: colourName(px.at(5, 5)), tr: colourName(px.at(px.width - 6, 5)), hidden: ['tEXt', 'eXIf', 'at home'].filter((s) => text.includes(s)) };
      }, { chunks: b64(cat(pngChunk('eXIf', tiffExif({ orientation: 3 })), pngChunk('tEXt', bytesOf('Comment\0at home')))) });
      assert(got.format === 'png' && got.size === '160x100', JSON.stringify(got));
      assert(got.tl === 'yellow' && got.tr === 'blue', 'turned round ' + JSON.stringify(got));
      assert(!got.hidden.length, 'still has ' + got.hidden);
    });

    await test(`${browser}: a very large photo is stored at half its size`, async () => {
      const got = await page.evaluate(async () => {
        // 6400 × 4200 = 26.9 megapixels, more than the 25 kept.
        const jpeg = await encode(quarters(6400, 4200), 'image/jpeg', 0.8);
        const r = await D.importImage({ name: 'big.jpg', bytes: jpeg });
        if (r.status !== 'added') return { status: r.status };
        const im = r.image;
        const px = await pixels(im.bytes, im.type);
        return { status: r.status, size: `${im.width}x${im.height}`, decoded: `${px.width}x${px.height}`, tl: colourName(px.at(10, 10)), br: colourName(px.at(px.width - 10, px.height - 10)) };
      });
      assert(got.status === 'added', got.status);
      assert(got.size === '3200x2100' && got.decoded === '3200x2100', JSON.stringify(got));
      assert(got.tl === 'red' && got.br === 'yellow', JSON.stringify(got));
    });

    // CropDeviceTest
    const photo = pagePhoto();
    const photoArgs = { data: b64(new Uint8Array(photo.buffer)), w: PAGE_PHOTO.PHOTO_WIDTH, h: PAGE_PHOTO.PHOTO_HEIGHT };
    await page.evaluate(async ({ data, w, h }) => {
      const c = canvasOf(w, h);
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(fromB64(data).buffer), w, h), 0, 0);
      window.pagePhoto = c;
      window.pagePhotoJpeg = await encode(c, 'image/jpeg', 0.92);
      // The same photo stored a quarter turn anticlockwise, with EXIF saying to turn it clockwise.
      const s = canvasOf(h, w);
      const g = s.getContext('2d');
      g.translate(0, w);
      g.rotate(-Math.PI / 2);
      g.drawImage(c, 0, 0);
      window.sidewaysJpeg = await encode(s, 'image/jpeg', 0.92);
    }, photoArgs);

    /** The straightened page is the test page: its shape, the corner squares' colours, its middle line straight. */
    const assertStraightPage = async (what, pageBytes, type, width, height) => {
      const got = await page.evaluate(async ({ data, type, width, height }) => {
        const px = await pixels(fromB64(data), type);
        const inX = Math.round(70 * width / 700 / 2);
        const inY = Math.round(70 * height / 990 / 2);
        const spots = [[inX, inY], [width - inX, inY], [width - inX, height - inY], [inX, height - inY]].map(([x, y]) => px.at(x, y));
        const lines = [0.25, 0.5, 0.75].map((f) => {
          const x = Math.round(width * f);
          let darkest = 0;
          let level = 999;
          for (let y = Math.round(height * 2 / 5); y < height * 3 / 5; y++) {
            const v = px.at(x, y)[0];
            if (v < level) {
              level = v;
              darkest = y;
            }
          }
          return darkest;
        });
        return { width: px.width, height: px.height, spots, lines };
      }, { data: b64(pageBytes), type, width, height });
      assert(got.width === width && got.height === height, `${what}: decoded ${got.width} × ${got.height}`);
      near(width / height, 700 / 990, 0.03, `${what}: shape`);
      PAGE_PHOTO.MARKS.forEach((mark, i) => {
        assert(mark.every((v, c) => Math.abs(v - got.spots[i][c]) <= 45), `${what}: corner ${i} ${got.spots[i]}, expected ${mark}`);
      });
      for (const y of got.lines) near(y, height / 2, height * 0.01, `${what}: middle line`);
    };

    await test(`${browser}: the page is found on a photo (in a worker), and not on the table alone`, async () => {
      const got = await page.evaluate(async () => {
        const im = (await D.importImage({ name: 'photo.jpg', bytes: pagePhotoJpeg })).image;
        const outline = await C.findPageOnImage(im);
        const table = canvasOf(1200, 1600);
        const g = table.getContext('2d');
        g.drawImage(pagePhoto, 0, 0, 150, 200, 0, 0, 1200, 1600);
        const tableImage = (await D.importImage({ name: 'table.jpg', bytes: await encode(table, 'image/jpeg', 0.92) })).image;
        return { outline, nothing: await C.findPageOnImage(tableImage) };
      });
      assert(got.outline?.confident, 'confidence ' + got.outline?.confidence);
      for (let i = 0; i < 4; i++) {
        const dx = (got.outline.quad[i].x - PAGE_PHOTO.QUAD[i].x) * PAGE_PHOTO.PHOTO_WIDTH;
        const dy = (got.outline.quad[i].y - PAGE_PHOTO.QUAD[i].y) * PAGE_PHOTO.PHOTO_HEIGHT;
        assert(Math.hypot(dx, dy) < 0.012 * PAGE_PHOTO.PHOTO_HEIGHT, `corner ${i} at ${JSON.stringify(got.outline.quad[i])}`);
      }
      assert(got.nothing == null || !got.nothing.confident, 'the table: ' + JSON.stringify(got.nothing));
      assert(workers.some((w) => w.endsWith('/outline-worker.js')), 'the search ran in a worker: ' + workers.join(', '));
    });

    for (const gpu of [true, false]) {
      const how = gpu ? 'on the graphics processor' : 'in typed arrays';
      await test(`${browser}: the cropped page is straight, ${how}`, async () => {
        const got = await page.evaluate(async ({ gpu, quad }) => {
          C.setGpuWarp(gpu);
          const im = (await D.importImage({ name: 'photo.jpg', bytes: pagePhotoJpeg })).image;
          const p = await C.cropImage(im, quad);
          return { ...p, bytes: toB64(p.bytes), expected: C.outputSize(quad, im.width, im.height), exif: String.fromCharCode(...p.bytes).includes('Exif'), onGpu: C.warpsOnGpu() };
        }, { gpu, quad: PAGE_PHOTO.QUAD });
        if (gpu && !got.onGpu) console.log('       (no WebGL 2 here: typed arrays both times)');
        assert(`${got.width},${got.height}` === String(got.expected), `size ${got.width} × ${got.height}, expected ${got.expected}`);
        assert(got.format === 'jpeg' && got.type === 'image/jpeg' && !got.exif, 'a JPEG without metadata');
        await assertStraightPage('photo', Buffer.from(got.bytes, 'base64'), got.type, got.width, got.height);
      });

      await test(`${browser}: a photo stored sideways is found and cropped as it shows, ${how}`, async () => {
        const got = await page.evaluate(async ({ gpu, quad, exif }) => {
          C.setGpuWarp(gpu);
          const bytes = new Uint8Array([...sidewaysJpeg.subarray(0, 2), ...fromB64(exif), ...sidewaysJpeg.subarray(2)]);
          const im = (await D.importImage({ name: 'sideways.jpg', bytes })).image;
          const outline = await C.findPageOnImage(im);
          const p = await C.cropImage(im, quad);
          const text = String.fromCharCode(...p.bytes);
          return { size: `${im.width}x${im.height}`, outline, page: { ...p, bytes: toB64(p.bytes) }, hidden: ['Exif', 'GPS', 'Pixel'].filter((s) => text.includes(s)) };
        }, { gpu, quad: PAGE_PHOTO.QUAD, exif: b64(exifSegment({ orientation: 6 })) });
        assert(got.size === '1200x1600', 'upright ' + got.size);
        assert(got.outline?.confident && Q.isCloseTo(got.outline.quad, PAGE_PHOTO.QUAD, 0.012), 'found where it shows ' + JSON.stringify(got.outline));
        await assertStraightPage('sideways', Buffer.from(got.page.bytes, 'base64'), got.page.type, got.page.width, got.page.height);
        assert(!got.hidden.length, 'no location or camera: ' + got.hidden);
      });

      await test(`${browser}: a PNG stays a PNG and a large photo is shrunk, ${how}`, async () => {
        const got = await page.evaluate(async ({ gpu, quad }) => {
          C.setGpuWarp(gpu);
          const png = (await D.importImage({ name: 'page.png', bytes: await encode(pagePhoto, 'image/png') })).image;
          const p = await C.cropImage(png, quad);
          // A 17-megapixel photo: the page comes out at most 3000 pixels long.
          const big = canvasOf(3600, 4800);
          big.getContext('2d').drawImage(pagePhoto, 0, 0, 3600, 4800);
          const large = (await D.importImage({ name: 'big.jpg', bytes: await encode(big, 'image/jpeg', 0.92) })).image;
          const l = await C.cropImage(large, quad);
          return { png: { ...p, bytes: toB64(p.bytes), magic: Array.from(p.bytes.subarray(0, 4)) }, large: { ...l, bytes: toB64(l.bytes) } };
        }, { gpu, quad: PAGE_PHOTO.QUAD });
        assert(got.png.format === 'png' && got.png.magic.join() === '137,80,78,71', 'a PNG');
        await assertStraightPage('png', Buffer.from(got.png.bytes, 'base64'), got.png.type, got.png.width, got.png.height);
        assert(Math.max(got.large.width, got.large.height) === 3000, `${got.large.width} × ${got.large.height}`);
        await assertStraightPage('large', Buffer.from(got.large.bytes, 'base64'), got.large.type, got.large.width, got.large.height);
      });
    }

    await test(`${browser}: a see-through PNG keeps its transparency when cropped`, async () => {
      const got = await page.evaluate(async () => {
        C.setGpuWarp(true);
        const c = canvasOf(200, 200);
        const g = c.getContext('2d');
        g.fillStyle = '#c00';
        g.fillRect(50, 50, 100, 100);
        const im = (await D.importImage({ name: 'clear.png', bytes: await encode(c, 'image/png') })).image;
        const p = await C.cropImage(im, C.quadOf(0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9));
        const px = await pixels(p.bytes, p.type);
        return { format: p.format, corner: px.at(5, 5), middle: px.at(px.width >> 1, px.height >> 1) };
      });
      assert(got.format === 'png' && got.corner[3] === 0, 'clear corner ' + got.corner);
      assert(got.middle[0] > 180 && got.middle[3] === 255, 'red middle ' + got.middle);
    });

    await test(`${browser}: corners that make no page are refused, and work can be cancelled`, async () => {
      const got = await page.evaluate(async () => {
        const im = (await D.importImage({ name: 'photo.jpg', bytes: pagePhotoJpeg })).image;
        let refused = null;
        try {
          await C.cropImage(im, C.quadOf(0, 0, 1, 1, 1, 0, 0, 1));
        } catch (e) {
          refused = e.key;
        }
        const controller = new AbortController();
        controller.abort();
        let cancelled = null;
        try {
          await C.cropImage(im, C.WHOLE, { signal: controller.signal });
        } catch (e) {
          cancelled = e.name;
        }
        let importCancelled = null;
        try {
          await D.importImage({ name: 'a.jpg', bytes: pagePhotoJpeg }, { signal: controller.signal });
        } catch (e) {
          importCancelled = e.name;
        }
        let unreadable = null;
        try {
          await D.loadImage({ name: 'gone.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), format: 'jpeg', width: 10, height: 10 });
        } catch (e) {
          unreadable = [e.key, ...e.args];
        }
        return { refused, cancelled, importCancelled, unreadable };
      });
      assert(got.refused === 'crop_not_a_page', 'refused ' + got.refused);
      assert(got.cancelled === 'CancelledError' && got.importCancelled === 'CancelledError', JSON.stringify(got));
      assert(got.unreadable?.join() === 'msg_image_unreadable,gone.jpg', 'unreadable ' + got.unreadable);
    });

    await test(`${browser}: previews: an image turned and shrunk, and a page straightened before it is cropped`, async () => {
      const got = await page.evaluate(async ({ quad }) => {
        const im = (await D.importImage({ name: 'photo.jpg', bytes: pagePhotoJpeg })).image;
        const turned = await D.loadImage(im, { maxSide: 800, rotation: 90 });
        const preview = await C.straighten(turned, C.turned(quad, 90), 1000);
        const g = preview.getContext('2d');
        const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
        return { turned: `${turned.width}x${turned.height}`, preview: `${preview.width}x${preview.height}`, red: at(Math.round(preview.width - 25 * preview.width / 990), 15) };
      }, { quad: PAGE_PHOTO.QUAD });
      assert(got.turned === '800x600', 'turned ' + got.turned);
      // Turned a quarter clockwise, the page's top-left (red) corner square is at its top right.
      assert(got.red[0] > 180 && got.red[1] < 80, 'red at the top right ' + got.red);
    });

    if (browser === 'chromium') {
      await test(`${browser}: a 12-megapixel photo is found and cropped quickly`, async () => {
        const got = await page.evaluate(async () => {
          C.setGpuWarp(true);
          const W = 4000;
          const H = 3000;
          const c = canvasOf(W, H);
          const g = c.getContext('2d');
          for (let y = 0; y < H; y += 4) {
            g.fillStyle = `rgb(${96 + 10 * Math.sin(y / 9)},66,42)`;
            g.fillRect(0, y, W, 4);
          }
          g.fillStyle = '#f2f0ea';
          g.beginPath();
          g.moveTo(700, 300); g.lineTo(3300, 420); g.lineTo(3500, 2750); g.lineTo(500, 2650);
          g.closePath();
          g.fill();
          g.fillStyle = '#222';
          for (let i = 0; i < 40; i++) g.fillRect(900, 600 + i * 50, 2200, 14);
          const im = (await D.importImage({ name: 'big.jpg', bytes: await encode(c, 'image/jpeg', 0.9) })).image;
          let t = performance.now();
          const outline = await C.findPageOnImage(im);
          const find = performance.now() - t;
          await C.cropImage(im, outline.quad);
          t = performance.now();
          const p = await C.cropImage(im, outline.quad);
          return { find, crop: performance.now() - t, size: `${p.width}x${p.height}`, confident: outline.confident, gpu: C.warpsOnGpu() };
        });
        console.log(`       found in ${Math.round(got.find)} ms, cropped (${got.size}${got.gpu ? ', WebGL 2' : ''}) in ${Math.round(got.crop)} ms`);
        assert(got.confident, 'found');
        assert(got.crop < 1000, 'cropped in ' + got.crop + ' ms');
        assert(got.find < 1500, 'found in ' + got.find + ' ms');
      });
    }
  }, { browser });
}

if (only !== 'node') {
  for (const browser of only && only !== 'browsers' ? [only] : ['chromium', 'webkit', 'firefox']) await browserTests(browser);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log('FAILED: ' + f.name);
  process.exit(1);
}
