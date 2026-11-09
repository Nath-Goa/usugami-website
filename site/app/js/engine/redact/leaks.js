// What else in a PDF could give away what Redact PDF hides (the app's Redactor.removeLeaks and
// findInComments): the document's details, bookmarks, tags, attached files, scripts, form fields,
// and what comments, links and fields say where no page shows it.
import {
  N, get, getDict, getArray, getName, getString, getNumber, resolve, items, textOf, nameOf, numbers,
  streamBytes, PDFDict, PDFArray, PDFStream, PDFName, PDFString, PDFHexString,
} from './objects.js';
import { between, clamp, makeBox, addressForms } from './boxes.js';
import { normalize, containsIgnoringCase } from './page-text.js';

/** Annotation flags (/F): hidden, and not shown on the screen. */
const HIDDEN = 1 << 1;
const NO_VIEW = 1 << 5;

/** The kinds of comment that mark what the page itself shows: text, or a place drawn around. */
const MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Line', 'Caret']);

/** A file specification's names: /F, /UF and the older ones for each system. */
const FILE_NAMES = ['F', 'UF', 'DOS', 'Mac', 'Unix'];

const REMOVED_CATALOG_KEYS = [
  'Metadata', 'Outlines', 'StructTreeRoot', 'MarkInfo', 'AA', 'PieceInfo', 'Threads', 'SpiderInfo', 'AF',
  'Collection', 'Perms', 'Legal',
  // The signers' certificates and what vouches for them.
  'DSS',
];

/** A signature field's signature and what it locks. */
const SIGNATURE_KEYS = ['V', 'Lock', 'SV'];

const REMOVED_PAGE_KEYS = ['Metadata', 'PieceInfo', 'AA', 'StructParents', 'B', 'AF'];

/** `widget` and the form fields it belongs to, up to the top. */
function fieldOf(widget) {
  const out = [];
  let current = widget;
  while (current instanceof PDFDict && out.length < 32) {
    out.push(current);
    current = get(current, 'Parent');
  }
  return out;
}

/** A field's value as text: a text, a choice (a name) or the choices of a list. */
function texts(ctx, value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return [textOf(value) ?? ''];
  if (value instanceof PDFName) return [nameOf(value)];
  if (value instanceof PDFArray) {
    return items(ctx, value).flatMap((item) => (item instanceof PDFArray ? [] : texts(ctx, item)));
  }
  return [];
}

/** A choice field's choices (/Opt): each a text, or the value it gives and the text it shows. */
function options(ctx, choices) {
  if (!(choices instanceof PDFArray)) return [];
  return items(ctx, choices).flatMap((choice) => {
    if (choice instanceof PDFString || choice instanceof PDFHexString) return [textOf(choice) ?? ''];
    if (choice instanceof PDFArray) return items(ctx, choice).map(textOf).filter((t) => t !== null);
    return [];
  });
}

/** What a form field says of itself that no page shows: its names, tooltip, default value and choices. */
function labels(ctx, field) {
  return [...['T', 'TM', 'TU'].map((k) => getString(field, k)).filter((t) => t !== null),
    ...texts(ctx, get(field, 'DV')), ...options(ctx, get(field, 'Opt'))];
}

/** All a form field holds as text: its labels and its value. */
const fieldTexts = (ctx, field) => [...labels(ctx, field), ...texts(ctx, get(field, 'V'))];

const flagsOf = (dict) => getNumber(dict, 'F', 0) | 0;

/**
 * Walks the form's fields under `kids` (and their widgets), calling offPage(field, page) for each
 * that has no widget among `onPages`, with the page one of its widgets names (/P), if any.
 * Returns [whether any of them has a widget on a page, the page one names].
 */
function walkFields(ctx, kids, onPages, offPage, seen = new Set(), depth = 0) {
  let shown = false;
  let named = null;
  if (!(kids instanceof PDFArray) || depth > 32) return [shown, named];
  for (const field of items(ctx, kids)) {
    if (!(field instanceof PDFDict) || seen.has(field)) continue;
    seen.add(field);
    const [below, namedBelow] = walkFields(ctx, get(field, 'Kids'), onPages, offPage, seen, depth + 1);
    const onPage = below || onPages.has(field);
    const p = get(field, 'P');
    const page = namedBelow ?? (p instanceof PDFDict ? p : null);
    if (!onPage) offPage(field, page);
    shown = shown || onPage;
    named = named ?? page;
  }
  return [shown, named];
}

/**
 * The form fields whose own text has `has` where no page shows it, for their widgets on pages to
 * be boxed (fields), and the pages to box for those none of whose widgets is on a page
 * (elsewhere: the one a widget names, or the first).
 */
