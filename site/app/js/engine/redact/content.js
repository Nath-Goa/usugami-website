// Reading pages' content streams for Redact PDF (the app's XObjectCleanup.kt): which images and
// forms a page draws and where, which patterns and soft masks it paints with, and emptying those
// only redacted pages drew. Pages often share one list of resources (many PDF makers put every
// image in it), so such an image would otherwise stay in the file through the pages that are left.
import {
  N, get, getDict, getName, resolve, numbers, items, streamBytes, inherited, dictOf,
  PDFDict, PDFArray, PDFStream, PDFRawStream, PDFRef,
} from './objects.js';
import { mapped, intersection, multiply, IDENTITY } from './boxes.js';

// ---- Tokens ----

const WHITE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const NUMERIC = new Uint8Array(256);
for (const c of '+-.0123456789') NUMERIC[c.charCodeAt(0)] = 1;

/** A name operand, such as /Im1. */
export class Name {
  constructor(name) { this.name = name; }
}

/** A string operand's bytes. */
export class Str {
  constructor(bytes) { this.bytes = bytes; }
}

const latin1 = (bytes, from, to) => {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/**
 * The operators of a content stream with their operands: [{ op, args }]. Never stops early or
 * loops on damaged content: anything it can't read is skipped a byte at a time. Inline images
 * become one operator 'BI' whose operand is their dictionary.
 */
export function tokenize(bytes) {
  const ops = [];
  const n = bytes.length;
  let args = [];
  const stack = [];
  const push = (v) => {
    if (stack.length) stack[stack.length - 1].items.push(v);
    else if (args.length < 10000) args.push(v);
  };
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (WHITE[c]) { i++; continue; }
    if (c === 0x25) { // %
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    if (c === 0x2F) { // /
      let j = i + 1;
      while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
      const raw = latin1(bytes, i + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      push(new Name(raw));
      i = j;
      continue;
    }
    if (c === 0x28) { // (
      const [str, next] = literalString(bytes, i);
      push(str);
      i = next;
      continue;
    }
    if (c === 0x3C) { // <
      if (bytes[i + 1] === 0x3C) {
        stack.push({ dict: true, items: [] });
        i += 2;
        continue;
      }
      let j = i + 1;
      let hex = '';
      while (j < n && bytes[j] !== 0x3E) {
        const ch = String.fromCharCode(bytes[j]);
        if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
        j++;
      }
      if (hex.length % 2) hex += '0';
      const out = new Uint8Array(hex.length / 2);
      for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(2 * k, 2), 16);
      push(new Str(out));
      i = j + 1;
      continue;
    }
    if (c === 0x3E) { // >
      if (bytes[i + 1] === 0x3E && stack.length && stack[stack.length - 1].dict) {
        const { items: entries } = stack.pop();
        const dict = new Map();
        for (let k = 0; k + 1 < entries.length; k += 2) if (entries[k] instanceof Name) dict.set(entries[k].name, entries[k + 1]);
        push(dict);
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === 0x5B) { // [
      if (stack.length < 64) stack.push({ dict: false, items: [] });
      i++;
      continue;
    }
    if (c === 0x5D) { // ]
      if (stack.length && !stack[stack.length - 1].dict) push(stack.pop().items);
      i++;
      continue;
    }
    if (NUMERIC[c]) {
      let j = i;
      while (j < n && NUMERIC[bytes[j]]) j++;
      const text = latin1(bytes, i, j);
      const value = Number.parseFloat(text.replace(/^[+-]+/, (s) => (s.includes('-') ? '-' : '')));
      push(Number.isFinite(value) ? value : 0);
      i = j;
      continue;
    }
    if (DELIM[c]) { i++; continue; } // a stray ) { or }
    let j = i;
    while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
    const word = latin1(bytes, i, j);
    i = j;
    if (word === 'true') { push(true); continue; }
    if (word === 'false') { push(false); continue; }
    if (word === 'null') { push(null); continue; }
    // An operator inside an array or dictionary is damage: it ends them.
    stack.length = 0;
    if (word === 'BI') {
      const [dict, next] = inlineImage(bytes, i);
      ops.push({ op: 'BI', args: [dict] });
      i = next;
      args = [];
      continue;
    }
    ops.push({ op: word, args });
    args = [];
  }
  return ops;
}

function literalString(bytes, start) {
  const n = bytes.length;
  const out = [];
  let depth = 1;
  let i = start + 1;
  while (i < n && depth > 0) {
    const b = bytes[i++];
    if (b === 0x5C) { // backslash
      if (i >= n) break;
      const e = bytes[i++];
      const simple = { 0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5C: 0x5C };
      if (e in simple) out.push(simple[e]);
      else if (e >= 0x30 && e <= 0x37) {
        let v = e - 0x30;
        for (let k = 0; k < 2 && i < n && bytes[i] >= 0x30 && bytes[i] <= 0x37; k++) v = v * 8 + (bytes[i++] - 0x30);
        out.push(v & 0xFF);
      } else if (e === 13) {
        if (bytes[i] === 10) i++;
      } else if (e !== 10) {
        out.push(e);
      }
    } else if (b === 0x28) {
      depth++;
      out.push(b);
    } else if (b === 0x29) {
      depth--;
      if (depth > 0) out.push(b);
    } else {
      out.push(b);
    }
  }
  return [new Str(Uint8Array.from(out)), i];
}

/** An inline image's dictionary, and where its data ends (after EI). */
function inlineImage(bytes, start) {
  const n = bytes.length;
  // Its dictionary runs to the ID keyword.
  let id = -1;
  for (let i = start; i + 1 < n; i++) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && (i === 0 || WHITE[bytes[i - 1]] || DELIM[bytes[i - 1]]) &&
        (i + 2 >= n || WHITE[bytes[i + 2]] || DELIM[bytes[i + 2]])) {
      id = i;
      break;
    }
  }
  if (id < 0) return [new Map(), n];
  const dictOps = tokenize(bytes.subarray(start, id));
  const dict = new Map();
  const flat = dictOps.flatMap((o) => o.args);
  for (let k = 0; k + 1 < flat.length; k += 2) if (flat[k] instanceof Name) dict.set(flat[k].name, flat[k + 1]);
  let data = id + 2;
  if (data < n && WHITE[bytes[data]]) data++;
  for (let i = data; i + 1 < n; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 && (i === data || WHITE[bytes[i - 1]]) &&
        (i + 2 >= n || WHITE[bytes[i + 2]] || DELIM[bytes[i + 2]])) {
      return [dict, i + 2];
    }
  }
  return [dict, n];
}

