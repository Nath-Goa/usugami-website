// Split PDF, Merge PDF, Reorganize PDF, Delete pages and Rotate PDF (the app's PdfToolsEngine.kt,
// with the choices of PdfToolsViewModel.kt). The PDFs made have no password. Pages left out are
// really gone (see cleanup.js), and the pages kept keep their bookmarks, links, form fields and labels.
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, PDFHexString, PDFNull,
} from '../lib/pdf-lib.js';
import { UserError, PasswordError, CancelledError, checkCancelled } from '../core/errors.js';
import { loadPdf, savePdf, createPdf } from './pdf-common.js';
import {
  parsePageSelection, parseRanges, fixedChunks, pagesToDelete, PageSelectionError, defaultName, partSuffix,
} from './page-selection.js';
// File names as the app makes them (FileNames.kt, ported by the shell), so every tool names its files
// alike. The names these tools give their PDFs are page-selection.js's (defaultName, partSuffix).
import { sanitizeName as sanitize, withSuffixes, uniqueName as unique } from '../core/names.js';
import {
  nm, resolve, dictOf, arrayOf, nameOf, numberOf, textOf, ticker, MAX_DEPTH,
  readPages, repairPageTree, setPages, rotationOf, boxesOf, resourcesOf, inherited, annotationsOf,
  treePairs, withExplicitDestination, Copier, copyPage, newPage, drawnOnly, fieldsElsewhere,
  dropRemovedPages, recountOutline,
} from './cleanup.js';

const PDF = 'application/pdf';
const A4 = { width: 595.27563, height: 841.8898 };

// ---------------------------------------------------------------------------------------------
// Page labels (the app's PageLabeling.kt): the numbers viewers show, such as a book's "iv" before
// its page "1". They are ranges that start at a page's place, so taking pages out or moving them
// would shift every label after them. These keep each page's own label wherever it goes.

/**
 * The label of each of `pages` ({ dict } in order), or null for a page without one of its own: every
 * page of a PDF without labels or whose labels are only the numbers viewers show anyway, and the
 * pages before its first range. Null (not a list) if its labels can't be read: they are then left alone.
 */
function labelsOf(doc, pages) {
  const ctx = doc.context;
  const none = pages.map(() => null);
  const tree = dictOf(ctx, doc.catalog.get(nm('PageLabels')));
  if (!tree) return none;
  const ranges = readLabelRanges(ctx, tree);
  if (!ranges) return null;
  const firstKey = numberOf(ctx, arrayOf(ctx, tree.get(nm('Nums')))?.get(0));
  const first = Number.isInteger(firstKey) ? firstKey : 0;
  // A range always starts at the first page.
  if (!ranges.has(0)) ranges.set(0, { style: 'D', prefix: null, prefixObj: null, start: 1 });
  let range = ranges.get(0);
  let start = 0;
  let plain = true;
  const result = pages.map((_, index) => {
    if (ranges.has(index)) {
      range = ranges.get(index);
      start = index;
    }
    if (index < first) return null;
    const label = { style: range.style, prefix: range.prefix, prefixObj: range.prefixObj, number: range.start + index - start };
    if (label.style !== 'D' || label.prefix || label.number !== index + 1) plain = false;
    return label;
  });
  return plain ? none : result;
}

