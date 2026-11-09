// Edit PDF's items and the one chosen, with Undo and Redo over whole changes (EditHistory.kt, and
// the edit parts of PdfToolsViewModel.kt that keep its limits). The app keeps the items in the
// state Android saves; a browser tab has nothing like it, so they live here for the visit.
import { sameItems, contains, inkPoints, MAX_EDIT_ITEMS, MAX_INK_POINTS } from './layout.js';

/** Changes Undo can take back, one after another. */
export const MAX_UNDO = 50;

export class EditHistory {
  /**
   * @param {object[]} [items]  items to start with
   * @param {() => void} [onChange]  called after every change of the items, the chosen item, or what
   *   Undo and Redo can do
   */
  constructor(items = [], onChange = null) {
    this._items = Object.freeze(items.slice());
    this._selected = null;
    this.undoStack = [];
    this.redoStack = [];
    // A change made of many steps, such as a drag, is under way: its steps are one change for Undo.
    this.gesture = false;
    // The items before that change, until a step changes something and they go on the Undo list:
    // a touch that moves nothing leaves Undo and Redo as they were.
    this.before = null;
    // Undo and Redo as they were when that change's first step went on Undo, which takes Redo away:
    // a change that ends where it started gives them back.
    this.stacksBefore = null;
    this.nextId = items.reduce((m, it) => Math.max(m, it.id), 0) + 1;
    this.onChange = onChange;
  }

  /** The items, in the order they are drawn (the last on top). */
  get items() { return this._items; }

  /** The chosen item's id, or null. */
  get selected() { return this._selected; }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  newId() { return this.nextId++; }

  select(id) {
    if (this._selected === id) return;
    this._selected = id ?? null;
    this._notify();
  }

  /** Makes `list` the items, as one change. */
  change(list) {
    this._stopGesture();
    if (sameItems(list, this._items)) return;
    this._push(this._items);
    this._set(list);
  }

  /** Starts a change made of many steps (a drag, or a slider moved); step() makes each. */
  begin() {
    if (this.gesture) return;
    this.gesture = true;
    this.before = this._items;
  }

  step(list) {
    if (!this.gesture) this.begin();
    const start = this.before;
    if (start != null && !sameItems(list, this._items)) {
      this.stacksBefore = [this.undoStack.slice(), this.redoStack.slice()];
      this._push(start);
      this.before = null;
    }
    this._set(list);
  }

  /**
   * The change begin() started is over; one that ended where it started leaves nothing to undo, and
   * Undo and Redo as they were.
   */
  end() {
    if (!this.gesture) return;
    const stacks = this.stacksBefore;
    this._stopGesture();
    const last = this.undoStack[this.undoStack.length - 1];
    if (stacks != null && last && sameItems(last, this._items)) {
      this.undoStack = stacks[0];
      this.redoStack = stacks[1];
      this._notify();
    }
  }

  /** Whether a change of many steps is under way. */
  get changing() { return this.gesture; }

  _stopGesture() {
    this.gesture = false;
    this.before = null;
    this.stacksBefore = null;
  }

  /** Takes back the latest change. Returns the page it was on, or null when there is nothing to undo. */
  undo() {
    this._stopGesture();
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(this._items);
    return this._travel(previous);
  }

  /** Makes again the change Undo last took back. Returns the page it is on, or null when there is nothing to redo. */
  redo() {
    this._stopGesture();
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(this._items);
    return this._travel(next);
  }

  _travel(target) {
    const current = this._items;
    // The page of an item that differs: the change Undo or Redo is showing.
    const changed = target.find((it) => !contains(current, it)) ?? current.find((it) => !contains(target, it));
    this._items = target;
    if (!target.some((it) => it.id === this._selected)) this._selected = null;
    this._notify();
    return changed ? changed.page : null;
  }

  /** Forgets every item and the history, as when the tool closes. */
  clear() {
    this._stopGesture();
    this.undoStack = [];
    this.redoStack = [];
    this._items = Object.freeze([]);
    this._selected = null;
    this._notify();
  }

  _push(list) {
    this.undoStack.push(list);
    while (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  _set(list) {
    this._items = Object.freeze(list.slice());
    this._notify();
  }

  _notify() {
    this.onChange?.();
  }

  // ---- The view model's edit functions (PdfToolsViewModel.kt) ----

  /**
   * Puts `item` on top of the others; it is chosen, unless it is a stroke just drawn. Refused (false)
   * once the PDF has as many items, or stroke points, as it can take (MAX_EDIT_ITEMS, MAX_INK_POINTS):
   * the screen then says edit_full.
   */
  add(item) {
    const points = item.type === 'ink' ? item.points.length / 2 : 0;
    if (this._items.length >= MAX_EDIT_ITEMS || inkPoints(this._items) + points > MAX_INK_POINTS) return false;
    this.change([...this._items, item]);
    if (item.type !== 'ink') this.select(item.id);
    return true;
  }

  /** How many more points pen and highlighter strokes can have on this PDF. */
  inkRoom() {
    return Math.max(0, MAX_INK_POINTS - inkPoints(this._items));
  }

  /** Whether another item can be added. */
  get full() {
    return this._items.length >= MAX_EDIT_ITEMS;
  }

  /** `list` with `item` in place of the item with its id. */
  replaced(item) {
    return this._items.map((it) => (it.id === item.id ? item : it));
  }

  /** Puts `item` in place of the item with its id, as one change. */
  replace(item) {
    this.change(this.replaced(item));
  }

  /** One step of a change of many steps (a slider moved): `item` in place of the item with its id. */
  stepItem(item) {
    this.step(this.replaced(item));
  }

  /**
   * A step of a drag of the chosen item: from `was`, as the drag's last step left it, to `item`.
   * Once it is no longer `was`, or no longer chosen (another finger changed its colour, undid the
   * drag or chose another page), nothing changes, and false says the drag is over.
   */
  drag(was, item) {
    if (this._selected !== was.id || !contains(this._items, was)) return false;
    this.step(this.replaced(item));
    return true;
  }

  /** Removes the item with `id`, as one change, and chooses nothing. */
  remove(id) {
    this.change(this._items.filter((it) => it.id !== id));
    this.select(null);
  }
}