// ---- Reading pages ----

/** Reads and keeps pages' and forms' content, for one document. */
export class ContentReader {
  constructor(doc) {
    this.doc = doc;
    this.ctx = doc.context;
    this.forms = new Map();
    this.pages = new Map();
  }

  /** The operators of a form or appearance stream (cached). Throws if it can't be decoded. */
  streamOps(stream) {
    let ops = this.forms.get(stream);
    if (!ops) {
      ops = tokenize(streamBytes(stream));
      this.forms.set(stream, ops);
    }
    return ops;
  }

  /** The operators of a page's content, all its streams in a row (cached). Throws if one can't be decoded. */
  pageOps(node) {
    let ops = this.pages.get(node);
    if (!ops) {
      const parts = contentStreams(this.ctx, node).map((s) => streamBytes(s));
      const total = parts.reduce((sum, p) => sum + p.length + 1, 0);
      const all = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
        all[at++] = 10;
      }
      ops = tokenize(all);
      this.pages.set(node, ops);
    }
    return ops;
  }

  /** A page's resources, also when inherited from the page tree. */
  resourcesOf(node) {
    const r = resolve(this.ctx, inherited(this.ctx, node, 'Resources'));
    return r instanceof PDFDict ? r : null;
  }

  /** The image or form a Do operator names, from `resources`, as it is stored. */
  xobject(resources, operand) {
    if (!(operand instanceof Name)) return null;
    const dict = getDict(resources, 'XObject');
    const x = dict ? get(dict, operand.name) : undefined;
    return x instanceof PDFStream ? x : null;
  }

  /** A named resource of a kind (Pattern, ExtGState) among `resources`. */
  resource(resources, kind, operand) {
    if (!(operand instanceof Name)) return null;
    const dict = getDict(resources, kind);
    const v = dict ? get(dict, operand.name) : undefined;
    return v ?? null;
  }
}

