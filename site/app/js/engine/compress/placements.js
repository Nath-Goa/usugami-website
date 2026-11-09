// Which images a PDF's pages use, and the largest size each is shown at. The images are found as
// the app finds them (in each page's resources and, through them, in form XObjects'); their sizes
// by following the pages' content streams with their transforms (cm), into form XObjects (with
// their /Matrix) and annotations' appearances, so an image drawn small, or several times, is known.
import { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFNumber } from '../../lib/pdf-lib.js';
import { checkCancelled } from '../../core/errors.js';
import { pause, runAsync } from '../images/canvas.js';
import { placementMatrix, multiply } from '../flatten/placement.js';
import { filtersOf, decodeAll } from './filters.js';
import { scanContent, OP_SAVE, OP_RESTORE, OP_TRANSFORM, OP_DRAW } from './content.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Forms inside forms deeper than this aren't followed (only a crafted file nests so deep). */
const MAX_DEPTH = 16;

/** The most content operations followed in one PDF, form XObjects counted each time they are drawn. */
const MAX_OPERATIONS = 20_000_000;

/** The most a page's content may inflate to before it counts as unreadable. */
const MAX_CONTENT_BYTES = 1 << 27;

const N = (key) => PDFName.of(key);

const lookup = (ctx, v) => {
  for (let i = 0; i < 8 && v instanceof PDFRef; i++) v = ctx.lookup(v);
  return v instanceof PDFRef ? undefined : v;
};

const subtypeOf = (stream) => {
  const s = stream.dict.get(N('Subtype'));
  return s instanceof PDFName ? s.decodeText() : undefined;
};

/** Too much drawing to follow: sizes found so far can't be relied on. */
class TooMuchWork extends Error {}

/**
 * Finds the images of `pages` as the app does: for each page its resources' XObjects, and in form
 * XObjects their resources' too, each resource dictionary once.
 * @param {object} ctx pdf-lib's PDFContext
 * @param {Array} pages pdf-lib's PDFPage objects
 * @returns {Map<PDFRef, ImageEntry>} ImageEntry: { ref, stream, width, height, uses: [{ xobjects, name }],
 *   extent (the most points on the page one of its pixels covers, 0 if never seen drawn), unknown
 *   (it may be drawn where its size couldn't be followed) }
 */
export function findImages(ctx, pages) {
  const images = new Map();
  const seen = new Set();
  const walk = (resources) => {
    if (!(resources instanceof PDFDict) || seen.has(resources)) return;
    seen.add(resources);
    const xobjects = lookup(ctx, resources.get(N('XObject')));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [key, value] of xobjects.entries()) {
      if (!(value instanceof PDFRef)) continue;
      const obj = ctx.lookup(value);
      if (!(obj instanceof PDFStream)) continue;
      const subtype = subtypeOf(obj);
      if (subtype === 'Form') {
        walk(lookup(ctx, obj.dict.get(N('Resources'))));
      } else if (subtype === 'Image') {
        let entry = images.get(value);
        if (!entry) {
          const size = (k) => {
            const n = lookup(ctx, obj.dict.get(N(k)));
            return n instanceof PDFNumber ? n.asNumber() : 0;
          };
          entry = { ref: value, stream: obj, width: size('Width'), height: size('Height'), uses: [], extent: 0, unknown: false };
          images.set(value, entry);
        }
        entry.uses.push({ xobjects, name: key });
      }
    }
  };
  for (const page of pages) walk(page.node.Resources());
  return images;
}

/**
 * Follows each page's drawing (its content, then its annotations' appearances) and records in
 * `images` the largest size each is shown at. Images drawn where it can't be followed (damaged
 * content, unknown filters, too much drawing) are marked unknown.
 * @param {object} ctx pdf-lib's PDFContext
 * @param {Array} pages pdf-lib's PDFPage objects
 * @param {Map} images from findImages
 * @param {{ signal?: AbortSignal, onPage?: (index: number) => void }} [options]
 */
