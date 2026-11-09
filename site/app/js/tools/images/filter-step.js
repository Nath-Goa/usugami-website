// The crop screen's second step (FilterScreen.kt): the page straightened out of the photo inside its
// corners, large and turned as it will be in the PDF, with its look and brightness and contrast;
// under it the looks, each shown on the page itself, the Brightness and Contrast sliders, Apply to all
// pages, and the step's buttons. The large page is made again in the background as the choices
// change, once a slider rests; the looks' small pages are made once for the corners.
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { iconButton, uid } from '../../core/ui.js';
import { CancelledError } from '../../core/errors.js';
import { straighten, isCloseTo } from '../../engine/images/crop.js';
import { applyLookAsync, LOOKS, LOOK_LABELS, MAX_ADJUSTMENT } from '../../engine/images/looks.js';

/** The large page is made at most this many pixels on its long side. */
const PAGE_MAX = 1200;
/** The looks' small pages are this many pixels on their long side. */
const SAMPLE_MAX = 200;
/** The looks are made on the page this large, then made small, so each looks as it does on the page. */
const SAMPLE_LOOK_MAX = 512;
/** How long the choices stay put before the page is made again with them. */
const LOOK_DELAY_MS = 150;
/** A slider this close to 0 holds at 0. */
const SNAP = 2;

const signed = (v) => (v > 0 ? `+${v}` : `${v}`);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new CancelledError()); }, { once: true });
  });
}

/** The page inside `quad` straightened out of `photo`, at most `maxSide` long, or smaller when memory is short. */
async function straightened(photo, quad, maxSide) {
  for (let side = maxSide; side >= 64; side = Math.floor(side / 2)) {
    try {
      return await straighten(photo, quad, side);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
    }
  }
  return null;
}

/** `picture` made SAMPLE_MAX pixels on its long side, as a new canvas; `picture` itself when it is no larger. */
function small(picture) {
  const long = Math.max(picture.width, picture.height);
  if (long <= SAMPLE_MAX) return picture;
  const scale = SAMPLE_MAX / long;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(picture.width * scale));
  c.height = Math.max(1, Math.round(picture.height * scale));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(picture, 0, 0, c.width, c.height);
  return c;
}

/** Draws `picture` (upright) onto `canvas` turned `rotation` degrees clockwise, the canvas taking its turned size. */
export function drawTurnedInto(canvas, picture, rotation) {
  const sideways = rotation % 180 !== 0;
  canvas.width = sideways ? picture.height : picture.width;
  canvas.height = sideways ? picture.width : picture.height;
  const g = canvas.getContext('2d');
  g.save();
  g.translate(canvas.width / 2, canvas.height / 2);
  g.rotate((rotation * Math.PI) / 180);
  g.drawImage(picture, -picture.width / 2, -picture.height / 2);
  g.restore();
}

/**
 * A slider from -100 to 100 with 0 in its middle, filled from the middle to the thumb, its name and
 * value over it ("+12"), and a button beside it that puts it back to 0 (AdjustmentSlider). Close to
 * 0 it holds at 0, so the middle is easy to find.
 */
function adjustmentSlider({ label, resetLabel, value, onChange }) {
  const id = uid('images-adjust');
  const shown = h('span', { class: 'images-adjust-value', 'aria-hidden': 'true' });
  const input = h('input', { type: 'range', class: 'images-adjust-input', id, min: String(-MAX_ADJUSTMENT), max: String(MAX_ADJUSTMENT), step: '1' });
  const reset = iconButton({ icon: 'restart_alt', label: resetLabel, onClick: () => set(0, true) });
  const el = h('div', { class: 'images-adjust' },
    h('div', { class: 'images-adjust-head' }, h('label', { class: 'images-adjust-label', for: id }, label), shown),
    h('div', { class: 'images-adjust-row' }, input, reset));
  let current = value;
  const render = () => {
    input.value = String(current);
    shown.textContent = signed(current);
    input.setAttribute('aria-valuetext', signed(current));
    input.style.setProperty('--at', `${((current + MAX_ADJUSTMENT) / (2 * MAX_ADJUSTMENT)) * 100}%`);
    reset.disabled = current === 0;
  };
  const set = (v, notify, snap = false) => {
    const next = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Math.round(v)));
    const snapped = snap && Math.abs(next) <= SNAP ? 0 : next;
    const changed = snapped !== current;
    current = snapped;
    render();
    if (changed && notify) onChange(current);
  };
  // Dragged, it holds at 0 near the middle; the arrow keys move it a step at a time from there.
  let byKey = false;
  input.addEventListener('keydown', () => { byKey = true; });
  input.addEventListener('pointerdown', () => { byKey = false; });
  input.addEventListener('input', () => set(Number(input.value), true, !byKey));
  render();
  el.setValue = (v) => { current = v; render(); };
  el.input = input;
  return el;
}

