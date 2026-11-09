// Flatten PDF: bakes form fields and annotations into the pages they are on, as they look, so
// nothing can be changed or filled in any more and every viewer shows them the same way. Links
// stay: they aren't something anyone edits, and they keep working. A port of the app's
// Flattening.kt (with PDFBox's form flattening and appearance drawing it relies on).
import { loadPdf, savePdf } from './pdf-common.js';
import { UserError, CancelledError, checkCancelled } from '../core/errors.js';
import { namesArg } from '../core/names.js';
import {
  N, get, getDict, getArray, getName, getNum, getBool, resolve, rectOf, matrixOf, fmt, copyDict,
  latin1, streamData, PDFDict, PDFArray, PDFStream, PDFRef, PDFBool,
} from './flatten/cos.js';
import {
  fieldTree, redrawField, hasValue, normalAppearance, drawable, shown,
} from './flatten/fields.js';
import { constructAppearance } from './flatten/annotations.js';
import { placementMatrix, pageArea } from './flatten/placement.js';
import { fontsUsed } from './flatten/content.js';
import { viewerPages } from './flatten/pages.js';

const FLAG_INVISIBLE = 1;

/** Lets the page paint and take input now and then during long work, and stops when cancelled. */
function ticker(signal) {
  let last = Date.now();
  return async () => {
    checkCancelled(signal);
    if (Date.now() - last > 25) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      last = Date.now();
      checkCancelled(signal);
    }
  };
}

/** What a run shares: the document, its form, fonts read so far, names given to resources. */
function environment(doc) {
  const ctx = doc.context;
  const acroForm = getDict(ctx, doc.catalog, 'AcroForm');
  const standardFonts = new Map();
  let counter = 0;
  const pageResources = new Map();
  const env = {
    doc,
    ctx,
    acroForm,
    drFonts: acroForm ? getDict(ctx, getDict(ctx, acroForm, 'DR'), 'Font') : undefined,
    fontCache: new WeakMap(),
    /** A standard font (WinAnsi, as Acrobat sets its form fonts up), made once per document. */
    standardFont(name) {
      let ref = standardFonts.get(name);
      if (!ref) {
        const symbolic = name === 'Symbol' || name === 'ZapfDingbats';
        ref = ctx.register(ctx.obj({
          Type: 'Font', Subtype: 'Type1', BaseFont: name, ...(symbolic ? {} : { Encoding: 'WinAnsiEncoding' }),
        }));
        standardFonts.set(name, ref);
      }
      return ref;
    },
    /**
     * Adds `value` to the page's resources of kind `kind` ('XObject', 'ExtGState', 'Properties')
     * under a new name, and returns that name. Each page gets resources of its own first: pages
     * often share theirs, and what one page draws shouldn't land in the others'.
     */
    addResource(page, kind, value) {
      let resources = pageResources.get(page);
      if (!resources) {
        resources = copyDict(ctx, inheritedResources(ctx, page.node));
        for (const sub of ['XObject', 'ExtGState', 'Properties', 'Font']) {
          const d = getDict(ctx, resources, sub);
          if (d) resources.set(N(sub), copyDict(ctx, d));
        }
        page.node.set(N('Resources'), resources);
        pageResources.set(page, resources);
      }
      let sub = getDict(ctx, resources, kind);
      if (!sub) {
        sub = ctx.obj({});
        resources.set(N(kind), sub);
      }
      let name;
      do name = `Fl${++counter}`; while (sub.has(N(name)));
      sub.set(N(name), value);
      return name;
    },
  };
  return env;
}

function inheritedResources(ctx, node) {
  let d = node;
  for (let depth = 0; d instanceof PDFDict && depth < 64; depth++) {
    const r = resolve(ctx, d.get(N('Resources')));
    if (r instanceof PDFDict) return r;
    d = resolve(ctx, d.get(N('Parent')));
  }
  return undefined;
}

