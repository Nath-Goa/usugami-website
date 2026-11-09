// Reading a JPEG's header and preparing it to go into a PDF unchanged (the app's Jpeg.kt), and the
// few facts about an image file the PDF needs: its EXIF orientation, its size, whether its colours
// are sRGB.
import { imageFileType } from './image-type.js';

/** A JPEG that can't be read. */
export class InvalidJpegError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidJpegError';
  }
}

const SOS = 0xda;
const COM = 0xfe;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
/** Length field of a JFIF segment without a thumbnail: itself (2) plus 14 bytes of header. */
const JFIF_LENGTH = 16;
const DIRECT_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const ascii = (b, i, text) => {
  if (i + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
};

export function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Reads the frame header. Throws InvalidJpegError if there is none before the first scan.
 * @returns {{ width, height, components, precision, frameMarker, componentIds: number[],
 *   hasAdobeMarker: boolean, hasJfifMarker: boolean, canEmbedDirectly: boolean, isPlainRgb: boolean }}
 *   canEmbedDirectly: PDF's DCTDecode shows it exactly as stored (8-bit Huffman coded baseline,
 *   extended or progressive, grey or colour). isPlainRgb: 3 components labelled R, G, B and neither
 *   a JFIF nor an Adobe marker, so the PDF needs /ColorTransform 0.
 */
export function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new InvalidJpegError('Not a JPEG file');
  let frame = null;
  let adobe = false;
  let jfif = false;
  forEachHeaderSegment(bytes, (marker, start, length) => {
    const data = start + 4; // after FF xx LL LL
    const dataLength = length - 2;
    if (isFrameMarker(marker)) {
      if (frame == null) {
        if (dataLength < 6) throw new InvalidJpegError('Truncated frame header');
        const components = bytes[data + 5];
        if (dataLength < 6 + 3 * components) throw new InvalidJpegError('Truncated frame header');
        frame = {
          width: u16(bytes, data + 3),
          height: u16(bytes, data + 1),
          components,
          precision: bytes[data],
          frameMarker: marker,
          componentIds: Array.from({ length: components }, (_, i) => bytes[data + 6 + 3 * i]),
        };
      }
    } else if (marker === APP14 && dataLength >= 5 && ascii(bytes, data, 'Adobe')) {
      adobe = true;
    } else if (marker === APP0 && dataLength >= JFIF_LENGTH - 2 && ascii(bytes, data, 'JFIF\u0000')) {
      // As libjpeg reads it: the identifier and the rest of the header.
      jfif = true;
    }
    return true;
  });
  if (!frame) throw new InvalidJpegError('No frame header');
  return jpegInfo({ ...frame, hasAdobeMarker: adobe, hasJfifMarker: jfif });
}

/** The header facts with the two derived ones worked out (see parseJpeg). */
export function jpegInfo(info) {
  const canEmbedDirectly = DIRECT_FRAMES.has(info.frameMarker) && info.precision === 8 &&
    (info.components === 1 || info.components === 3) && info.width > 0 && info.height > 0;
  const ids = info.componentIds;
  const isPlainRgb = info.components === 3 && !info.hasAdobeMarker && !info.hasJfifMarker &&
    ids.length === 3 && ids[0] === 82 && ids[1] === 71 && ids[2] === 66;
  return { ...info, canEmbedDirectly, isPlainRgb };
}

/**
 * The image prepared for embedding: the primary image only, ending at its EOI marker (dropping
 * anything appended after it, such as the video of a "motion photo" or MPF secondary images), with
 * only the segments decoders need. Everything else, such as EXIF and XMP with the GPS location, is
 * left out. Image data is copied byte for byte, so there is no quality loss.
 */
export function stripJpeg(bytes) {
  const out = new Output(new Uint8Array(jpegStrippedSize(bytes)));
  strip(bytes, out);
  return out.array;
}

/** The size of what stripJpeg returns, worked out without copying anything. */
export function jpegStrippedSize(bytes) {
  const out = new Output(null);
  strip(bytes, out);
  return out.size;
}

/** Where strip writes: an array of exactly the stripped size, or with no array, only counting. */
class Output {
  constructor(array) {
    this.array = array;
    this.size = 0;
  }

  byte(b) {
    if (this.array) this.array[this.size] = b;
    this.size++;
  }

  bytes(source, offset = 0, length = source.length - offset) {
    if (this.array) this.array.set(source.subarray(offset, offset + length), this.size);
    this.size += length;
  }
}

function strip(bytes, out) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new InvalidJpegError('Not a JPEG file');
  out.byte(0xff);
  out.byte(0xd8);
  let scanStart = -1;
  forEachHeaderSegment(bytes, (marker, start, length) => {
    if (marker === SOS) {
      scanStart = start;
      return false;
    }
    writeIfNeeded(bytes, marker, start, length, out);
    return true;
  });
  if (scanStart < 0) throw new InvalidJpegError('No image data');
  copyScans(bytes, scanStart, out);
}

