// The crop screen (CropScreen.kt): a page cropped out of its image in two steps. First Crop page:
// the image, turned as on its page, with four corners and four sides to drag onto the page's edges,
// a magnifier under the finger while dragging, and buttons that move the chosen handle a step at a
// time (each handle can also be focused and moved with the arrow keys). Then Filters (filter-step.js).
// On both, Rotate left and Rotate right turn the image, the corners with it; Back on Filters goes
// back to Crop page with the corners kept. A photo just taken ends with Take another or Done; the
// images of a scan come one after another ("Page 2 of 5"), with Next and Done on the last.
import { h, announce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { topBar, button, iconButton, uid } from '../../core/ui.js';
import { loadImage } from '../../engine/images/decode.js';
import {
  shownQuad, uprightQuad, withCorner, movedCorner, movedSide, turned, ordered, isUsable, isWhole, WHOLE,
} from '../../engine/images/crop.js';
import { sourceOf } from './model.js';
import { createFilterStep } from './filter-step.js';

/** A page's four corners, then its four sides: the handles of the crop step. */
const CORNERS = 4;
const HANDLES = 8;
const HANDLE_NAMES = [
  'crop_corner_top_left', 'crop_corner_top_right', 'crop_corner_bottom_right', 'crop_corner_bottom_left',
  'crop_side_top', 'crop_side_right', 'crop_side_bottom', 'crop_side_left',
];
/** A handle's touch target, and the element a keyboard or screen reader finds for it. */
const HANDLE_SIZE = 56;
/** How far from a handle a press still takes it. */
const HANDLE_REACH = 40;
const MAGNIFIER_RADIUS = 56;
const MAGNIFICATION = 2.5;
/** A step of the arrow buttons: this much of the image's long side. */
const STEP = 0.004;
/** The image is shown at most this many pixels on its long side. */
const PREVIEW_MAX = 2048;

const floorMod = (x, m) => ((x % m) + m) % m;
const samePoint = (p, q) => p.x === q.x && p.y === q.y;
const sameQuad = (a, b) => a.every((p, i) => samePoint(p, b[i]));

/** Where handle `i` is: a corner, or the middle of a side. */
function handleAt(quad, i) {
  if (i < CORNERS) return quad[i];
  const from = quad[i - CORNERS];
  const to = quad[(i - CORNERS + 1) % 4];
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/** Whether handle `i` moves left and right (a corner, or a side that runs up and down). */
const movesAcross = (i) => i < CORNERS || (i - CORNERS) % 2 === 1;
/** Whether handle `i` moves up and down. */
const movesUpDown = (i) => i < CORNERS || (i - CORNERS) % 2 === 0;

function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** `image` (upright) drawn turned `rotation` degrees clockwise to fill `frame`. */
function drawTurned(g, image, frame, rotation) {
  const sideways = rotation % 180 !== 0;
  const w = sideways ? frame.height : frame.width;
  const hgt = sideways ? frame.width : frame.height;
  g.save();
  g.translate(frame.left + frame.width / 2, frame.top + frame.height / 2);
  g.rotate((rotation * Math.PI) / 180);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'medium';
  g.drawImage(image, -w / 2, -hgt / 2, w, hgt);
  g.restore();
}

function roundRect(g, x, y, w, hgt, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, hgt, r);
  else {
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + hgt, r);
    g.arcTo(x + w, y + hgt, x, y + hgt, r);
    g.arcTo(x, y + hgt, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
}

/**
 * What the crop screen has chosen so far (CropState): the corners as the screen shows the image
 * turned `rotation` degrees clockwise, the handle the arrow buttons move (`chosen`: a corner 0–3,
 * or a side 4–7), the look, brightness and contrast, the step, and Apply to all pages.
 */
class CropState {
  constructor(session) {
    this.corners = shownQuad(session.start, session.rotation);
    this.rotation = session.rotation;
    this.look = session.look;
    this.adjustments = { ...session.adjustments };
    this.step = 'crop';
    this.chosen = 0;
    this.allPages = false;
  }

  /** Turns the image `degrees` clockwise (a quarter turn), the corners and the chosen handle with it. */
  turn(degrees, width, height) {
    this.corners = turned(this.corners, degrees);
    const quarters = floorMod(degrees, 360) / 90;
    this.chosen = Math.floor(this.chosen / CORNERS) * CORNERS + ((this.chosen % CORNERS) + quarters) % CORNERS;
    this.rotation = floorMod(this.rotation + degrees, 360);
    const sideways = this.rotation % 180 !== 0;
    this.settle(sideways ? height : width, sideways ? width : height);
  }

  /** Moves handle `handle` by (dx, dy), fractions of the image shown, `width` × `height` pixels. */
  move(handle, dx, dy, width, height) {
    this.corners = handle < CORNERS ? movedCorner(this.corners, handle, dx, dy) : movedSide(this.corners, handle - CORNERS, dx, dy, width, height);
  }

  /**
   * Once a drag or a step is over, the corners take a page's order, so each is named for where it
   * is, and the chosen handle stays the same corner or side.
   */
  settle(width, height) {
    const corners = this.corners;
    const next = ordered(corners);
    if (sameQuad(next, corners) || !isUsable(next, width, height)) return;
    if (this.chosen < CORNERS) {
      this.chosen = Math.max(0, next.findIndex((p) => samePoint(p, corners[this.chosen])));
    } else {
      const side = this.chosen - CORNERS;
      const a = corners[side];
      const b = corners[(side + 1) % 4];
      const found = [0, 1, 2, 3].find((i) => {
        const p = next[i];
        const q = next[(i + 1) % 4];
        return (samePoint(p, a) && samePoint(q, b)) || (samePoint(p, b) && samePoint(q, a));
      });
      this.chosen = CORNERS + (found ?? side);
    }
    this.corners = next;
  }
}

/**
 * The image with the page's outline, the area outside it dimmed, and its handles (CropArea).
 * Pressing near a handle drags it, with a magnifier showing what is under it: a corner goes where
 * the pointer takes it, a side moves across itself.
 */
class CropArea {
  constructor({ state, shown, onChange, onChoose, onNudge }) {
    this.state = state;
    this.shown = shown;
    this.onChange = onChange;
    this.photo = null;
    this.dragging = null;
    this.finger = { x: 0, y: 0 };
    this.canvas = h('canvas', { class: 'images-crop-canvas', role: 'img', 'aria-label': t('crop_image_description') });
    this.ctx = this.canvas.getContext('2d');
    this.spinner = h('div', { class: 'images-spinner images-crop-spinner', 'aria-hidden': 'true' });
    const hintId = uid('images-handle');
    this.handles = HANDLE_NAMES.map((name, i) => {
      const b = h('button', { type: 'button', class: 'images-crop-handle', 'aria-label': t(name), 'aria-describedby': hintId });
      b.addEventListener('focus', () => { if (state.chosen !== i) onChoose(i); this.updateHandles(); });
      b.addEventListener('click', () => onChoose(i));
      b.addEventListener('keydown', (e) => {
        const big = e.shiftKey ? 10 : 1;
        let dx = 0;
        let dy = 0;
        if (e.key === 'ArrowLeft') dx = -big;
        else if (e.key === 'ArrowRight') dx = big;
        else if (e.key === 'ArrowUp') dy = -big;
        else if (e.key === 'ArrowDown') dy = big;
        else return;
        e.preventDefault();
        if ((dx && !movesAcross(i)) || (dy && !movesUpDown(i))) return;
        onNudge(i, dx, dy);
      });
      return b;
    });
    this.handleBox = h('div', { class: 'images-crop-handles', role: 'group', 'aria-label': t('crop_image_description') },
      h('span', { id: hintId, class: 'ui-visually-hidden' }, t('web_crop_handle_hint')), ...this.handles);
    this.el = h('div', { class: 'images-step-area images-crop-area' }, this.canvas, this.spinner, this.handleBox);
    this.size = { width: 0, height: 0 };
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.el);
    // The outline and handles take the theme's colours: drawn again when it changes.
    const redraw = () => this.draw();
    this.dark = window.matchMedia?.('(prefers-color-scheme: dark)');
    this.dark?.addEventListener?.('change', redraw);
    this.theme = new MutationObserver(redraw);
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.unwatch = () => {
      this.dark?.removeEventListener?.('change', redraw);
      this.theme.disconnect();
    };
    this.bindPointer();
  }

  setPhoto(photo) {
    this.photo = photo;
    this.spinner.hidden = true;
    this.draw();
  }

  layout() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.size = { width: r.width, height: r.height };
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.draw();
  }

  /** The image, as large as fits with room around it for the handles. */
  frame() {
    const [w, hgt] = this.shown();
    const aspect = w / hgt;
    const room = HANDLE_SIZE / 2;
    const fitW = Math.max(1, this.size.width - 2 * room);
    const fitH = Math.max(1, this.size.height - 2 * room);
    const width = Math.min(fitW, fitH * aspect);
    const height = width / aspect;
    return { left: (this.size.width - width) / 2, top: (this.size.height - height) / 2, width, height };
  }

  at(p, frame = this.frame()) {
    return { x: frame.left + p.x * frame.width, y: frame.top + p.y * frame.height };
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The handle a press at `p` takes: the nearest within reach (a corner before a side as near), or -1. */
  handleNear(p) {
    const quad = this.state.corners;
    let index = -1;
    let best = Infinity;
    for (let i = 0; i < HANDLES; i++) {
      const q = this.at(handleAt(quad, i));
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) { best = d; index = i; }
    }
    return best > HANDLE_REACH ? -1 : index;
  }

  bindPointer() {
    const c = this.canvas;
    // A mouse over a handle it would take shows that it can be dragged (a web extra, as other tools'
    // cursors); touch has no pointer to show.
    const hover = (e) => {
      if (this.dragging || e.pointerType !== 'mouse') return;
      c.style.cursor = this.handleNear(this.local(e)) >= 0 ? 'grab' : '';
    };
    c.addEventListener('pointerleave', () => { if (!this.dragging) c.style.cursor = ''; });
    c.addEventListener('pointerdown', (e) => {
      if (this.dragging || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const p = this.local(e);
      const quad = this.state.corners;
      const index = this.handleNear(p);
      if (index < 0) return;
      e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      if (e.pointerType === 'mouse') c.style.cursor = 'grabbing';
      this.state.chosen = index;
      const q = this.at(handleAt(quad, index));
      // Where the handle is from the pointer.
      this.dragging = { index, id: e.pointerId, grip: { x: q.x - p.x, y: q.y - p.y }, last: p };
      this.finger = p;
      this.onChange();
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.dragging;
      if (!d) { hover(e); return; }
      if (e.pointerId !== d.id) return;
      e.preventDefault();
      const p = this.local(e);
      const frame = this.frame();
      this.finger = p;
      if (d.index < CORNERS) {
        const q = { x: p.x + d.grip.x, y: p.y + d.grip.y };
        this.state.corners = withCorner(this.state.corners, d.index, (q.x - frame.left) / frame.width, (q.y - frame.top) / frame.height);
      } else {
        // A side moves as far as the pointer did since the last move.
        const [w, hgt] = this.shown();
        this.state.corners = movedSide(this.state.corners, d.index - CORNERS, (p.x - d.last.x) / frame.width, (p.y - d.last.y) / frame.height, w, hgt);
      }
      d.last = p;
      this.onChange();
    });
    const end = (e) => {
      const d = this.dragging;
      if (!d || e.pointerId !== d.id) return;
      this.dragging = null;
      const [w, hgt] = this.shown();
      this.state.settle(w, hgt);
      this.onChange();
      c.style.cursor = '';
      if (e.type === 'pointerup') hover(e);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);
  }

  updateHandles() {
    const frame = this.frame();
    const quad = this.state.corners;
    this.handles.forEach((b, i) => {
      const p = this.at(handleAt(quad, i), frame);
      b.style.left = `${p.x - HANDLE_SIZE / 2}px`;
      b.style.top = `${p.y - HANDLE_SIZE / 2}px`;
      b.setAttribute('aria-pressed', String(i === this.state.chosen));
    });
  }

  draw() {
    const g = this.ctx;
    const { width, height } = this.size;
    if (!width || !height) return;
    const dpr = this.dpr ?? 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const frame = this.frame();
    const primary = cssColor('--primary', '#b3261e');
    const { corners, rotation, chosen } = this.state;
    if (this.photo) drawTurned(g, this.photo, frame, rotation);
    else {
      g.fillStyle = cssColor('--surface-variant', '#f5ddda');
      g.fillRect(frame.left, frame.top, frame.width, frame.height);
    }
    const points = corners.map((p) => this.at(p, frame));
    const pagePath = () => {
      g.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < 4; i++) g.lineTo(points[i].x, points[i].y);
      g.closePath();
    };
    // What will be left out is dimmed.
    g.beginPath();
    g.rect(frame.left, frame.top, frame.width, frame.height);
    pagePath();
    g.fillStyle = 'rgba(0, 0, 0, 0.45)';
    g.fill('evenodd');
    g.beginPath();
    pagePath();
    g.lineWidth = 2;
    g.strokeStyle = primary;
    g.stroke();
    for (let side = 0; side < 4; side++) {
      const from = points[side];
      const to = points[(side + 1) % 4];
      this.drawSideHandle(g, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, Math.atan2(to.y - from.y, to.x - from.x), chosen === CORNERS + side, primary);
    }
    points.forEach((p, i) => this.drawHandle(g, p, i === chosen, primary));
    if (this.dragging && this.photo) this.drawMagnifier(g, frame, points, this.at(handleAt(corners, this.dragging.index), frame), primary);
    this.updateHandles();
  }

  /** A corner's handle: a ring, filled when it is the one the arrow buttons move. */
  drawHandle(g, c, chosen, color) {
    const r = chosen ? 13 : 11;
    g.beginPath();
    g.arc(c.x, c.y, r + 2, 0, 2 * Math.PI);
    g.fillStyle = 'rgba(0, 0, 0, 0.3)';
    g.fill();
    g.beginPath();
    g.arc(c.x, c.y, r, 0, 2 * Math.PI);
    g.fillStyle = chosen ? color : '#fff';
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = chosen ? '#fff' : color;
    g.stroke();
  }

  /** A side's handle: a short rounded bar along the side at its middle, filled when it is the one chosen. */
  drawSideHandle(g, c, angle, chosen, color) {
    const length = 28;
    const thickness = chosen ? 10 : 8;
    const shadow = 2;
    g.save();
    g.translate(c.x, c.y);
    g.rotate(angle);
    roundRect(g, -length / 2 - shadow, -thickness / 2 - shadow, length + 2 * shadow, thickness + 2 * shadow, thickness / 2 + shadow);
    g.fillStyle = 'rgba(0, 0, 0, 0.3)';
    g.fill();
    roundRect(g, -length / 2, -thickness / 2, length, thickness, thickness / 2);
    g.fillStyle = chosen ? color : '#fff';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = chosen ? '#fff' : color;
    g.stroke();
    g.restore();
  }

  /** A round magnifier in the top corner further from the pointer, showing the image around the handle. */
  drawMagnifier(g, frame, points, handle, color) {
    const radius = MAGNIFIER_RADIUS;
    const margin = 8;
    const left = { x: margin + radius, y: margin + radius };
    const right = { x: this.size.width - margin - radius, y: margin + radius };
    const f = this.finger;
    const center = Math.hypot(f.x - left.x, f.y - left.y) > Math.hypot(f.x - right.x, f.y - right.y) ? left : right;
    g.save();
    g.beginPath();
    g.arc(center.x, center.y, radius, 0, 2 * Math.PI);
    g.clip();
    g.fillStyle = '#000';
    g.fillRect(center.x - radius, center.y - radius, 2 * radius, 2 * radius);
    g.save();
    g.translate(center.x - handle.x * MAGNIFICATION, center.y - handle.y * MAGNIFICATION);
    g.scale(MAGNIFICATION, MAGNIFICATION);
    drawTurned(g, this.photo, frame, this.state.rotation);
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(points[i].x, points[i].y);
    g.closePath();
    g.lineWidth = 1.5 / MAGNIFICATION;
    g.strokeStyle = color;
    g.stroke();
    g.restore();
    const hair = 10;
    g.lineWidth = 1.5;
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(center.x - hair, center.y);
    g.lineTo(center.x + hair, center.y);
    g.moveTo(center.x, center.y - hair);
    g.lineTo(center.x, center.y + hair);
    g.stroke();
    g.restore();
    g.beginPath();
    g.arc(center.x, center.y, radius, 0, 2 * Math.PI);
    g.lineWidth = 3;
    g.strokeStyle = '#fff';
    g.stroke();
    g.beginPath();
    g.arc(center.x, center.y, radius + 1.5, 0, 2 * Math.PI);
    g.lineWidth = 1;
    g.strokeStyle = color;
    g.stroke();
  }

  destroy() {
    this.resize.disconnect();
    this.unwatch();
  }
}