/** The annotations listed on a page: [{ raw, dict }] (dict undefined for an entry that isn't one). */
function annotationsOf(ctx, page) {
  const annots = resolve(ctx, page.node.get(N('Annots')));
  if (!(annots instanceof PDFArray)) return [];
  const out = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = resolve(ctx, raw);
    out.push({ raw, dict: dict instanceof PDFDict ? dict : undefined });
  }
  return out;
}

function setAnnotations(ctx, page, items) {
  if (items.length) page.node.set(N('Annots'), ctx.obj(items));
  else page.node.delete(N('Annots'));
}

const subtypeOf = (ctx, dict) => getName(ctx, dict, 'Subtype');

/**
 * What an annotation looks like, ready to be drawn into its page: { raw, rect, bbox, matrix }; made,
 * for the kinds viewers draw, when the PDF has none. Null when it has nothing to show.
 */
function appearanceOf(env, annot) {
  const { ctx } = env;
  const rect = rectOf(ctx, annot.get(N('Rect')));
  if (!rect) return null;
  const subtype = subtypeOf(ctx, annot);
  const look = normalAppearance(ctx, annot);
  if (!look) {
    if (subtype === 'Widget') return null;
    const made = constructAppearance(env, annot, subtype, rect);
    if (!made) return null;
    return { raw: made.raw, rect: made.box, bbox: made.box, matrix: [1, 0, 0, 1, 0, 0] };
  }
  const bbox = rectOf(ctx, get(ctx, look.stream, 'BBox'));
  if (!bbox || bbox[2] - bbox[0] <= 0 || bbox[3] - bbox[1] <= 0) return null;
  // Appearances are form XObjects, but some PDFs leave that unsaid: Do needs it said.
  if (!look.stream.dict.has(N('Subtype'))) look.stream.dict.set(N('Subtype'), N('Form'));
  const raw = look.raw instanceof PDFRef ? look.raw : ctx.register(look.stream);
  if (subtype === 'Widget') addFormFonts(env, look.stream);
  return { raw, rect, bbox, matrix: matrixOf(ctx, get(ctx, look.stream, 'Matrix')) };
}

/**
 * A field's appearance may use a font that only the form's resources (/DR) define, which viewers
 * look in for fields: once part of the page, it needs the font among its own resources.
 */
function addFormFonts(env, stream) {
  const { ctx, drFonts } = env;
  if (!drFonts) return;
  const data = streamData(stream);
  if (!data || data.length > 1 << 20) return;
  const used = fontsUsed(latin1(data));
  if (!used.size) return;
  let resources = getDict(ctx, stream, 'Resources');
  let fonts = resources && getDict(ctx, resources, 'Font');
  const missing = [...used].filter((name) => !fonts?.has(N(name)) && drFonts.has(N(name)));
  if (!missing.length) return;
  resources = copyDict(ctx, resources);
  fonts = copyDict(ctx, fonts);
  for (const name of missing) fonts.set(N(name), drFonts.get(N(name)));
  resources.set(N('Font'), fonts);
  stream.dict.set(N('Resources'), resources);
}

/** The content that draws `look` of `annot` where viewers show it, with its opacity and layer. */
function drawOps(env, page, annot, look) {
  const { ctx } = env;
  const m = placementMatrix(look.rect, look.bbox, look.matrix);
  const ops = ['q'];
  let layer = false;
  const oc = annot.get(N('OC'));
  if (oc !== undefined && resolve(ctx, oc) instanceof PDFDict) {
    // A comment on a layer stays on it: hidden when the layer is.
    ops.push(`/OC /${env.addResource(page, 'Properties', oc)} BDC`);
    layer = true;
  }
  // A comment's own opacity (/CA) applies to its whole appearance.
  const opacity = getNum(ctx, annot, 'CA', 1);
  if (opacity >= 0 && opacity <= 0.999) {
    const gs = env.addResource(page, 'ExtGState', ctx.obj({ Type: 'ExtGState', CA: opacity, ca: opacity }));
    ops.push(`/${gs} gs`);
  }
  ops.push(`${m.map(fmt).join(' ')} cm`, `/${env.addResource(page, 'XObject', look.raw)} Do`);
  if (layer) ops.push('EMC');
  ops.push('Q');
  return ops;
}

