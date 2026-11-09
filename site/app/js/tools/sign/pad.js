// The pad to sign on (SignaturePad.kt's SignaturePadDialog): white like paper, with a line to sign
// above, black or blue ink, Clear and Done. Full screen on phones, a dialog in the middle on wide
// screens. A finger, a pen or a mouse signs; strokes are kept in pad units, so a drawing keeps its
// place when the pad changes size (turning the phone, resizing the window).
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { button, iconButton, uid } from '../../core/ui.js';
import {
  Signature, PAD_WIDTH, PAD_HEIGHT, MIN_STEP, MAX_POINTS, drawSignature, inkColor,
} from '../../engine/signature.js';

const INK_ORDER = ['black', 'blue'];
// The line to sign on: black at 0x42 alpha, as the app draws it.
const LINE_COLOR = 'rgba(0, 0, 0, 0.259)';

let openPad = null;

/** Closes the pad if one is open (the tool is going away). */
export function closeSignaturePad() {
  openPad?.(null);
}

/**
 * Opens the pad, starting from `initial` (a Signature) if there is one. Resolves with the drawing
 * once Done is pressed (the stroke being drawn included), or null when the pad is closed, which
 * keeps the signature there was.
 * @param {{ initial?: Signature | null }} [options]
 * @returns {Promise<Signature | null>}
 */
