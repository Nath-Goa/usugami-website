// The PDF the converters draw, and the pictures in it: a port of the app's OfficePdf.kt (PagedPdf,
// OfficeImages, ImagePicture) and of OfficeText.kt's BitmapPicture and StandInPicture.
//
// The app draws pictures at 200 dpi and then runs the whole PDF through Compress PDF
// (Recommended: 150 dpi, JPEG quality 75). Here each picture is decoded once, straight to what that
// gives (no more than 150 pixels per inch where it is shown, JPEG at quality 75, lossless with its
// transparency when it has any), so there is no second pass. Pages are drawn with the text engine
// (PdfCanvas), in points, with the origin at the top-left corner.
import { createPdf, savePdf } from '../pdf-common.js';
import { PdfCanvas, embedImage, ensureFonts, fontsReady, layoutParagraphSync } from '../text/index.js';
import { imageFileType, IMAGE_MIME } from '../images/image-type.js';
import { readImageInfo, withoutExifOrientation } from '../images/image-meta.js';
import { makeCanvas, releaseCanvas, context2d } from '../images/image-canvas.js';
import { checkCancelled } from '../../core/errors.js';
import { box } from './drawingml.js';

const f = Math.fround;

/** Pixels per inch a picture keeps where it is shown (Compress PDF's Recommended level). */
export const DPI = 150;

/** JPEG quality pictures are stored at (Recommended's). */
export const JPEG_QUALITY = 0.75;

/** No picture is decoded larger than this on a side, or than MAX_PIXELS in all (OfficeImages). */
export const MAX_SIDE = 2400;
export const MAX_PIXELS = 12000000;

/** Pictures claiming more pixels than this aren't decoded: what a crafted file claims to make a browser run out of memory. */
export const MAX_DECODE_PIXELS = 220000000;

const roundToInt = (x) => Math.round(x);
const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------------------------
// Pages

/**
 * The PDF a conversion draws: pages one after another (the app's PagedPdf). Page sizes are
 * whole points, as Android's PDF writer makes them.
 */
export class OfficePdf {
  /** A new, empty PDF. */
  static async create() {
    return new OfficePdf(await createPdf());
  }

  constructor(doc) {
    this.doc = doc;
    this.page = null;
    this.canvas = null;
    this.pageCount = 0;
  }

  /** Starts a page `width` × `height` points big, and returns its canvas (points, top-left origin). */
  startPage(width, height) {
    if (this.page) throw new Error('A page is already open');
    const w = Math.max(1, roundToInt(Number.isFinite(width) ? width : 1));
    const h = Math.max(1, roundToInt(Number.isFinite(height) ? height : 1));
    this.page = this.doc.addPage([w, h]);
    this.canvas = new PdfCanvas(this.page);
    return this.canvas;
  }

  finishPage() {
    if (!this.page) return;
    this.page = null;
    this.canvas = null;
    this.pageCount++;
  }

  /**
   * Finishes the last page and saves the PDF (fonts are subset and pictures written here):
   * { bytes, pageCount }. `onProgress(pages, pages, { compressing: true })` is told first, as the
   * app's progress shows its last step.
   */
  async finish({ onProgress, signal } = {}) {
    this.finishPage();
    checkCancelled(signal);
    onProgress?.(this.pageCount, this.pageCount, { compressing: true });
    const bytes = await savePdf(this.doc);
    checkCancelled(signal);
    return { bytes, pageCount: this.pageCount };
  }
}

// ---------------------------------------------------------------------------------------------
// Pictures

/** How `open` gives a part's bytes: an OfficePackage or ZipArchive, or a function. */
function opener(source) {
  if (typeof source === 'function') return source;
  if (source && typeof source.bytes === 'function') return (path) => source.bytes(path);
  throw new TypeError('OfficeImages needs an OfficePackage, a ZipArchive or a function giving bytes');
}

/** The size a picture `w` × `h` is decoded at to be shown at `targetW` × `targetH` pixels (OfficeImages.decode). */
export function decodedSize(w, h, targetW, targetH) {
  let sample = 1;
  while (Math.floor(w / (sample * 2)) >= targetW && Math.floor(h / (sample * 2)) >= targetH) sample *= 2;
  while (Math.floor(w / sample) * Math.floor(h / sample) > MAX_PIXELS) sample *= 2;
  let dw = Math.max(1, Math.floor(w / sample));
  let dh = Math.max(1, Math.floor(h / sample));
  // Still well over the size shown: scaled down the rest of the way.
  const scale = Math.max(targetW / dw, targetH / dh);
  if (scale < 0.8) {
    dw = Math.max(1, roundToInt(dw * scale));
    dh = Math.max(1, roundToInt(dh * scale));
  }
  return [dw, dh];
}

