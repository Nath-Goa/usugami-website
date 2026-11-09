// The kinds of image file Images to PDF takes in, told apart by their first bytes rather than by a
// name or a type another app gives, which can be wrong (ImageFileType.kt), and what a WebP file's
// header says about its picture (Webp.kt).

/** Enough of the start of a file for imageFileType(), with the brands of a HEIF or AVIF file. */
export const IMAGE_HEADER_BYTES = 64;

/** Enough of the start of a WebP file for isLossyOpaqueWebp(), even after a colour profile. */
export const WEBP_HEADER_BYTES = 64 * 1024;

/** The media type of each kind of image. */
export const IMAGE_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heif: 'image/heic',
  avif: 'image/avif',
};

/**
 * The image types the file picker offers (ImageStore.pickableTypes), as an accept attribute. Kept
 * here, in a module with no imports, so the app can name them without loading the decoders.
 */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/bmp,image/x-ms-bmp,image/gif,image/heic,image/heif,image/avif,.jpg,.jpeg,.png,.webp,.bmp,.gif,.heic,.heif,.avif';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The sizes the header of a BMP file's picture can have, one per version of the format. */
const BMP_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

/**
 * The type of the file starting with `header` (its first IMAGE_HEADER_BYTES bytes are enough):
 * 'jpeg', 'png', 'webp', 'bmp', 'gif', 'heif' (HEIC and other HEIF files, as phones save photos)
 * or 'avif'; null when it is none of these.
 * @param {Uint8Array} header
 * @returns {'jpeg'|'png'|'webp'|'bmp'|'gif'|'heif'|'avif'|null}
 */
export function imageFileType(header) {
  if (!header) return null;
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (header.length >= 8 && PNG_SIGNATURE.every((b, i) => header[i] === b)) return 'png';
  if (ascii(header, 0, 'RIFF') && ascii(header, 8, 'WEBP')) return 'webp';
  if (ascii(header, 0, 'GIF87a') || ascii(header, 0, 'GIF89a')) return 'gif';
  if (ascii(header, 0, 'BM') && header.length >= 18 && BMP_HEADER_SIZES.has(u32le(header, 14))) return 'bmp';
  if (ascii(header, 4, 'ftyp')) return isoType(header);
  return null;
}

/**
 * A HEIF or AVIF file starts with a box listing the brands it follows: its main one, then those it
 * is compatible with. An AVIF file also lists HEIF's own ("mif1"), so AVIF is looked for first.
 */
function isoType(header) {
  const boxEnd = Math.min(header.length >= 4 ? u32be(header, 0) : 0, header.length);
  const brands = [];
  if (boxEnd >= 12) brands.push(text(header, 8, 4));
  for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(text(header, at, 4));
  if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
  if (brands.some((b) => HEIF_BRANDS.has(b))) return 'heif';
  return null;
}

const ALPHA = 0x10;
const ANIMATION = 0x02;

/**
 * Whether `header`, the start of a WebP file, holds a lossy picture (a photo, nearly always) without
 * transparency or animation: one that loses nothing more by being stored as JPEG. Lossless,
 * see-through and animated pictures, and anything that can't be read this far, are false.
 * @param {Uint8Array} header
 * @returns {boolean}
 */
export function isLossyOpaqueWebp(header) {
  if (!header || header.length < 16 || !ascii(header, 0, 'RIFF') || !ascii(header, 8, 'WEBP')) return false;
  // The simple format: a single lossy ("VP8 ") or lossless ("VP8L") picture.
  if (ascii(header, 12, 'VP8 ')) return true;
  if (!ascii(header, 12, 'VP8X') || header.length < 21) return false;
  // The extended format: flags for alpha and animation, then chunks up to the picture's own.
  const flags = header[20];
  if (flags & (ALPHA | ANIMATION)) return false;
  let at = 12;
  while (at + 8 <= header.length) {
    if (ascii(header, at, 'VP8 ')) return true;
    if (ascii(header, at, 'VP8L') || ascii(header, at, 'ALPH')) return false;
    const size = u32le(header, at + 4);
    // Chunks are padded to an even length.
    const next = at + 8 + size + (size & 1);
    if (next > 0x7fffffff) return false;
    at = next;
  }
  return false;
}

function ascii(bytes, at, s) {
  if (at < 0 || at + s.length > bytes.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function text(bytes, at, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

function u32le(b, at) {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}

function u32be(b, at) {
  return b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}