/** The ranges of a /PageLabels number tree, by the page they start at; null if it is damaged. */
function readLabelRanges(ctx, tree) {
  const ranges = new Map();
  const seen = new Set();
  let damaged = false;
  const visit = (node, depth) => {
    if (!node || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    const kids = arrayOf(ctx, node.get(nm('Kids')));
    if (kids) {
      for (let i = 0; i < kids.size(); i++) visit(dictOf(ctx, kids.get(i)), depth + 1);
      return;
    }
    const nums = arrayOf(ctx, node.get(nm('Nums')));
    if (!nums) return;
    const pairs = [];
    for (let i = 0; i + 1 < nums.size(); i += 2) {
      const key = resolve(ctx, nums.get(i));
      // A node whose keys aren't whole numbers is left out, as PDF libraries do.
      if (!(key instanceof PDFNumber) || !Number.isInteger(key.asNumber())) return;
      const value = dictOf(ctx, nums.get(i + 1));
      if (!value) { damaged = true; return; }
      pairs.push([key.asNumber(), value]);
    }
    for (const [key, value] of pairs) {
      if (key < 0) continue;
      const prefixObj = resolve(ctx, value.get(nm('P')));
      const start = numberOf(ctx, value.get(nm('St')));
      ranges.set(key, {
        style: nameOf(ctx, value.get(nm('S')))?.decodeText() ?? null,
        prefix: textOf(ctx, prefixObj) ?? null,
        prefixObj: prefixObj instanceof PDFString || prefixObj instanceof PDFHexString ? prefixObj : null,
        start: Number.isInteger(start) ? start : 1,
      });
    }
  };
  visit(tree, 0);
  return damaged ? null : ranges;
}

/** `pages`' labels (see labelsOf) by page, added to `into`; those of several PDFs add up. */
function labelsByPage(pages, labels, into = new Map()) {
  pages.forEach((page, i) => { if (labels[i]) into.set(page.dict, labels[i]); });
  return into;
}

/**
 * Gives the document's pages, in their new order, the labels they had. A page without one (a blank
 * page added, a page of a PDF without labels) goes on from the page before it, as it would in that
 * page's range. Without any, viewers number the pages 1, 2, 3...
 */
function restoreLabels(doc, labels) {
  const ctx = doc.context;
  if (!labels.size) {
    doc.catalog.delete(nm('PageLabels'));
    return;
  }
  const nums = PDFArray.withContext(ctx);
  let previous = null;
  readPages(doc).pages.forEach((page, index) => {
    const own = labels.get(page.dict);
    const label = own
      ?? (previous ? { ...previous, number: previous.number + 1 } : { style: 'D', prefix: null, prefixObj: null, number: 1 });
    // Pages numbered on from the page before share its range.
    const continues = previous && label.style === previous.style && label.prefix === previous.prefix
      && (label.style === null || label.number === previous.number + 1);
    if (!continues) {
      const range = PDFDict.withContext(ctx);
      if (label.style !== null) range.set(nm('S'), PDFName.of(label.style));
      if (label.prefix !== null) range.set(nm('P'), label.prefixObj ?? PDFHexString.fromText(label.prefix));
      if (label.style !== null && label.number !== 1) range.set(nm('St'), PDFNumber.of(Math.max(1, label.number)));
      nums.push(PDFNumber.of(index));
      nums.push(range);
    }
    previous = label;
  });
  const tree = PDFDict.withContext(ctx);
  tree.set(nm('Nums'), nums);
  doc.catalog.set(nm('PageLabels'), tree);
}

// ---------------------------------------------------------------------------------------------
// Joining a PDF onto another (what the app gets from PDFBox's PDFMergerUtility.appendDocument)

const isPageOrTree = (ctx, obj) => {
  if (!(obj instanceof PDFDict)) return false;
  const type = nameOf(ctx, obj.get(nm('Type')));
  return type === nm('Page') || type === nm('Pages');
};

/** Key bytes of a name or number tree key, as a string of char codes for sorting. */
function keyBytes(ctx, key) {
  const k = resolve(ctx, key);
  if (k instanceof PDFString || k instanceof PDFHexString || k instanceof PDFName) {
    return String.fromCharCode(...k.asBytes());
  }
  return '';
}

/** A name tree key with " (n)" added, in the encoding of the key it extends. */
function renamedKey(bytes, n) {
  const suffix = ` (${n})`;
  let out = bytes;
  if (bytes.startsWith('\xfe\xff')) for (const ch of suffix) out += '\x00' + ch;
  else out += suffix;
  return out;
}

function hexKey(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes.charCodeAt(i).toString(16).padStart(2, '0');
  return PDFHexString.of(hex);
}

/**
 * Joins PDFs onto `dest`, one after another, as Merge does: each PDF's pages go after those there,
 * and its bookmarks, form fields (renamed when their names clash), named places, attachments,
 * layers, colour profiles and tags come along. Links and bookmarks to named places lead straight to
 * their pages, so names two PDFs share can't mix them up. A dynamic XFA form can't be joined.
 */
class Appender {
  constructor(dest) {
    this.dest = dest;
    this.ctx = dest.context;
    let rootRef = dest.catalog.get(nm('Pages'));
    this.root = dictOf(this.ctx, rootRef);
    if (!this.root) throw new UserError('pdf_import_failed');
    // Pages name their parent by reference.
    if (!(rootRef instanceof PDFRef)) {
      rootRef = this.ctx.register(this.root);
      dest.catalog.set(nm('Pages'), rootRef);
    }
    this.rootRef = rootRef;
    this.struct = null;
  }

  /** Appends `source`'s pages and what comes with them; returns the new pages ([{ ref, dict }]). */
  async append(source, tick) {
    const { ctx } = this;
    const srcCtx = source.context;
    const srcPages = readPages(source).pages;
    if (!srcPages.length) throw new UserError('pdf_import_failed');
    const srcForm = dictOf(srcCtx, source.catalog.get(nm('AcroForm')));
    if (srcForm?.has(nm('XFA')) && !(arrayOf(srcCtx, srcForm.get(nm('Fields')))?.size() > 0)) {
      // A form drawn by XFA alone: its pages are placeholders, and there is nothing to join.
      throw new UserError('pdf_process_failed');
    }
    const srcStructRoot = dictOf(srcCtx, source.catalog.get(nm('StructTreeRoot')));
    const srcParentTree = srcStructRoot ? treePairs(srcCtx, srcStructRoot.get(nm('ParentTree')), 'Nums') : [];
    const merging = srcParentTree.length > 0;
    if (merging && !this.struct) this.struct = new StructMerge(this.dest);
    const offset = merging ? this.struct.prepare() : 0;

    const pageRefs = new Map(srcPages.map((p) => [p.dict, ctx.nextRef()]));
    const copier = new Copier(srcCtx, ctx, {
      redirect: (obj) => {
        const ref = pageRefs.get(obj);
        if (ref) return ref;
        if (obj === source.catalog || isPageOrTree(srcCtx, obj)) return null;
        if (obj === srcStructRoot) return merging ? this.struct.rootRef : null;
        return undefined;
      },
      transform: (dict) => withExplicitDestination(source, dict),
    });

    const added = [];
    const annotations = new Set();
    for (const { dict } of srcPages) {
      await tick();
      const ref = pageRefs.get(dict);
      const page = copyPage(copier, dict, ref, this.rootRef, { skip: merging ? [] : ['StructParents'] });
      added.push({ ref, dict: page });
      annotationsOf(ctx, page, annotations);
    }
    // The tags' numbers go on from those already there; without tags to join, they mean nothing.
    const renumber = (target, key) => {
      const n = numberOf(ctx, target.get(nm(key)));
      if (n === undefined) return;
      if (merging) target.set(nm(key), PDFNumber.of(n + offset));
      else target.delete(nm(key));
    };
    for (const { dict } of added) renumber(dict, 'StructParents');
    for (const annotation of annotations) renumber(annotation, 'StructParent');

    this.mergeForm(copier, source, srcForm);
    this.mergeNames(copier, source);
    this.appendOutline(copier, source);
    this.mergeCatalog(copier, source, merging);
    if (merging) this.struct.add(copier, srcStructRoot, srcParentTree, offset);

    const kids = arrayOf(ctx, this.root.get(nm('Kids'))) ?? PDFArray.withContext(ctx);
    for (const { ref } of added) kids.push(ref);
    this.root.set(nm('Kids'), kids);
    this.root.set(nm('Count'), PDFNumber.of((numberOf(ctx, this.root.get(nm('Count'))) ?? 0) + added.length));
    return added;
  }

  /** Puts right what is counted over all the PDFs joined: bookmark counts, the tags' parent tree. */
  finish() {
    const outline = dictOf(this.ctx, this.dest.catalog.get(nm('Outlines')));
    if (outline) recountOutline(this.ctx, outline);
    this.struct?.write();
  }

  mergeForm(copier, source, srcForm) {
    const { ctx } = this;
    if (!srcForm) return;
    const srcCtx = source.context;
    let destForm = dictOf(ctx, this.dest.catalog.get(nm('AcroForm')));
    if (!destForm) {
      // An XFA form describes only the PDF it came with, and holds its fields' values again.
      const raw = source.catalog.get(nm('AcroForm'));
      // References to the form, rare as they are, lead to its copy.
      let ref = raw instanceof PDFRef ? copier.refs.get(raw) ?? ctx.nextRef() : undefined;
      if (ref) copier.map(raw, ref);
      destForm = copier.copyEntries(srcForm, PDFDict.withContext(ctx), new Set(['XFA']));
      if (ref) ctx.assign(ref, destForm);
      else ref = ctx.register(destForm);
      this.dest.catalog.set(nm('AcroForm'), ref);
      return;
    }
    const srcFields = arrayOf(srcCtx, srcForm.get(nm('Fields')));
    if (srcFields?.size()) {
      let destFields = arrayOf(ctx, destForm.get(nm('Fields')));
      if (!destFields) {
        destFields = PDFArray.withContext(ctx);
        destForm.set(nm('Fields'), destFields);
      }
      const taken = new Set();
      for (let i = 0; i < destFields.size(); i++) {
        const name = textOf(ctx, dictOf(ctx, destFields.get(i))?.get(nm('T')));
        if (name !== undefined) taken.add(name);
      }
      for (let i = 0; i < srcFields.size(); i++) {
        const copied = copier.copy(srcFields.get(i));
        const field = dictOf(ctx, copied);
        if (!field) continue;
        const name = textOf(ctx, field.get(nm('T')));
        if (name !== undefined) {
          // Two PDFs' fields of one name would be filled in together.
          let unique = name;
          for (let n = 2; taken.has(unique); n++) unique = `${name}_${n}`;
          if (unique !== name) field.set(nm('T'), PDFHexString.fromText(unique));
          taken.add(unique);
        }
        destFields.push(copied);
      }
    }
    // The fonts and the like its fields are drawn with.
    const srcDr = dictOf(srcCtx, srcForm.get(nm('DR')));
    if (srcDr) {
      const destDr = dictOf(ctx, destForm.get(nm('DR')));
      if (!destDr) destForm.set(nm('DR'), copier.copy(srcForm.get(nm('DR'))));
      else {
        for (const [kind, value] of srcDr.entries()) {
          const srcKind = dictOf(srcCtx, value);
          const destKind = dictOf(ctx, destDr.get(kind));
          if (!destKind || !srcKind) {
            if (!destDr.has(kind)) destDr.set(kind, copier.copy(value));
            continue;
          }
          for (const [name, item] of srcKind.entries()) if (!destKind.has(name)) destKind.set(name, copier.copy(item));
        }
      }
    }
    if (resolve(srcCtx, srcForm.get(nm('NeedAppearances')))?.asBoolean?.()) destForm.set(nm('NeedAppearances'), ctx.obj(true));
    const srcOrder = arrayOf(srcCtx, srcForm.get(nm('CO')));
    if (srcOrder?.size()) {
      let order = arrayOf(ctx, destForm.get(nm('CO')));
      if (!order) destForm.set(nm('CO'), (order = PDFArray.withContext(ctx)));
      for (let i = 0; i < srcOrder.size(); i++) {
        const copied = copier.copy(srcOrder.get(i));
        if (copied !== undefined) order.push(copied);
      }
    }
  }

  /** The source's name trees (named places, attachments, scripts...) joined into the document's. */
  mergeNames(copier, source) {
    const { ctx } = this;
    const srcCtx = source.context;
    const srcNames = dictOf(srcCtx, source.catalog.get(nm('Names')));
    if (srcNames) {
      let destNames = dictOf(ctx, this.dest.catalog.get(nm('Names')));
      for (const [kind, value] of srcNames.entries()) {
        const srcPairs = treePairs(srcCtx, value);
        if (!srcPairs.length) continue;
        if (!destNames) {
          destNames = PDFDict.withContext(ctx);
          this.dest.catalog.set(nm('Names'), ctx.register(destNames));
        }
        const merged = treePairs(ctx, destNames.get(kind)).map(([k, v]) => [keyBytes(ctx, k), v]);
        const taken = new Set(merged.map(([k]) => k));
        for (const [key, raw] of srcPairs) {
          const copied = copier.copy(raw);
          if (copied === undefined) continue;
          const bytes = keyBytes(srcCtx, key);
          let unique = bytes;
          for (let n = 2; taken.has(unique); n++) unique = renamedKey(bytes, n);
          taken.add(unique);
          merged.push([unique, copied]);
        }
        merged.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const list = PDFArray.withContext(ctx);
        for (const [k, v] of merged) {
          list.push(hexKey(k));
          list.push(v);
        }
        const tree = PDFDict.withContext(ctx);
        tree.set(nm('Names'), list);
        destNames.set(kind, ctx.register(tree));
      }
    }
    // The old-style dictionary of named places.
    const srcDests = dictOf(srcCtx, source.catalog.get(nm('Dests')));
    if (srcDests) {
      const destDests = dictOf(ctx, this.dest.catalog.get(nm('Dests')));
      if (!destDests) this.dest.catalog.set(nm('Dests'), copier.copy(source.catalog.get(nm('Dests'))));
      else for (const [name, value] of srcDests.entries()) if (!destDests.has(name)) destDests.set(name, copier.copy(value));
    }
  }

  /** The source's bookmarks, after the document's last. */
  appendOutline(copier, source) {
    const { ctx } = this;
    const srcCtx = source.context;
    const srcRoot = dictOf(srcCtx, source.catalog.get(nm('Outlines')));
    let itemRaw = srcRoot?.get(nm('First'));
    if (!dictOf(srcCtx, itemRaw)) return;
    let destRootRef = this.dest.catalog.get(nm('Outlines'));
    let destRoot = dictOf(ctx, destRootRef);
    if (!destRoot) {
      destRoot = PDFDict.withContext(ctx);
      destRoot.set(nm('Type'), nm('Outlines'));
      destRootRef = ctx.register(destRoot);
      this.dest.catalog.set(nm('Outlines'), destRootRef);
    } else if (!(destRootRef instanceof PDFRef)) {
      destRootRef = ctx.register(destRoot);
      this.dest.catalog.set(nm('Outlines'), destRootRef);
    }
    // The last bookmark there; /Last is sometimes wrong, so the list is walked.
    let lastRef = destRoot.get(nm('First'));
    let last = dictOf(ctx, lastRef);
    const seenDest = new Set();
    while (last && !seenDest.has(last)) {
      seenDest.add(last);
      const nextRef = last.get(nm('Next'));
      const next = dictOf(ctx, nextRef);
      if (!next) break;
      lastRef = nextRef;
      last = next;
    }
    const seen = new Set();
    let item = dictOf(srcCtx, itemRaw);
    while (item && !seen.has(item)) {
      seen.add(item);
      const nextRaw = item.get(nm('Next'));
      // Without its siblings and parent, which the bookmarks there replace.
      const alone = item.clone(srcCtx);
      for (const key of ['Prev', 'Next', 'Parent']) alone.delete(nm(key));
      const ref = copier.copyAs(itemRaw instanceof PDFRef ? itemRaw : null, alone);
      const copy = ctx.lookup(ref);
      copy.set(nm('Parent'), destRootRef);
      if (last) {
        last.set(nm('Next'), ref);
        copy.set(nm('Prev'), lastRef);
      } else destRoot.set(nm('First'), ref);
      last = copy;
      lastRef = ref;
      itemRaw = nextRaw;
      item = dictOf(srcCtx, nextRaw);
    }
    destRoot.set(nm('Last'), lastRef);
  }

  /** The rest of the catalog: what the document lacks is taken from the source. */
  mergeCatalog(copier, source, mergingTags) {
    const { ctx } = this;
    const srcCtx = source.context;
    const src = source.catalog;
    const dest = this.dest.catalog;
    const take = (key) => {
      if (!dest.has(nm(key)) && src.has(nm(key))) {
        const copied = copier.copy(src.get(nm(key)));
        if (copied !== undefined) dest.set(nm(key), copied);
      }
    };
    take('PageMode');
    take('Metadata');
    take('OpenAction');
    // Layers: the lists of each are joined.
    const srcLayers = dictOf(srcCtx, src.get(nm('OCProperties')));
    if (srcLayers) {
      const destLayers = dictOf(ctx, dest.get(nm('OCProperties')));
      if (!destLayers) take('OCProperties');
      else cloneMerge(copier, srcCtx, ctx, srcLayers, destLayers, 0);
    }
    // Colour profiles, one of each kind.
    const srcIntents = arrayOf(srcCtx, src.get(nm('OutputIntents')));
    if (srcIntents?.size()) {
      let intents = arrayOf(ctx, dest.get(nm('OutputIntents')));
      if (!intents) dest.set(nm('OutputIntents'), (intents = PDFArray.withContext(ctx)));
      const ids = new Set();
      for (let i = 0; i < intents.size(); i++) ids.add(textOf(ctx, dictOf(ctx, intents.get(i))?.get(nm('OutputConditionIdentifier'))));
      for (let i = 0; i < srcIntents.size(); i++) {
        const id = textOf(srcCtx, dictOf(srcCtx, srcIntents.get(i))?.get(nm('OutputConditionIdentifier')));
        if (id !== undefined && id !== 'Custom' && ids.has(id)) continue;
        const copied = copier.copy(srcIntents.get(i));
        if (copied !== undefined) intents.push(copied);
        ids.add(id);
      }
    }
    // Document details the document doesn't have yet.
    const srcInfo = dictOf(srcCtx, srcCtx.trailerInfo.Info);
    if (srcInfo) {
      let info = dictOf(ctx, ctx.trailerInfo.Info);
      if (!info) {
        info = PDFDict.withContext(ctx);
        ctx.trailerInfo.Info = ctx.register(info);
      }
      for (const [key, value] of srcInfo.entries()) {
        if (info.has(key)) continue;
        const copied = copier.copy(value);
        if (copied !== undefined) info.set(key, copied);
      }
    }
    if (mergingTags) {
      take('Lang');
      take('ViewerPreferences');
      const srcMark = dictOf(srcCtx, src.get(nm('MarkInfo')));
      const destMark = dictOf(ctx, dest.get(nm('MarkInfo')));
      if (!destMark) take('MarkInfo');
      else if (resolve(srcCtx, srcMark?.get(nm('Marked')))?.asBoolean?.()) destMark.set(nm('Marked'), ctx.obj(true));
    }
  }
}

/** Adds to `dest` what `src` has: missing entries copied, lists joined, dictionaries merged alike. */
function cloneMerge(copier, srcCtx, ctx, src, dest, depth) {
  if (depth > MAX_DEPTH) return;
  for (const [key, value] of src.entries()) {
    const d = resolve(ctx, dest.get(key));
    const s = resolve(srcCtx, value);
    if (d === undefined) {
      const copied = copier.copy(value);
      if (copied !== undefined) dest.set(key, copied);
    } else if (d instanceof PDFArray && s instanceof PDFArray) {
      for (let i = 0; i < s.size(); i++) {
        const copied = copier.copy(s.get(i));
        if (copied !== undefined) d.push(copied);
      }
    } else if (d instanceof PDFDict && s instanceof PDFDict) {
      cloneMerge(copier, srcCtx, ctx, s, d, depth + 1);
    }
  }
}

/**
 * The tags (structure tree) of the PDFs joined: each tagged PDF's elements go under the document's
 * root, its parent tree's keys and its pages' and annotations' numbers moved past those already there.
 */
class StructMerge {
  constructor(dest) {
    this.dest = dest;
    this.ctx = dest.context;
    this.rootRef = null;
    this.root = null;
    this.pairs = new Map();
    this.kids = [];
    this.nextKey = 0;
    this.changed = false;
    const raw = dest.catalog.get(nm('StructTreeRoot'));
    const root = dictOf(this.ctx, raw);
    if (root) this.adopt(raw, root);
  }

  adopt(raw, root) {
    const { ctx } = this;
    this.root = root;
    this.rootRef = raw instanceof PDFRef ? raw : ctx.register(root);
    if (!(raw instanceof PDFRef)) this.dest.catalog.set(nm('StructTreeRoot'), this.rootRef);
    let max = -1;
    for (const [key, value] of treePairs(ctx, root.get(nm('ParentTree')), 'Nums')) {
      if (!(key instanceof PDFNumber)) continue;
      this.pairs.set(key.asNumber(), value);
      max = Math.max(max, key.asNumber());
    }
    const next = numberOf(ctx, root.get(nm('ParentTreeNextKey')));
    this.nextKey = Number.isInteger(next) && next > max ? next : max + 1;
    const k = resolve(ctx, root.get(nm('K')));
    if (k instanceof PDFArray) for (let i = 0; i < k.size(); i++) this.kids.push(k.get(i));
    else if (k !== undefined && k !== PDFNull) this.kids.push(root.get(nm('K')));
  }

  /** Readies the document's tags for another PDF's; returns the number its keys start at. */
  prepare() {
    const { ctx } = this;
    if (!this.root) {
      const root = PDFDict.withContext(ctx);
      root.set(nm('Type'), nm('StructTreeRoot'));
      const ref = ctx.register(root);
      this.dest.catalog.set(nm('StructTreeRoot'), ref);
      this.adopt(ref, root);
      // Pages there without tags have numbers that lead nowhere now.
      for (const { dict } of readPages(this.dest).pages) {
        dict.delete(nm('StructParents'));
        for (const a of annotationsOf(ctx, dict, new Set())) a.delete(nm('StructParent'));
      }
    }
    return this.nextKey;
  }

  add(copier, srcRoot, srcPairs, offset) {
    const { ctx } = this;
    const srcCtx = copier.src;
    let max = -1;
    for (const [key, value] of srcPairs) {
      if (!(key instanceof PDFNumber) || key.asNumber() < 0) continue;
      const copied = copier.copy(value);
      if (copied === undefined) continue;
      this.pairs.set(offset + key.asNumber(), copied);
      max = Math.max(max, key.asNumber());
    }
    this.nextKey = offset + max + 1;
    const k = resolve(srcCtx, srcRoot.get(nm('K')));
    const items = k instanceof PDFArray ? k.asArray() : k !== undefined && k !== PDFNull ? [srcRoot.get(nm('K'))] : [];
    for (const item of items) {
      const copied = copier.copy(item);
      if (copied === undefined) continue;
      const element = dictOf(ctx, copied);
      if (element) element.set(nm('P'), this.rootRef);
      this.kids.push(copied);
    }
    // Role and class maps: what the document lacks.
    for (const kind of ['RoleMap', 'ClassMap']) {
      const srcMap = dictOf(srcCtx, srcRoot.get(nm(kind)));
      if (!srcMap) continue;
      let map = dictOf(ctx, this.root.get(nm(kind)));
      if (!map) this.root.set(nm(kind), (map = PDFDict.withContext(ctx)));
      for (const [name, value] of srcMap.entries()) {
        if (map.has(name)) continue;
        const copied = copier.copy(value);
        if (copied !== undefined) map.set(name, copied);
      }
    }
    // The index of elements by ID.
    const ids = treePairs(srcCtx, srcRoot.get(nm('IDTree')));
    if (ids.length) {
      const merged = treePairs(ctx, this.root.get(nm('IDTree'))).map(([key, v]) => [keyBytes(ctx, key), v]);
      const taken = new Set(merged.map(([key]) => key));
      for (const [key, value] of ids) {
        const bytes = keyBytes(srcCtx, key);
        const copied = copier.copy(value);
        if (copied === undefined || taken.has(bytes)) continue;
        taken.add(bytes);
        merged.push([bytes, copied]);
      }
      merged.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const list = PDFArray.withContext(ctx);
      for (const [key, v] of merged) {
        list.push(hexKey(key));
        list.push(v);
      }
      const tree = PDFDict.withContext(ctx);
      tree.set(nm('Names'), list);
      this.root.set(nm('IDTree'), ctx.register(tree));
    }
    this.changed = true;
  }

  write() {
    if (!this.changed) return;
    const { ctx } = this;
    const nums = PDFArray.withContext(ctx);
    for (const key of [...this.pairs.keys()].sort((a, b) => a - b)) {
      nums.push(PDFNumber.of(key));
      nums.push(this.pairs.get(key));
    }
    const tree = PDFDict.withContext(ctx);
    tree.set(nm('Nums'), nums);
    this.root.set(nm('ParentTree'), ctx.register(tree));
    this.root.set(nm('ParentTreeNextKey'), PDFNumber.of(this.nextKey));
    const kids = PDFArray.withContext(ctx);
    for (const kid of this.kids) kids.push(kid);
    this.root.set(nm('K'), kids);
  }
}

// ---------------------------------------------------------------------------------------------
// Running the tools

/** Problems the screens can explain pass through; anything else is "Couldn't process this PDF". */
async function guarded(work) {
  try {
    return await work();
  } catch (e) {
    if (e instanceof UserError || e instanceof PasswordError || e instanceof CancelledError) throw e;
    const error = new UserError('pdf_process_failed');
    error.cause = e;
    throw error;
  }
}

function checkInput(input) {
  if (!input || !(input.bytes instanceof Uint8Array)) throw new Error('A PDF is needed: { name, bytes, password }');
}

async function open(input, tick) {
  checkInput(input);
  await tick();
  const doc = await loadPdf(input.bytes, { password: input.password || undefined });
  await tick();
  return doc;
}

function progress(hooks, total) {
  let done = 0;
  return (steps = 1) => {
    done = Math.min(total, done + steps);
    hooks?.onProgress?.(done, total);
  };
}

const floorMod = (a, b) => ((a % b) + b) % b;

function checkTurn(degrees) {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) throw new Error(`Pages turn by quarter turns, not ${degrees}`);
}

