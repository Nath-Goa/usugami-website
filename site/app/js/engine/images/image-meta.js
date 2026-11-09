// What an image file's own bytes say about its picture, read without decoding it: its stored size,
// how it is turned (EXIF orientation, or a HEIF/AVIF file's own turn), when it was taken (EXIF
// DateTimeOriginal) and whether it can be see-through; and copies of JPEG and PNG files without
// their hidden metadata (location, camera details, the video of a motion photo).
//
// Everything is read with bounds checks: a damaged or crafted file gives what can be read, never an
// exception or a long loop.

/**
 * @typedef {object} ImageInfo
 * @property {number} width        stored width in pixels (before turning), 0 when unknown
 * @property {number} height       stored height in pixels, 0 when unknown
 * @property {number} orientation  the EXIF orientation (1–8) a viewer applies to show it upright;
 *   for HEIF and AVIF only when the file has no turn of its own (ImageOrientation.kt)
 * @property {boolean} turnedByFile  a HEIF/AVIF file turns or mirrors its picture itself (irot, imir),
 *   which every decoder applies
 * @property {Date|null} taken     when the photo was taken (EXIF DateTimeOriginal, local time)
 * @property {boolean} alpha       the format says the picture may be see-through
 * @property {number} exifAt       where the EXIF data's name or type is in the file, -1 if none
 *   (for withoutExifOrientation())
 */

/**
 * Reads what `bytes`, an image file of `type` (see image-type.js), says about its picture.
 * @param {Uint8Array} bytes
 * @param {'jpeg'|'png'|'webp'|'bmp'|'gif'|'heif'|'avif'} type
 * @returns {ImageInfo}
 */
export function readImageInfo(bytes, type) {
  const info = { width: 0, height: 0, orientation: 1, turnedByFile: false, taken: null, alpha: false, exifAt: -1 };
  try {
    switch (type) {
      case 'jpeg': readJpeg(bytes, info); break;
      case 'png': readPng(bytes, info); break;
      case 'webp': readWebp(bytes, info); break;
      case 'gif': readGif(bytes, info); break;
      case 'bmp': readBmp(bytes, info); break;
      case 'heif':
      case 'avif': readHeif(bytes, info); break;
      default: break;
    }
  } catch {
    // What was read so far stands.
  }
  if (!(info.orientation >= 1 && info.orientation <= 8)) info.orientation = 1;
  return info;
}

/**
 * A copy of `bytes` whose EXIF data no decoder recognises, so a browser can't turn the picture by
 * it (it is turned by `info.orientation` instead, the same in every browser). The EXIF name (JPEG,
 * WebP) or type (PNG chunk, HEIF item) is changed; nothing moves.
 */
export function withoutExifOrientation(bytes, type, info) {
  if (info.exifAt < 0) return bytes;
  const copy = bytes.slice();
  switch (type) {
    case 'jpeg':
    case 'webp':
    case 'heif':
    case 'avif':
      copy[info.exifAt] = 0x58; // 'X': "Exif" becomes "Xxif", "EXIF" becomes "XXIF"
      break;
    case 'png': {
      // The chunk type becomes "eXIx" (ancillary, unknown), with its checksum made again.
      const at = info.exifAt;
      copy[at + 3] = 0x78;
      const length = u32be(copy, at - 4);
      const crc = crc32(copy, at, at + 4 + length);
      writeU32be(copy, at + 4 + length, crc);
      break;
    }
    default:
      break;
  }
  return copy;
}

// ---- JPEG ----

/** Markers whose segments carry a frame header (SOF0–SOF15 but DHT, JPG and DAC). */
const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function readJpeg(b, info) {
  let at = 2;
  let exifSeen = false;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) break;
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16be(b, at + 2);
    if (length < 2) break;
    const data = at + 4;
    const end = Math.min(b.length, at + 2 + length);
    if (isSof(marker) && data + 5 <= end && !info.width) {
      info.height = u16be(b, data + 1);
      info.width = u16be(b, data + 3);
    } else if (marker === 0xe1 && !exifSeen && ascii(b, data, 'Exif\0\0')) {
      exifSeen = true;
      info.exifAt = data;
      readTiff(b, data + 6, end, info);
    }
    at += 2 + length;
  }
}

/**
 * `jpeg` without what a photo hides in it: EXIF (location, camera details, the thumbnail), XMP,
 * IPTC and other APPn data, comments, and everything after its end (the video of a motion photo,
 * the extra pictures of a multi-picture file). Its colour profile (APP2 ICC_PROFILE), its JFIF and
 * Adobe colour markers and the picture itself are kept byte for byte. Null when its structure
 * can't be followed (it is then made again from its pixels instead).
 * @param {Uint8Array} jpeg
 * @returns {Uint8Array|null}
 */
