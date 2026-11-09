// Reading the ZIP files Word, PowerPoint, Excel and EPUB files are, safely: only read, never
// extracted, so odd names inside can't reach anything, and with limits on what is inflated, so a
// crafted file (a "zip bomb": a few kilobytes that inflate to gigabytes) fails as damaged instead
// of filling the device's memory. The app reads its zips with java.util.zip.ZipFile (Ooxml.kt's
// openZip and OfficePackage, EpubBook.kt's EpubArchive); this follows its rules.
import { Inflate } from '../../lib/fflate.js';
import { checkCancelled } from '../../core/errors.js';
import { pause } from './pause.js';

/** More entries than any Office file or e-book has (a book of pictures has a few thousand). */
export const MAX_ENTRIES = 100000;

/** The most one entry may inflate to: far more than any part Office writes, well within a browser's memory. */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** The most all the entries read from one archive may inflate to, in all. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Compressed bytes inflated at a time: what one step inflates to stays a few megabytes. */
const STEP = 16 * 1024;

/**
 * A zip that can't be read. `reason`: 'not-zip' (no zip directory), 'damaged' (broken structure or
 * data, or an entry name with ".."), 'encrypted' (a zip password), 'unsupported' (a compression
 * method other than stored or deflated) or 'too-large' (past MAX_ENTRIES, MAX_ENTRY_BYTES or
 * MAX_TOTAL_BYTES).
 */
export class ZipError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

