// Builds PDFs from images, always compressed (the app's PdfExporter.kt and ImagePdfBuilder.kt):
// each image is shrunk to the compression level's resolution for the space it fills on its page and
// stored as JPEG, unless keeping the original is smaller. A page with a look of its own, or
// brightness and contrast, is given them at that size and stored as it needs: black and white a bit
// a pixel (CCITT Group 4, or Flate when that is smaller), grey as a one-component JPEG, colour as JPEG.
import { PDFName } from '../../lib/pdf-lib.js';
import { createPdf, savePdf } from '../pdf-common.js';
import { UserError, CancelledError, checkCancelled } from '../../core/errors.js';
import { sanitizeName, baseName, uniqueNames, defaultPdfName } from '../../core/names.js';
import {
  layoutSettings, computeLayout, scaleFor, scaledSize, imagePlacement, pdfNumber, pdfRound,
  imageTransform, swapsAxes, COMPRESSION,
} from './page-layout.js';
import { lookGen, lookAdjustments, isBilevel, isColour, LOOKS } from './looks.js';
import { encodeJpeg, flateRaster, flateBits, isGray } from './encode.js';
import { encodeBitImage } from './ccitt.js';
import {
  parseJpeg, stripJpeg, jpegStrippedSize, jpegIsSrgb, isLossyOpaqueWebp, InvalidJpegError,
} from './jpeg.js';
import { openPageSource, renderShown, release } from './page-source.js';
import { context2d, runAsync, pause } from './canvas.js';

/** The name a PDF gets when its own is blank (PdfExporter.DEFAULT_NAME). */
export const DEFAULT_NAME = 'Usugami';

/** What the PDF's Producer and Creator say: the app's name. */
export const PRODUCER = 'Usugami';

/** At most this many pixels are drawn for a page; a larger one is halved until it fits. */
const MAX_PIXELS = 40_000_000;

/** How many times a page is halved, at most, when the browser runs out of memory for it. */
const MAX_HALVINGS = 5;

/**
 * Makes one PDF of all `pages`, or one PDF per image.
 *
 * @param {Array<{
 *   name: string,
 *   bytes?: Uint8Array,
 *   source?: ImageBitmap|HTMLCanvasElement|OffscreenCanvas|ImageData|HTMLImageElement|(() => Promise<any>),
 *   exifOrientation?: number,
 *   rotation?: number,
 *   look?: string,
 *   brightness?: number,
 *   contrast?: number,
 * }>} pages each image: its file's name and bytes (JPEG, PNG, WebP, GIF, BMP, AVIF, or what else
 *   the browser decodes), or `source`, pixels already decoded (a cropped page, a HEIC photo
 *   decoded elsewhere), or a function giving them, called when the page is made. `exifOrientation`
 *   (1 to 8) is how those pixels are stored: by default read from `bytes`, 1 for a `source`.
 *   `rotation` is the user's clockwise turn (0, 90, 180, 270). `look` is one of LOOKS (default
 *   'original'), `brightness` and `contrast` -100 to 100.
 * @param {{ pageSize?: string, orientation?: string, margin?: string, compression?: string,
 *   merge?: boolean, name?: string, created?: Date }} [settings] pageSize 'fit' | 'a4' | 'letter' |
 *   'legal' | 'a3' | 'a5' (default 'a4'); orientation 'auto' | 'portrait' | 'landscape' (default
 *   'portrait'); margin 'none' | 'small' | 'big' (default 'none'); compression 'less' |
 *   'recommended' | 'extreme' (default 'recommended'); merge: one PDF (default) or one per image;
 *   name: the merged PDF's name (default: the image's own for one, else Usugami_date_time).
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal,
 *   onPage?: (pdfDoc: any, page: any, info: object) => (void | Promise<void>) }} [hooks]
 *   onPage is called once each page is drawn, before the PDF is saved, with pdf-lib's document and
 *   page and the page's info (see docs/api/images-looks.md): text recognition adds its layer there.
 * @returns {Promise<Array<{ name: string, bytes: Uint8Array, type: 'application/pdf',
 *   pageCount: number, originalSize: number, images: object[] }>>}
 */
