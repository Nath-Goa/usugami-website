// The list of pages Merge PDF's page mode and Reorganize PDF work on, with Undo: the page logic of
// the app's PdfToolsViewModel (pages, movePage, movePageBy, rotatePage, removePage, resetPages,
// resetToOriginal, append, insertBlankPage, followFileOrder, beginPageDrag/endPageDrag, undo).
//
// A page is { input, page, rotation } (input: the id of the PDF it comes from, page: zero-based,
// rotation: 0, 90, 180 or 270 clockwise on top of the page's own turn), or a blank page
// { input: BLANK, page: n, rotation, width, height } (n tells blank pages apart, sizes in points).
// Pages are found by their key, whatever their rotation: a button tapped again before the screen
// shows the page turned still finds it.

/** The `input` of a blank page (PdfPageRef.BLANK). */
export const BLANK = 'blank';

/** Changes Undo can take back, one after another (MAX_UNDO). */
export const MAX_UNDO = 50;

/** Tells pages apart in lists, whatever their rotation (PdfPageRef.key). */
export function pageKey(ref) {
  return `${ref.input}:${ref.page}`;
}

/** Whether `ref` is a blank page. */
export function isBlank(ref) {
  return ref?.input === BLANK;
}

/** Whether two pages are the same page, turned the same, and (blank ones) the same size. */
export function samePage(a, b) {
  return a.input === b.input && a.page === b.page && (a.rotation ?? 0) === (b.rotation ?? 0)
    && (a.width ?? 0) === (b.width ?? 0) && (a.height ?? 0) === (b.height ?? 0);
}

/** Whether two page lists are equal (Kotlin's == on List<PdfPageRef>). */
export function samePages(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!samePage(a[i], b[i])) return false;
  return true;
}

/** Every page of `inputs` ({ id, pageCount }), in order and unturned: what a page list starts as. */
export function pagesOf(inputs) {
  const list = [];
  for (const input of inputs) for (let p = 0; p < input.pageCount; p++) list.push({ input: input.id, page: p, rotation: 0 });
  return list;
}

/** `n` mod 360, kept from 0 to 359 (Math.floorMod). */
const turn = (n) => ((n % 360) + 360) % 360;

/**
 * The pages and their Undo list. Every change goes through here and calls the listeners given to
 * onChange; `pages` is replaced (never changed in place), so it can be compared and kept.
 */
export class PageList {
  constructor(pages = []) {
    this.pages = pages.slice();
    this.undoStack = [];
    this.listeners = new Set();
  }

  /** Calls fn() after each change to the pages or to Undo. Returns a function that stops it. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get length() {
    return this.pages.length;
  }

  /** The place of the page with `key`, or -1. */
  indexOf(key) {
    return this.pages.findIndex((p) => pageKey(p) === key);
  }

  /** The page with `key`, or undefined. */
  find(key) {
    return this.pages.find((p) => pageKey(p) === key);
  }

  /** Makes `list` the pages, without an Undo step (setPages). */
  set(list) {
    this.pages = list.slice();
    this.emit();
  }