/** The content streams `node` (a page) is drawn from. */
export function contentStreams(ctx, node) {
  const contents = get(node, 'Contents');
  if (contents instanceof PDFStream) return [contents];
  if (contents instanceof PDFArray) return items(ctx, contents).filter((s) => s instanceof PDFStream);
  return [];
}

const MAX_DEPTH = 32;

/**
 * At most this many operators are read for one page, forms drawn again and again included: a
 * crafted PDF can draw a form that draws a form… thousands of times over. Past it, the page counts
 * as one whose content can't be read.
 */
const MAX_OPERATIONS = 3_000_000;

/**
 * Where a page's content draws each image and form, those inside forms included: [{ xobject,
 * matrix, extent, clip }]. `matrix` takes the space the xobject is drawn in, where it covers
 * `extent` ([left, bottom, right, top]: the unit square for an image, the bounding box for a
 * form), to the page's own coordinates; `clip` is the area, in those, to which the forms it is
 * drawn inside and the clipping paths set before it cut it (at most: the bounds of each path),
 * or null. Null if the page's content can't be read.
 */
export function placements(reader, node) {
  try {
    const placer = new Placer(reader);
    placer.run(reader.pageOps(node), reader.resourcesOf(node), IDENTITY, null);
    return placer.found;
  } catch {
    return null;
  }
}

/** [x, y] moved by m. */
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** `outer` cut to `area`: nothing at all if they don't overlap. */
const cut = (outer, area) => (outer ? intersection(outer, area) ?? [0, 0, 0, 0] : area);

class Placer {
  constructor(reader) {
    this.reader = reader;
    this.found = [];
    this.budget = MAX_OPERATIONS;
  }