function turn(ctx, page, degrees) {
  if (!degrees) return;
  page.set(nm('Rotate'), PDFNumber.of(floorMod(rotationOf(ctx, page) + degrees, 360)));
}

function output(name, bytes, pageCount, inputs) {
  const file = { name: `${name}.pdf`, bytes, type: PDF, pageCount };
  // The screen says so, as the app does ("The new PDF has no password").
  if (inputs.some((i) => i?.password)) file.passwordRemoved = true;
  return file;
}

/**
 * The parts Split makes for its choices, as zero-based page lists (the view model's runSplit):
 * mode 'selected' ("Selected pages", `pages` typed like "1,3,5-8"), 'custom' ("Custom ranges",
 * `pages` like "1-3;5;7-9"), 'fixed' ("Fixed chunks", `pagesPerFile` as typed or a number) or
 * 'every' ("Every page"). With `combine` (on unless false, as on the app's screen), the selected
 * pages or all ranges make one PDF. Throws PageSelectionError (a UserError) saying what is wrong
 * with the pages typed.
 * @param {{ mode: string, pages?: string, pagesPerFile?: string|number, combine?: boolean }} options
 * @param {number} pageCount
 * @returns {number[][]}
 */
export function splitGroups(options, pageCount) {
  const mode = String(options?.mode ?? 'selected').toLowerCase().replace('every_page', 'every');
  const text = options?.pages ?? options?.text ?? '';
  const combine = options?.combine !== false;
  switch (mode) {
    case 'selected': {
      const selected = parsePageSelection(text, pageCount);
      return combine ? [selected] : selected.map((page) => [page]);
    }
    case 'custom': {
      const ranges = parseRanges(text, pageCount);
      return combine ? [ranges.flat()] : ranges;
    }
    case 'fixed': return fixedChunks(pageCount, options.pagesPerFile ?? text);
    case 'every': return fixedChunks(pageCount, 1);
    default: throw new Error(`Unknown split mode ${options?.mode}`);
  }
}