/**
 * Copies the segment at `start` to `out` if decoders need it: every segment except application
 * data (APPn) and comments, plus the JFIF header (its thumbnail removed), ICC profiles (APP2) and
 * the Adobe marker (APP14).
 */
function writeIfNeeded(bytes, marker, start, length, out) {
  const hasId = (id) => length - 2 >= id.length && ascii(bytes, start + 4, id);
  if (marker !== COM && !(marker >= APP0 && marker <= APP15)) {
    out.bytes(bytes, start, 2 + length);
  } else if (marker === APP0 && length >= JFIF_LENGTH && hasId('JFIF\u0000')) {
    const jfif = bytes.slice(start, start + 2 + JFIF_LENGTH);
    jfif[2] = 0;
    jfif[3] = JFIF_LENGTH;
    jfif[16] = 0; // thumbnail width
    jfif[17] = 0; // thumbnail height
    out.bytes(jfif);
  } else if ((marker === APP2 && hasId('ICC_PROFILE\u0000')) || (marker === APP14 && hasId('Adobe'))) {
    out.bytes(bytes, start, 2 + length);
  }
}

/**
 * Calls visit(marker, offset of its 0xFF, segment length) for each length-prefixed segment from
 * just after SOI up to and including the first SOS. Stops early when visit returns false.
 */
function forEachHeaderSegment(bytes, visit) {
  let pos = 2;
  for (;;) {
    // Tolerate stray bytes between segments (libjpeg does too), then skip fill bytes.
    while (pos < bytes.length && bytes[pos] !== 0xff) pos++;
    while (pos + 1 < bytes.length && bytes[pos + 1] === 0xff) pos++;
    if (pos + 1 >= bytes.length) throw new InvalidJpegError('No image data');
    const start = pos;
    const marker = bytes[pos + 1];
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9) throw new InvalidJpegError('No image data');
    if (pos + 2 > bytes.length) throw new InvalidJpegError('Truncated segment');
    const length = u16(bytes, pos);
    if (length < 2 || pos + length > bytes.length) throw new InvalidJpegError('Truncated segment');
    if (!visit(marker, start, length)) return;
    if (marker === SOS) return;
    pos += length;
  }
}

/**
 * Copies everything from the first SOS through the EOI marker, filtering later segments like the
 * header. A truncated file is copied as far as it goes (up to a cut-off segment) and closed.
 */
function copyScans(bytes, firstScan, out) {
  let copied = firstScan;
  let end = bytes.length;
  let pos = firstScan + 2 + u16(bytes, firstScan + 2);
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    let next = pos + 1;
    while (next < bytes.length && bytes[next] === 0xff) next++;
    if (next >= bytes.length) break;
    const marker = bytes[next];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos = next + 1; // stuffed byte or restart marker
    } else if (marker === 0xd9) {
      out.bytes(bytes, copied, next + 1 - copied);
      return;
    } else {
      const start = next - 1;
      const length = next + 3 <= bytes.length ? u16(bytes, next + 1) : 0;
      if (length < 2 || start + 2 + length > bytes.length) {
        end = start;
        break;
      }
      out.bytes(bytes, copied, start - copied);
      writeIfNeeded(bytes, marker, start, length, out);
      copied = start + 2 + length;
      pos = copied;
    }
  }
  out.bytes(bytes, copied, end - copied);
  out.byte(0xff);
  out.byte(0xd9);
}

function isFrameMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// ---- Facts about image files ----

export { imageFileType, isLossyOpaqueWebp } from './image-type.js';

/** The stored pixel size of a JPEG or PNG from its header; null for other files or a damaged header. */
export function storedSize(bytes) {
  const type = imageFileType(bytes);
  try {
    if (type === 'jpeg') {
      const info = parseJpeg(bytes);
      return info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null;
    }
    if (type === 'png' && bytes.length >= 24 && ascii(bytes, 12, 'IHDR')) {
      const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
      const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The EXIF orientation (1 to 8) of a JPEG (APP1 "Exif"), PNG (eXIf chunk) or WebP (EXIF chunk);
 * 1 when it has none or it can't be read.
 */
export function exifOrientation(bytes) {
  try {
    const tiff = exifTiff(bytes);
    if (!tiff) return 1;
    const v = tiffOrientation(bytes, tiff.start, tiff.end);
    return v >= 1 && v <= 8 ? v : 1;
  } catch {
    return 1;
  }
}

/** Where the TIFF structure of an image's EXIF data is: { start, end }, or null. */
function exifTiff(bytes) {
  const type = imageFileType(bytes);
  if (type === 'jpeg') {
    let pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xff) return null;
      const marker = bytes[pos + 1];
      if (marker === 0xff) {
        pos++;
        continue;
      }
      if (marker === SOS || marker === 0xd9) return null;
      const length = u16(bytes, pos + 2);
      if (length < 2) return null;
      if (marker === 0xe1 && ascii(bytes, pos + 4, 'Exif\u0000\u0000')) {
        return { start: pos + 10, end: Math.min(bytes.length, pos + 2 + length) };
      }
      pos += 2 + length;
    }
    return null;
  }
  if (type === 'png') {
    let pos = 8;
    while (pos + 12 <= bytes.length) {
      const length = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
      if (ascii(bytes, pos + 4, 'eXIf')) return { start: pos + 8, end: Math.min(bytes.length, pos + 8 + length) };
      if (ascii(bytes, pos + 4, 'IDAT') || ascii(bytes, pos + 4, 'IEND')) return null;
      pos += 12 + length;
    }
    return null;
  }
  if (type === 'webp' && ascii(bytes, 12, 'VP8X')) {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const size = (bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24)) >>> 0;
      if (ascii(bytes, at, 'EXIF')) {
        let start = at + 8;
        // Some writers keep JPEG's "Exif\0\0" in front.
        if (ascii(bytes, start, 'Exif\u0000\u0000')) start += 6;
        return { start, end: Math.min(bytes.length, at + 8 + size) };
      }
      at += 8 + size + (size & 1);
    }
  }
  return null;
}

