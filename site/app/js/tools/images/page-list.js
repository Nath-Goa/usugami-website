// The editor's pages (EditorScreen.kt's PageGrid and PageCardContent): a card for each page with its
// live preview, its number, a crop button on the picture, its name, and Rotate left, Rotate right and
// Remove under it; then "Add more". Pages move by a long press and drag (touch), a drag (mouse),
// Ctrl (⌘) and the arrow keys on a focused page, or its Move earlier and Move later buttons, which
// show when it has the focus and are always there for screen readers.
import { h, announce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { iconButton, uid } from '../../core/ui.js';
import { pagePreview } from './preview.js';
import { LOOK_LABELS } from '../../engine/images/looks.js';

/** How long a finger is held on a page before it lifts, to be dragged. */
const LONG_PRESS_MS = 450;
/** How far a held finger may wander before it counts as scrolling. */
const TOUCH_SLOP = 10;
/** How far a mouse moves with its button down before it drags the page. */
const MOUSE_SLOP = 5;
/** Within this distance of the top or bottom of what shows, a page being dragged scrolls. */
const EDGE = 56;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const TURNED = { 90: 'rotated_right', 180: 'rotated_upside_down', 270: 'rotated_left' };

/** A name cut in its middle when it doesn't fit, as TextOverflow.MiddleEllipsis does. */
function middleName() {
  const head = h('span', { class: 'images-name-head' });
  const tail = h('span', { class: 'images-name-tail' });
  const full = h('span', { class: 'ui-visually-hidden' });
  const el = h('div', { class: 'images-card-name' }, h('span', { class: 'images-name-shown', 'aria-hidden': 'true' }, head, tail), full);
  el.setName = (name) => {
    const cut = Math.min(10, Math.floor(name.length / 2));
    head.textContent = name.slice(0, name.length - cut);
    tail.textContent = name.slice(name.length - cut);
    full.textContent = name;
    el.title = name;
  };
  return el;
}

/**
 * @param {object} o
 * @param {(id: number, button: HTMLElement) => void} o.onCrop
 * @param {(id: number, degrees: number) => void} o.onRotate
 * @param {(id: number) => void} o.onRemove
 * @param {(from: number, to: number) => boolean} o.onMove   a page moved (places); false refuses
 * @param {(anchor: HTMLElement) => void} o.onAddMore
 * @returns {HTMLElement} el.update(items, { layout, cropping }), el.focusPage(id, part?), el.destroy()
 */
export function pageList(o) {
  const hintId = uid('images-hint');
  const list = h('div', { class: 'images-grid', role: 'list', 'aria-label': t('editor_title') });
  const hint = h('span', { id: hintId, class: 'ui-visually-hidden' }, t('web_reorder_hint'));
  const addMore = h('button', { type: 'button', class: 'images-add-more', 'aria-haspopup': 'menu' },
    h('span', { class: 'images-add-more-icon', 'aria-hidden': 'true' }, icon('add', { size: 36 })),
    h('span', { class: 'images-add-more-label' }, t('add_more')));
  addMore.addEventListener('click', () => o.onAddMore(addMore));
  const addItem = h('div', { class: 'images-add-more-item', role: 'listitem' }, addMore);
  const wrap = h('div', { class: 'images-grid-wrap' }, hint, list);
  /** id → card, and the cards in the order shown. */
  const cards = new Map();
  let order = [];
  let count = 0;

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const e of entries) e.target.card?.preview.show(e.isIntersecting);
    }, { rootMargin: '600px 0px' })
    : null;

  class Card {
    constructor(id) {
      this.id = id;
      this.index = 0;
      this.preview = pagePreview();
      this.number = h('span', { class: 'images-card-number', 'aria-hidden': 'true' });
      this.handle = h('div', { class: 'images-card-handle', tabindex: '0', role: 'img', 'aria-describedby': hintId }, this.preview);
      this.crop = iconButton({ icon: 'crop', label: '', variant: 'tonal', cls: 'images-card-crop', onClick: () => o.onCrop(this.id, this.crop) });
      this.spinner = h('div', { class: 'images-spinner images-card-spinner', role: 'progressbar' });
      this.spinner.hidden = true;
      this.name = middleName();
      this.left = iconButton({ icon: 'rotate_left', label: '', onClick: () => o.onRotate(this.id, -90) });
      this.right = iconButton({ icon: 'rotate_right', label: '', onClick: () => o.onRotate(this.id, 90) });
      this.remove = iconButton({ icon: 'close', label: '', onClick: () => o.onRemove(this.id) });
      // A turn to the left is to the left whichever way the text runs (TurnIcon).
      for (const b of [this.left, this.right]) b.querySelector('.icon')?.classList.remove('icon-mirrored');
      this.earlier = iconButton({ icon: 'arrow_back', label: '', cls: 'images-card-move', onClick: () => moveBy(this, -1, 'earlier') });
      this.later = iconButton({ icon: 'arrow_forward', label: '', cls: 'images-card-move', onClick: () => moveBy(this, 1, 'later') });
      this.moves = h('div', { class: 'images-card-moves' }, this.earlier, this.later);
      this.picture = h('div', { class: 'images-card-picture' }, this.handle, this.number, this.crop, this.moves, this.spinner);
      this.actions = h('div', { class: 'images-card-actions' }, this.left, this.right, this.remove);
      this.el = h('div', { class: 'images-card', role: 'listitem' }, this.picture, this.name, this.actions);
      this.el.card = this;
      observer?.observe(this.el);
      if (!observer) this.preview.show(true);
    }

    update(item, index, total, layout, cropping) {
      this.index = index;
      const n = index + 1;
      this.number.textContent = String(n);
      // The page is only drawn turned, and with its look: a screen reader hears both.
      const state = [TURNED[item.rotation] ? t(TURNED[item.rotation]) : null, item.look !== 'original' ? t(LOOK_LABELS[item.look]) : null].filter(Boolean);
      this.handle.setAttribute('aria-label', [t('pdf_page_number', n), ...state].join(', '));
      this.crop.setLabel(t('crop_page', n));
      this.crop.disabled = cropping;
      this.spinner.hidden = !cropping;
      this.spinner.setAttribute('aria-label', t('cropping_page', n));
      this.name.setName(item.name);
      this.left.setLabel(t('rotate_page_left', n));
      this.right.setLabel(t('rotate_page_right', n));
      this.remove.setLabel(t('remove_page', n));
      this.earlier.setLabel(t('move_page_earlier', n));
      this.later.setLabel(t('move_page_later', n));
      this.earlier.disabled = index === 0;
      this.later.disabled = index === total - 1;
      this.moves.hidden = total < 2;
      this.preview.update(item, layout);
    }

    destroy() {
      observer?.unobserve(this.el);
      this.preview.show(false);
    }
  }

  // ---- Showing the pages ----

  /** Where each card is on screen, to glide them from there after a change (FLIP). */
  const rects = () => {
    const map = new Map();
    const vh = window.innerHeight;
    for (const card of cards.values()) {
      // A card just made has no place yet to glide from.
      if (!card.el.isConnected) continue;
      const r = card.el.getBoundingClientRect();
      if (r.width && r.bottom >= -50 && r.top <= vh + 50) map.set(card, r);
    }
    return map;
  };

  const glide = (before, skip) => {
    for (const [card, r] of before) {
      if (card === skip || !card.el.isConnected) continue;
      const now = card.el.getBoundingClientRect();
      const dx = r.left - now.left;
      const dy = r.top - now.top;
      if (!dx && !dy) continue;
      card.el.style.transition = 'none';
      card.el.style.transform = `translate(${dx}px, ${dy}px)`;
      card.el.getBoundingClientRect();
      card.el.style.transition = '';
      card.el.style.transform = '';
    }
  };

  /** Puts the cards in `order` in the list, the moved ones gliding to their places. */
  const arrange = (animate) => {
    const before = animate && !reducedMotion() ? rects() : null;
    let at = list.firstChild;
    for (const card of order) {
      if (card.el !== at) list.insertBefore(card.el, at);
      else at = at.nextSibling;
      at = card.el.nextSibling;
    }
    if (addItem !== list.lastChild) list.append(addItem);
    if (before) glide(before, dragging?.card);
  };

  list.update = (items, { layout, cropping }) => {
    const seen = new Set();
    const next = [];
    count = items.length;
    items.forEach((item, i) => {
      let card = cards.get(item.id);
      if (!card) {
        card = new Card(item.id);
        cards.set(item.id, card);
      }
      seen.add(item.id);
      card.update(item, i, items.length, layout, cropping.has(item.id));
      next.push(card);
    });
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.destroy();
        card.el.remove();
        cards.delete(id);
      }
    }
    const moved = next.length !== order.length || next.some((c, i) => order[i] !== c);
    order = next;
    if (moved) arrange(!dragging);
    else if (!addItem.isConnected) list.append(addItem);
  };

  // ---- Moving pages ----

  /** Moves the page at `from` to `to`, telling the model first; its card goes there at once. */
  const move = (from, to, { focus, say } = {}) => {
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) return false;
    const card = order[from];
    if (o.onMove(from, to) === false) return false;
    // The model may have redrawn already; else the cards are put in order here.
    if (order[to] !== card) {
      order.splice(to, 0, ...order.splice(from, 1));
      arrange(true);
    }
    if (focus === 'handle') {
      card.handle.focus({ preventScroll: true });
      card.handle.scrollIntoView?.({ block: 'nearest' });
    } else if (focus === 'earlier' || focus === 'later') {
      const target = focus === 'earlier' && !card.earlier.disabled ? card.earlier
        : focus === 'later' && !card.later.disabled ? card.later : card.handle;
      target.focus({ preventScroll: true });
    }
    if (say) announce(t('web_page_moved', to + 1, count));
    return true;
  };

  const moveBy = (card, by, focus) => move(card.index, card.index + by, { focus, say: true });

  const columns = () => Math.max(1, getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length);

  list.addEventListener('keydown', (e) => {
    const handle = e.target.closest?.('.images-card-handle');
    if (!handle || !(e.ctrlKey || e.metaKey)) return;
    const card = handle.closest('.images-card').card;
    const i = card.index;
    const rtl = getComputedStyle(list).direction === 'rtl';
    let to = null;
    switch (e.key) {
      case 'ArrowRight': to = i + (rtl ? -1 : 1); break;
      case 'ArrowLeft': to = i + (rtl ? 1 : -1); break;
      case 'ArrowDown': to = i + columns(); break;
      case 'ArrowUp': to = i - columns(); break;
      case 'Home': to = 0; break;
      case 'End': to = count - 1; break;
      default: return;
    }
    e.preventDefault();
    move(i, Math.max(0, Math.min(count - 1, to)), { focus: 'handle', say: true });
  });

  // A finger lifts a page after a long press (a quick swipe still scrolls); a mouse drags at once.
  let press = null;
  let dragging = null;
  let scrollFrame = 0;
  let suppressClick = false;

  list.addEventListener('pointerdown', (e) => {
    if (dragging || (e.pointerType === 'mouse' && e.button !== 0) || count < 2) return;
    const el = e.target.closest('.images-card');
    if (!el || e.target.closest('button')) return;
    press = { card: el.card, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, timer: 0 };
    if (e.pointerType !== 'mouse') {
      press.timer = setTimeout(() => { if (press?.card === el.card) startDrag(press.x, press.y); }, LONG_PRESS_MS);
    }
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  });
  list.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  list.addEventListener('contextmenu', (e) => { if (press || dragging) e.preventDefault(); });
  list.addEventListener('click', (e) => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick = false;
  }, true);
  // The browser's own drag of the picture would take over the mouse.
  list.addEventListener('dragstart', (e) => { if (e.target.closest?.('.images-card')) e.preventDefault(); });

  const onPointerMove = (e) => {
    if (press && e.pointerId === press.id && !dragging) {
      const dist = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
      if (press.type === 'mouse') {
        if (dist > MOUSE_SLOP) startDrag(press.x0, press.y0);
      } else if (dist > TOUCH_SLOP) {
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
    if (!dragging) removeListeners();
  };

  const removeListeners = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };

  /** Where a card's place is on screen, without the shift it is drawn with. */
  const slotOf = (card) => {
    const g = list.getBoundingClientRect();
    return { left: g.left + card.el.offsetLeft, top: g.top + card.el.offsetTop };
  };

  const startDrag = (x, y) => {
    if (!press) return;
    const card = press.card;
    clearTimeout(press.timer);
    const slot = slotOf(card);
    // The places, measured once: the k-th place stays where it is whichever page is in it.
    const slots = order.map((c) => ({ left: c.el.offsetLeft, top: c.el.offsetTop, right: c.el.offsetLeft + c.el.offsetWidth, bottom: c.el.offsetTop + c.el.offsetHeight }));
    dragging = { card, id: press.id, from: card.index, x, y, dx: x - slot.left, dy: y - slot.top, slots };
    press = null;
    card.el.classList.add('is-dragging');
    list.classList.add('is-dragging');
    try { navigator.vibrate?.(10); } catch { /* not allowed */ }
    track();
  };

  const placeAt = (d) => {
    const g = list.getBoundingClientRect();
    const x = d.x - g.left;
    const y = d.y - g.top;
    for (let k = 0; k < d.slots.length; k++) {
      const s = d.slots[k];
      if (x >= s.left && x < s.right && y >= s.top && y < s.bottom) return k;
    }
    return -1;
  };

  /** Draws the lifted page under the pointer, and moves it to the place it is held over. */
  const track = () => {
    const d = dragging;
    if (!d) return;
    const k = placeAt(d);
    if (k >= 0 && k !== d.card.index) move(d.card.index, k);
    const slot = slotOf(d.card);
    d.card.el.style.transform = `translate(${d.x - d.dx - slot.left}px, ${d.y - d.dy - slot.top}px)`;
  };

  /** The window scrolls while the page is held near the top or bottom of what shows. */
  const autoScroll = () => {
    if (scrollFrame) return;
    const step = () => {
      scrollFrame = 0;
      const d = dragging;
      if (!d) return;
      const top = (document.querySelector('.images-editor .ui-topbar')?.getBoundingClientRect().bottom ?? 0) + EDGE;
      const bottom = (document.querySelector('.images-editor .ui-bottombar')?.getBoundingClientRect().top ?? window.innerHeight) - EDGE;
      let speed = 0;
      if (d.y < top) speed = -Math.ceil(Math.min(1, (top - d.y) / EDGE) * 14);
      else if (d.y > bottom) speed = Math.ceil(Math.min(1, (d.y - bottom) / EDGE) * 14);
      if (!speed) return;
      const before = window.scrollY;
      window.scrollBy(0, speed);
      if (window.scrollY !== before) track();
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
    removeListeners();
    d.card.el.classList.remove('is-dragging');
    list.classList.remove('is-dragging');
    d.card.el.style.transform = '';
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    const to = d.card.index;
    if (to !== d.from) announce(t('web_page_moved', to + 1, count));
    d.card.handle.focus({ preventScroll: true });
  };

  wrap.update = (items, state) => list.update(items, state);
  wrap.focusPage = (id, part = 'crop') => {
    const card = cards.get(id);
    if (!card) return false;
    const target = part === 'crop' && !card.crop.disabled ? card.crop : part === 'remove' ? card.remove : card.handle;
    target.focus({ preventScroll: true });
    return true;
  };
  wrap.focusAddMore = () => addMore.focus({ preventScroll: true });
  wrap.destroy = () => {
    observer?.disconnect();
    removeListeners();
    for (const card of cards.values()) card.destroy();
  };
  wrap.list = list;
  return wrap;
}