/**
 * Split PDF: a PDF of each part. Each part holds only its own pages: links between them still
 * work, links to pages left out lead nowhere, and nothing of the other pages (their text, pictures,
 * form values) comes along. Form fields on its pages stay fillable.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {{ groups?: number[][], mode?: string, pages?: string, pagesPerFile?: string|number,
 *           combine?: boolean, fileName?: string }} options
 *   `groups` (zero-based page lists) or the screen's choices (see splitGroups). `fileName` is the
 *   name typed, without ".pdf" (default: defaultName('split', input)); parts add "_1_1-3" and so on.
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<Array<{ name: string, bytes: Uint8Array, type: string, pageCount: number }>>}
 */
export function splitPdf(input, options = {}, hooks = {}) {
  return guarded(async () => {
    const tick = ticker(hooks.signal);
    const src = await open(input, tick);
    const ctx = src.context;
    const pages = readPages(src).pages;
    if (!pages.length) throw new UserError('pdf_import_failed');
    const groups = options.groups ?? splitGroups(options, pages.length);
    if (!Array.isArray(groups) || !groups.length || groups.some((g) => !Array.isArray(g) || !g.length)) {
      throw new UserError('pdf_invalid_pages');
    }
    for (const group of groups) {
      for (const p of group) if (!Number.isInteger(p) || p < 0 || p >= pages.length) throw new PageSelectionError('OUT_OF_RANGE', pages.length);
    }
    const base = options.fileName ?? defaultName('split', { name: input.name, pageCount: pages.length });
    // A long name is cut the same for every part, so their names begin alike, and their numbers and pages stay whole.
    const names = withSuffixes(base, groups.length === 1 ? [''] : groups.map((g, i) => partSuffix(i, g)), 'Split');
    const step = progress(hooks, groups.reduce((n, g) => n + g.length + 1, 0));

    // Read once for all the parts: the pages, and the annotations on them.
    const sourcePages = new Set(pages.map((p) => p.dict));
    const annotations = new Set();
    const annotationsByPage = new Map();
    for (const { dict } of pages) {
      const own = annotationsOf(ctx, dict, new Set());
      annotationsByPage.set(dict, own);
      for (const a of own) annotations.add(a);
    }
    const resourcesCache = new Map();
    const resourcesFor = (page) => {
      if (!resourcesCache.has(page)) {
        const raw = inherited(ctx, page, nm('Resources'));
        const resources = dictOf(ctx, raw);
        // Its resources listing only the pictures and forms it draws: pages often share one list
        // that holds every page's.
        const own = resources ? drawnOnly(ctx, page, resources) : undefined;
        resourcesCache.set(page, own === resources ? raw : own);
      }
      return resourcesCache.get(page);
    };

    const taken = new Set();
    const outputs = [];
    for (const [index, group] of groups.entries()) {
      await tick();
      const name = unique(names[index], taken);
      taken.add(name);
      const dest = await createPdf();
      const destCtx = dest.context;
      const rootRef = dest.catalog.get(nm('Pages'));
      // Each page's copy in the part, by the page, for the links between them.
      const copies = new Map();
      const refs = group.map((p) => {
        const ref = destCtx.nextRef();
        copies.set(pages[p].dict, ref);
        return [p, ref];
      });
      const kept = new Set();
      for (const p of group) for (const a of annotationsByPage.get(pages[p].dict)) kept.add(a);
      const { owners, others } = fieldsElsewhere(ctx, kept);
      // References to the part's own pages lead to their copies; those to the other pages, their
      // annotations and the form fields of other pages are cut.
      const copier = new Copier(ctx, destCtx, {
        redirect: (obj) => {
          const copy = copies.get(obj);
          if (copy) return copy;
          if (sourcePages.has(obj) || obj === src.catalog || isPageOrTree(ctx, obj)) return null;
          if ((annotations.has(obj) && !kept.has(obj)) || others.has(obj)) return null;
          return undefined;
        },
        transform: (dict) => withExplicitDestination(src, dict),
      });
      for (const [p, ref] of refs) {
        await tick();
        copyPage(copier, pages[p].dict, ref, rootRef, { resources: resourcesFor(pages[p].dict) });
        step();
      }
      const root = destCtx.lookup(rootRef);
      root.set(nm('Kids'), destCtx.obj(refs.map(([, ref]) => ref)));
      root.set(nm('Count'), PDFNumber.of(refs.length));
      copyPartForm(src, dest, copier, kept, owners);
      await tick();
      outputs.push(output(name, await savePdf(dest), group.length, [input]));
      step();
    }
    return outputs;
  });
}