  /** Saves the pages as they are, so the change about to be made can be undone (pushUndo). */
  pushUndo(list = this.pages) {
    this.undoStack.push(list);
    while (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  /** Forgets Undo (clearUndo). */
  clearUndo() {
    this.undoStack = [];
    this.emit();
  }

  /**
   * Takes back the latest change. Pages of PDFs no longer there (`inputs`, a Set of ids, when
   * given) don't come back: their PDF has gone. Returns whether there was something to undo.
   */
  undo(inputs) {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.set(inputs ? previous.filter((p) => isBlank(p) || inputs.has(p.input)) : previous);
    return true;
  }

  /** A page is about to be dragged: the whole drag is one change for Undo (beginPageDrag). */
  beginDrag() {
    this.pushUndo();
    this.emit();
  }

  /** The drag is over; one that moved nothing leaves nothing to undo (endPageDrag). */
  endDrag() {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && samePages(last, this.pages)) {
      this.undoStack.pop();
      this.emit();
    }
  }

  /** One step of a drag: the page at `from` goes to `to`, with no Undo step of its own (movePage). */
  moveAt(from, to) {
    const list = this.pages.slice();
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return false;
    list.splice(to, 0, ...list.splice(from, 1));
    this.set(list);
    return true;
  }

  /** The page with `key` moves to the place of the page with `toKey` (movePage, a drag step). */
  move(key, toKey) {
    return this.moveAt(this.indexOf(key), this.indexOf(toKey));
  }

  /** Moves the page with `key` by `offset` places, as one change (movePageBy). */
  moveBy(key, offset) {
    const a = this.indexOf(key);
    const b = a + offset;
    if (a < 0 || b < 0 || b >= this.pages.length) return false;
    this.pushUndo();
    const list = this.pages.slice();
    list.splice(b, 0, ...list.splice(a, 1));
    this.set(list);
    return true;
  }

  /** Turns the page with `key` by `degrees` more, clockwise (rotatePage). */
  rotate(key, degrees) {
    if (this.indexOf(key) < 0) return false;
    this.pushUndo();
    this.set(this.pages.map((p) => (pageKey(p) === key ? { ...p, rotation: turn((p.rotation ?? 0) + degrees) } : p)));
    return true;
  }

  /** Turns every page by `degrees` more (rotateAll). */
  rotateAll(degrees) {
    this.pushUndo();
    this.set(this.pages.map((p) => ({ ...p, rotation: turn((p.rotation ?? 0) + degrees) })));
  }

  /** Takes the page with `key` out (removePage). */
  remove(key) {
    if (this.indexOf(key) < 0) return false;
    this.pushUndo();
    this.set(this.pages.filter((p) => pageKey(p) !== key));
    return true;
  }

  /** Merge's Reset pages: `all` (every page of the PDFs), always one change (resetPages). */
  reset(all) {
    this.pushUndo();
    this.set(all);
  }

  /**
   * Reorganize's Reset: back to `original`, the PDF's own pages. Tapped again once they are, it
   * changes nothing and Undo gets no step (resetToOriginal). Returns whether it changed them.
   */
  resetTo(original) {
    if (samePages(this.pages, original)) return false;
    this.pushUndo();
    this.set(original);
    return true;
  }

  /**
   * Adds `added` (a PDF's pages) after the page with `afterKey`, or at the end when it is null or
   * has gone (append). `undoable`: adding to PDFs already there can be undone.
   */
  insert(added, afterKey = null, { undoable = true } = {}) {
    const list = this.pages;
    if (undoable) this.pushUndo(list);
    const anchor = afterKey == null ? -1 : list.findIndex((p) => pageKey(p) === afterKey);
    this.set(anchor < 0 ? [...list, ...added] : [...list.slice(0, anchor + 1), ...added, ...list.slice(anchor + 1)]);
  }

  /**
   * Puts a blank page of `width` by `height` points after `neighbour`, or at the end if it has
   * gone since it was asked for; sideways when that page is turned a quarter, so a blank page
   * among sideways pages lies sideways too (insertBlankPage). Returns the blank page, or null.
   */
  insertBlank(neighbour, width, height) {
    const current = this.pages;
    if (!current.length) return null;
    const found = current.findIndex((p) => pageKey(p) === pageKey(neighbour));
    const at = found >= 0 ? found : current.length - 1;
    const sideways = ((found >= 0 ? current[found] : neighbour).rotation ?? 0) % 180 !== 0;
    const number = current.filter(isBlank).reduce((m, p) => Math.max(m, p.page), -1) + 1;
    const blank = { input: BLANK, page: number, rotation: 0, width: sideways ? height : width, height: sideways ? width : height };
    this.pushUndo(current);
    this.set([...current.slice(0, at + 1), blank, ...current.slice(at + 1)]);
    return blank;
  }

  /** Takes the pages of the PDF `id` out, with no Undo step (removeInput, forgetInputs). */
  dropInput(id) {
    this.set(this.pages.filter((p) => p.input !== id));
  }

  /**
   * Merge's pages follow the PDFs' new order (`ids`), each PDF's pages keeping their own order,
   * turns and removals. Not once pages of different PDFs have been mixed: that order was chosen
   * page by page (followFileOrder).
   */
  followOrder(ids) {
    const order = this.pages.map((p) => p.input);
    let changes = 0;
    for (let i = 1; i < order.length; i++) if (order[i] !== order[i - 1]) changes++;
    if (changes !== new Set(order).size - 1) return false;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const r = (p) => rank.get(p.input) ?? Number.MAX_SAFE_INTEGER;
    // Array.prototype.sort is stable, as Kotlin's sortedBy.
    this.set(this.pages.slice().sort((a, b) => r(a) - r(b)));
    return true;
  }
}

/** What a screen reader says a page is turned to (turnedLabel): a string key, or null. */
export function turnedKey(rotation) {
  switch (turn(rotation ?? 0)) {
    case 90: return 'rotated_right';
    case 180: return 'rotated_upside_down';
    case 270: return 'rotated_left';
    default: return null;
  }
}

/**
 * The engines' page list for `pages` (organize.js' mergePdfs / reorganizePdf): blank pages with
 * their size, the others by their PDF's id.
 */
export function enginePages(pages) {
  return pages.map((p) => (isBlank(p)
    ? { blank: true, width: p.width, height: p.height, rotation: p.rotation ?? 0 }
    : { input: p.input, page: p.page, rotation: p.rotation ?? 0 }));
}