export function openSignaturePad({ initial } = {}) {
  closeSignaturePad();
  let draft = initial instanceof Signature && !initial.isEmpty ? initial : new Signature([], 'black');
  // The stroke a finger, pen or mouse is drawing, in pad units: x, y, x, y, …
  let stroke = [];
  // Clear was pressed while it was drawn: the rest of it isn't drawn either.
  let dropped = false;
  let active = null;
  let room = 0;
  let box = null;
  let frame = 0;
  let closed = false;

  const id = uid('sign-pad');
  const fine = matchMedia('(pointer: fine)').matches;
  const titleEl = h('h2', { class: 'sign-pad-title', id: id + '-title' }, t('sign_draw'));
  const hint = h('p', { class: 'sign-pad-hint', id: id + '-hint' }, t(fine ? 'web_sign_pad_hint' : 'sign_pad_hint'));
  const canvas = h('canvas', { class: 'sign-pad-canvas' });
  const pad = h('div', { class: 'sign-pad', role: 'img', 'aria-label': t('sign_pad'), 'aria-describedby': id + '-hint' }, canvas);
  const area = h('div', { class: 'sign-pad-area' }, pad);
  const inkLabel = h('span', { class: 'sign-pad-ink-label', id: id + '-ink' }, t('sign_ink'));
  const swatches = INK_ORDER.map((ink) => {
    const b = h('button', {
      type: 'button', role: 'radio', class: 'sign-swatch', 'aria-label': t('color_' + ink), title: t('color_' + ink),
      style: { '--sign-swatch': inkColor(ink) }, dataset: { ink },
    }, h('span', { class: 'sign-swatch-dot', 'aria-hidden': 'true' }, icon('check', { size: 24 })));
    b.addEventListener('click', () => setInk(ink));
    b.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const rtl = getComputedStyle(b).direction === 'rtl' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
      const next = INK_ORDER[(INK_ORDER.indexOf(ink) + (rtl ? -step : step) + INK_ORDER.length) % INK_ORDER.length];
      setInk(next);
      swatches[INK_ORDER.indexOf(next)].focus();
    });
    return b;
  });
  const swatchGroup = h('div', { class: 'sign-swatches', role: 'radiogroup', 'aria-labelledby': id + '-ink' }, ...swatches);
  const clearBtn = button({ label: t('sign_clear'), variant: 'outlined', onClick: clearDrawing, cls: 'sign-pad-clear' });
  const doneBtn = button({ label: t('sign_done'), onClick: done, cls: 'sign-pad-done' });
  const closeBtn = iconButton({ icon: 'close', label: t('cancel'), onClick: () => finish(null) });
  const surface = h('div', { class: 'sign-pad-surface' },
    h('header', { class: 'sign-pad-bar' }, closeBtn, titleEl),
    h('div', { class: 'sign-pad-body' },
      hint,
      area,
      h('div', { class: 'sign-pad-row' }, inkLabel, swatchGroup, h('span', { class: 'sign-pad-spacer' }), clearBtn)),
    h('div', { class: 'sign-pad-actions' }, doneBtn));
  const dialog = h('dialog', { class: 'ui-dialog sign-pad-dialog', 'aria-labelledby': id + '-title', 'aria-modal': 'true' }, surface);

  const ctx = canvas.getContext('2d');

  function draw() {
    frame = 0;
    if (!ctx) return;
    const w = canvas.width;
    const hgt = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const ratio = w / Math.max(1, pad.clientWidth || 1);
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = Math.max(1, ratio);
    ctx.beginPath();
    ctx.moveTo(w * 0.06, hgt * 0.72);
    ctx.lineTo(w * 0.94, hgt * 0.72);
    ctx.stroke();
    const scale = w / PAD_WIDTH;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const strokes = stroke.length && !dropped ? [...draft.strokes, stroke] : draft.strokes;
    drawSignature(ctx, strokes, inkColor(draft.ink));
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function render() {
    for (const b of swatches) {
      const on = b.dataset.ink === draft.ink;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('is-selected', on);
      b.tabIndex = on ? 0 : -1;
    }
    doneBtn.disabled = draft.isEmpty;
    clearBtn.disabled = draft.isEmpty;
    pad.classList.toggle('is-blue', draft.ink === 'blue');
    schedule();
  }

  function setInk(ink) {
    if (ink === draft.ink) return;
    draft = draft.withInk(ink);
    render();
  }

  function clearDrawing() {
    draft = draft.cleared();
    stroke = [];
    dropped = true;
    render();
  }

  function done() {
    const signed = stroke.length && !dropped ? draft.plus(stroke) : draft;
    if (signed.isEmpty) return;
    finish(signed);
  }

  // ---- Drawing: one finger, pen or mouse at a time signs; the others are ignored.

  const add = (e) => {
    const toPad = PAD_WIDTH / box.width;
    const x = Math.max(0, Math.min(PAD_WIDTH, (e.clientX - box.left) * toPad));
    const y = Math.max(0, Math.min(PAD_HEIGHT, (e.clientY - box.top) * toPad));
    const count = stroke.length;
    if (dropped || room <= 0) return;
    if (count >= 2 && Math.hypot(x - stroke[count - 2], y - stroke[count - 1]) < MIN_STEP) return;
    stroke.push(x, y);
    room--;
  };

  const endStroke = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    if (!dropped && stroke.length) {
      draft = draft.plus(stroke);
    }
    stroke = [];
    render();
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (active != null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    active = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
    box = canvas.getBoundingClientRect();
    if (!box.width) { active = null; return; }
    room = MAX_POINTS - draft.pointCount;
    stroke = [];
    dropped = false;
    add(e);
    schedule();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    // The points between frames make the curve smoother.
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of events.length ? events : [e]) add(c);
    schedule();
  });
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('lostpointercapture', endStroke);
  // A long press of a finger mustn't bring up the page's menu over the pad.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // As wide as the screen; when the screen is low (a phone turned sideways), as tall as the room
  // left. In the dialog of a large screen, at most 340 px tall.
  const body = surface.querySelector('.sign-pad-body');
  const row = surface.querySelector('.sign-pad-row');
  const centred = matchMedia('(min-width: 840px) and (min-height: 600px)');
  const fitPad = () => {
    const width = area.clientWidth;
    if (!width) return;
    let room;
    if (centred.matches) {
      room = Math.max(160, Math.min(340, window.innerHeight - 330));
    } else {
      const style = getComputedStyle(body);
      const gap = parseFloat(style.rowGap) || 0;
      const inner = body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      room = Math.max(100, inner - hint.offsetHeight - row.offsetHeight - 2 * gap);
    }
    pad.style.width = `${Math.floor(Math.min(width, room * (PAD_WIDTH / PAD_HEIGHT)))}px`;
  };

  const resize = () => {
    fitPad();
    const r = pad.getBoundingClientRect();
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(r.width * dpr));
    const hgt = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    if (frame) cancelAnimationFrame(frame);
    draw();
  };
  // Sized after the browser's layout pass, so changing the pad's size can't loop back into it.
  let sizing = 0;
  const resizeSoon = () => {
    if (!sizing) sizing = requestAnimationFrame(() => { sizing = 0; if (!closed) resize(); });
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resizeSoon) : null;

  // ---- The dialog: modal, Escape closes it, Tab stays inside, the focus goes back where it was.

  const previous = document.activeElement;
  let resolveClosed;
  const result = new Promise((r) => { resolveClosed = r; });

  function finish(value) {
    if (closed) return;
    closed = true;
    if (openPad === finish) openPad = null;
    observer?.disconnect();
    window.removeEventListener('resize', resizeSoon);
    if (frame) cancelAnimationFrame(frame);
    if (sizing) cancelAnimationFrame(sizing);
    dialog.classList.add('is-closing');
    const gone = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
      if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('ui-modal-open');
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
      resolveClosed(value);
    };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) gone(); else setTimeout(gone, 150);
  }

  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(null);
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const list = [...surface.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !surface.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !surface.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });

  document.body.append(dialog);
  document.documentElement.classList.add('ui-modal-open');
  dialog.showModal();
  openPad = finish;
  render();
  if (observer) {
    observer.observe(pad);
    observer.observe(body);
  }
  window.addEventListener('resize', resizeSoon);
  resize();
  closeBtn.focus({ preventScroll: true });
  return result;
}