/** Adds `ops` after the page's content, with the content before it kept in its own q ... Q. */
function appendContent(env, page, ops) {
  const { ctx } = env;
  const contents = page.node.get(N('Contents'));
  const existing = resolve(ctx, contents);
  let items = [];
  if (existing instanceof PDFArray) for (let i = 0; i < existing.size(); i++) items.push(existing.get(i));
  else if (existing instanceof PDFStream) items = [contents instanceof PDFRef ? contents : ctx.register(existing)];
  const body = ops.join('\n') + '\n';
  if (!items.length) {
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(body)));
    return;
  }
  // The page's own drawing may leave the graphics state changed (scaled, turned, clipped).
  const before = ctx.register(ctx.stream('q\n'));
  const after = ctx.register(ctx.flateStream('Q\n' + body));
  page.node.set(N('Contents'), ctx.obj([before, ...items, after]));
}

/** Draws the annotations of `page` that `bake(item)` picks into its content and takes them off. */
function bakeAnnotations(env, page, items, bake, drop = () => false) {
  const { ctx } = env;
  const kept = [];
  const ops = [];
  for (const item of items) {
    if (!item.dict) continue;
    if (!bake(item)) {
      if (!drop(item)) kept.push(item.raw);
      continue;
    }
    const subtype = subtypeOf(ctx, item.dict);
    // Hidden ones aren't seen, so they aren't drawn. A popup is only the window of a comment,
    // which goes with the comment.
    const flags = getNum(ctx, item.dict, 'F', 0);
    if (!shown(ctx, item.dict) || flags & FLAG_INVISIBLE || subtype === 'Popup') continue;
    let look = null;
    try {
      look = appearanceOf(env, item.dict);
    } catch {
      look = null;
    }
    if (look) ops.push(...drawOps(env, page, item.dict, look));
  }
  if (ops.length) appendContent(env, page, ops);
  setAnnotations(ctx, page, kept);
}

/**
 * Draws again the fields that need it: all of them when the form asks viewers to (NeedAppearances),
 * otherwise only those with a widget that has no appearance. Fields that already look right keep
 * the appearance their app gave them. Returns the fields that couldn't be drawn and that have a
 * value but nothing that shows it (a widget with no appearance, or, when the form asks viewers to
 * draw its fields, any appearance at all, which the form itself says is out of date): drawn into
 * the page, they would come out blank or show an older value, so they stay fields.
 */
async function redrawFields(env, nodes, tick, progress) {
  const { ctx, acroForm } = env;
  const all = getBool(ctx, acroForm, 'NeedAppearances');
  const undrawn = [];
  for (const node of nodes) {
    progress();
    if (!all && node.widgets.every((w) => normalAppearance(ctx, w))) continue;
    await tick();
    let failed = false;
    try {
      redrawField(env, node);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      failed = true;
    }
    if (!failed) continue;
    if (hasValue(ctx, node, acroForm)
      && node.widgets.some((w) => shown(ctx, w) && (all || !drawable(ctx, normalAppearance(ctx, w))))) undrawn.push(node);
  }
  return undrawn;
}

/** Takes the fields not in `keep` (dictionaries) off the form, as PDFBox's flatten does. */
function removeFields(env, tree, keep) {
  const { ctx, acroForm } = env;
  const containers = new Map();
  for (const node of tree.all) {
    if (keep.has(node.dict)) continue;
    const owner = node.parent ? node.parent.dict : acroForm;
    const key = node.parent ? 'Kids' : 'Fields';
    const list = getArray(ctx, owner, key);
    if (!list) continue;
    if (!containers.has(list)) containers.set(list, new Set());
    containers.get(list).add(node.dict);
  }
  for (const [list, gone] of containers) {
    for (let i = list.size() - 1; i >= 0; i--) if (gone.has(resolve(ctx, list.get(i)))) list.remove(i);
  }
  // The calculation order lists fields too.
  const co = getArray(ctx, acroForm, 'CO');
  if (co) for (let i = co.size() - 1; i >= 0; i--) if (!keep.has(resolve(ctx, co.get(i)))) co.remove(i);
}