export async function buildImagesPdf(pages, settings = {}, hooks = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new RangeError('No images to make a PDF of');
  const layout = layoutSettings(settings);
  const compression = settings.compression ?? 'recommended';
  if (!(compression in COMPRESSION)) throw new RangeError(`Unknown compression ${compression}`);
  for (const page of pages) {
    const look = page.look ?? 'original';
    if (!LOOKS.includes(look)) throw new RangeError(`Unknown look ${look}`);
    lookAdjustments(page);
  }
  const options = {
    layout,
    compression,
    signal: hooks.signal,
    onPage: hooks.onPage,
    created: settings.created ?? new Date(),
  };
  const total = pages.length;
  let done = 0;
  const pageDone = () => hooks.onProgress?.(++done, total);
  checkCancelled(options.signal);
  hooks.onProgress?.(0, total);

  // One image always makes one PDF, named as the user typed (as the app's Convert sheet does).
  if (settings.merge !== false || pages.length === 1) {
    const fallback = pages.length === 1 ? baseName(pages[0].name ?? '') : defaultPdfName();
    const name = sanitizeName(settings.name ?? fallback, DEFAULT_NAME);
    return [await writePdf(name, pages, options, pageDone)];
  }
  const names = uniqueNames(pages.map((p) => baseName(p.name ?? '')), DEFAULT_NAME);
  const files = [];
  for (let i = 0; i < pages.length; i++) {
    files.push(await writePdf(names[i], [pages[i]], options, pageDone));
  }
  return files;
}

/** One PDF named `name`, a page for each of `items`. */
async function writePdf(name, items, options, pageDone) {
  const doc = await createPdf();
  const images = [];
  let originalSize = 0;
  for (let index = 0; index < items.length; index++) {
    checkCancelled(options.signal);
    const item = items[index];
    originalSize += item.bytes?.length ?? 0;
    const source = await openSource(item, options);
    try {
      const image = await pageImage(item, source, options);
      checkCancelled(options.signal);
      const { page, placement } = addPage(doc, image, options.layout);
      images.push({ item, placement });
      if (options.onPage) {
        const info = pageInfo(index, item, source, placement, options);
        try {
          await options.onPage(doc, page, info);
        } finally {
          info.close();
        }
      }
    } finally {
      source.close();
    }
    pageDone();
    await pause();
  }
  doc.setTitle(name);
  doc.setCreator(PRODUCER);
  doc.setProducer(PRODUCER);
  doc.setCreationDate(options.created);
  doc.setModificationDate(options.created);
  checkCancelled(options.signal);
  const bytes = await savePdf(doc);
  return { name: `${name}.pdf`, bytes, type: 'application/pdf', pageCount: items.length, originalSize, images };
}

/**
 * The page's image opened, an unreadable one reported by its name: decoded no larger than the page
 * needs (at the nearest larger power-of-two reduction, as Android decodes it), or `whole`.
 */
async function openSource(item, options, { whole = false } = {}) {
  const sizeHint = whole ? null : (width, height, exif) => {
    const t = imageTransform(exif, item.rotation ?? 0);
    const [sw, sh] = swapsAxes(t) ? [height, width] : [width, height];
    return scaledSize(width, height, scaleFor(sw, sh, options.layout, options.compression));
  };
  try {
    return await openPageSource(item, { sizeHint });
  } catch (e) {
    if (e instanceof UserError || e instanceof CancelledError) throw e;
    throw new UserError('msg_image_unreadable', item.name);
  }
}

/** What onPage is told about a page: where its image sits, and the original image to read text from. */
function pageInfo(index, item, source, placement, options) {
  let open = true;
  return {
    index,
    item,
    placement,
    geometry: placement.geometry,
    matrix: placement.matrix,
    toPage: placement.toPage,
    /** The original image's size as shown on the page (upright and turned), in pixels. */
    width: source.shownWidth,
    height: source.shownHeight,
    /**
     * The original image as shown on the page (upright and turned as the user chose), in colour
     * whatever its look, at most `maxSide` pixels on its long side, on a canvas. Only while onPage runs.
     */
    async render({ maxSide = 4000, dom = false } = {}) {
      if (!open || !source.pixels) throw new Error('The page has been made: render() is only there during onPage');
      const whole = source.width >= source.fullWidth && source.height >= source.fullHeight;
      const wanted = Math.min(maxSide, Math.max(source.shownWidth, source.shownHeight));
      if (whole || Math.max(source.width, source.height) >= wanted) {
        return renderShown(source.pixels, source.width, source.height, source.transform, { maxSide, dom });
      }
      // The PDF's copy was decoded smaller than the original: the text is read from the original.
      const full = await openSource(item, options, { whole: true });
      try {
        return renderShown(full.pixels, full.width, full.height, full.transform, { maxSide, dom });
      } finally {
        full.close();
      }
    },
    close() {
      open = false;
    },
  };
}