export function strippedJpeg(jpeg) {
  const b = jpeg;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts = [b.subarray(0, 2)];
  let at = 2;
  const keep = (marker, data) => {
    if (marker === 0xfe) return false; // comment
    if (marker < 0xe0 || marker > 0xef) return true;
    // APP0 JFIF (not its JFXX thumbnail), APP2's colour profile and APP14 Adobe's colour transform.
    if (marker === 0xe0) return ascii(b, data, 'JFIF\0');
    if (marker === 0xe2) return ascii(b, data, 'ICC_PROFILE\0');
    if (marker === 0xee) return ascii(b, data, 'Adobe');
    return false;
  };
  for (;;) {
    if (at + 2 > b.length || b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xd9) {
      parts.push(b.subarray(at, at + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > b.length) return null;
    const length = u16be(b, at + 2);
    if (length < 2 || at + 2 + length > b.length) return null;
    const end = at + 2 + length;
    if (keep(marker, at + 4)) parts.push(b.subarray(at, end));
    at = end;
    if (marker === 0xda) {
      // The entropy-coded data runs to the next marker that isn't a stuffed byte or a restart.
      const scan = at;
      while (at + 1 < b.length && !(b[at] === 0xff && b[at + 1] !== 0 && !(b[at + 1] >= 0xd0 && b[at + 1] <= 0xd7))) at++;
      if (at + 1 >= b.length) {
        // Cut short: keep what there is, and end it.
        parts.push(b.subarray(scan), Uint8Array.of(0xff, 0xd9));
        return concat(parts);
      }
      parts.push(b.subarray(scan, at));
    }
  }
  return concat(parts);
}

// ---- PNG ----

/** The chunks a PNG keeps: the picture, its colours and how it is shown (and APNG's frames). */
const PNG_KEPT = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT',
  'bKGD', 'pHYs', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);

function readPng(b, info) {
  let at = 8;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = text(b, at + 4, 4);
    const data = at + 8;
    if (data + length > b.length) break;
    if (type === 'IHDR' && length >= 13) {
      info.width = u32be(b, data);
      info.height = u32be(b, data + 4);
      const colourType = b[data + 9];
      if (colourType === 4 || colourType === 6) info.alpha = true;
    } else if (type === 'tRNS') {
      info.alpha = true;
    } else if (type === 'eXIf' && info.exifAt < 0) {
      info.exifAt = at + 4;
      // Some writers put the JPEG "Exif\0\0" name in front of the TIFF data.
      const tiff = ascii(b, data, 'Exif\0\0') ? data + 6 : data;
      readTiff(b, tiff, data + length, info);
    } else if (type === 'IEND') {
      break;
    }
    at = data + length + 4;
  }
}

/**
 * `png` with only the chunks that make its picture (PNG_KEPT): its text chunks (which can hold
 * XMP, a location, a camera's details), EXIF, time and any private chunk are left out, as is
 * everything after its end. Null when its chunks can't be followed.
 * @param {Uint8Array} png
 * @returns {Uint8Array|null}
 */
export function strippedPng(png) {
  const b = png;
  if (b.length < 8) return null;
  const parts = [b.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const end = at + 12 + length;
    if (end > b.length) return null;
    const type = text(b, at + 4, 4);
    if (PNG_KEPT.has(type)) parts.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') return concat(parts);
  }
  return null;
}

// ---- WebP, GIF, BMP ----

function readWebp(b, info) {
  let at = 12;
  while (at + 8 <= b.length) {
    const type = text(b, at, 4);
    const size = u32le(b, at + 4);
    const data = at + 8;
    if (type === 'VP8X' && data + 10 <= b.length) {
      if (b[data] & 0x10) info.alpha = true;
      info.width = 1 + (b[data + 4] | (b[data + 5] << 8) | (b[data + 6] << 16));
      info.height = 1 + (b[data + 7] | (b[data + 8] << 8) | (b[data + 9] << 16));
    } else if (type === 'VP8 ' && data + 10 <= b.length && !info.width) {
      info.width = u16le(b, data + 6) & 0x3fff;
      info.height = u16le(b, data + 8) & 0x3fff;
    } else if (type === 'VP8L' && data + 5 <= b.length && !info.width) {
      const bits = u32le(b, data + 1);
      info.width = (bits & 0x3fff) + 1;
      info.height = ((bits >>> 14) & 0x3fff) + 1;
      if ((bits >>> 28) & 1) info.alpha = true;
    } else if (type === 'ALPH') {
      info.alpha = true;
    } else if (type === 'EXIF' && info.exifAt < 0) {
      info.exifAt = at;
      const end = Math.min(b.length, data + size);
      readTiff(b, ascii(b, data, 'Exif\0\0') ? data + 6 : data, end, info);
    }
    const next = data + size + (size & 1);
    if (next <= at) break;
    at = next;
  }
}