/** `jpeg` with an EXIF segment saying it is stored turned as `orientation` (1 to 8), right after SOI. */
export function withExifOrientation(jpeg, orientation) {
  const payload = [
    0x45, 0x78, 0x69, 0x66, 0, 0, // Exif\0\0
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, // big-endian TIFF, IFD0 at 8
    0, 1, // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // Orientation, SHORT, 1
    0, 0, 0, 0, // no next IFD
  ];
  const segment = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

/** The Orientation tag (0x0112) of IFD0 in the TIFF structure at start..end; 1 if missing. */
function tiffOrientation(b, start, end) {
  if (start + 8 > end) return 1;
  const little = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!little && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return 1;
  const r16 = (i) => (little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const r32 = (i) => (little ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
    : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
  const ifd = start + r32(start + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 1;
    if (r16(entry) === 0x0112) return r16(entry + 8);
  }
  return 1;
}

/**
 * Whether a JPEG's colours are sRGB as far as its header tells: true without an ICC profile or with
 * one that names itself sRGB. A wide-gamut photo (Display P3, Adobe RGB) would look dull embedded
 * as it is, as a PDF reads /DeviceRGB as sRGB.
 */
export function jpegIsSrgb(bytes) {
  const parts = [];
  try {
    forEachHeaderSegment(bytes, (marker, start, length) => {
      if (marker === APP2 && length - 2 >= 14 && ascii(bytes, start + 4, 'ICC_PROFILE\u0000')) {
        parts.push(bytes.subarray(start + 4 + 14, start + 2 + length));
      }
      return marker !== SOS;
    });
  } catch {
    return true;
  }
  if (!parts.length) return true;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const profile = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    profile.set(p, at);
    at += p.length;
  }
  return iccIsSrgb(profile);
}

/** Whether an ICC profile describes sRGB (its description tag says so, as Android's checks do in effect). */
export function iccIsSrgb(profile) {
  if (profile.length < 132) return true;
  const r32 = (i) => ((profile[i] << 24) | (profile[i + 1] << 16) | (profile[i + 2] << 8) | profile[i + 3]) >>> 0;
  const count = r32(128);
  for (let k = 0; k < count && 132 + k * 12 + 12 <= profile.length; k++) {
    const entry = 132 + k * 12;
    if (!ascii(profile, entry, 'desc')) continue;
    const offset = r32(entry + 4);
    const size = r32(entry + 8);
    const text = profileText(profile, offset, size);
    if (text == null) return true;
    return /srgb|iec\s*61966-2[.-]1/i.test(text);
  }
  return true;
}

/** The text of an ICC 'desc' (v2) or 'mluc' (v4) tag. */
function profileText(p, offset, size) {
  if (offset + 12 > p.length) return null;
  const end = Math.min(p.length, offset + size);
  if (ascii(p, offset, 'desc')) {
    const n = ((p[offset + 8] << 24) | (p[offset + 9] << 16) | (p[offset + 10] << 8) | p[offset + 11]) >>> 0;
    let s = '';
    for (let i = offset + 12; i < Math.min(end, offset + 12 + n); i++) if (p[i]) s += String.fromCharCode(p[i]);
    return s;
  }
  if (ascii(p, offset, 'mluc')) {
    const records = ((p[offset + 8] << 24) | (p[offset + 9] << 16) | (p[offset + 10] << 8) | p[offset + 11]) >>> 0;
    let s = '';
    for (let r = 0; r < records && offset + 16 + r * 12 + 12 <= end; r++) {
      const rec = offset + 16 + r * 12;
      const len = ((p[rec + 4] << 24) | (p[rec + 5] << 16) | (p[rec + 6] << 8) | p[rec + 7]) >>> 0;
      const at = offset + (((p[rec + 8] << 24) | (p[rec + 9] << 16) | (p[rec + 10] << 8) | p[rec + 11]) >>> 0);
      for (let i = at; i + 1 < Math.min(end, at + len); i += 2) s += String.fromCharCode((p[i] << 8) | p[i + 1]);
      s += ' ';
    }
    return s;
  }
  return null;
}