/** Whether `bytes` start as a zip does (a local file header). */
export function isZip(bytes) {
  return !!bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const nameDecoder = new TextDecoder('utf-8');

function u64(dv, at) {
  return dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 0x100000000;
}

/**
 * One file in the archive: `name` (as written, without a leading "/"), `size` and
 * `compressedSize` (as the directory says), `method` (0 stored, 8 deflated), `encrypted`.
 */
export class ZipEntry {
  constructor(name, size, compressedSize, method, flags, offset) {
    this.name = name;
    this.size = size;
    this.compressedSize = compressedSize;
    this.method = method;
    this.encrypted = (flags & 1) !== 0;
    this.offset = offset;
  }

  get isDirectory() {
    return this.name.endsWith('/');
  }
}

/**
 * A zip file's directory, and its files' contents on request. Names are found as written (a
 * leading "/" aside) or, failing that, ignoring case: Office part names are case-insensitive, and
 * books made on Windows sometimes link with the wrong case.
 */
export class ZipArchive {
  /**
   * Reads the directory of the zip in `bytes`. Throws ZipError. `limits` may lower MAX_ENTRIES,
   * MAX_ENTRY_BYTES and MAX_TOTAL_BYTES: { entries, entryBytes, totalBytes }.
   */
  static open(bytes, { limits } = {}) {
    return new ZipArchive(bytes, { limits });
  }

  constructor(bytes, { limits } = {}) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('ZipArchive needs a Uint8Array');
    this.data = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.inflated = 0;
    this.limits = {
      entries: Math.min(MAX_ENTRIES, limits?.entries ?? MAX_ENTRIES),
      entryBytes: Math.min(MAX_ENTRY_BYTES, limits?.entryBytes ?? MAX_ENTRY_BYTES),
      totalBytes: Math.min(MAX_TOTAL_BYTES, limits?.totalBytes ?? MAX_TOTAL_BYTES),
    };
    const { entries, base } = readDirectory(bytes, this.dv, this.limits.entries);
    this.base = base;
    /** Every entry, folders too, in the directory's order. */
    this.all = entries;
    this.exact = new Map();
    this.folded = new Map();
    for (const e of entries) {
      if (e.isDirectory) continue;
      // As the app's maps: the last of two entries with one name wins.
      this.exact.set(e.name, e);
      this.folded.set(e.name.toLowerCase(), e);
    }
  }

  /** The files' names (not folders'), in the directory's order. */
  get names() {
    return this.all.filter((e) => !e.isDirectory).map((e) => e.name);
  }

  /** The entry for `path`, or null. */
  entry(path) {
    const p = String(path ?? '').replace(/^\/+/, '');
    return this.exact.get(p) ?? this.folded.get(p.toLowerCase()) ?? null;
  }

  has(path) {
    return this.entry(path) != null;
  }

  /** The first file (in name order) whose name ends with `suffix`, ignoring case: EpubArchive.firstEndingWith. */
  firstEndingWith(suffix) {
    const s = suffix.toLowerCase();
    return [...this.exact.keys()].sort().find((n) => n.toLowerCase().endsWith(s)) ?? null;
  }

  /**
   * The contents of `path`, or null when there's no such file. With `maxBytes`, only up to that
   * many bytes from its start (no error past them); with `limit`, a ZipError ('too-large') past
   * that many. Pauses now and then so the page stays responsive, and stops with CancelledError
   * when `signal` is aborted. Throws ZipError.
   */
  async bytes(path, { signal, maxBytes, limit } = {}) {
    const e = this.entry(path);
    if (!e) return null;
    checkCancelled(signal);
    return this.read(e, { signal, maxBytes, limit, async: true });
  }

  /** As bytes(), without pausing: for the small parts (relationships, styles). */
  bytesSync(path, { maxBytes, limit } = {}) {
    const e = this.entry(path);
    if (!e) return null;
    return this.read(e, { maxBytes, limit, async: false });
  }

  /** The contents of `path` as UTF-8 text, or null. */
  async text(path, options) {
    const b = await this.bytes(path, options);
    return b == null ? null : new TextDecoder('utf-8').decode(b);
  }

  /** Lets go of the file's bytes. */
  close() {
    this.data = new Uint8Array(0);
    this.dv = new DataView(this.data.buffer);
    this.exact.clear();
    this.folded.clear();
    this.all = [];
  }

  /** Where `e`'s data starts. */
  dataStart(e) {
    const n = this.data.length;
    const p = this.base + e.offset;
    if (p < 0 || p + 30 > n || this.dv.getUint32(p, true) !== 0x04034b50) throw new ZipError('damaged', `Bad local header for ${e.name}`);
    const start = p + 30 + this.dv.getUint16(p + 26, true) + this.dv.getUint16(p + 28, true);
    if (start + e.compressedSize > n) throw new ZipError('damaged', `${e.name} runs past the end of the file`);
    return start;
  }

  read(e, { signal, maxBytes, limit, async }) {
    if (e.encrypted) throw new ZipError('encrypted', `${e.name} is encrypted`);
    const start = this.dataStart(e);
    const data = this.data.subarray(start, start + e.compressedSize);
    const room = Math.min(this.limits.entryBytes, this.limits.totalBytes - this.inflated, limit ?? Infinity);
    const head = maxBytes != null && maxBytes >= 0 ? maxBytes : Infinity;
    if (e.method === 0) {
      const size = Math.min(data.length, head);
      if (size > room) throw new ZipError('too-large', `${e.name} is too large`);
      this.inflated += size;
      const out = data.slice(0, size);
      return async ? Promise.resolve(out) : out;
    }
    if (e.method !== 8) throw new ZipError('unsupported', `${e.name} uses compression method ${e.method}`);
    if (data.length === 0) {
      if (e.size > 0) throw new ZipError('damaged', `${e.name} has no data`);
      return async ? Promise.resolve(new Uint8Array(0)) : new Uint8Array(0);
    }
    return async ? this.inflateAsync(e, data, room, head, signal) : this.inflate(e, data, room, head);
  }

  inflate(e, data, room, head) {
    const sink = new Sink(e, room, head);
    const inf = new Inflate((chunk) => sink.add(chunk));
    try {
      for (let p = 0; p < data.length && !sink.full; p += STEP) {
        const end = Math.min(data.length, p + STEP);
        inf.push(data.subarray(p, end), end >= data.length);
      }
    } catch (err) {
      if (!(err instanceof Stop)) throw sink.problem(err);
    }
    this.inflated += sink.total;
    return sink.result();
  }

  async inflateAsync(e, data, room, head, signal) {
    const sink = new Sink(e, room, head);
    const inf = new Inflate((chunk) => sink.add(chunk));
    let since = performance.now();
    try {
      for (let p = 0; p < data.length && !sink.full; p += STEP) {
        const end = Math.min(data.length, p + STEP);
        inf.push(data.subarray(p, end), end >= data.length);
        if (performance.now() - since > 30) {
          await pause();
          checkCancelled(signal);
          since = performance.now();
        }
      }
    } catch (err) {
      if (!(err instanceof Stop)) throw sink.problem(err);
    }
    this.inflated += sink.total;
    return sink.result();
  }
}