/**
 * @param {object} o
 * @param {Promise<ImageBitmap|null>} o.photo    the image upright, as the crop screen shows it
 * @param {() => {x: number, y: number}[]} o.corners  the page's corners on it, upright, in a page's order
 * @param {{ rotation: number, look: string, adjustments: { brightness: number, contrast: number }, allPages: boolean }} o.state
 * @param {() => number} o.pageCount  the pages Apply to all pages would reach
 * @param {Node} o.buttons
 * @returns {{ el: HTMLElement, area: HTMLElement, panel: HTMLElement, update(), destroy() }}
 */
export function createFilterStep({ photo: photoPromise, corners: getCorners, state, pageCount, buttons }) {
  let destroyed = false;
  let photo = null;
  // The page without its look, straightened once for the corners.
  let base = null;
  let baseCorners = null;
  let baseRun = 0;
  // The page with its look and adjustments.
  let preview = null;
  let previewRun = null;
  // Each look on a small copy of the page.
  let samplesCorners = null;
  let samplesRun = null;
  const samples = new Map();

  // ---- The large page ----
  const canvas = h('canvas', { class: 'images-filter-canvas', role: 'img', 'aria-label': t('filter_preview_description') });
  canvas.width = 0;
  canvas.height = 0;
  const bigSpinner = h('div', { class: 'images-spinner images-filter-spinner', role: 'progressbar', 'aria-label': t('filter_preview_description') });
  const smallSpinner = h('div', { class: 'images-spinner images-spinner--small images-filter-busy', 'aria-hidden': 'true' });
  const area = h('div', { class: 'images-step-area images-filter-area' }, canvas, bigSpinner, smallSpinner);

  // ---- The looks ----
  const titleId = uid('images-look');
  const lookButtons = LOOKS.map((look) => {
    const sample = h('canvas', { class: 'images-look-canvas', 'aria-hidden': 'true' });
    const check = h('span', { class: 'images-look-check', 'aria-hidden': 'true' }, icon('check', { size: 14 }));
    const b = h('button', { type: 'button', role: 'radio', class: 'images-look', dataset: { look } },
      h('span', { class: 'images-look-sample' }, sample, check),
      h('span', { class: 'images-look-label' }, t(LOOK_LABELS[look])));
    b.sample = sample;
    b.addEventListener('click', () => chooseLook(look));
    return b;
  });
  const looks = h('div', { class: 'images-looks', role: 'radiogroup', 'aria-labelledby': titleId }, ...lookButtons);
  looks.addEventListener('keydown', (e) => {
    const at = lookButtons.indexOf(document.activeElement);
    if (at < 0) return;
    const rtl = getComputedStyle(looks).direction === 'rtl';
    let next = null;
    if (e.key === 'ArrowRight') next = at + (rtl ? -1 : 1);
    else if (e.key === 'ArrowLeft') next = at + (rtl ? 1 : -1);
    else if (e.key === 'ArrowDown') next = at + 1;
    else if (e.key === 'ArrowUp') next = at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = lookButtons.length - 1;
    else return;
    e.preventDefault();
    next = (next + lookButtons.length) % lookButtons.length;
    lookButtons[next].focus();
    chooseLook(LOOKS[next]);
  });

  const brightness = adjustmentSlider({
    label: t('filter_brightness'), resetLabel: t('filter_reset_brightness'), value: state.adjustments.brightness,
    onChange: (v) => { state.adjustments = { ...state.adjustments, brightness: v }; refresh(); },
  });
  const contrast = adjustmentSlider({
    label: t('filter_contrast'), resetLabel: t('filter_reset_contrast'), value: state.adjustments.contrast,
    onChange: (v) => { state.adjustments = { ...state.adjustments, contrast: v }; refresh(); },
  });

  const allBox = h('input', { type: 'checkbox', class: 'images-all-pages-box' });
  allBox.checked = !!state.allPages;
  allBox.addEventListener('change', () => { state.allPages = allBox.checked; });
  const allRow = h('label', { class: 'images-all-pages' }, allBox, h('span', null, t('look_all_pages')));

  const controls = h('div', { class: 'images-step-controls' },
    h('h2', { class: 'images-look-title', id: titleId }, t('look_title')),
    looks, brightness, contrast, allRow);
  const panel = h('div', { class: 'images-step-panel' }, controls, h('div', { class: 'images-step-buttons' }, buttons));
  const el = h('div', { class: 'images-step images-filter-step' }, area, panel);

  function chooseLook(look) {
    if (state.look === look) return;
    state.look = look;
    renderLooks();
    refresh();
  }

  function renderLooks() {
    for (const b of lookButtons) {
      const on = b.dataset.look === state.look;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('is-selected', on);
      b.tabIndex = on ? 0 : -1;
    }
  }

  function drawSamples() {
    for (const b of lookButtons) {
      const s = samples.get(b.dataset.look);
      if (s) drawTurnedInto(b.sample, s, state.rotation);
    }
  }

  function drawPreview() {
    const image = preview && preview.base === base ? preview.image : base;
    if (image) drawTurnedInto(canvas, image, state.rotation);
    const busy = !base || !preview || preview.base !== base || preview.look !== state.look ||
      preview.brightness !== state.adjustments.brightness || preview.contrast !== state.adjustments.contrast;
    bigSpinner.hidden = !!image || (baseCorners != null && !baseRun && !base);
    smallSpinner.hidden = !image || !busy;
    area.setAttribute('aria-busy', String(busy));
  }

  async function makeBase(corners) {
    const run = ++baseRun;
    baseCorners = corners;
    base = null;
    drawPreview();
    const made = await straightened(photo, corners, PAGE_MAX).catch(() => null);
    if (destroyed || run !== baseRun) return;
    base = made;
    baseRun = 0;
    makePreview();
  }

  async function makePreview() {
    if (!base) { drawPreview(); return; }
    const want = { base, look: state.look, brightness: state.adjustments.brightness, contrast: state.adjustments.contrast };
    if (preview && preview.base === want.base && preview.look === want.look && preview.brightness === want.brightness && preview.contrast === want.contrast) {
      // Back to what shows: a look still being made for a choice since undone is not wanted.
      previewRun?.abort();
      previewRun = null;
      drawPreview();
      return;
    }
    previewRun?.abort();
    if (want.look === 'original' && !want.brightness && !want.contrast) {
      previewRun = null;
      preview = { ...want, image: base };
      drawPreview();
      return;
    }
    const controller = new AbortController();
    previewRun = controller;
    drawPreview();
    try {
      // Made again once the choices have stayed put for a moment.
      if (preview?.base === base) await delay(LOOK_DELAY_MS, controller.signal);
      let image;
      try {
        image = await applyLookAsync(base, want.look, { brightness: want.brightness, contrast: want.contrast }, { output: 'dom', signal: controller.signal });
      } catch (e) {
        if (e instanceof CancelledError || controller.signal.aborted) throw e;
        // Without memory for it, the page shows as it is.
        image = base;
      }
      if (destroyed || previewRun !== controller) return;
      preview = { ...want, image };
      previewRun = null;
      drawPreview();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }
  }

  async function makeSamples(corners) {
    samplesRun?.abort();
    const controller = new AbortController();
    samplesRun = controller;
    samplesCorners = corners;
    samples.clear();
    for (const b of lookButtons) { b.sample.width = 0; b.sample.height = 0; }
    const plain = await straightened(photo, corners, SAMPLE_LOOK_MAX).catch(() => null);
    if (!plain || destroyed || controller.signal.aborted) return;
    for (const look of LOOKS) {
      if (destroyed || controller.signal.aborted) return;
      try {
        const made = look === 'original' ? plain : await applyLookAsync(plain, look, {}, { output: 'dom', signal: controller.signal });
        if (controller.signal.aborted) return;
        samples.set(look, small(made));
      } catch (e) {
        if (e instanceof CancelledError || controller.signal.aborted) return;
        continue;
      }
      const b = lookButtons[LOOKS.indexOf(look)];
      drawTurnedInto(b.sample, samples.get(look), state.rotation);
    }
  }

  function refresh() {
    if (destroyed) return;
    allRow.hidden = pageCount() < 2;
    if (!photo) { drawPreview(); return; }
    const corners = getCorners();
    // Turned and back, the corners may be a hair from where they were: that is the same page.
    if (!baseCorners || !isCloseTo(baseCorners, corners)) makeBase(corners);
    else makePreview();
    if (!samplesCorners || !isCloseTo(samplesCorners, corners)) makeSamples(corners);
  }

  photoPromise.then((p) => {
    if (destroyed) return;
    photo = p;
    if (!p) { bigSpinner.hidden = true; return; }
    refresh();
  });
  renderLooks();
  refresh();
  // The look chosen shows in its row.
  requestAnimationFrame(() => lookButtons[LOOKS.indexOf(state.look)]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));

  return {
    el,
    area,
    panel,
    /** The page turned, or the pages Apply to all pages reaches changed. */
    update() {
      allRow.hidden = pageCount() < 2;
      drawPreview();
      drawSamples();
      refresh();
    },
    destroy() {
      destroyed = true;
      previewRun?.abort();
      samplesRun?.abort();
    },
  };
}