/**
 * Flattens the open document `doc` in place: returns { droppedDynamicXfa, keptFields, pageCount }
 * (its pages as viewers find them; a damaged page tree is mended first). Throws
 * UserError('flatten_nothing') when it has no form fields and no annotations but links, and
 * UserError('flatten_xfa_only') when its only form is a dynamic XFA form, which has no fields.
 * @param {import('../lib/pdf-lib.js').PDFDocument} doc
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 */
export async function flattenDocument(doc, { onProgress, signal } = {}) {
  const tick = ticker(signal);
  const env = environment(doc);
  const { ctx, acroForm } = env;
  const catalog = doc.catalog;
  // The pages viewers find, a damaged page tree mended first, as the app mends it when the PDF is
  // picked (UserError('pdf_import_failed') when it has none to find).
  const pages = viewerPages(doc);
  const tree = fieldTree(ctx, acroForm);
  const hasXfa = !!acroForm && acroForm.get(N('XFA')) !== undefined;
  // A dynamic XFA form draws the pages itself; its AcroForm part, if it has one, is a stand-in.
  const dynamicXfa = hasXfa && (getBool(ctx, catalog, 'NeedsRendering') || tree.all.length === 0);
  const annotated = pages.some((page) => annotationsOf(ctx, page).some((a) => a.dict && subtypeOf(ctx, a.dict) !== 'Link'));
  if (!tree.all.length && !annotated) throw new UserError(dynamicXfa ? 'flatten_xfa_only' : 'flatten_nothing');

  const total = tree.terminals.length + pages.length;
  let done = 0;
  const progress = () => onProgress?.(Math.min(done++, total), total);

  // The widgets of the fields left as they are, which stay on their pages.
  const keptWidgets = new Set();
  let keptFields = 0;
  if (acroForm) {
    if (hasXfa) {
      acroForm.delete(N('XFA'));
      catalog.delete(N('NeedsRendering'));
    }
    if (tree.all.length) {
      // A field whose text can't be drawn and that has no look of its own, or only one the form
      // says is out of date, would come out blank or wrong: it stays a field, value and all, for
      // viewers to draw, rather than be lost.
      const undrawn = await redrawFields(env, tree.terminals, tick, progress);
      const keep = new Set();
      for (const node of undrawn) {
        // Its parents too: taking a parent off the form would take the field with it.
        for (let n = node; n; n = n.parent) keep.add(n.dict);
        for (const w of node.widgets) keptWidgets.add(w);
      }
      removeFields(env, tree, keep);
      if (undrawn.length) acroForm.set(N('NeedAppearances'), PDFBool.True);
      keptFields = undrawn.length;
    } else {
      done += tree.terminals.length;
    }
    // A form with no fields left is no form.
    const fields = getArray(ctx, acroForm, 'Fields');
    if (!fields || fields.size() === 0) catalog.delete(N('AcroForm'));
  }
  // Fields, comments, highlights, drawings, stamps: everything but links and the fields kept.
  for (const page of pages) {
    progress();
    await tick();
    const items = annotationsOf(ctx, page);
    if (!items.length) continue;
    const bake = (item) => subtypeOf(ctx, item.dict) !== 'Link' && !keptWidgets.has(item.dict);
    if (!items.some((item) => item.dict && bake(item))) continue;
    bakeAnnotations(env, page, items, bake);
  }
  onProgress?.(total, total);
  return { droppedDynamicXfa: dynamicXfa, keptFields, pageCount: pages.length };
}

/** The file name a flattened PDF gets: the name asked for, or the original's with "_flattened". */
function outputName(input, options) {
  const wanted = options?.name ?? input.outputName;
  const clean = (s) => s.trim().replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[\s.]+$/, '').replace(/\.pdf$/i, '').replace(/[\s.]+$/, '').replace(/^[\s.]+/, '');
  let name = typeof wanted === 'string' ? clean(wanted) : '';
  if (!name) {
    const original = String(input.name ?? '');
    const dot = original.lastIndexOf('.');
    const base = clean(dot > 0 ? original.slice(0, dot) : original) || 'Usugami';
    name = base + '_flattened';
  }
  return name + '.pdf';
}