/** The form of a part of a split: the fields whose widgets are on its pages. */
function copyPartForm(src, dest, copier, kept, owners) {
  const ctx = src.context;
  const form = dictOf(ctx, src.catalog.get(nm('AcroForm')));
  const fields = arrayOf(ctx, form?.get(nm('Fields')));
  if (!fields) return;
  const tops = new Set();
  for (const a of kept) {
    if (nameOf(ctx, a.get(nm('Subtype'))) !== nm('Widget')) continue;
    let top = a;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const parent = dictOf(ctx, top.get(nm('Parent')));
      if (!parent) break;
      top = parent;
    }
    tops.add(top);
  }
  if (!tops.size) return;
  const destCtx = dest.context;
  const partFields = PDFArray.withContext(destCtx);
  for (let i = 0; i < fields.size(); i++) {
    if (!tops.has(dictOf(ctx, fields.get(i)))) continue;
    const copied = copier.copy(fields.get(i));
    if (copied !== undefined) partFields.push(copied);
  }
  if (!partFields.size()) return;
  const partForm = PDFDict.withContext(destCtx);
  partForm.set(nm('Fields'), partFields);
  for (const key of ['DA', 'DR', 'Q', 'NeedAppearances']) {
    if (!form.has(nm(key))) continue;
    const copied = copier.copy(form.get(nm(key)));
    if (copied !== undefined) partForm.set(nm(key), copied);
  }
  dest.catalog.set(nm('AcroForm'), destCtx.register(partForm));
}