export async function measureImages(ctx, pages, images, { signal, onPage } = {}) {
  const forms = new Map();
  const work = { operations: 0, started: performance.now() };
  let gaveUp = false;
  if (!images.size) return;

  // Whether drawing with these resources can show one of the images (through forms too): the
  // drawing of a page that can't, such as a page of text, needn't be read at all.
  const reach = new Map();
  const reachesImages = (resources) => {
    if (!(resources instanceof PDFDict)) return false;
    if (reach.has(resources)) return reach.get(resources);
    reach.set(resources, false); // a loop of forms reaches nothing new
    let found = false;
    const xobjects = lookup(ctx, resources.get(N('XObject')));
    if (xobjects instanceof PDFDict) {
      for (const [, value] of xobjects.entries()) {
        if (images.has(value)) {
          found = true;
          break;
        }
        const obj = value instanceof PDFRef ? ctx.lookup(value) : undefined;
        if (obj instanceof PDFStream && subtypeOf(obj) === 'Form' && reachesImages(lookup(ctx, obj.dict.get(N('Resources'))))) {
          found = true;
          break;
        }
      }
    }
    reach.set(resources, found);
    return found;
  };

  const markUnknown = (resources, seen = new Set()) => {
    if (!(resources instanceof PDFDict) || seen.has(resources)) return;
    seen.add(resources);
    const xobjects = lookup(ctx, resources.get(N('XObject')));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
      const entry = images.get(value);
      if (entry) {
        entry.unknown = true;
        continue;
      }
      const obj = value instanceof PDFRef ? ctx.lookup(value) : undefined;
      if (obj instanceof PDFStream && subtypeOf(obj) === 'Form') markUnknown(lookup(ctx, obj.dict.get(N('Resources'))), seen);
    }
  };

  const operationsOf = async (stream) => {
    const { bytes, complete } = await decodeAll(ctx, stream.getContents(), filtersOf(ctx, stream.dict), { maxBytes: MAX_CONTENT_BYTES, signal });
    if (!complete) throw new Error('Damaged content');
    return runAsync(scanContent(bytes), { signal });
  };

  const formOperations = async (ref) => {
    if (forms.has(ref)) {
      const cached = forms.get(ref);
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const ops = await operationsOf(ctx.lookup(ref));
      forms.set(ref, ops);
      return ops;
    } catch (e) {
      if (e?.name === 'CancelledError') throw e;
      forms.set(ref, e);
      throw e;
    }
  };

  const draw = async (ops, resources, ctm, stack) => {
    const saved = [];
    let m = ctm;
    for (let k = 0; k < ops.length;) {
      if (++work.operations > MAX_OPERATIONS) throw new TooMuchWork();
      if ((work.operations & 0x3fff) === 0 && performance.now() - work.started > 24) {
        checkCancelled(signal);
        await pause();
        work.started = performance.now();
      }
      const op = ops[k++];
      if (op === OP_SAVE) {
        saved.push(m);
      } else if (op === OP_RESTORE) {
        if (saved.length) m = saved.pop();
      } else if (op === OP_TRANSFORM) {
        m = multiply(ops.slice(k, k + 6), m);
        k += 6;
      } else if (op === OP_DRAW) {
        await drawXObject(ops[k++], resources, m, stack);
      }
    }
  };

  const drawXObject = async (resourceName, resources, m, stack) => {
    const xobjects = resources instanceof PDFDict ? lookup(ctx, resources.get(N('XObject'))) : undefined;
    const value = xobjects instanceof PDFDict ? xobjects.get(N(resourceName)) : undefined;
    if (!(value instanceof PDFRef)) return;
    const entry = images.get(value);
    if (entry) {
      record(entry, m);
      return;
    }
    const form = ctx.lookup(value);
    if (!(form instanceof PDFStream) || subtypeOf(form) !== 'Form') return;
    if (stack.includes(value) || stack.length >= MAX_DEPTH) return;
    const own = lookup(ctx, form.dict.get(N('Resources')));
    // A form without resources of its own uses its page's (as older PDFs do).
    const formResources = own instanceof PDFDict ? own : resources;
    let ops;
    try {
      ops = await formOperations(value);
    } catch (e) {
      if (e?.name === 'CancelledError') throw e;
      markUnknown(formResources);
      return;
    }
    await draw(ops, formResources, multiply(matrixOf(ctx, form.dict.get(N('Matrix'))), m), [...stack, value]);
  };

  for (let index = 0; index < pages.length && !gaveUp; index++) {
    checkCancelled(signal);
    const node = pages[index].node;
    const resources = node.Resources();
    try {
      if (reachesImages(resources)) {
        const ops = await pageOperations(ctx, node, operationsOf);
        await draw(ops, resources, IDENTITY, []);
      }
    } catch (e) {
      if (e?.name === 'CancelledError') throw e;
      if (e instanceof TooMuchWork) gaveUp = true;
      else markUnknown(resources);
    }
    if (!gaveUp) {
      try {
        for (const { ref, ctm } of appearances(ctx, node)) {
          if (reachesImages(lookup(ctx, ctx.lookup(ref).dict.get(N('Resources'))))) await drawXObjectDirect(ref, ctm);
        }
      } catch (e) {
        if (e?.name === 'CancelledError') throw e;
        if (e instanceof TooMuchWork) gaveUp = true;
      }
    }
    onPage?.(index);
    if (performance.now() - work.started > 24) {
      checkCancelled(signal);
      await pause();
      work.started = performance.now();
    }
  }

  async function drawXObjectDirect(ref, ctm) {
    const form = ctx.lookup(ref);
    const own = lookup(ctx, form.dict.get(N('Resources')));
    let ops;
    try {
      ops = await formOperations(ref);
    } catch (e) {
      if (e?.name === 'CancelledError') throw e;
      markUnknown(own);
      return;
    }
    await draw(ops, own, ctm, [ref]);
  }

  if (gaveUp) for (const entry of images.values()) entry.unknown = true;
}