/**
 * Flattens a PDF: its filled-in form fields, comments, highlights, drawings and stamps become part
 * of its pages; links keep working. Fields whose text the form's own font can't show and that no
 * app has drawn stay fields (keptFields says how many), so their text isn't lost.
 *
 * @param {{ name: string, bytes: Uint8Array, password?: string, outputName?: string }} input
 * @param {{ name?: string } | { onProgress?: Function, signal?: AbortSignal }} [optionsOrHooks]
 *   the hooks, or (with hooks as the third argument) options: { name } for the file made
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [maybeHooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: 'application/pdf', pageCount: number,
 *   keptFields: number, droppedDynamicXfa: boolean }>}
 */
export async function flattenPdf(input, optionsOrHooks = {}, maybeHooks) {
  const hooks = maybeHooks ?? optionsOrHooks ?? {};
  const options = maybeHooks ? optionsOrHooks : {};
  checkCancelled(hooks.signal);
  const doc = await loadPdf(input.bytes, { password: input.password });
  checkCancelled(hooks.signal);
  let result;
  try {
    result = await flattenDocument(doc, hooks);
  } catch (e) {
    if (e instanceof UserError || e instanceof CancelledError) throw e;
    throw new UserError('pdf_process_failed');
  }
  checkCancelled(hooks.signal);
  let bytes;
  try {
    bytes = await savePdf(doc);
  } catch {
    throw new UserError('pdf_process_failed');
  }
  checkCancelled(hooks.signal);
  return {
    name: outputName(input, options),
    bytes,
    type: 'application/pdf',
    pageCount: result.pageCount,
    keptFields: result.keptFields,
    droppedDynamicXfa: result.droppedDynamicXfa,
  };
}

/**
 * What the app says after Flatten PDF (PdfToolsViewModel's runFlatten and runFlattenAll), as
 * messages to show one after another. `outcomes` lists each PDF in order: { name, result } for
 * one flattened (result: what flattenPdf returned) or { name, error } for one that failed
 * (CancelledError ones are left out). Each message is { key, args } for t(key, ...args), or
 * { key, count, args } for tp(key, count, ...args); an argument may itself be such a message.
 * @param {{ name: string, result?: { keptFields: number, droppedDynamicXfa: boolean }, error?: Error }[]} outcomes
 * @returns {{ key: string, count?: number, args?: any[] }[]}
 */
export function flattenNotes(outcomes) {
  const list = outcomes.filter((o) => !(o.error instanceof CancelledError));
  const keptNote = (n) => ({ key: 'flatten_fields_kept', count: n, args: [n] });
  if (outcomes.length === 1) {
    const [{ result, error }] = outcomes;
    if (error) {
      if (error instanceof CancelledError) return [];
      return [{ key: error instanceof UserError ? error.key : 'pdf_process_failed', args: error instanceof UserError ? error.args : [] }];
    }
    const notes = [];
    if (result.droppedDynamicXfa) notes.push({ key: 'flatten_xfa_dropped', args: [] });
    if (result.keptFields > 0) notes.push(keptNote(result.keptFields));
    return notes;
  }
  // Of several: those that failed first, then what happened to the others; what is said of
  // several files comes once for them all, naming them, in words for them all.
  const messages = [];
  const sayOf = (said) => {
    const groups = new Map();
    for (const item of said) {
      if (!groups.has(item.many)) groups.set(item.many, []);
      groups.get(item.many).push(item);
    }
    for (const group of groups.values()) {
      const text = group.length === 1 ? group[0].one : { key: group[0].many, args: [] };
      messages.push({ key: 'file_problem', args: [namesArg(group.map((g) => g.name)), text] });
    }
  };
  const reasons = [];
  const nothing = [];
  const failed = [];
  for (const { name, error } of list) {
    if (!error) continue;
    if (error instanceof UserError && error.key === 'flatten_nothing') nothing.push(name);
    else if (error instanceof UserError && error.key === 'flatten_xfa_only') {
      reasons.push({ name, one: { key: 'flatten_xfa_only', args: [] }, many: 'flatten_xfa_only_many' });
    } else failed.push(name);
  }
  sayOf(reasons);
  const named = (key, names) => {
    if (names.length) messages.push({ key, count: names.length, args: [names.length, namesArg(names)] });
  };
  named('batch_nothing_to_flatten', nothing);
  named('batch_failed', failed);
  const notes = [];
  for (const { name, result } of list) {
    if (!result) continue;
    if (result.droppedDynamicXfa) notes.push({ name, one: { key: 'flatten_xfa_dropped', args: [] }, many: 'flatten_xfa_dropped_many' });
    if (result.keptFields > 0) notes.push({ name, one: keptNote(result.keptFields), many: 'flatten_fields_kept_many' });
  }
  sayOf(notes);
  return messages;
}