/** Finds a page reference's PDF: by `id` when the PDFs have ids, otherwise by place in the list. */
function sourceIndex(list, key) {
  if (list.some((item) => item?.id !== undefined)) return list.findIndex((item) => item?.id === key);
  return Number.isInteger(key) && key >= 0 && key < list.length ? key : -1;
}

/**
 * Merge PDF: the PDFs joined in order, with their bookmarks, links, form fields (renamed when two
 * PDFs' names clash), page labels and tags. With `pages` (page mode), only those pages, in that
 * order, each turned by its `rotation` more; the pages left out are gone from the file, their
 * bookmarks and fields too.
 * @param {Array<{ name: string, bytes: Uint8Array, password?: string, id?: any }>} inputs  at least two
 * @param {{ pages?: Array<{ input: any, page: number, rotation?: number }> | null, fileName?: string }} options
 *   `input` is the id of one of `inputs` (when they have ids) or its place in `inputs`; `page` is zero-based.
 *   `fileName` without ".pdf" (default "Merged_PDF").
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: string, pageCount: number }>}
 */
export function mergePdfs(inputs, options = {}, hooks = {}) {
  return guarded(async () => {
    const tick = ticker(hooks.signal);
    if (!Array.isArray(inputs) || inputs.length < 2) throw new UserError('pdf_need_two');
    inputs.forEach(checkInput);
    const refs = options.pages ?? null;
    if (refs !== null && (!Array.isArray(refs) || !refs.length)) throw new UserError('pdf_need_page');
    const step = progress(hooks, inputs.length + (refs ? 2 : 1));
    const name = sanitize(options.fileName ?? defaultName('merge'), 'Merged');
    const dest = await createPdf();
    const appender = new Appender(dest);
    const offsets = [];
    const counts = [];
    // Each PDF's own page labels, read before it is joined, and given back once the pages are in place.
    const labels = new Map();
    for (const input of inputs) {
      const source = await open(input, tick);
      const own = labelsOf(source, readPages(source).pages);
      offsets.push(readPages(dest).pages.length);
      const added = await appender.append(source, tick);
      counts.push(added.length);
      if (own) labelsByPage(added, own, labels);
      step();
    }
    appender.finish();
    if (refs) {
      await tick();
      const originals = readPages(dest).pages;
      const used = new Set();
      const order = refs.map((ref) => {
        const which = sourceIndex(inputs, ref?.input);
        if (which < 0 || !Number.isInteger(ref.page) || ref.page < 0 || ref.page >= counts[which]) {
          throw new Error(`No page ${ref?.page} in PDF ${ref?.input}`);
        }
        const page = originals[offsets[which] + ref.page];
        if (used.has(page)) throw new Error('A page can be merged once');
        used.add(page);
        checkTurn(ref.rotation ?? 0);
        turn(dest.context, page.dict, ref.rotation ?? 0);
        return page;
      });
      setPages(dest, order);
      // Bookmarks, links and form fields of the pages left out mustn't carry them into the file.
      await dropRemovedPages(dest, originals.map((p) => p.dict), tick);
      step();
    }
    restoreLabels(dest, labels);
    await tick();
    const bytes = await savePdf(dest);
    step();
    return output(name, bytes, readPages(dest).pages.length, inputs);
  });
}