/** Thrown inside the inflater to stop once enough has been read. */
class Stop {}

/** Collects what an entry inflates to, failing once it passes `room` bytes. */
class Sink {
  constructor(entry, room, head) {
    this.entry = entry;
    this.room = room;
    this.head = head;
    this.total = 0;
    this.full = false;
    // The directory's size is used to place the bytes straight where they go, when it is believable.
    const declared = entry.size;
    this.out = declared > 0 && declared <= room && declared <= head ? new Uint8Array(declared) : null;
    this.chunks = this.out ? null : [];
  }

  add(chunk) {
    if (this.full) throw new Stop();
    let c = chunk;
    if (this.total + c.length > this.head) {
      c = c.subarray(0, this.head - this.total);
      this.full = true;
    }
    if (this.total + c.length > this.room) throw new ZipError('too-large', `${this.entry.name} is too large`);
    if (this.out && this.total + c.length <= this.out.length) {
      this.out.set(c, this.total);
    } else {
      if (this.out) {
        // More than the directory said: kept in pieces from here on.
        this.chunks = [this.out.subarray(0, this.total)];
        this.out = null;
      }
      this.chunks.push(c);
    }
    this.total += c.length;
    if (this.full) throw new Stop();
  }

  problem(err) {
    if (err instanceof ZipError) return err;
    return new ZipError('damaged', `${this.entry.name} can't be inflated: ${err?.message ?? err}`);
  }

  result() {
    if (this.out) return this.total === this.out.length ? this.out : this.out.slice(0, this.total);
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** The zip's central directory: its entries, and where the zip starts in `bytes` (data may come before it). */
function readDirectory(bytes, dv, maxEntries) {
  const n = bytes.length;
  if (n < 22) throw new ZipError('not-zip', 'Too short for a zip');
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 0xffff); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      if (i + 22 + dv.getUint16(i + 20, true) <= n) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new ZipError('not-zip', 'No zip directory');
  let total = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  let end = eocd;
  // ZIP64: the real counts are in a record of their own, found through a locator just before.
  const loc = eocd - 20;
  if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
    const at = u64(dv, loc + 8);
    if (at + 56 <= n && dv.getUint32(at, true) === 0x06064b50) {
      if (total === 0xffff) total = u64(dv, at + 32);
      if (cdSize === 0xffffffff) cdSize = u64(dv, at + 40);
      if (cdOffset === 0xffffffff) cdOffset = u64(dv, at + 48);
      end = at;
    }
  }
  const cdStart = end - cdSize;
  const base = cdStart - cdOffset;
  if (cdStart < 0 || base < 0) throw new ZipError('damaged', 'Zip directory out of place');
  const entries = [];
  let p = cdStart;
  while (p + 46 <= end && dv.getUint32(p, true) === 0x02014b50) {
    if (entries.length >= maxEntries) throw new ZipError('too-large', 'Too many zip entries');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compressed = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new ZipError('damaged', 'Zip directory entry runs past its end');
    const raw = nameDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    // ZIP64 sizes and offsets, for those the entry gives as 0xFFFFFFFF.
    let x = p + 46 + nameLength;
    const xEnd = x + extraLength;
    while (x + 4 <= xEnd) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        const qEnd = Math.min(xEnd, q + len);
        if (size === 0xffffffff && q + 8 <= qEnd) { size = u64(dv, q); q += 8; }
        if (compressed === 0xffffffff && q + 8 <= qEnd) { compressed = u64(dv, q); q += 8; }
        if (offset === 0xffffffff && q + 8 <= qEnd) { offset = u64(dv, q); q += 8; }
      }
      x += 4 + len;
    }
    // As the app on current Android: an entry whose name climbs out of the archive (".."), which
    // only a crafted file has, makes the whole zip unreadable. A leading "/" is let through.
    if (raw.split('/').some((s) => s === '..') || raw.split('\\').some((s) => s === '..')) {
      throw new ZipError('damaged', `Invalid zip entry path: ${raw}`);
    }
    entries.push(new ZipEntry(raw.replace(/^\/+/, ''), size, compressed, method, flags, offset));
    p = next;
  }
  if (entries.length === 0 && total > 0) throw new ZipError('damaged', 'Zip directory not found where it should be');
  return { entries, base };
}