/** Notes that `entry` is drawn with the transform `m`: how many points one of its pixels covers. */
function record(entry, m) {
  if (!(entry.width > 0 && entry.height > 0)) return;
  const across = Math.hypot(m[0], m[1]) / entry.width;
  const down = Math.hypot(m[2], m[3]) / entry.height;
  const extent = Math.max(across, down);
  if (Number.isFinite(extent) && extent > 0) entry.extent = Math.max(entry.extent, extent);
}

/** A page's content streams as one list of operations (an array of streams is read as one). */
async function pageOperations(ctx, node, operationsOf) {
  const contents = lookup(ctx, node.get(N('Contents')));
  if (contents == null) return [];
  if (contents instanceof PDFStream) return operationsOf(contents);
  if (!(contents instanceof PDFArray)) throw new Error('Bad contents');
  // Each part is read on its own: an operator can't be split between them in practice, and graphics
  // state carries over, which a single list keeps.
  const all = [];
  for (const part of contents.asArray()) {
    const s = lookup(ctx, part);
    if (!(s instanceof PDFStream)) continue;
    const ops = await operationsOf(s);
    for (let i = 0; i < ops.length; i++) all.push(ops[i]);
  }
  return all;
}

/**
 * The appearances a page's annotations show (each normal appearance, every state of one with
 * several) and the transform each is drawn with on the page.
 */
function appearances(ctx, node) {
  const out = [];
  const annots = lookup(ctx, node.get(N('Annots')));
  if (!(annots instanceof PDFArray)) return out;
  for (const a of annots.asArray()) {
    const annot = lookup(ctx, a);
    if (!(annot instanceof PDFDict)) continue;
    const ap = lookup(ctx, annot.get(N('AP')));
    if (!(ap instanceof PDFDict)) continue;
    const rect = numbersOf(ctx, annot.get(N('Rect')));
    if (!rect || rect.length < 4) continue;
    const normal = ap.get(N('N'));
    const refs = [];
    if (normal instanceof PDFRef && ctx.lookup(normal) instanceof PDFStream) refs.push(normal);
    else {
      const states = lookup(ctx, normal);
      if (states instanceof PDFDict) for (const [, v] of states.entries()) if (v instanceof PDFRef && ctx.lookup(v) instanceof PDFStream) refs.push(v);
    }
    for (const ref of refs) {
      const form = ctx.lookup(ref);
      const bbox = numbersOf(ctx, form.dict.get(N('BBox')));
      if (!bbox || bbox.length < 4) continue;
      const matrix = matrixOf(ctx, form.dict.get(N('Matrix')));
      const placed = placementMatrix(rect.slice(0, 4), bbox.slice(0, 4), matrix);
      out.push({ ref, ctm: multiply(matrix, placed) });
    }
  }
  return out;
}

function numbersOf(ctx, value) {
  const a = lookup(ctx, value);
  if (!(a instanceof PDFArray)) return undefined;
  const out = a.asArray().map((v) => {
    const n = lookup(ctx, v);
    return n instanceof PDFNumber ? n.asNumber() : NaN;
  });
  return out.every(Number.isFinite) ? out : undefined;
}

/** A /Matrix entry: six numbers, or the identity when it isn't one. */
function matrixOf(ctx, value) {
  const m = numbersOf(ctx, value);
  return m && m.length >= 6 ? m.slice(0, 6) : IDENTITY;
}