  /** Runs `ops` drawn with `resources`, from `ctm`, cut to `clip`. */
  run(ops, resources, ctm, clip, depth = 0, forms = new Set()) {
    const { reader } = this;
    const saved = [];
    let path = null;
    let clips = false;
    const extend = (x, y) => {
      const [px, py] = apply(ctm, x, y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      path = path ? [Math.min(path[0], px), Math.min(path[1], py), Math.max(path[2], px), Math.max(path[3], py)] : [px, py, px, py];
    };
    const nums = (args, count) => {
      if (args.length < count) return null;
      const out = args.slice(0, count);
      return out.every((v) => typeof v === 'number') ? out : null;
    };
    if ((this.budget -= ops.length) < 0) throw new RangeError('Too much to read');
    for (const { op, args } of ops) {
      switch (op) {
        case 'q':
          saved.push([ctm, clip]);
          break;
        case 'Q':
          if (saved.length) [ctm, clip] = saved.pop();
          break;
        case 'cm': {
          const m = nums(args, 6);
          if (m) ctm = multiply(ctm, m);
          break;
        }
        case 're': {
          const r = nums(args, 4);
          if (r) {
            const [x, y, w, h] = r;
            extend(x, y); extend(x + w, y); extend(x, y + h); extend(x + w, y + h);
          }
          break;
        }
        case 'm': case 'l': {
          const p = nums(args, 2);
          if (p) extend(p[0], p[1]);
          break;
        }
        case 'c': case 'v': case 'y': {
          // A curve stays within its points and control points.
          const p = nums(args, op === 'c' ? 6 : 4);
          if (p) for (let k = 0; k < p.length; k += 2) extend(p[k], p[k + 1]);
          break;
        }
        case 'W': case 'W*':
          clips = true;
          break;
        case 'n': case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
          if (clips && path) clip = cut(clip, path);
          path = null;
          clips = false;
          break;
        case 'Do': {
          const xobject = reader.xobject(resources, args[0]);
          if (!xobject) break;
          const subtype = getName(xobject.dict, 'Subtype');
          if (subtype === 'Image') {
            this.found.push({ xobject, matrix: ctm, extent: [0, 0, 1, 1], clip });
          } else if (subtype === 'Form') {
            const fm = numbers(reader.ctx, get(xobject.dict, 'Matrix'), 6) ?? IDENTITY;
            const bbox = normalRect(numbers(reader.ctx, get(xobject.dict, 'BBox'), 4));
            const m = multiply(ctm, fm);
            if (bbox) this.found.push({ xobject, matrix: m, extent: bbox, clip });
            if (depth < MAX_DEPTH && !forms.has(xobject)) {
              const formResources = getDict(xobject.dict, 'Resources') ?? resources;
              // A form draws only inside its bounding box.
              const inner = bbox ? cut(clip, mapped(m, bbox)) : clip;
              forms.add(xobject);
              try {
                this.run(reader.streamOps(xobject), formResources, m, inner, depth + 1, forms);
              } finally {
                forms.delete(xobject);
              }
            }
            path = null;
            clips = false;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** Where an annotation's appearance draws images and forms: fitted to its rectangle and cut to it. */
  place(dict, resources) {
    const { ctx } = this.reader;
    const rect = normalRect(numbers(ctx, get(dict, 'Rect'), 4));
    if (!rect) return [];
    const appearance = normalAppearance(ctx, dict);
    if (!appearance) return [];
    const bbox = normalRect(numbers(ctx, get(appearance.dict, 'BBox'), 4));
    const matrix = numbers(ctx, get(appearance.dict, 'Matrix'), 6) ?? IDENTITY;
    const rw = rect[2] - rect[0];
    const rh = rect[3] - rect[1];
    if (!bbox || !(rw > 0 && rh > 0) || !(bbox[2] - bbox[0] > 0 && bbox[3] - bbox[1] > 0)) return [];
    const box = mapped(matrix, bbox);
    const a = multiply([1, 0, 0, 1, rect[0], rect[1]], multiply([rw / (box[2] - box[0]), 0, 0, rh / (box[3] - box[1]), 0, 0], [1, 0, 0, 1, -box[0], -box[1]]));
    const aa = multiply(a, matrix);
    const start = this.found.length;
    const own = getDict(appearance.dict, 'Resources') ?? resources;
    this.run(this.reader.streamOps(appearance), own, aa, rect, 0, new Set([appearance]));
    return this.found.slice(start);
  }
}

/** [x0, y0, x1, y1] with x0 < x1 and y0 < y1, or null. */
export function normalRect(r) {
  if (!r) return null;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** An annotation's normal appearance, in its current state (/AS) when it has several. */
export function normalAppearance(ctx, dict) {
  const ap = getDict(dict, 'AP');
  if (!ap) return null;
  const n = get(ap, 'N');
  if (n instanceof PDFStream) return n;
  if (n instanceof PDFDict) {
    const state = getName(dict, 'AS');
    const s = state ? get(n, state) : undefined;
    return s instanceof PDFStream ? s : null;
  }
  return null;
}

/** Annotation flags (/F): hidden, and not shown on the screen. */
const HIDDEN = 1 << 1;
const NO_VIEW = 1 << 5;
export const isHiddenAnnotation = (ctx, dict) => {
  const flags = resolve(ctx, get(dict, 'F'));
  const value = typeof flags?.asNumber === 'function' ? flags.asNumber() : 0;
  return (value & (HIDDEN | NO_VIEW)) !== 0;
};

/**
 * Where the appearances of a page's annotations draw any of `xobjects`, as viewers show them: each
 * in its current state, cut to its annotation's rectangle. What else of `xobjects` an annotation
 * holds goes in `unseen`, as kept out of sight: all it holds when it is hidden or not for the
 * screen, what only its other looks draw, and all it holds when its appearance can't be read.
 */
export function annotationPlacements(reader, node, xobjects, unseen) {
  const { ctx } = reader;
  const placed = [];
  const resources = reader.resourcesOf(node);
  for (const dict of items(ctx, get(node, 'Annots'))) {
    if (!(dict instanceof PDFDict)) continue;
    const held = new Set();
    collect(ctx, get(dict, 'AP'), held);
    for (const x of [...held]) if (!xobjects.has(x)) held.delete(x);
    if (!held.size) continue;
    let shown;
    try {
      shown = isHiddenAnnotation(ctx, dict) ? [] : new Placer(reader).place(dict, resources).filter((p) => xobjects.has(p.xobject));
    } catch {
      shown = [];
    }
    placed.push(...shown);
    for (const x of held) if (!shown.some((p) => p.xobject === x)) unseen.add(x);
  }
  return placed;
}

/**
 * Whether a page's resources list any of `xobjects`, also inside forms and the like: if not, it
 * can't draw them, and its content needn't be read. `known` keeps the answer for shared resources.
 */
export function mayDraw(reader, node, xobjects, known) {
  const resources = reader.resourcesOf(node);
  if (!resources) return false;
  if (!known.has(resources)) {
    const reach = new Set();
    collect(reader.ctx, resources, reach);
    known.set(resources, [...reach].some((x) => xobjects.has(x)));
  }
  return known.get(resources);
}

/**
 * Adds to `into` the images, forms, patterns and soft masks a page's content draws (those inside
 * forms included), with all they hold. Form resources met go in `contexts`. Throws if the
 * content can't be read.
 */
function drawnXObjects(reader, node, into, contexts) {
  const followed = new Set();
  const follow = (resource) => {
    if (resource != null && !followed.has(resource)) {
      followed.add(resource);
      collect(reader.ctx, resource, into);
    }
  };
  let budget = MAX_OPERATIONS;
  const run = (ops, resources, depth, forms) => {
    if ((budget -= ops.length) < 0) throw new RangeError('Too much to read');
    for (const { op, args } of ops) {
      if (op === 'Do') {
        const xobject = reader.xobject(resources, args[0]);
        if (!xobject) continue;
        into.add(xobject);
        if (getName(xobject.dict, 'Subtype') !== 'Form') continue;
        const formResources = getDict(xobject.dict, 'Resources');
        if (formResources) contexts.add(formResources);
        if (depth < MAX_DEPTH && !forms.has(xobject)) {
          forms.add(xobject);
          try {
            run(reader.streamOps(xobject), formResources ?? resources, depth + 1, forms);
          } finally {
            forms.delete(xobject);
          }
        }
      } else if (op === 'scn' || op === 'SCN') {
        // A pattern is named last, after any colour it is painted in.
        follow(reader.resource(resources, 'Pattern', args[args.length - 1]));
      } else if (op === 'gs') {
        follow(reader.resource(resources, 'ExtGState', args[0]));
      }
    }
  };
  run(reader.pageOps(node), reader.resourcesOf(node), 0, new Set());
}

/**
 * Adds to `into` the images, forms, patterns and soft masks a page draws. If its content can't be
 * read, everything its resources list counts, so nothing it might have drawn is missed.
 */
export function drawnBy(reader, node, into) {
  const found = new Set();
  try {
    drawnXObjects(reader, node, found, new Set());
    for (const x of found) into.add(x);
  } catch {
    collect(reader.ctx, reader.resourcesOf(node), into);
  }
}

/**
 * Adds to `into` every image, form and pattern a page might draw: what its content draws and
 * paints with, and, to be safe, all those reachable from its fonts, shadings and annotation
 * appearances. Without `readContent`, only its annotations' appearances are looked at.
 */
function usedBy(reader, node, into, readContent) {
  const { ctx } = reader;
  if (readContent) {
    const contexts = new Set();
    const resources = reader.resourcesOf(node);
    if (resources) contexts.add(resources);
    try {
      drawnXObjects(reader, node, into, contexts);
      for (const context of contexts) {
        for (const key of ['Font', 'Shading', 'Properties']) collect(ctx, get(context, key), into);
      }
    } catch {
      collect(ctx, resources, into);
    }
  }
  for (const annotation of items(ctx, get(node, 'Annots'))) {
    if (annotation instanceof PDFDict) collect(ctx, get(annotation, 'AP'), into);
  }
}

/**
 * Empties, in place, each of `drawn` that none of `users` (the pages that stay) nor the form's
 * default resources might still draw.
 */
export function emptyUnused(reader, drawn, users, check) {
  if (!drawn.size) return;
  const { ctx, doc } = reader;
  const used = new Set();
  const reaches = new Map();
  for (const node of users) {
    check?.();
    usedBy(reader, node, used, mayDraw(reader, node, drawn, reaches));
  }
  collect(ctx, get(getDict(doc.catalog, 'AcroForm'), 'DR'), used);
  // What an image drawn there needs to look as it does: its soft mask, its mask, its alternates.
  for (const x of [...used]) {
    if (x instanceof PDFStream && getName(x.dict, 'Subtype') === 'Image') collect(ctx, x, used);
  }
  const unused = [...drawn].filter((x) => x instanceof PDFStream && !used.has(x));
  if (!unused.length) return;
  const refs = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) refs.set(obj, ref);
  for (const x of unused) {
    const ref = refs.get(x);
    if (ref) ctx.assign(ref, emptied(ctx, x));
  }
}

/** An image, form or pattern made to draw nothing: a white pixel, or no content. */
function emptied(ctx, stream) {
  const dict = stream.dict;
  const image = getName(dict, 'Subtype') === 'Image';
  const pattern = get(dict, 'PatternType') !== undefined;
  const keep = image ? ['Type', 'Subtype']
    : pattern ? ['Type', 'PatternType', 'PaintType', 'TilingType', 'BBox', 'XStep', 'YStep', 'Matrix']
      : ['Type', 'Subtype', 'BBox', 'Matrix', 'FormType'];
  const fresh = ctx.obj({});
  for (const key of keep) {
    const v = dict.get(N(key));
    if (v !== undefined) fresh.set(N(key), v);
  }
  if (image) {
    fresh.set(N('Width'), ctx.obj(1));
    fresh.set(N('Height'), ctx.obj(1));
    fresh.set(N('BitsPerComponent'), ctx.obj(8));
    fresh.set(N('ColorSpace'), N('DeviceGray'));
    return PDFRawStream.of(fresh, Uint8Array.of(0xFF));
  }
  fresh.set(N('Resources'), ctx.obj({}));
  return PDFRawStream.of(fresh, new Uint8Array(0));
}

/**
 * Adds to `into` every image, form and (tiling) pattern stream reachable from `start`, not
 * following links up to pages (Parent, P).
 */
export function collect(ctx, start, into) {
  const seen = new Set();
  const pending = [];
  const first = resolve(ctx, start);
  if (first != null) pending.push(first);
  let steps = 0;
  while (pending.length && steps++ < 1_000_000) {
    const item = pending.pop();
    if (item == null || seen.has(item)) continue;
    seen.add(item);
    const dict = dictOf(item);
    if (dict) {
      if (item instanceof PDFStream) {
        const subtype = getName(dict, 'Subtype');
        if (subtype === 'Image' || subtype === 'Form' || dict.has(N('PatternType'))) into.add(item);
      }
      for (const [key, value] of dict.entries()) {
        const k = key.asString();
        if (k === '/Parent' || k === '/P') continue;
        const v = value instanceof PDFRef ? ctx.lookup(value) : value;
        if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) pending.push(v);
      }
    } else if (item instanceof PDFArray) {
      for (let i = 0; i < item.size(); i++) {
        const raw = item.get(i);
        const v = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
        if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) pending.push(v);
      }
    }
  }
}

