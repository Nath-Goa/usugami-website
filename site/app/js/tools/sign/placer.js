// Choosing where the signature goes (SignOptions.kt): the pages in a row to pick from, then the
// chosen page with the signature on it, drawn as the PDF will have it, to drag into place, a size
// slider, and buttons that move it a step at a time (for those who can't drag). On computers the
// signature can also be moved with the arrow keys.
import { h, svg, isWide } from '../../core/dom.js';
import { t, formatNumber } from '../../core/i18n.js';
import { iconButton, slider, uid } from '../../core/ui.js';
import {
  PEN_WIDTH, clampPlacement, defaultPlacement, widthRange, signaturePathData, inkColor,
} from '../../engine/sign.js';

/** Each nudge moves the signature by this share of the page. */
export const NUDGE = 0.02;
/** The dashed frame's distance from the signature, in CSS pixels. */
const GAP = 4;
/** How far around the signature a press still picks it up to drag, in CSS pixels. */
const REACH = 16;
/** The size slider's steps across the signature's range of widths. */
const SIZE_STEPS = 1000;
/** Until the page's size is known, an A4 page stands in for it. */
const A4 = { width: 595, height: 842 };

/**
 * A picture of `signature` (a Signature) filling its box, as an <svg>: the strokes drawn with the
 * pen in pad units, so it is as sharp as the screen at any size. `fit` 'meet' keeps it whole and
 * centred in a box of another shape.
 */
export function signatureSvg(signature, { fit = 'none', cls = '' } = {}) {
  const b = signature.bounds;
  const { line, dots } = signaturePathData(signature.strokes);
  const color = inkColor(signature.ink);
  return svg('svg', {
    class: cls, viewBox: `${b.x} ${b.y} ${b.width} ${b.height}`, preserveAspectRatio: fit === 'meet' ? 'xMidYMid meet' : 'none',
    'aria-hidden': 'true', focusable: 'false',
  },
  line ? svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': String(PEN_WIDTH), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) : null,
  dots ? svg('path', { d: dots, fill: color }) : null);
}

/**
 * The pages in a row, each a radio button named "Page 3" showing its preview and number (the
 * app's PageStrip). Previews are drawn only near the visible part of the row. Arrow keys, Home and
 * End choose; a mouse wheel scrolls the row.
 * @returns {HTMLElement} with setSelected(i), destroy()
 */
