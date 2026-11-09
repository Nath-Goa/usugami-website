// A list whose rows can be put in another order, for Merge PDF's files and pages (the app's
// reorderable LazyColumn): a long press and drag on touch screens (a quick swipe still scrolls),
// a drag with a mouse, Ctrl (⌘) and the arrow keys, Home and End, or the rows' own buttons. The row
// held near the list's top or bottom edge scrolls it. Rows are kept by key, so a row keeps its
// element, its focus and its picture when the list changes around it.
import { h, announce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { uid } from '../../core/ui.js';

/** How long a touch is held before the row under it lifts, to be dragged (as the page grid). */
const LONG_PRESS_MS = 450;
/** How far a finger may wander while held before it counts as scrolling instead. */
const TOUCH_SLOP = 10;
/** How far a mouse moves with its button down before it drags the row. */
const MOUSE_SLOP = 5;
/** Within this distance of the scrolling area's top or bottom, a row being dragged scrolls it. */
const EDGE = 48;
/** Rows this far beyond the visible part of the list get their pictures ahead of being scrolled to. */
const PREFETCH = '300px';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {object} o
 * @param {string} [o.cls]            more classes for the list
 * @param {string} [o.ariaLabel]      the list's name
 * @param {(item: any) => string} o.keyOf
 * @param {(item: any) => Row} o.create   makes a row: { el, handle?, update(item, index, count, active), load?(), unload?(), destroy?() }.
 *   `handle` is the row's focusable element for the keyboard (arrows move the focus, Ctrl+arrows the row);
 *   elements inside the row marked data-rove are only in the Tab order on the active row (with `roving`).
 * @param {(from: number, to: number) => (void|false)} o.onMove   a row moved one or more places; false refuses
 * @param {() => void} [o.onMoveStart]   a drag starts (one Undo step for the whole drag)
 * @param {(from: number, to: number) => void} [o.onMoveEnd]   a drag ended
 * @param {boolean} [o.roving]   one Tab stop for the whole list, arrow keys between rows
 * @param {boolean} [o.lazy]     rows' load() and unload() as they come near the visible part of the list and go
 * @returns {HTMLElement} el.setItems(items), el.focusKey(key), el.destroy()
 */
export function reorderList(o) {
  const hintId = uid('reorder-hint');
  const list = h('div', { class: ['merge-list', o.cls], role: 'list' });
  if (o.ariaLabel) list.setAttribute('aria-label', o.ariaLabel);
  const hint = h('span', { id: hintId, class: 'ui-visually-hidden' }, t('web_reorder_hint'));
  list.append(hint);
  /** Rows in the order shown. */
  let rows = [];
  const byKey = new Map();
  let activeKey = null;
  let observer = null;

  if (o.lazy && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const row = e.target.row;
        if (!row) continue;
        if (e.isIntersecting) row.load?.(); else row.unload?.();
      }
    }, { root: list, rootMargin: `${PREFETCH} 0px` });
  }

  const count = () => rows.length;
  const activeIndex = () => {
    const i = rows.findIndex((r) => r.key === activeKey);
    return i >= 0 ? i : 0;
  };

  const updateRow = (row) => {
    const active = !o.roving || row.index === activeIndex();
    row.update(row.item, row.index, rows.length, active);
    if (row.handle) {
      row.handle.tabIndex = active ? 0 : -1;
      row.handle.setAttribute('aria-describedby', [row.handle.dataset.describedby, hintId].filter(Boolean).join(' '));
    }
    if (o.roving) for (const n of row.el.querySelectorAll('[data-rove]')) n.tabIndex = active ? 0 : -1;
  };

  const updateRange = (a, b) => {
    for (let i = Math.max(0, a); i <= Math.min(rows.length - 1, b); i++) updateRow(rows[i]);
  };

  const setActive = (i) => {
    const before = activeIndex();
    activeKey = rows[Math.max(0, Math.min(rows.length - 1, i))]?.key ?? null;
    const now = activeIndex();
    if (o.roving && before !== now) {
      if (rows[before]) updateRow(rows[before]);
      if (rows[now]) updateRow(rows[now]);
    }
  };

  /** Shows `items` in their order: rows of keys still there are kept, others made or let go. */
  list.setItems = (items) => {
    const wasActive = activeIndex();
    const next = [];
    const seen = new Set();
    for (const item of items) {
      const key = o.keyOf(item);
      seen.add(key);
      let row = byKey.get(key);
      if (!row) {
        row = { key, ...o.create(item) };
        row.el.dataset.row = '';
        row.el.setAttribute('role', 'listitem');
        row.el.row = row;
        byKey.set(key, row);
        observer?.observe(row.el);
      }
      row.item = item;
      next.push(row);
    }
    for (const [key, row] of byKey) {
      if (seen.has(key)) continue;
      byKey.delete(key);
      observer?.unobserve(row.el);
      row.unload?.();
      row.destroy?.();
      row.el.remove();
    }
    // In order, moving only the rows out of place.
    let at = hint;
    for (const row of next) {
      if (at.nextSibling !== row.el) list.insertBefore(row.el, at.nextSibling);
      at = row.el;
    }
    rows = next;
    rows.forEach((row, i) => { row.index = i; });
    // The active row gone, the one now in its place takes over.
    if (!byKey.has(activeKey)) activeKey = rows[Math.min(rows.length - 1, wasActive)]?.key ?? null;
    updateRange(0, rows.length - 1);
  };

  /** Puts the focus on the row with `key` (its handle, or else its first button). */
  list.focusKey = (key) => {
    const row = byKey.get(key);
    if (!row) return;
    setActive(row.index);
    (row.handle ?? row.el.querySelector('button:not(:disabled)'))?.focus({ preventScroll: false });
  };

  // -------------------------------------------------------------------------------------------
  // Moving

  /** Moves the row at `from` to `to`: tells onMove, then moves its element, the others gliding along. */
  const move = (from, to, { say = false, animate = true } = {}) => {
    if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return false;
    const row = rows[from];
    const before = animate && !reducedMotion() ? rects() : null;
    if (o.onMove(from, to) === false) return false;
    // The owner may have shown its new order already (setItems from onMove); otherwise the row
    // moves here, its item with it.
    if (rows[to] !== row) {
      rows.splice(to, 0, ...rows.splice(from, 1));
      list.insertBefore(row.el, rows[to + 1]?.el ?? null);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let i = lo; i <= hi; i++) rows[i].index = i;
      updateRange(lo, hi);
    }
    if (before) glide(before, row);
    if (say) announce(t('web_page_moved', to + 1, rows.length));
    return true;
  };

  /** Where the rows on screen are, to glide them from there after a move. */
  const rects = () => {
    const map = new Map();
    const vh = window.innerHeight;
    for (const row of rows) {
      const r = row.el.getBoundingClientRect();
      if (r.bottom >= -50 && r.top <= vh + 50) map.set(row, r);
    }
    return map;
  };

  const glide = (before, skip) => {
    for (const [row, r] of before) {
      if (row === skip && dragging) continue;
      const now = row.el.getBoundingClientRect();
      const dx = r.left - now.left;
      const dy = r.top - now.top;
      if (!dx && !dy) continue;
      row.el.style.transition = 'none';
      row.el.style.transform = `translate(${dx}px, ${dy}px)`;
      row.el.getBoundingClientRect();
      row.el.style.transition = '';
      row.el.style.transform = '';
    }
  };

  const columns = () => {
    const s = getComputedStyle(list);
    if (!s.display.includes('grid')) return 1;
    return Math.max(1, s.gridTemplateColumns.split(' ').filter(Boolean).length);
  };

  // A focused element the move turned off (a row's own "earlier" button once it is first, say)
  // hands the focus to the row.
  // (Moving the row's element in the page takes the focus away from what is in it.)
  const keepFocus = (row, focused) => {
    const inRow = focused && focused.isConnected && row.el.contains(focused);
    let target;
    if (inRow && !focused.disabled) target = focused;
    // A move button turned off: its other one ("earlier" once the row is last, say).
    else if (inRow) target = [focused.nextElementSibling, focused.previousElementSibling].find((b) => b?.tagName === 'BUTTON' && !b.disabled);
    target ??= row.handle ?? row.el.querySelector('button:not(:disabled)');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  list.addEventListener('keydown', (e) => {
    const rowEl = e.target.closest?.('[data-row]');
    if (!rowEl || !list.contains(rowEl) || dragging) return;
    const row = rowEl.row;
    const i = row.index;
    const onHandle = e.target === row.handle;
    const ctrl = e.ctrlKey || e.metaKey;
    // Plain keys move the focus between rows only from a row's handle; Ctrl moves the row from
    // anywhere in it (its buttons too).
    if (!ctrl && !onHandle) return;
    if (e.altKey || e.shiftKey) return;
    const rtl = getComputedStyle(list).direction === 'rtl';
    const cols = columns();
    let to = null;
    switch (e.key) {
      case 'ArrowDown': to = i + cols; break;
      case 'ArrowUp': to = i - cols; break;
      case 'ArrowRight': to = cols > 1 || !onHandle ? i + (rtl ? -1 : 1) : null; break;
      case 'ArrowLeft': to = cols > 1 || !onHandle ? i + (rtl ? 1 : -1) : null; break;
      case 'Home': to = 0; break;
      case 'End': to = rows.length - 1; break;
      default: return;
    }
    if (to == null) return;
    e.preventDefault();
    to = Math.max(0, Math.min(rows.length - 1, to));
    if (ctrl) {
      const focused = document.activeElement;
      setActive(i);
      if (move(i, to, { say: true })) keepFocus(row, focused);
    } else if (to !== i) {
      setActive(to);
      rows[to].handle?.focus();
      rows[to].handle?.scrollIntoView?.({ block: 'nearest' });
    }
  });

  list.addEventListener('focusin', (e) => {
    const rowEl = e.target.closest?.('[data-row]');
    if (rowEl?.row && rowEl.row.index !== activeIndex()) setActive(rowEl.row.index);
  });

  // -------------------------------------------------------------------------------------------
  // Dragging: a mouse drags at once, a finger after a long press.

  let press = null;
  let dragging = null;
  let suppressClick = false;
  let scrollFrame = 0;

  list.addEventListener('click', (e) => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick = false;
  }, true);

  list.addEventListener('pointerdown', (e) => {
    if (dragging || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const rowEl = e.target.closest('[data-row]');
    if (!rowEl || !list.contains(rowEl)) return;
    // The row's buttons are pressed, not dragged.
    if (e.target.closest('button, a, input, textarea, select')) return;
    const row = rowEl.row;
    press = { row, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, timer: 0 };
    if (e.pointerType !== 'mouse') {
      press.timer = setTimeout(() => {
        if (press?.row === row) startDrag(press.x, press.y);
      }, LONG_PRESS_MS);
    } else {
      // No text selection while a row is dragged with the mouse.
      e.preventDefault();
      row.handle?.focus({ preventScroll: true });
    }
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });

  // Once a row is lifted, the finger moves it instead of scrolling the page.
  list.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  list.addEventListener('contextmenu', (e) => { if (press || dragging) e.preventDefault(); });

  const onPointerMove = (e) => {
    if (press && e.pointerId === press.id && !dragging) {
      const dist = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
      if (press.type === 'mouse') {
        if (dist > MOUSE_SLOP) startDrag(press.x0, press.y0);
      } else if (dist > TOUCH_SLOP) {
        // The finger moved before the long press: it is scrolling.
        cancelPress();
        return;
      } else {
        press.x = e.clientX;
        press.y = e.clientY;
      }
    }
    if (dragging && e.pointerId === dragging.id) {
      e.preventDefault();
      dragging.x = e.clientX;
      dragging.y = e.clientY;
      track();
      autoScroll();
    }
  };

  const onPointerUp = (e) => {
    if (dragging && e.pointerId === dragging.id) endDrag();
    else if (press && e.pointerId === press.id) cancelPress();
  };

  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
    if (!dragging) removeWindowListeners();
  };

  const removeWindowListeners = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };

  /** Where the row's place in the list is on screen, without the shift it is drawn with. */
  const slotOf = (row) => {
    const g = list.getBoundingClientRect();
    return {
      left: g.left + list.clientLeft + row.el.offsetLeft - list.scrollLeft,
      top: g.top + list.clientTop + row.el.offsetTop - list.scrollTop,
    };
  };

  const startDrag = (x, y) => {
    if (!press) return;
    const row = press.row;
    clearTimeout(press.timer);
    const slot = slotOf(row);
    // The list's places, in its own coordinates: the k-th row's place stays the k-th place
    // whichever row is in it.
    const slots = rows.map((r) => ({ left: r.el.offsetLeft, top: r.el.offsetTop, right: r.el.offsetLeft + r.el.offsetWidth, bottom: r.el.offsetTop + r.el.offsetHeight }));
    dragging = { row, id: press.id, from: row.index, x, y, dx: x - slot.left, dy: y - slot.top, slots };
    press = null;
    row.el.classList.add('is-dragging');
    list.classList.add('is-dragging');
    setActive(row.index);
    try { navigator.vibrate?.(10); } catch { /* not allowed */ }
    o.onMoveStart?.();
    track();
  };

  /** The place the pointer is over (nearest in a column, so a gap between rows counts too). */
  const placeAt = (d) => {
    const g = list.getBoundingClientRect();
    const x = d.x - g.left - list.clientLeft + list.scrollLeft;
    const y = d.y - g.top - list.clientTop + list.scrollTop;
    let best = -1;
    let bestDist = Infinity;
    for (let k = 0; k < d.slots.length; k++) {
      const s = d.slots[k];
      if (x >= s.left && x < s.right && y >= s.top && y < s.bottom) return k;
      const dx = x < s.left ? s.left - x : x > s.right ? x - s.right : 0;
      const dy = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = k; }
    }
    // Only between places, not far outside the list.
    return bestDist <= 24 ? best : -1;
  };

  /** Draws the lifted row under the pointer, and moves it to the place it is held over. */
  const track = () => {
    const d = dragging;
    if (!d) return;
    const k = placeAt(d);
    if (k >= 0 && k !== d.row.index) move(d.row.index, k, { animate: true });
    const slot = slotOf(d.row);
    d.row.el.style.transform = `translate(${d.x - d.dx - slot.left}px, ${d.y - d.dy - slot.top}px)`;
  };

  const findScroller = (node) => {
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return document.scrollingElement;
  };

  const autoScroll = () => {
    if (scrollFrame) return;
    const step = () => {
      scrollFrame = 0;
      const d = dragging;
      if (!d) return;
      // The list itself when it scrolls, and the page once the list can scroll no further.
      const own = findScroller(list);
      const isDoc = own === document.scrollingElement;
      const top = isDoc ? 0 : Math.max(0, own.getBoundingClientRect().top);
      const bottom = isDoc ? window.innerHeight : Math.min(window.innerHeight, own.getBoundingClientRect().bottom);
      let speed = 0;
      if (d.y < top + EDGE) speed = -Math.ceil(((top + EDGE - d.y) / EDGE) * 14);
      else if (d.y > bottom - EDGE) speed = Math.ceil(((d.y - (bottom - EDGE)) / EDGE) * 14);
      if (!speed) return;
      let moved = false;
      for (const s of isDoc ? [own] : [own, document.scrollingElement]) {
        const before = s.scrollTop;
        s.scrollTop += speed;
        if (s.scrollTop !== before) { moved = true; break; }
      }
      if (moved) track();
      scrollFrame = requestAnimationFrame(step);
    };
    scrollFrame = requestAnimationFrame(step);
  };

  const endDrag = () => {
    const d = dragging;
    if (!d) return;
    dragging = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    removeWindowListeners();
    d.row.el.classList.remove('is-dragging');
    list.classList.remove('is-dragging');
    d.row.el.style.transform = '';
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    const to = d.row.index;
    o.onMoveEnd?.(d.from, to);
    if (to !== d.from) announce(t('web_page_moved', to + 1, rows.length));
    d.row.handle?.focus({ preventScroll: true });
  };

  /**
   * Moves the row with `key` by `offset` places, as its own move buttons do: said to screen
   * readers, the focus kept on the button pressed (or the row, once that button is off).
   */
  list.moveBy = (key, offset) => {
    const row = byKey.get(key);
    if (!row || dragging) return false;
    const focused = document.activeElement;
    setActive(row.index);
    const moved = move(row.index, row.index + offset, { say: true });
    if (moved) keepFocus(row, focused);
    return moved;
  };

  /** The row with `key`: { el, handle, index, item }, or undefined. */
  list.rowOf = (key) => byKey.get(key);

  list.destroy = () => {
    observer?.disconnect();
    for (const row of rows) { row.unload?.(); row.destroy?.(); }
    removeWindowListeners();
    if (press) clearTimeout(press.timer);
    cancelAnimationFrame(scrollFrame);
  };
  Object.defineProperty(list, 'count', { get: count, configurable: true });
  return list;
}