/**
 * Draws into page `pageIndex` of `doc` the annotations seen on it (form fields, comments, stamps;
 * not links) that overlap any of `areas`, each a rectangle in the page's own coordinates (left,
 * bottom, right, top), and takes them off the page, so what Edit PDF and Sign PDF add there goes
 * on top of them. A field drawn this way can't be filled in there any more; its widgets on other
 * pages are left as they are, and so are fields whose text can't be drawn.
 */
export async function bakeUnder(doc, pageIndex, areas, { signal } = {}) {
  const tick = ticker(signal);
  const env = environment(doc);
  const { ctx, acroForm } = env;
  const page = doc.getPages()[pageIndex];
  if (!page) return;
  const items = annotationsOf(ctx, page);
  const overlaps = (r, a) => r[0] < a[2] && a[0] < r[2] && r[1] < a[3] && a[1] < r[3];
  const under = items.filter((item) => {
    if (!item.dict) return false;
    const subtype = subtypeOf(ctx, item.dict);
    if (subtype === 'Link' || subtype === 'Popup' || !shown(ctx, item.dict)) return false;
    const r = rectOf(ctx, item.dict.get(N('Rect')));
    return !!r && areas.some((a) => overlaps(r, a));
  });
  if (!under.length) return;
  await tick();
  // The field each widget belongs to: it is drawn as the preview draws it, then taken off it.
  const tree = fieldTree(ctx, acroForm);
  const fields = [...new Set(under.map((item) => tree.ownerOf.get(item.dict)).filter(Boolean))];
  const undrawn = new Set(acroForm && fields.length ? await redrawFields(env, fields, tick, () => {}) : []);
  const baked = new Set(under.filter((item) => !undrawn.has(tree.ownerOf.get(item.dict))).map((item) => item.dict));
  if (!baked.size) return;
  const isPopupOfBaked = (item) => subtypeOf(ctx, item.dict) === 'Popup' && baked.has(resolve(ctx, item.dict.get(N('Parent'))));
  bakeAnnotations(env, page, items, (item) => baked.has(item.dict), isPopupOfBaked);
  if (!acroForm) return;
  for (const widget of baked) {
    const field = tree.ownerOf.get(widget);
    if (field) detach(env, tree, field, widget);
  }
}

/** Takes `widget` off `field`, and the field off the form once it has no widget left. */
function detach(env, tree, field, widget) {
  const { ctx, acroForm } = env;
  if (widget !== field.dict) {
    const kids = getArray(ctx, field.dict, 'Kids');
    if (kids) {
      for (let i = kids.size() - 1; i >= 0; i--) if (resolve(ctx, kids.get(i)) === widget) kids.remove(i);
      if (kids.size() > 0) return;
    }
  }
  const siblings = field.parent ? getArray(ctx, field.parent.dict, 'Kids') : getArray(ctx, acroForm, 'Fields');
  if (siblings) for (let i = siblings.size() - 1; i >= 0; i--) if (resolve(ctx, siblings.get(i)) === field.dict) siblings.remove(i);
}

export { placementMatrix, pageArea };