/** A step's buttons at its foot: `main`, filled, and before it `other`, side by side while they fit. */
function stepButtons(main, other) {
  const make = (b, variant) => {
    const el = button({ label: '', variant, disabled: b.disabled, onClick: b.onClick, cls: 'images-step-button' + (b.iconAfter ? ' has-icon-after' : '') });
    el.querySelector('.ui-btn-label').textContent = b.label;
    const i = icon(b.icon, { size: 18 });
    if (b.iconAfter) el.append(i); else el.prepend(i);
    return el;
  };
  const row = h('div', { class: 'images-step-button-row' + (other ? ' has-two' : '') });
  if (other) row.append(make(other, 'outlined'));
  const mainEl = make(main, 'filled');
  row.append(mainEl);
  row.main = mainEl;
  return row;
}

/** Makes the step's layout follow its shape: the controls beside the image when it is wider than tall. */
function stepLayout(el, hint) {
  const area = el.querySelector('.images-step-area');
  const controls = el.querySelector('.images-step-controls');
  const apply = () => {
    const r = el.getBoundingClientRect();
    const wide = r.width > r.height;
    el.classList.toggle('is-wide', wide);
    if (hint) {
      if (wide && hint.parentElement !== controls) controls.prepend(hint);
      else if (!wide && hint.nextElementSibling !== area) el.insertBefore(hint, area);
    }
  };
  const observer = new ResizeObserver(apply);
  observer.observe(el);
  apply();
  return () => observer.disconnect();
}