export function pageStrip({ src, selected, onSelect, label }) {
  const list = h('div', { class: 'sign-strip', role: 'radiogroup', 'aria-label': label });
  const items = [];
  const shown = new Map();
  let current = selected;

  const load = (i) => {
    if (shown.has(i)) return;
    const controller = new AbortController();
    shown.set(i, controller);
    const holder = items[i].firstChild;
    src.thumbnail(i, 72, { maxCssHeight: 92, signal: controller.signal }).then((canvas) => {
      if (shown.get(i) !== controller) return;
      canvas.classList.add('ui-fade-in');
      holder.replaceChildren(canvas);
    }, () => { /* cancelled or not drawable: the blank stays */ });
  };
  const unload = (i) => {
    const c = shown.get(i);
    if (!c) return;
    c.abort();
    shown.delete(i);
    items[i].firstChild.replaceChildren();
  };
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.index);
        if (e.isIntersecting) load(i); else unload(i);
      }
    }, { root: list, rootMargin: '0px 600px' })
    : null;

  const render = () => {
    items.forEach((b, i) => {
      const on = i === current;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('is-selected', on);
      b.tabIndex = on ? 0 : -1;
    });
  };

  /** Scrolls the row, not the page, so that page `i` shows (at the start when `start`). */
  const reveal = (i, start = false) => {
    const item = items[i];
    if (!item) return;
    const r = item.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const rtl = getComputedStyle(list).direction === 'rtl';
    const pad = 4;
    let dx = 0;
    if (start) dx = rtl ? r.right - l.right + pad : r.left - l.left - pad;
    else if (r.left < l.left) dx = r.left - l.left - pad;
    else if (r.right > l.right) dx = r.right - l.right + pad;
    if (dx) list.scrollLeft += dx;
  };

  const choose = (i, focus) => {
    i = Math.max(0, Math.min(src.pageCount - 1, i));
    if (focus) {
      items[i].focus({ preventScroll: true });
      reveal(i);
    }
    if (i === current) return;
    current = i;
    render();
    onSelect(i);
  };

  for (let i = 0; i < src.pageCount; i++) {
    const b = h('button', {
      type: 'button', role: 'radio', class: 'sign-strip-page', 'aria-label': t('pdf_page_number', i + 1), dataset: { index: i },
    },
    h('span', { class: 'sign-strip-thumb', 'aria-hidden': 'true' }),
    h('span', { class: 'sign-strip-number', 'aria-hidden': 'true' }, formatNumber(i + 1)));
    b.addEventListener('click', () => choose(i, false));
    items.push(b);
  }
  list.append(...items);
  list.addEventListener('keydown', (e) => {
    const rtl = getComputedStyle(list).direction === 'rtl';
    let next = null;
    if (e.key === 'ArrowRight') next = current + (rtl ? -1 : 1);
    else if (e.key === 'ArrowLeft') next = current + (rtl ? 1 : -1);
    else if (e.key === 'ArrowDown') next = current + 1;
    else if (e.key === 'ArrowUp') next = current - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = src.pageCount - 1;
    else return;
    e.preventDefault();
    choose(next, true);
  });
  // A mouse wheel turns into scrolling along the row, which has nowhere to go up or down.
  list.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const max = list.scrollWidth - list.clientWidth;
    if (max <= 0) return;
    const before = list.scrollLeft;
    list.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (list.scrollLeft !== before) e.preventDefault();
  }, { passive: false });
  render();
  if (observer) for (const b of items) observer.observe(b);
  else for (let i = 0; i < Math.min(items.length, 12); i++) load(i);
  // The row starts with the page before the chosen one, as the app's.
  requestAnimationFrame(() => reveal(Math.max(0, current - 1), true));

  list.setSelected = (i) => { current = i; render(); };
  list.destroy = () => {
    observer?.disconnect();
    for (const c of shown.values()) c.abort();
    shown.clear();
  };
  return list;
}

/**
 * The chosen page with `signature` where `placement` puts it ({ centerX, centerY, width } as
 * shares of the page as shown, or null for where it starts out), to drag into place; a tap
 * elsewhere on the page moves it there, and a swipe that starts off it scrolls the screen. Then a
 * size slider and the four nudge buttons (`controls`, put where the screen wants them).
 * onPlacement(placement) is told every change.
 * @returns {{ el: HTMLElement, controls: HTMLElement, setPage(i), setSignature(signature), placed(), destroy() }}
 */