function readGif(b, info) {
  if (b.length >= 10) {
    info.width = u16le(b, 6);
    info.height = u16le(b, 8);
  }
  info.alpha = true;
}

function readBmp(b, info) {
  if (b.length < 26) return;
  const headerSize = u32le(b, 14);
  if (headerSize === 12) {
    info.width = u16le(b, 18);
    info.height = u16le(b, 20);
  } else {
    info.width = Math.abs(i32le(b, 18));
    info.height = Math.abs(i32le(b, 22));
    if (headerSize >= 56 && b.length >= 14 + 56 && u16le(b, 28) === 32) info.alpha = u32le(b, 14 + 52) !== 0;
  }
}

// ---- HEIF and AVIF (ISO base media file format) ----

/** The boxes inside `b` from `from` to `to`: [{ type, start (of its data), end }]. */
function boxes(b, from, to) {
  const out = [];
  let at = from;
  while (at + 8 <= to && out.length < 4096) {
    let size = u32be(b, at);
    const type = text(b, at + 4, 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u32be(b, at + 8) * 0x100000000 + u32be(b, at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

function readHeif(b, info) {
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return;
  const inner = boxes(b, meta.start + 4, meta.end);
  const find = (type) => inner.find((x) => x.type === type);
  let primary = -1;
  const pitm = find('pitm');
  if (pitm) primary = b[pitm.start] === 0 ? u16be(b, pitm.start + 4) : u32be(b, pitm.start + 4);

  // Items: their ids and types.
  const items = new Map();
  const iinf = find('iinf');
  if (iinf) {
    const version = b[iinf.start];
    const first = iinf.start + 4 + (version === 0 ? 2 : 4);
    for (const infe of boxes(b, first, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const v = b[infe.start];
      if (v < 2) continue;
      const id = v === 2 ? u16be(b, infe.start + 4) : u32be(b, infe.start + 4);
      const typeAt = infe.start + 4 + (v === 2 ? 2 : 4) + 2;
      items.set(id, { type: text(b, typeAt, 4), typeAt });
    }
  }
  if (primary < 0 && items.size) primary = items.keys().next().value;

  // The primary item's properties: its size, turn and mirroring; and whether any has transparency.
  const iprp = find('iprp');
  if (iprp) {
    const parts = boxes(b, iprp.start, iprp.end);
    const ipco = parts.find((x) => x.type === 'ipco');
    const properties = ipco ? boxes(b, ipco.start, ipco.end) : [];
    for (const p of properties) {
      if (p.type === 'auxC') {
        const urn = text(b, p.start + 4, Math.min(64, p.end - p.start - 4));
        if (/auxiliary:alpha|auxid:1(\0|$)/.test(urn)) info.alpha = true;
      }
    }
    for (const ipma of parts.filter((x) => x.type === 'ipma')) {
      const version = b[ipma.start];
      const flags = b[ipma.start + 3];
      const count = u32be(b, ipma.start + 4);
      let at = ipma.start + 8;
      for (let e = 0; e < count && at < ipma.end; e++) {
        const id = version < 1 ? u16be(b, at) : u32be(b, at);
        at += version < 1 ? 2 : 4;
        const n = b[at++];
        for (let k = 0; k < n && at < ipma.end; k++) {
          const index = flags & 1 ? u16be(b, at) & 0x7fff : b[at] & 0x7f;
          at += flags & 1 ? 2 : 1;
          if (id !== primary || index < 1 || index > properties.length) continue;
          const p = properties[index - 1];
          if (p.type === 'ispe' && p.start + 12 <= p.end) {
            info.width = u32be(b, p.start + 4);
            info.height = u32be(b, p.start + 8);
          } else if (p.type === 'irot' && p.start < p.end) {
            if (b[p.start] & 3) info.turnedByFile = true;
          } else if (p.type === 'imir') {
            info.turnedByFile = true;
          }
        }
      }
    }
  }

  // The EXIF item, for when the photo was taken, and its orientation when the file doesn't turn it.
  let exifId = -1;
  for (const [id, item] of items) {
    if (item.type === 'Exif') {
      exifId = id;
      info.exifAt = item.typeAt;
      break;
    }
  }
  if (exifId < 0) return;
  const place = itemLocation(b, find('iloc'), find('idat'), exifId);
  if (!place) return;
  const [start, end] = place;
  if (start + 4 > end) return;
  const tiff = start + 4 + u32be(b, start);
  const exif = { orientation: 1, taken: null };
  readTiff(b, ascii(b, tiff, 'Exif\0\0') ? tiff + 6 : tiff, end, exif);
  info.taken = exif.taken;
  // A file that turns its picture itself is shown that way; libheif then marks its EXIF upright.
  if (!info.turnedByFile) info.orientation = exif.orientation;
}

/** Where item `id`'s data is in the file, [start, end], from its iloc box; null if it can't be told. */
function itemLocation(b, iloc, idat, id) {
  if (!iloc) return null;
  const version = b[iloc.start];
  let at = iloc.start + 4;
  const sizes = u16be(b, at);
  at += 2;
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 15;
  const baseSize = (sizes >> 4) & 15;
  const indexSize = version >= 1 ? sizes & 15 : 0;
  const read = (size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + b[at + i];
    at += size;
    return v;
  };
  const count = version < 2 ? read(2) : read(4);
  for (let i = 0; i < count && at < iloc.end; i++) {
    const itemId = version < 2 ? read(2) : read(4);
    const method = version >= 1 ? read(2) & 15 : 0;
    read(2); // data reference index
    const base = read(baseSize);
    const extents = read(2);
    let first = null;
    for (let e = 0; e < extents && at < iloc.end; e++) {
      if (indexSize) read(indexSize);
      const offset = read(offsetSize);
      const length = read(lengthSize);
      if (e === 0) first = [offset, length];
    }
    if (itemId !== id || !first) continue;
    // Only one extent is read: EXIF data is small and written in one piece.
    let start;
    if (method === 0) start = base + first[0];
    else if (method === 1 && idat) start = idat.start + base + first[0];
    else return null;
    const end = first[1] ? start + first[1] : (method === 1 ? idat.end : b.length);
    if (start < 0 || start >= b.length) return null;
    return [start, Math.min(end, b.length)];
  }
  return null;
}

// ---- EXIF (TIFF) ----

/** Reads the orientation and DateTimeOriginal from TIFF data at `start`..`end` of `b` into `out`. */
function readTiff(b, start, end, out) {
  if (start + 8 > end) return;
  const little = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!little && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return;
  const u16 = (at) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at) => (little ? u32le(b, at) : u32be(b, at));
  if (u16(start + 2) !== 42) return;
  const entries = (ifd, each) => {
    const at = start + ifd;
    if (ifd < 8 || at + 2 > end) return;
    const count = Math.min(u16(at), 512);
    for (let i = 0; i < count; i++) {
      const e = at + 2 + 12 * i;
      if (e + 12 > end) return;
      each(u16(e), u16(e + 2), u32(e + 4), e + 8);
    }
  };
  let exifIfd = 0;
  entries(u32(start + 4), (tag, type, count, value) => {
    if (tag === 0x0112 && type === 3) out.orientation = u16(value);
    else if (tag === 0x8769) exifIfd = u32(value);
  });
  if (!exifIfd) return;
  entries(exifIfd, (tag, type, count, value) => {
    if (tag !== 0x9003 || type !== 2 || count < 19) return;
    const at = count > 4 ? start + u32(value) : value;
    if (at + 19 > end) return;
    out.taken = exifDate(text(b, at, 19));
  });
}

/** "2024:05:01 13:45:12" as a local Date; null when it isn't a real date. */
function exifDate(s) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const date = new Date(year, month - 1, day, hour, minute, Math.min(second, 59));
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---- Bytes ----

function ascii(b, at, s) {
  if (at < 0 || at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function text(b, at, length) {
  let s = '';
  for (let i = 0; i < length && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

function u16be(b, at) {
  return at + 2 <= b.length ? (b[at] << 8) | b[at + 1] : 0;
}

function u16le(b, at) {
  return at + 2 <= b.length ? b[at] | (b[at + 1] << 8) : 0;
}

function u32be(b, at) {
  return at + 4 <= b.length ? b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) : 0;
}

function u32le(b, at) {
  return at + 4 <= b.length ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000 : 0;
}

function i32le(b, at) {
  return at + 4 <= b.length ? b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24) : 0;
}

function writeU32be(b, at, v) {
  b[at] = v >>> 24;
  b[at + 1] = (v >>> 16) & 255;
  b[at + 2] = (v >>> 8) & 255;
  b[at + 3] = v & 255;
}

function concat(parts) {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

let crcTable = null;

/** The CRC-32 a PNG chunk ends with, of `b` from `from` to `to`. */
function crc32(b, from, to) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = from; i < to; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