/**
 * The crop screen for one opening of it.
 * @param {object} o
 * @param {import('./model.js').ImagesModel} o.model
 * @param {object} o.session   the model's crop session
 * @param {() => object|null} o.scan   the scan, while this page is one of its images
 * @param {() => number} o.pageCount   the pages Apply to all pages would reach
 * @param {(step: 'crop'|'filters') => void} o.onStep
 * @param {{ done(choices), takeAnother(choices), close() }} o.actions
 * @returns {{ el, step, setStep(step), back(), update(), focus(), destroy() }}
 */
export function createCropScreen({ model, session, scan, pageCount, onStep, actions }) {
  const state = new CropState(session);
  const item = model.item(session.itemId);
  const source = sourceOf(item);
  const width = source.image.width;
  const height = source.image.height;
  const shown = () => (state.rotation % 180 !== 0 ? [height, width] : [width, height]);
  const previewSide = Math.min(PREVIEW_MAX, Math.round(Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1)));
  // The image upright, read once: the steps show it turned as the page is.
  const photo = loadImage(source.image, { maxSide: previewSide }).catch(() => null);
  const el = h('div', { class: 'images-crop' });
  let bar = null;
  let body = null;
  let cleanup = [];
  let area = null;
  let filters = null;
  let controlsUpdate = () => {};
  let destroyed = false;

  const choices = () => ({
    corners: state.corners,
    rotation: state.rotation,
    look: state.look,
    adjustments: { ...state.adjustments },
    allPages: state.allPages && pageCount() > 1,
  });

  const turn = (degrees) => {
    state.turn(degrees, width, height);
    if (state.step === 'crop') { area.draw(); controlsUpdate(); } else filters.update();
  };

  const title = () => t(state.step === 'filters' ? 'filter_title' : 'crop_title');
  const place = () => {
    const s = scan();
    return s ? t('scan_place', s.done + 1, s.done + s.waiting.length + s.coming) : null;
  };

  function makeBar() {
    const filtersStep = state.step === 'filters';
    const closes = !filtersStep && (session.fromCamera || session.queued);
    const b = topBar({
      title: title(),
      subtitle: place(),
      onBack: () => (filtersStep ? setStep('crop') : actions.close()),
      backLabel: filtersStep ? t('back') : closes ? t(session.fromCamera ? 'crop_discard' : 'crop_stop') : t('back'),
      actions: [
        { icon: 'rotate_left', label: t('crop_rotate_left'), onClick: () => turn(-90) },
        { icon: 'rotate_right', label: t('crop_rotate_right'), onClick: () => turn(90) },
      ],
    });
    if (closes) b.back.replaceChildren(icon('close', { size: 24 }));
    // A turn to the left is to the left whichever way the text runs.
    for (const a of b.actions) a.querySelector('.icon')?.classList.remove('icon-mirrored');
    return b;
  }

  function cornersStep() {
    const step = STEP * Math.max(width, height);
    const nudge = (handle, dx, dy) => {
      const [w, hgt] = shown();
      state.chosen = handle;
      state.move(handle, (dx * step) / w, (dy * step) / hgt, w, hgt);
      state.settle(w, hgt);
      changed();
    };
    area = new CropArea({
      state,
      shown,
      onChange: () => changed(),
      onChoose: (i) => { state.chosen = i; changed(); },
      onNudge: nudge,
    });
    photo.then((p) => { if (!destroyed && area) area.setPhoto(p); });
    // As tall as the longer of its two texts: the image stays put when they change places.
    const found = t(session.foundPage ? 'crop_found' : 'crop_not_found');
    const notPage = t('crop_not_a_page');
    const shownHint = h('p', { class: 'images-crop-hint-text', 'aria-live': 'polite' });
    const spare = h('p', { class: 'images-crop-hint-text images-crop-hint-spare', 'aria-hidden': 'true' });
    const hint = h('div', { class: 'images-crop-hint' }, spare, shownHint);
    const handleName = h('span', { class: 'images-crop-handle-name' });
    const west = iconButton({ icon: 'west', label: t('edit_move_left'), onClick: () => nudge(state.chosen, -1, 0) });
    const north = iconButton({ icon: 'north', label: t('edit_move_up'), onClick: () => nudge(state.chosen, 0, -1) });
    const south = iconButton({ icon: 'south', label: t('edit_move_down'), onClick: () => nudge(state.chosen, 0, 1) });
    const east = iconButton({ icon: 'east', label: t('edit_move_right'), onClick: () => nudge(state.chosen, 1, 0) });
    const reset = button({ label: t('crop_reset'), icon: 'restart_alt', variant: 'text', onClick: () => { state.corners = shownQuad(session.found, state.rotation); changed(); } });
    const whole = button({ label: t('crop_whole'), icon: 'crop_free', variant: 'text', onClick: () => { state.corners = WHOLE.map((p) => ({ ...p })); changed(); } });
    const controls = h('div', { class: 'images-step-controls' },
      h('div', { class: 'images-crop-moves' }, handleName, west, north, south, east),
      h('div', { class: 'images-crop-resets' }, reset, whole));
    const buttons = stepButtons({
      label: t('crop_next'), icon: 'arrow_forward', iconAfter: true,
      onClick: () => {
        if (!usable()) return;
        const [w, hgt] = shown();
        state.settle(w, hgt);
        setStep('filters');
      },
    });
    const panel = h('div', { class: 'images-step-panel' }, controls, h('div', { class: 'images-step-buttons' }, buttons));
    const stepEl = h('div', { class: 'images-step images-crop-step' }, hint, area.el, panel);
    const usable = () => {
      const [w, hgt] = shown();
      return isWhole(state.corners) || isUsable(ordered(state.corners), w, hgt);
    };
    controlsUpdate = () => {
      const ok = usable();
      shownHint.textContent = ok ? found : notPage;
      spare.textContent = ok ? notPage : found;
      hint.classList.toggle('is-error', !ok);
      buttons.main.disabled = !ok;
      handleName.textContent = t(HANDLE_NAMES[state.chosen]);
      west.disabled = east.disabled = !movesAcross(state.chosen);
      north.disabled = south.disabled = !movesUpDown(state.chosen);
    };
    controlsUpdate();
    cleanup.push(stepLayout(stepEl, hint), () => area?.destroy());
    return stepEl;
  }

  function filtersStep() {
    const s = () => (session.queued ? scan() : null);
    let buttons;
    if (session.fromCamera) {
      buttons = stepButtons(
        { label: t('crop_done'), icon: 'check', onClick: () => actions.done(choices()) },
        { label: t('crop_take_another'), icon: 'photo_camera', onClick: () => actions.takeAnother(choices()) },
      );
    } else {
      const last = () => { const q = s(); return !q || (q.waiting.length <= 1 && q.coming === 0); };
      buttons = last()
        ? stepButtons({ label: t('crop_done'), icon: 'check', onClick: () => actions.done(choices()) })
        : stepButtons({ label: t('crop_next'), icon: 'arrow_forward', iconAfter: true, onClick: () => actions.done(choices()) });
      buttons.isLast = last();
      buttons.last = last;
    }
    filters = createFilterStep({ photo, corners: () => uprightQuad(state.corners, state.rotation), state, pageCount, buttons });
    filters.buttons = buttons;
    cleanup.push(stepLayout(filters.el, null), () => filters?.destroy());
    return filters.el;
  }

  function changed() {
    if (state.step === 'crop' && area) {
      area.draw();
      controlsUpdate();
    }
  }

  function render(direction) {
    for (const fn of cleanup) fn();
    cleanup = [];
    area = null;
    filters = null;
    controlsUpdate = () => {};
    const nextBar = makeBar();
    const nextBody = state.step === 'filters' ? filtersStep() : cornersStep();
    if (direction) nextBody.classList.add(direction > 0 ? 'images-in-forward' : 'images-in-back');
    if (bar) bar.replaceWith(nextBar); else el.append(nextBar);
    if (body) body.replaceWith(nextBody); else el.append(nextBody);
    bar = nextBar;
    body = nextBody;
  }

  function focusTitle() {
    const heading = bar.querySelector('h1');
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    // Each step is a pane, named as it comes in; with a scan, which of its images this is.
    const p = place();
    announce(p ? t('scan_pane_title', title(), p) : title());
  }

  function setStep(next, { fromHistory = false } = {}) {
    if (next === state.step) return;
    const forward = next === 'filters';
    state.step = next;
    render(forward ? 1 : -1);
    focusTitle();
    if (!fromHistory) onStep(next);
  }

  render(0);

  return {
    el,
    get step() { return state.step; },
    setStep: (step) => setStep(step, { fromHistory: true }),
    /** What Back does: Filters goes back to Crop page, Crop page closes the screen. */
    back() {
      if (state.step === 'filters') setStep('crop');
      else actions.close();
    },
    /** The scan's count or the page count changed. */
    update() {
      bar.setSubtitle(place());
      if (filters) {
        const b = filters.buttons;
        if (b.last && b.last() !== b.isLast) render(0);
        else filters.update();
      }
    },
    focus: focusTitle,
    destroy() {
      destroyed = true;
      for (const fn of cleanup) fn();
      cleanup = [];
      photo.then((p) => p?.close?.());
    },
  };
}

/**
 * The crop screen while a scan waits for its next image: one still being added, or its page being
 * looked for (ScanWaiting). Closing it stops the scan.
 */
export function createScanWaiting({ scan, onClose }) {
  const place = () => {
    const s = scan();
    return s ? t('scan_place', s.done + 1, s.done + s.waiting.length + s.coming) : null;
  };
  const bar = topBar({ title: t('crop_title'), subtitle: place(), onBack: onClose, backLabel: t('crop_stop') });
  bar.back.replaceChildren(icon('close', { size: 24 }));
  const text = h('p', { class: 'images-waiting-text', 'aria-live': 'polite' });
  const el = h('div', { class: 'images-crop images-waiting' }, bar,
    h('div', { class: 'images-waiting-body' }, h('div', { class: 'images-spinner', 'aria-hidden': 'true' }), text));
  const update = () => {
    const s = scan();
    bar.setSubtitle(place());
    text.textContent = s && s.waiting.length === 0 ? t('adding_images') : '';
  };
  update();
  return {
    el,
    update,
    focus() {
      const heading = bar.querySelector('h1');
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    },
    destroy() {},
  };
}