// ---- The image on each page ----

/**
 * The image for `item`'s page (PdfExporter.loadPage): the smaller of the compressed image and the
 * original (when the original can be kept as it is), or the image with its look.
 * Returns { kind: 'jpeg' | 'raster' | 'bilevel', width, height, transform, ... }.
 */
async function pageImage(item, source, options) {
  const { layout, compression, signal } = options;
  const scale = scaleFor(source.shownWidth, source.shownHeight, layout, compression);
  const quality = COMPRESSION[compression].jpegQuality;
  const look = item.look ?? 'original';
  const adjustments = lookAdjustments(item);
  const styled = look !== 'original' || adjustments.brightness !== 0 || adjustments.contrast !== 0;
  if (styled) return halving(scale, (s) => withLook(source, s, look, adjustments, quality, signal));
  const compressed = await halving(scale, (s) => compressedJpeg(source, s, quality));
  checkCancelled(signal);
  if (source.type === 'jpeg' && source.bytes) {
    return originalJpeg(source, item, compressed.data.length) ?? compressed;
  }
  // Small PNGs (screenshots of plain colours, diagrams) can beat JPEG; keep those lossless. The
  // app stores GIF, BMP and lossless or see-through WebP as PNG when they are picked, so they count too.
  const lossless = source.type === 'png' || source.type === 'gif' || source.type === 'bmp' ||
    (source.type === 'webp' && !isLossyOpaqueWebp(source.bytes));
  if (lossless && source.bytes && source.bytes.length <= compressed.data.length && scale >= 1) {
    try {
      return raster(source);
    } catch (e) {
      if (!isOutOfMemory(e)) throw e;
    }
  }
  return compressed;
}

/** Runs make(scale), halving the scale while the browser runs out of memory for the picture. */
async function halving(scale, make) {
  let s = scale;
  for (let halvings = 0; ; halvings++) {
    try {
      return await make(s);
    } catch (e) {
      if (!isOutOfMemory(e) || halvings >= MAX_HALVINGS) {
        if (isOutOfMemory(e)) throw new UserError('msg_out_of_memory');
        throw e;
      }
      s /= 2;
    }
  }
}

function isOutOfMemory(e) {
  return (e instanceof UserError && e.key === 'msg_out_of_memory') || (e instanceof RangeError && /memory|allocat|buffer|size/i.test(e.message));
}

/** The size the pixels are drawn at for `scale` of the picture's full size, at most MAX_PIXELS. */
function targetSize(source, scale) {
  let [w, h] = scaledSize(source.fullWidth, source.fullHeight, scale);
  while (w * h > MAX_PIXELS) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return [w, h];
}

/** The picture drawn at `scale`, flattened onto white and encoded as JPEG. */
async function compressedJpeg(source, scale, quality) {
  const [w, h] = targetSize(source, scale);
  const canvas = source.draw(w, h);
  try {
    const data = await encodeJpeg(canvas, { quality });
    return jpegImage(data, source.transform);
  } finally {
    release(canvas);
  }
}

function jpegImage(data, transform) {
  const info = parseJpeg(data);
  return { kind: 'jpeg', data, info, width: info.width, height: info.height, transform };
}

/**
 * The original JPEG, stripped for embedding, if a PDF can show it as it is, its colours are sRGB
 * and it is no bigger than `maxSize` bytes; otherwise null.
 */
function originalJpeg(source, item, maxSize) {
  const bytes = source.bytes;
  // A PDF says how to read the colours (/DeviceRGB, as sRGB), and viewers ignore a profile in the
  // JPEG, so a wide-gamut photo would look dull. The compressed copy has been converted to sRGB.
  if (!jpegIsSrgb(bytes)) return null;
  try {
    const info = parseJpeg(bytes);
    // Sized first, so a big photo that can't beat the compressed copy isn't copied as well.
    if (!info.canEmbedDirectly || jpegStrippedSize(bytes) > maxSize) return null;
    // As stored: the PDF turns it by its EXIF orientation, then the user's rotation.
    return { kind: 'jpeg', data: stripJpeg(bytes), info, width: info.width, height: info.height, transform: imageTransform(source.exif, item.rotation ?? 0) };
  } catch (e) {
    if (e instanceof InvalidJpegError) return null;
    throw e;
  }
}