/**
 * Pictures from the document, decoded no bigger than they are shown, and put into the PDF once
 * each (per size shown). `source` gives a part's bytes: an OfficePackage, a ZipArchive, or
 * `(path) => Promise<Uint8Array | null>`.
 */
export class OfficeImages {
  constructor(source, doc, { signal } = {}) {
    this.open = opener(source);
    this.doc = doc;
    this.signal = signal;
    this.cache = new Map();
  }

  /**
   * The picture in part `path`, to be shown `width` × `height` points big, decoded and put into the
   * PDF: { ref, width, height } (pixels) to draw with canvas.drawImage, or null when the browser
   * can't decode it (EMF and WMF drawings, TIFF, damaged files).
   */
  image(path, width, height) {
    const targetW = clampInt(roundToInt((width / 72) * DPI) || 1, 1, MAX_SIDE);
    const targetH = clampInt(roundToInt((height / 72) * DPI) || 1, 1, MAX_SIDE);
    const key = `${path}@${targetW}×${targetH}`;
    let found = this.cache.get(key);
    if (!found) {
      found = this.decode(path, targetW, targetH).catch((e) => {
        if (e?.name === 'CancelledError') throw e;
        return null;
      });
      this.cache.set(key, found);
    }
    return found;
  }

  /** A loaded ImagePicture of part `path`, shown `width` × `height` points big, with `crop` cut off. */
  async picture(path, width, height, crop = null) {
    return new ImagePicture(this, path, width, height, crop).load();
  }

  async decode(path, targetW, targetH) {
    checkCancelled(this.signal);
    const bytes = await this.open(path);
    checkCancelled(this.signal);
    if (!bytes || !bytes.length) return null;
    const type = imageFileType(bytes.subarray(0, 64));
    if (!type) return null;
    const info = readImageInfo(bytes, type);
    if (info.width > 0 && info.height > 0 && info.width * info.height > MAX_DECODE_PIXELS) return null;
    // As Android decodes pictures for the app: without turning them by their EXIF orientation.
    const plain = type === 'jpeg' || type === 'webp' || type === 'png' ? withoutExifOrientation(bytes, type, info) : bytes;
    const blob = new Blob([plain], { type: IMAGE_MIME[type] });
    let w = info.width;
    let h = info.height;
    let bitmap;
    if (w > 0 && h > 0) {
      const [dw, dh] = decodedSize(w, h, targetW, targetH);
      bitmap = await createImageBitmap(blob, dw === w && dh === h ? {} : { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' });
      w = dw;
      h = dh;
    } else {
      bitmap = await createImageBitmap(blob);
      if (bitmap.width * bitmap.height > MAX_DECODE_PIXELS) {
        bitmap.close?.();
        return null;
      }
      [w, h] = decodedSize(bitmap.width, bitmap.height, targetW, targetH);
    }
    checkCancelled(this.signal);
    let source = bitmap;
    let canvas = null;
    try {
      if (bitmap.width !== w || bitmap.height !== h) {
        // A browser that doesn't resize while decoding: scaled here.
        canvas = makeCanvas(w, h);
        const ctx = context2d(canvas);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, w, h);
        source = canvas;
      }
      return embedImage(this.doc, source, { format: 'auto', quality: JPEG_QUALITY });
    } finally {
      bitmap.close?.();
      releaseCanvas(canvas);
    }
  }
}

/**
 * `image` (anything canvas.drawImage takes: an ImageBitmap, a canvas, what OfficeImages.image
 * gives), or the part of it in `crop` ({ x, y, width, height } in its pixels), stretched over the
 * rectangle it is drawn in.
 */
export class BitmapPicture {
  constructor(image, crop = null) {
    this.image = image;
    this.crop = crop;
  }

  draw(canvas, rect) {
    const r = box(rect);
    if (!(r.width > 0 && r.height > 0)) return;
    canvas.imageSmoothingEnabled = true;
    const c = this.crop;
    if (c) canvas.drawImage(this.image, c.x, c.y, c.width, c.height, r.x, r.y, r.width, r.height);
    else canvas.drawImage(this.image, r.x, r.y, r.width, r.height);
  }
}

const STAND_IN_FILL = 0xfff1f1f1;
const STAND_IN_LINE = 0xffc8c8c8;
const STAND_IN_TEXT = 0xff757575;

/** A light grey box, with `caption` in it when there is one: for charts and the like. */
export class StandInPicture {
  constructor(caption = null) {
    this.caption = caption;
  }