export function signaturePlacer({ src, signature, page, placement, onPlacement }) {
  let pageIndex = page;
  let size = A4;
  let sig = signature;
  let wanted = placement;
  let previewW = 0;
  let previewH = 0;
  let renderedW = 0;
  let token = 0;
  let controller = null;
  let resizeTimer = 0;
  let destroyed = false;

  const id = uid('sign-place');
  const fine = matchMedia('(pointer: fine)').matches;
  const pageHolder = h('div', { class: 'sign-preview-page' });
  const inkHolder = h('div', { class: 'sign-mark-ink' });
  const frameRect = svg('rect', { x: '0.75', y: '0.75', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-dasharray': '6 4' });
  const frameSvg = svg('svg', { class: 'sign-mark-frame', 'aria-hidden': 'true', focusable: 'false' }, frameRect);
  const keysHint = h('span', { class: 'visually-hidden', id: id + '-keys' }, t('web_sign_keys_hint'));
  const mark = h('div', { class: 'sign-mark', tabindex: '0', role: 'img', 'aria-describedby': id + '-keys' }, frameSvg, inkHolder);
  const preview = h('div', { class: 'sign-preview' }, pageHolder, mark, keysHint);
  const wrap = h('div', { class: 'sign-preview-wrap' }, preview);
  const hint = h('p', { class: 'sign-hint' }, t(fine ? 'web_sign_place_hint' : 'sign_place_hint'));

  const sizeSlider = slider({
    label: t('sign_size'), min: 0, max: SIZE_STEPS, step: 1, value: 0,
    format: (v) => t('web_sign_size_value', formatNumber(Math.round((v / SIZE_STEPS) * 100))),
    onChange: (v) => {
      const p = placed();
      const [lo, hi] = range();
      set({ ...p, width: lo + (v / SIZE_STEPS) * (hi - lo) }, false);
    },
  });
  sizeSlider.input.setAttribute('aria-label', t('sign_size_description'));
  sizeSlider.classList.add('sign-size');

  /** A step on from where the signature is now, which may be further than the screen shows yet. */
  const step = (dx, dy) => () => {
    const p = placed();
    return fit({ ...p, centerX: p.centerX + dx, centerY: p.centerY + dy });
  };
  const moves = [
    { icon: 'west', label: 'sign_move_left', move: step(-NUDGE, 0) },
    { icon: 'north', label: 'sign_move_up', move: step(0, -NUDGE) },
    { icon: 'south', label: 'sign_move_down', move: step(0, NUDGE) },
    { icon: 'east', label: 'sign_move_right', move: step(NUDGE, 0) },
  ];
  for (const m of moves) {
    m.button = iconButton({ icon: m.icon, label: t(m.label), onClick: () => set(m.move(), true) });
  }
  const nudges = h('div', { class: 'sign-nudges' }, ...moves.map((m) => m.button));

  const headingId = id + '-title';
  const heading = h('h2', { class: 'sign-title', id: headingId }, t('sign_place'));
  const el = h('section', { class: 'sign-place', 'aria-labelledby': headingId }, heading, wrap, hint);
  // The size and the nudge buttons: under the preview on phones, beside it on wide screens.
  const controls = h('div', { class: 'sign-controls', role: 'group', 'aria-labelledby': headingId }, sizeSlider, nudges);

  const fit = (p) => clampPlacement(p, size.width, size.height, sig.aspect);
  const placed = () => fit(wanted ?? defaultPlacement(size.width, size.height, sig.aspect));
  const range = () => widthRange(size.width, size.height, sig.aspect);
  const same = (a, b) => Math.abs(a.centerX - b.centerX) < 1e-9 && Math.abs(a.centerY - b.centerY) < 1e-9 && Math.abs(a.width - b.width) < 1e-9;

  function set(p, glide) {
    wanted = fit(p);
    draw(glide);
    onPlacement(wanted);
  }

  function drawInk() {
    inkHolder.replaceChildren(signatureSvg(sig, { cls: 'sign-mark-svg' }));
  }

  /** Puts the signature where it is now; `glide` lets it move there smoothly (a tap or a nudge). */
  function draw(glide = false) {
    const p = placed();
    const boxW = p.width * previewW;
    const boxH = boxW / sig.aspect;
    const left = p.centerX * previewW - boxW / 2;
    const top = p.centerY * previewH - boxH / 2;
    mark.classList.toggle('is-gliding', !!glide);
    mark.style.width = `${boxW + 2 * GAP}px`;
    mark.style.height = `${boxH + 2 * GAP}px`;
    mark.style.transform = `translate(${left - GAP}px, ${top - GAP}px)`;
    frameRect.setAttribute('width', String(Math.max(0, boxW + 2 * GAP - 1.5)));
    frameRect.setAttribute('height', String(Math.max(0, boxH + 2 * GAP - 1.5)));
    const [lo, hi] = range();
    const usable = hi > lo;
    sizeSlider.setDisabled(!usable);
    sizeSlider.setValue(usable ? Math.round(((p.width - lo) / (hi - lo)) * SIZE_STEPS) : 0);
    for (const m of moves) m.button.disabled = same(m.move(), p);
  }

  /** The preview's size: as wide as there is room, and short enough for the whole page to show. */
  function layout() {
    const room = wrap.clientWidth;
    if (!room) return;
    const vh = window.innerHeight || 800;
    const tallest = isWide() ? Math.min(760, Math.max(240, vh - 200)) : Math.min(440, Math.max(240, vh - 180));
    const aspect = size.width / size.height;
    previewW = Math.min(room, tallest * aspect);
    previewH = previewW / aspect;
    preview.style.width = `${previewW}px`;
    preview.style.height = `${previewH}px`;
    draw(false);
  }

  /** Draws the chosen page; the page drawn last stays meanwhile, instead of a blank. */
  async function drawPage() {
    const mine = ++token;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    mark.setAttribute('aria-label', t('sign_preview_description', pageIndex + 1));
    try {
      const s = await src.pageSize(pageIndex);
      if (mine !== token || destroyed) return;
      if (s.width > 0 && s.height > 0) size = { width: s.width, height: s.height };
      layout();
      if (!previewW) return;
      renderedW = previewW;
      const canvas = await src.render(pageIndex, { cssWidth: previewW, maxCssHeight: previewH, signal });
      if (mine !== token || destroyed) return;
      pageHolder.replaceChildren(canvas);
    } catch {
      // Cancelled for another page, or not drawable: the white page stays.
    }
  }

  // ---- Dragging the signature, tapping elsewhere, and the arrow keys.

  let drag = null;
  let tap = null;
  mark.addEventListener('pointerdown', (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = preview.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: placed(), w: r.width, h: r.height };
    try { mark.setPointerCapture(e.pointerId); } catch { /* gone already */ }
    mark.classList.add('is-dragging');
    mark.focus({ preventScroll: true });
  });
  mark.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { start } = drag;
    set({ ...start, centerX: start.centerX + (e.clientX - drag.x) / drag.w, centerY: start.centerY + (e.clientY - drag.y) / drag.h }, false);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    mark.classList.remove('is-dragging');
  };
  mark.addEventListener('pointerup', endDrag);
  mark.addEventListener('pointercancel', endDrag);
  mark.addEventListener('lostpointercapture', endDrag);
  preview.addEventListener('pointerdown', (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    tap = { id: e.pointerId };
  });
  preview.addEventListener('pointerup', (e) => {
    if (!tap || e.pointerId !== tap.id) return;
    tap = null;
    const r = preview.getBoundingClientRect();
    set({ ...placed(), centerX: (e.clientX - r.left) / r.width, centerY: (e.clientY - r.top) / r.height }, true);
  });
  // The browser scrolling the screen (a swipe that started off the signature) isn't a tap.
  preview.addEventListener('pointercancel', () => { tap = null; });
  mark.addEventListener('keydown', (e) => {
    const index = { ArrowLeft: 0, ArrowUp: 1, ArrowDown: 2, ArrowRight: 3 }[e.key];
    if (index == null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    set(moves[index].move(), true);
  });

  // Laid out after the browser's layout pass, so sizing the preview can't loop back into it.
  let sizing = 0;
  const relayout = () => {
    sizing = 0;
    if (destroyed) return;
    layout();
    // Drawn again, sharp, once the size has settled.
    if (previewW && Math.abs(previewW - renderedW) > 1) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!destroyed) drawPage(); }, 200);
    }
  };
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (!sizing) sizing = requestAnimationFrame(relayout); })
    : null;
  observer?.observe(wrap);

  drawInk();
  requestAnimationFrame(() => { if (!destroyed) layout(); });
  drawPage();

  return {
    el,
    controls,
    setPage(i) {
      if (i === pageIndex) return;
      pageIndex = i;
      drawPage();
    },
    setSignature(s) {
      sig = s;
      // Its place is kept, fitted to the new signature's shape.
      if (wanted) {
        wanted = fit(wanted);
        onPlacement(wanted);
      }
      drawInk();
      draw(false);
    },
    placed,
    destroy() {
      destroyed = true;
      token++;
      controller?.abort();
      clearTimeout(resizeTimer);
      if (sizing) cancelAnimationFrame(sizing);
      observer?.disconnect();
    },
  };
}