function fieldsHolding(doc, has, check) {
  const ctx = doc.context;
  const holders = new Set();
  const onPages = new Set();
  const pageOf = new Map();
  doc.getPages().forEach((page, index) => {
    check?.();
    pageOf.set(page.node, index);
    for (const widget of items(ctx, get(page.node, 'Annots'))) {
      if (!(widget instanceof PDFDict) || getName(widget, 'Subtype') !== 'Widget') continue;
      onPages.add(widget);
      const hidden = (flagsOf(widget) & (HIDDEN | NO_VIEW)) !== 0;
      for (const field of fieldOf(widget)) {
        if (labels(ctx, field).some(has) || (hidden && texts(ctx, get(field, 'V')).some(has))) holders.add(field);
      }
    }
  });
  const elsewhere = [];
  const fields = get(getDict(doc.catalog, 'AcroForm'), 'Fields');
  walkFields(ctx, fields, onPages, (field, page) => {
    if (fieldTexts(ctx, field).some(has)) elsewhere.push(page ? pageOf.get(page) ?? 0 : 0);
  });
  return { fields: holders, elsewhere };
}

/** Adds to `into` the names a file specification gives. */
function fileNames(spec, into) {
  const text = textOf(spec);
  if (text !== null) into.push(text);
  else if (spec instanceof PDFDict) for (const key of FILE_NAMES) {
    const name = getString(spec, key);
    if (name !== null) into.push(name);
  }
}

/**
 * The web and email addresses and files an annotation leads to, each also as a person reads it:
 * a link's, a button's, also when it is clicked, pressed or left (/AA, and a widget's field's
 * own), those that follow (/Next), and a link's former one (/PA).
 */