/** The picture at its full size, stored losslessly. */
function raster(source) {
  const canvas = source.draw(source.fullWidth, source.fullHeight);
  try {
    const pixels = context2d(canvas, { willRead: true }).getImageData(0, 0, canvas.width, canvas.height);
    const gray = isGray(pixels);
    return { kind: 'raster', data: flateRaster(pixels, gray), gray, width: pixels.width, height: pixels.height, transform: source.transform };
  } finally {
    release(canvas);
  }
}

/**
 * The picture shrunk by `scale` with its look and adjustments: black and white a bit a pixel, grey
 * as a grey JPEG, the colour looks as a colour JPEG, at the compression level's quality.
 */
async function withLook(source, scale, look, adjustments, quality, signal) {
  const [w, h] = targetSize(source, scale);
  const canvas = source.draw(w, h);
  let pixels;
  try {
    pixels = context2d(canvas, { willRead: true }).getImageData(0, 0, canvas.width, canvas.height);
  } catch (e) {
    release(canvas);
    if (e instanceof RangeError) throw new UserError('msg_out_of_memory');
    throw e;
  }
  release(canvas);
  // A colour look is made in the pixels themselves, rather than in a second picture as large.
  const result = await runAsync(lookGen(pixels, look, adjustments, { inPlace: true }), { signal });
  const transform = source.transform;
  if (isBilevel(look)) return { kind: 'bilevel', bits: result.bits, width: result.bits.width, height: result.bits.height, transform };
  if (!isColour(look)) {
    return jpegImage(await encodeJpeg(result.gray, { quality, gray: true, signal }), transform);
  }
  return jpegImage(await encodeJpeg(result.imageData, { quality }), transform);
}

// ---- Pages ----

/** Adds `image` as the next page of `doc` (ImagePdfBuilder.addPage); returns the page and where the image went. */
function addPage(doc, image, layout) {
  const swap = swapsAxes(image.transform);
  const shownWidth = swap ? image.height : image.width;
  const shownHeight = swap ? image.width : image.height;
  const geometry = computeLayout(shownWidth, shownHeight, layout);
  const placement = imagePlacement(geometry, image.transform);
  const context = doc.context;
  const imageRef = context.register(imageStream(context, image));
  // Numbers with four decimals at most, as the app writes them.
  const page = doc.addPage([pdfRound(geometry.pageWidth), pdfRound(geometry.pageHeight)]);
  page.node.setXObject(PDFName.of('Im0'), imageRef);
  page.node.Resources().set(PDFName.of('ProcSet'), context.obj(['PDF', 'ImageB', 'ImageC']));
  const content = `q\n${placement.matrix.map(pdfNumber).join(' ')} cm\n/Im0 Do\nQ\n`;
  page.node.addContentStream(context.register(context.stream(content)));
  return { page, placement };
}

/** The image XObject for a page's image (ImagePdfBuilder.writeImage). */
function imageStream(context, image) {
  const size = { Type: 'XObject', Subtype: 'Image', Width: image.width, Height: image.height };
  if (image.kind === 'jpeg') {
    const dict = { ...size, BitsPerComponent: 8, ColorSpace: image.info.components === 1 ? 'DeviceGray' : 'DeviceRGB', Filter: 'DCTDecode' };
    if (image.info.isPlainRgb) dict.DecodeParms = { ColorTransform: 0 };
    return context.stream(image.data, dict);
  }
  if (image.kind === 'raster') {
    return context.stream(image.data, {
      ...size,
      BitsPerComponent: 8,
      ColorSpace: image.gray ? 'DeviceGray' : 'DeviceRGB',
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: image.gray ? 1 : 3, BitsPerComponent: 8, Columns: image.width },
    });
  }
  const g4 = encodeBitImage(image.bits);
  const flate = flateBits(image.bits);
  const bilevel = { ...size, BitsPerComponent: 1, ColorSpace: 'DeviceGray' };
  if (g4.length <= flate.length) {
    // 0 is black, as in DeviceGray (/BlackIs1 false).
    return context.stream(g4, { ...bilevel, Filter: 'CCITTFaxDecode', DecodeParms: { K: -1, Columns: image.width, Rows: image.height } });
  }
  return context.stream(flate, {
    ...bilevel,
    Filter: 'FlateDecode',
    DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 1, Columns: image.width },
  });
}