/**
 * Reorganize PDF: `input` with its pages as `plan` lists them: its own pages, pages of `extraInputs`
 * (other PDFs the user added) and blank pages, each turned by its `rotation` more. Pages left out are
 * gone as Delete pages removes them. The PDF's bookmarks, form, tags and document details are kept;
 * an added PDF's come along with its pages, as in Merge. Each page keeps its label.
 * @param {{ name: string, bytes: Uint8Array, password?: string, id?: any }} input
 * @param {Array<object> | { pages: Array<object>, fileName?: string }} plan
 *   The pages in order: `{ page, rotation? }` for the PDF's own page `page` (zero-based),
 *   `{ input, page, rotation? }` for a page of one of `extraInputs` (its id, or its place in the list;
 *   `input` null or the PDF's own id means the PDF itself), `{ blank: true, width, height, rotation? }`
 *   for a blank page of that size in points. `fileName` without ".pdf" (default: defaultName('reorganize', input)).
 * @param {Array<{ name: string, bytes: Uint8Array, password?: string, id?: any }>} [extraInputs]
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: string, pageCount: number }>}
 */
export function reorganizePdf(input, plan, extraInputs = [], hooks = {}) {
  return guarded(async () => {
    const tick = ticker(hooks.signal);
    const refs = Array.isArray(plan) ? plan : plan?.pages;
    if (!Array.isArray(refs) || !refs.length) throw new UserError('pdf_need_page');
    const extras = extraInputs ?? [];
    extras.forEach(checkInput);
    const which = (ref) => {
      if (ref.blank) return 'blank';
      if (ref.input === undefined || ref.input === null || (input.id !== undefined && ref.input === input.id)) return -1;
      const i = sourceIndex(extras, ref.input);
      if (i < 0) throw new Error(`No PDF ${ref.input} among those added`);
      return i;
    };
    const used = [...new Set(refs.map(which).filter((w) => w !== 'blank' && w >= 0))].sort((a, b) => a - b);
    const step = progress(hooks, used.length + 3);
    const doc = await open(input, tick);
    const ctx = doc.context;
    const own = repairPageTree(doc).pages;
    const sources = new Map([[-1, own]]);
    // Each PDF's own page labels, read before an extra one is joined (see merge).
    const ownLabels = labelsOf(doc, own);
    const labels = ownLabels ? labelsByPage(own, ownLabels) : null;
    step();
    if (used.length) {
      const appender = new Appender(doc);
      for (const i of used) {
        const extra = await open(extras[i], tick);
        const extraLabels = labelsOf(extra, readPages(extra).pages);
        const added = await appender.append(extra, tick);
        sources.set(i, added);
        if (labels && extraLabels) labelsByPage(added, extraLabels, labels);
        step();
      }
      appender.finish();
    }
    const before = readPages(doc).pages;
    const placed = new Set();
    const order = [];
    for (const ref of refs) {
      await tick();
      const from = which(ref);
      checkTurn(ref.rotation ?? 0);
      if (from === 'blank') {
        if (!(ref.width > 0 && ref.height > 0)) throw new Error('A blank page needs a size');
        const page = newPage(ctx);
        page.set(nm('MediaBox'), ctx.obj([0, 0, ref.width, ref.height]));
        page.set(nm('Resources'), PDFDict.withContext(ctx));
        turn(ctx, page, ref.rotation ?? 0);
        order.push({ ref: ctx.register(page), dict: page });
        continue;
      }
      const list = sources.get(from);
      if (!Number.isInteger(ref.page) || ref.page < 0 || ref.page >= list.length) throw new Error(`No page ${ref.page}`);
      const page = list[ref.page];
      if (placed.has(page)) throw new Error('A page can be placed once');
      placed.add(page);
      turn(ctx, page.dict, ref.rotation ?? 0);
      order.push(page);
    }
    setPages(doc, order);
    await dropRemovedPages(doc, before.map((p) => p.dict), tick);
    if (labels) restoreLabels(doc, labels);
    step();
    const name = sanitize(plan?.fileName ?? defaultName('reorganize', input), 'Reorganized');
    const bytes = await savePdf(doc);
    step();
    return output(name, bytes, order.length, [input, ...used.map((i) => extras[i])]);
  });
}