function addresses(ctx, annotation) {
  const pending = [get(annotation, 'A'), get(annotation, 'PA')];
  const triggered = getName(annotation, 'Subtype') === 'Widget' ? fieldOf(annotation) : [annotation];
  for (const holder of triggered) {
    const triggers = getDict(holder, 'AA');
    if (triggers) for (const [key] of triggers.entries()) pending.push(get(triggers, nameOf(key)));
  }
  const seen = new Set();
  const found = [];
  while (pending.length && seen.size < 64) {
    const action = pending.pop();
    if (action instanceof PDFArray) {
      if (!seen.has(action)) {
        seen.add(action);
        pending.push(...items(ctx, action));
      }
    } else if (action instanceof PDFDict && !seen.has(action)) {
      seen.add(action);
      const uri = getString(action, 'URI');
      if (uri !== null) found.push(uri);
      // GoToR's other PDF, Launch's file, SubmitForm's address, and so on.
      fileNames(get(action, 'F'), found);
      // An app launched on Windows: its file, its folder and its parameters.
      const win = getDict(action, 'Win');
      if (win) for (const key of ['F', 'D', 'P']) {
        const v = getString(win, key);
        if (v !== null) found.push(v);
      }
      pending.push(get(action, 'Next'));
    }
  }
  return found.flatMap(addressForms);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u{A0}' };

/** A comment's rich text (/RC, XHTML), as plain text. */
function richText(annotation) {
  const rich = get(annotation, 'RC');
  let xhtml = textOf(rich);
  if (xhtml === null && rich instanceof PDFStream) {
    try {
      xhtml = new TextDecoder('utf-8').decode(streamBytes(rich));
    } catch {
      xhtml = null;
    }
  }
  if (xhtml === null) return null;
  return xhtml
    .replace(/<(br|p|div|li|tr|td|h[1-6]|body|ol|ul|table)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|h[1-6]|ol|ul|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/**
 * A box over each comment on the document's pages, but those in `skip`, whose text has `query`:
 * what it says, its author or its subject. The box covers the comment as the page shows it, so
 * that page becomes a picture and the comment goes. A comment that marks the page's own content
 * (a highlight, a drawing), and links, buttons and fields that hold the text where no page shows
 * it, get the smallest box, at their corner. Only when nothing else has `query` is a page boxed
 * for a field none of whose widgets is on a page. Returns [[box], ...] (fractions of the shown page).
 */
export function findInComments(doc, frames, query, skip, check) {
  const ctx = doc.context;
  const wanted = normalize(query);
  if (!wanted.length) return [];
  const has = (text) => containsIgnoringCase(normalize(text), wanted);
  const holding = fieldsHolding(doc, has, check);
  const found = [];
  doc.getPages().forEach((page, index) => {
    if (skip.has(index)) return;
    check?.();
    const annotations = get(page.node, 'Annots');
    if (!(annotations instanceof PDFArray)) return;
    const frame = frames[index];
    for (const annotation of items(ctx, annotations)) {
      if (!(annotation instanceof PDFDict)) continue;
      const subtype = getName(annotation, 'Subtype');
      const widget = subtype === 'Widget';
      const rich = widget ? null : richText(annotation);
      const says = !widget && [...['Contents', 'T', 'Subj'].map((k) => getString(annotation, k)), rich]
        .some((t) => t !== null && has(t));
      const leads = addresses(ctx, annotation).some(has);
      const holds = widget && fieldOf(annotation).some((f) => holding.fields.has(f));
      if (!says && !leads && !holds) continue;
      // A pop-up's window may be anywhere: it is boxed where its comment is.
      const parent = get(annotation, 'Parent');
      const placed = subtype === 'Popup' && parent instanceof PDFDict ? parent : annotation;
      const rect = numbers(ctx, get(placed, 'Rect'), 4) ?? [0, 0, 0, 0];
      const [x0, y0] = frame.toShown(rect[0], rect[1]);
      const [x1, y1] = frame.toShown(rect[2], rect[3]);
      const box = between(index, x0 / frame.shownWidth, 1 - y0 / frame.shownHeight, x1 / frame.shownWidth, 1 - y1 / frame.shownHeight);
      // What the page shows there needn't hold the text: it isn't blacked out.
      const small = !says || MARKUP.has(getName(placed, 'Subtype'));
      // Off the page, it is boxed at the nearest edge, so the page is still redacted.
      found.push([clamp(small ? { ...box, right: box.left, bottom: box.top } : box)]);
    }
  });
  if (!found.length && !skip.size && holding.elsewhere.length) {
    found.push([clamp(makeBox(holding.elsewhere[0], 0, 0, 0, 0))]);
  }
  return found;
}

// ---- Removing ----

/** A form field's type (/FT), which it may inherit from the fields above it. */
function fieldType(field) {
  for (const f of fieldOf(field)) {
    const type = getName(f, 'FT');
    if (type) return type;
  }
  return null;
}

/**
 * Removes from a name tree the entries `drop` says to, in every node, and the nodes left empty;
 * the first and last names each node keeps in its /Limits are set again. Returns whether `node`
 * is left empty.
 */
function pruneNameTree(ctx, node, seen, drop, root = true) {
  if (seen.has(node)) return false;
  seen.add(node);
  let first = null;
  let last = null;
  const pairs = getArray(node, 'Names');
  if (pairs) {
    for (let i = pairs.size() - 2; i >= 0; i -= 2) {
      if (drop(pairs.get(i + 1))) {
        pairs.remove(i + 1);
        pairs.remove(i);
      }
    }
    if (pairs.size() >= 2) {
      first = pairs.get(0);
      last = pairs.get(pairs.size() - 2 - (pairs.size() % 2));
    }
  }
  const kids = getArray(node, 'Kids');
  if (kids) {
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = resolve(ctx, kids.get(i));
      if (kid instanceof PDFDict && pruneNameTree(ctx, kid, seen, drop, false)) kids.remove(i);
    }
    const limits = items(ctx, kids)
      .map((kid) => (kid instanceof PDFDict ? getArray(kid, 'Limits') : null))
      .filter((l) => l && l.size() === 2);
    if (first === null && limits.length) {
      first = limits[0].get(0);
      last = limits[limits.length - 1].get(1);
    }
  }
  // The root has no /Limits.
  if (root || first === null || last === null) node.delete(N('Limits'));
  else node.set(N('Limits'), ctx.obj([first, last]));
  return (!pairs || pairs.size() === 0) && (!kids || kids.size() === 0);
}

/** Removes widgets in `removed` from the form's field tree, and fields left with none. */
function pruneFields(ctx, kids, removed, seen) {
  for (let i = kids.size() - 1; i >= 0; i--) {
    const kid = resolve(ctx, kids.get(i));
    if (!(kid instanceof PDFDict)) continue;
    if (seen.has(kid)) {
      kids.remove(i);
      continue;
    }
    seen.add(kid);
    let gone = removed.has(kid);
    if (!gone) {
      const children = getArray(kid, 'Kids');
      if (children) {
        pruneFields(ctx, children, removed, seen);
        gone = children.size() === 0;
      }
    }
    if (gone) kids.remove(i);
  }
}

function collectFields(ctx, kids, into, seen) {
  for (const field of items(ctx, kids)) {
    if (!(field instanceof PDFDict) || seen.has(field)) continue;
    seen.add(field);
    into.add(field);
    const children = getArray(field, 'Kids');
    if (children) collectFields(ctx, children, into, seen);
  }
}

/**
 * Takes out of the form the fields under `kids` whose own text has any of `searched`, and that no
 * page that stays has a widget of. Their values go with them; fields left with none under them too.
 */
function dropFieldsHolding(doc, kids, searched) {
  const ctx = doc.context;
  const wanted = searched.map(normalize).filter((w) => w.length);
  if (!wanted.length) return;
  const has = (text) => {
    const t = normalize(text);
    return wanted.some((w) => containsIgnoringCase(t, w));
  };
  const onPages = new Set();
  for (const page of doc.getPages()) for (const a of items(ctx, get(page.node, 'Annots'))) if (a instanceof PDFDict) onPages.add(a);
  const doomed = new Set();
  walkFields(ctx, kids, onPages, (field) => {
    if (fieldTexts(ctx, field).some(has)) doomed.add(field);
  });
  if (doomed.size) pruneFields(ctx, kids, doomed, new Set());
}

/**
 * Removes what could still hold the hidden content once the redacted pages are pictures: the
 * document's information and XMP metadata, bookmarks, tags, form fields whose only places were on
 * redacted pages (and those holding what was `searched` that no page that stays shows), what
 * digital signatures say of their signers, named destinations to redacted pages, attached files,
 * JavaScript, applications' private data, article threads, pages' metadata and actions, and the
 * pop-ups of annotations that were removed. The pages without boxes otherwise stay as they were.
 */
export function removeLeaks(doc, redactedPages, removedAnnotations, searched) {
  const ctx = doc.context;
  ctx.trailerInfo.Info = undefined;
  const catalog = doc.catalog;
  for (const key of REMOVED_CATALOG_KEYS) catalog.delete(N(key));
  const pageMode = getName(catalog, 'PageMode');
  if (pageMode === 'UseOutlines' || pageMode === 'UseAttachments') catalog.delete(N('PageMode'));
  // A destination stays; an action (perhaps JavaScript) goes.
  if (get(catalog, 'OpenAction') instanceof PDFDict) catalog.delete(N('OpenAction'));

  const leadsToRedactedPage = (destination) => {
    const d = resolve(ctx, destination);
    const target = d instanceof PDFArray ? d : d instanceof PDFDict ? get(d, 'D') : null;
    return target instanceof PDFArray && target.size() > 0 && redactedPages.has(resolve(ctx, target.get(0)));
  };
  // Only named destinations stay of the name trees: attached files and scripts go.
  const names = getDict(catalog, 'Names');
  const destsRaw = names ? names.get(N('Dests')) : undefined;
  const dests = resolve(ctx, destsRaw);
  if (dests instanceof PDFDict) {
    pruneNameTree(ctx, dests, new Set(), leadsToRedactedPage);
    catalog.set(N('Names'), ctx.obj({ Dests: destsRaw }));
  } else {
    catalog.delete(N('Names'));
  }
  const oldDests = getDict(catalog, 'Dests');
  if (oldDests) {
    for (const [key, value] of [...oldDests.entries()]) if (leadsToRedactedPage(value)) oldDests.delete(key);
  }

  const form = getDict(catalog, 'AcroForm');
  if (form) {
    form.delete(N('XFA'));
    const fields = getArray(form, 'Fields');
    if (fields) {
      pruneFields(ctx, fields, removedAnnotations, new Set());
      dropFieldsHolding(doc, fields, searched);
    }
    if (!fields || fields.size() === 0) {
      catalog.delete(N('AcroForm'));
    } else {
      // The calculation order mustn't keep removed fields alive.
      const remaining = new Set();
      collectFields(ctx, fields, remaining, new Set());
      const order = getArray(form, 'CO');
      if (order) for (let i = order.size() - 1; i >= 0; i--) if (!remaining.has(resolve(ctx, order.get(i)))) order.remove(i);
      // A digital signature no longer matches anyway: what it says of the signer (name, reason,
      // place, certificate) goes, wherever its field is. The field stays, unsigned.
      for (const field of remaining) if (fieldType(field) === 'Sig') for (const key of SIGNATURE_KEYS) field.delete(N(key));
      form.delete(N('SigFlags'));
    }
  }

  // Attached files go from the pages that stay too; then nothing there may still lead to an
  // annotation that went: a pop-up goes with it, and a reply or a field forgets it.
  const kept = doc.getPages().map((p) => p.node).filter((node) => !redactedPages.has(node));
  const gone = new Set(removedAnnotations);
  for (const node of kept) {
    for (const key of REMOVED_PAGE_KEYS) node.delete(N(key));
    const annotations = getArray(node, 'Annots');
    if (!annotations) continue;
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const annotation = resolve(ctx, annotations.get(i));
      if (annotation instanceof PDFDict && getName(annotation, 'Subtype') === 'FileAttachment') {
        annotations.remove(i);
        gone.add(annotation);
      }
    }
  }
  for (const node of kept) {
    const annotations = getArray(node, 'Annots');
    if (!annotations) continue;
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const annotation = resolve(ctx, annotations.get(i));
      if (!(annotation instanceof PDFDict)) continue;
      if (getName(annotation, 'Subtype') === 'Popup' && gone.has(get(annotation, 'Parent'))) {
        annotations.remove(i);
        continue;
      }
      annotation.delete(N('AF'));
      for (const key of ['IRT', 'Parent', 'Popup']) if (gone.has(get(annotation, key))) annotation.delete(N(key));
    }
  }
}