  /** A stand-in whose caption's fonts are loaded, ready to draw. */
  static async create(caption = null) {
    return new StandInPicture(caption).prepare();
  }

  /** Loads the fonts the caption needs; draw() leaves out a caption whose fonts aren't loaded. */
  async prepare() {
    const text = this.caption?.trim();
    if (text) await ensureFonts(text, { size: 10 });
    return this;
  }

  draw(canvas, rect) {
    const r = box(rect);
    canvas.fillStyle = STAND_IN_FILL;
    canvas.fillRect(r.x, r.y, r.width, r.height);
    canvas.strokeStyle = STAND_IN_LINE;
    canvas.lineWidth = 0.75;
    canvas.lineCap = 'butt';
    canvas.lineJoin = 'miter';
    canvas.setLineDash([]);
    canvas.strokeRect(r.x, r.y, r.width, r.height);
    const text = this.caption?.trim();
    if (!text) return;
    const size = Math.min(10, r.height / 3, r.width / 6);
    if (size < 3) return;
    const style = { size, color: STAND_IN_TEXT };
    if (!fontsReady(text, style)) return;
    const layout = layoutParagraphSync({ text, base: style, width: Math.max(1, r.width * 0.9), align: 'center', maxLines: 3 });
    canvas.save();
    canvas.beginPath();
    canvas.rect(r.x, r.y, r.width, r.height);
    canvas.clip();
    layout.draw(canvas, r.x + r.width * 0.05, r.y + r.height / 2 - layout.height / 2);
    canvas.restore();
  }
}

/** A stand-in without a caption, for a picture that can't be decoded. */
StandInPicture.EMPTY = Object.freeze(new StandInPicture(null));

/**
 * A picture from the document, shown `width` × `height` points big, with the share of each side in
 * `crop` ([left, top, right, bottom]) cut off. load() decodes it (as the size shown asks); draw()
 * then draws it, or a grey box when it can't be decoded (or wasn't loaded).
 */
export class ImagePicture {
  constructor(images, path, width, height, crop = null) {
    this.images = images;
    this.path = path;
    this.width = width;
    this.height = height;
    this.crop = crop ?? null;
    const c = this.crop;
    const x = c ? f(f(1 - c[0]) - c[2]) : 1;
    const y = c ? f(f(1 - c[1]) - c[3]) : 1;
    this.shownX = c && x > 0.05 ? x : 1;
    this.shownY = c && y > 0.05 ? y : 1;
    this.image = undefined;
  }

  get loaded() {
    return this.image !== undefined;
  }

  async load() {
    if (this.image === undefined) this.image = await this.images.image(this.path, this.width / this.shownX, this.height / this.shownY);
    return this;
  }

  draw(canvas, rect) {
    const r = box(rect);
    const image = this.image;
    if (!image) return StandInPicture.EMPTY.draw(canvas, r);
    const c = this.crop;
    let source = null;
    if (c) {
      const w = image.width;
      const h = image.height;
      const left = clampInt(roundToInt(c[0] * w), 0, w - 1);
      const top = clampInt(roundToInt(c[1] * h), 0, h - 1);
      const right = clampInt(roundToInt(w - c[2] * w), 1, w);
      const bottom = clampInt(roundToInt(h - c[3] * h), 1, h);
      if (right - left > 0 && bottom - top > 0) source = { x: left, y: top, width: right - left, height: bottom - top };
    }
    // A side cropped by a negative share (Crop > Fit) leaves that much of the frame empty, rather
    // than the picture being stretched over it.
    let target = r;
    if (c && c.some((v) => v < 0) && this.shownX === f(f(1 - c[0]) - c[2]) && this.shownY === f(f(1 - c[1]) - c[3])) {
      const sx = this.shownX;
      const sy = this.shownY;
      const left = r.x + (r.width * (Math.max(c[0], 0) - c[0])) / sx;
      const top = r.y + (r.height * (Math.max(c[1], 0) - c[1])) / sy;
      const right = r.x + (r.width * (1 - Math.max(c[2], 0) - c[0])) / sx;
      const bottom = r.y + (r.height * (1 - Math.max(c[3], 0) - c[1])) / sy;
      target = { x: left, y: top, width: right - left, height: bottom - top };
    }
    new BitmapPicture(image, source).draw(canvas, target);
  }
}

/**
 * A picture (anything with draw(canvas, rect)) as an inline object for the text engine's
 * RichText.appendObject: it sits on the baseline, `width` × `height` points big (PictureSpan).
 */
export function inlinePicture(picture, width, height) {
  return {
    width,
    height,
    draw(target, rect) {
      picture.draw(target, rect);
    },
  };
}