/**
 * Delete pages: `input` without `pages`, which must leave at least one page. Their bookmarks, form
 * fields, tags, links to them and pictures only they drew go too, so nothing of them stays in the
 * file. The pages left keep their labels.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {number[] | string | { pages: number[] | string, fileName?: string }} pages
 *   Zero-based page indexes, or the pages as typed ("2,5-7"). `fileName` without ".pdf"
 *   (default: defaultName('delete-pages', input)).
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: string, pageCount: number }>}
 */
export function deletePages(input, pages, hooks = {}) {
  return guarded(async () => {
    const tick = ticker(hooks.signal);
    const options = Array.isArray(pages) || typeof pages === 'string' ? { pages } : pages ?? {};
    const step = progress(hooks, 3);
    const doc = await open(input, tick);
    const all = repairPageTree(doc).pages;
    let doomed;
    if (typeof options.pages === 'string') doomed = pagesToDelete(options.pages, all.length);
    else {
      if (!Array.isArray(options.pages) || !options.pages.length) throw new UserError('pdf_invalid_pages');
      doomed = [...new Set(options.pages)].sort((a, b) => a - b);
      if (doomed.some((p) => !Number.isInteger(p) || p < 0 || p >= all.length)) throw new PageSelectionError('OUT_OF_RANGE', all.length);
      if (doomed.length >= all.length) throw new PageSelectionError('ALL_PAGES', all.length);
    }
    step();
    const ownLabels = labelsOf(doc, all);
    const labels = ownLabels ? labelsByPage(all, ownLabels) : null;
    const gone = new Set(doomed);
    const removed = doomed.map((p) => all[p].dict);
    setPages(doc, all.filter((_, i) => !gone.has(i)));
    await tick();
    await dropRemovedPages(doc, removed, tick);
    if (labels) restoreLabels(doc, labels);
    step();
    const name = sanitize(options.fileName ?? defaultName('delete-pages', input), 'Pages_deleted');
    const bytes = await savePdf(doc);
    step();
    return output(name, bytes, all.length - doomed.length, [input]);
  });
}

/** Rotations as given: an object or Map of page index to degrees, [[index, degrees]], or [{ page, rotation }]. */
function rotationEntries(rotations) {
  if (rotations instanceof Map) return [...rotations.entries()];
  if (Array.isArray(rotations)) {
    return rotations.map((r) => (Array.isArray(r) ? r : [r.page, r.rotation ?? r.degrees]));
  }
  return Object.entries(rotations ?? {}).map(([k, v]) => [Number(k), v]);
}

/**
 * Rotate PDF: pages turned clockwise by the degrees given (a multiple of 90; negative turns left),
 * on top of the turn they already have. Only how each page is shown changes; its content is left
 * exactly as it is.
 * @param {{ name: string, bytes: Uint8Array, password?: string }} input
 * @param {object | Map | Array | { rotations: object | Map | Array, fileName?: string }} rotations
 *   Page index (zero-based) to degrees, as `{ 0: 90, 3: -90 }`, a Map, `[[0, 90]]` or `[{ page: 0, rotation: 90 }]`.
 *   `fileName` without ".pdf" (default: defaultName('rotate', input)).
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [hooks]
 * @returns {Promise<{ name: string, bytes: Uint8Array, type: string, pageCount: number }>}
 */
export function rotatePdf(input, rotations, hooks = {}) {
  return guarded(async () => {
    const tick = ticker(hooks.signal);
    const options = rotations && !(rotations instanceof Map) && !Array.isArray(rotations) && 'rotations' in rotations
      ? rotations : { rotations };
    const step = progress(hooks, 2);
    const doc = await open(input, tick);
    const ctx = doc.context;
    const pages = repairPageTree(doc).pages;
    for (const [index, degrees] of rotationEntries(options.rotations)) {
      await tick();
      if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error(`No page ${index}`);
      checkTurn(degrees);
      turn(ctx, pages[index].dict, degrees);
    }
    step();
    const name = sanitize(options.fileName ?? defaultName('rotate', input), 'Rotated');
    const bytes = await savePdf(doc);
    step();
    return output(name, bytes, pages.length, [input]);
  });
}

/**
 * Page `index` (zero-based) of `input` as it is shown: its crop box, turned by its rotation. Width
 * and height in points; A4 if it can't be read. For Reorganize's blank page, which takes the size
 * of the page before it (see blankPageAfter).
 * @returns {Promise<{ width: number, height: number }>}
 */
export async function shownPageSize(input, index) {
  try {
    const doc = await loadPdf(input.bytes, { password: input.password || undefined });
    const page = readPages(doc).pages[index]?.dict;
    if (!page) return { ...A4 };
    const { crop } = boxesOf(doc.context, page);
    const width = crop[2] - crop[0];
    const height = crop[3] - crop[1];
    return rotationOf(doc.context, page) % 180 === 0 ? { width, height } : { width: height, height: width };
  } catch {
    return { ...A4 };
  }
}

/**
 * The blank page Reorganize adds after a page (the view model's insertBlankPage): the size that page
 * shows (`shown`, as shownPageSize gives it, or a blank page's own width and height), lying sideways
 * when that page is turned a quarter in the list (`rotation`, the turn the user gave it).
 * @param {{ width: number, height: number }} shown
 * @param {number} [rotation]
 * @returns {{ blank: true, width: number, height: number, rotation: 0 }}
 */
export function blankPageAfter(shown, rotation = 0) {
  const sideways = floorMod(rotation, 180) !== 0;
  return { blank: true, width: sideways ? shown.height : shown.width, height: sideways ? shown.width : shown.height, rotation: 0 };
}

/** The number of pages of `input` as the organize tools count them (viewers' way; see readPages). */
export async function countPages(input) {
  checkInput(input);
  const doc = await loadPdf(input.bytes, { password: input.password || undefined });
  return readPages(doc).pages.length;
}

// Exported for tests and other tools that name files the app's way.
export { fileNames } from '../core/names.js';
export { defaultName, partSuffix };

// Kept for the screens' error handling: the same classes the engines throw.
export { PageSelectionError, checkCancelled, resourcesOf };
