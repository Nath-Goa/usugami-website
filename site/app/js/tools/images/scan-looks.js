// A scan's last screen, Filters (ScanLooksScreen.kt): the page chosen, large, in its look; under it
// the scan's pages in a row (with more than one), the one shown marked; then the looks, each shown
// on that page, Brightness and Contrast, and Same filter for all pages (with more than one page);
// Save at the foot. The first page shows at first; a page tapped in the row shows instead. A look or
// a slider changes the page shown, or every page with the switch on (the model's styleScan). The
// row, the controls and Save take at most 60 % of the height, Save always in sight; on a wide screen
// they are in a 320 px column beside the page, with the row under the page. A page still being
// cropped shows a ring until it is made.
import { h, announce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { topBar, switchRow } from '../../core/ui.js';
import { CancelledError } from '../../core/errors.js';
import { loadImage } from '../../engine/images/decode.js';
import { applyLookAsync, LOOKS } from '../../engine/images/looks.js';
import { shownPage } from './model.js';
import { pagePicture } from './preview.js';
import { stepButtons, isWideStep } from './crop-screen.js';
import {
  adjustmentSlider, fitSliders, looksRow, revealIn, drawTurnedInto, small, delay, PAGE_MAX, LOOK_DELAY_MS,
} from './filter-step.js';
import { wheelAlong } from './wheel.js';

/** A copy of picture on a canvas of its own. */
function copyOf(picture) {
  const c = document.createElement('canvas');
  c.width = picture.width;
  c.height = picture.height;
  c.getContext('2d').drawImage(picture, 0, 0);
  return c;
}

/** The looks of this many pages are kept, the last shown, so that going back to a page shows its looks at once. */
const SAMPLES_KEPT = 12;

/**
 * @param {object} o
 * @param {import('./model.js').ImagesModel} o.model
 * @param {{ back(), save() }} o.actions  back: the scan's last image on the crop screen again;
 *   save: the scan's pages into the editor
 * @returns {{ el, update(), back(), focus(), destroy() }}
 */
export function createScanLooks({ model, actions }) {
  let destroyed = false;
  /** The page shown large, and what it shows: its id and image. */
  let shownId = null;
  let shownImage = null;
  /** A slider held, or let go but not yet the page's: { id, brightness, contrast }. */
  let held = null;

  // ---- The bar ----
  const bar = topBar({ title: t('filter_title'), onBack: () => actions.back(), backLabel: t('back') });

  // ---- The large page ----
  const canvas = h('canvas', { class: 'images-filter-canvas', role: 'img', 'aria-label': t('filter_preview_description') });
  canvas.width = 0;
  canvas.height = 0;
  const bigSpinner = h('div', { class: 'images-spinner images-filter-spinner', 'aria-hidden': 'true' });
  const smallSpinner = h('div', { class: 'images-spinner images-spinner--small images-filter-busy', 'aria-hidden': 'true' });
  // While the page is still being cropped: a ring, and a line that says so.
  const croppingText = h('p', { class: 'images-scan-cropping-text', 'aria-live': 'polite' });
  const cropping = h('div', { class: 'images-scan-cropping' }, h('div', { class: 'images-spinner', 'aria-hidden': 'true' }), croppingText);
  const area = h('div', { class: 'images-step-area images-filter-area' }, canvas, bigSpinner, smallSpinner, cropping);

  // ---- The pages row ----
  // A radio group, which needs a name: the app's row has none to give it, so the web's own.
  const strip = h('div', { class: 'images-scan-pages', role: 'radiogroup', 'aria-label': t('web_scan_pages') });
  wheelAlong(strip);
  /** id → the page's tile in the row. */
  const tiles = new Map();
  strip.addEventListener('keydown', (e) => {
    const list = [...strip.children];
    const at = list.indexOf(document.activeElement);
    if (at < 0) return;
    const rtl = getComputedStyle(strip).direction === 'rtl';
    let next = null;
    if (e.key === 'ArrowRight') next = at + (rtl ? -1 : 1);
    else if (e.key === 'ArrowLeft') next = at + (rtl ? 1 : -1);
    else if (e.key === 'ArrowDown') next = at + 1;
    else if (e.key === 'ArrowUp') next = at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    next = (next + list.length) % list.length;
    list[next].focus();
    model.selectScanPage(list[next].pageId);
  });

  // ---- The controls ----
  // No heading over the looks, as the crop screen's Filters step has: their names say what they are,
  // and the page keeps the room. The row is named by that heading's word for screen readers.
  const looks = looksRow({ label: t('look_title'), onChoose: (look) => model.setScanLook(look) });
  const current = () => model.item(shownId);
  const adjustments = () => {
    const page = current();
    if (held && held.id === shownId) return held;
    return { brightness: page?.brightness ?? 0, contrast: page?.contrast ?? 0 };
  };
  // A slider held moves what shows; every page of the scan gets it as it is let go, not at each step.
  const hold = (change) => {
    held = { id: shownId, ...adjustments(), ...change };
    drawLarge();
  };
  const letGo = () => {
    if (!held || held.id !== shownId) return;
    const page = current();
    if (page && page.brightness === held.brightness && page.contrast === held.contrast) {
      held = null;
      return;
    }
    model.setScanAdjustments({ brightness: held.brightness, contrast: held.contrast });
  };
  const brightness = adjustmentSlider({
    label: t('filter_brightness'), resetLabel: t('filter_reset_brightness'), value: 0,
    onChange: (v) => hold({ brightness: v }), onRest: letGo,
  });
  const contrast = adjustmentSlider({
    label: t('filter_contrast'), resetLabel: t('filter_reset_contrast'), value: 0,
    onChange: (v) => hold({ contrast: v }), onRest: letGo,
  });
  const same = switchRow({ label: t('scan_same_look'), checked: false, onChange: (on) => model.setScanSameLook(on) });
  same.classList.add('images-scan-same');
  const controls = h('div', { class: 'images-step-controls images-scan-controls' }, looks, brightness, contrast, same);
  const buttons = stepButtons({ label: t('save'), icon: 'check', onClick: () => actions.save() });
  const panel = h('div', { class: 'images-step-panel images-scan-panel' }, strip, controls, h('div', { class: 'images-step-buttons' }, buttons));
  const main = h('div', { class: 'images-scan-main' }, area);
  const step = h('div', { class: 'images-step images-scan-looks-step' }, main, panel);
  const el = h('div', { class: 'images-crop images-scan-looks' }, bar, step);

  // On a wide screen the pages row is under the page, the controls and Save beside them; the
  // sliders share a line with their names while there is room.
  const layout = () => {
    const wide = isWideStep(step.getBoundingClientRect());
    step.classList.toggle('is-wide', wide);
    if (wide && strip.parentElement !== main) main.append(strip);
    else if (!wide && strip.parentElement !== panel) panel.prepend(strip);
    fitSliders([brightness, contrast], controls.clientWidth);
    reveal();
  };
  const resize = new ResizeObserver(layout);
  resize.observe(step);

  // ---- Drawing the pages ----

  /** A page's tile in the row, like a radio button: the page in its look and turn, its number in its corner. */
  function makeTile(id) {
    const thumb = h('canvas', { class: 'images-scan-page-canvas', 'aria-hidden': 'true' });
    const paper = h('span', { class: 'images-scan-page-paper' }, thumb);
    const ring = h('span', { class: 'images-spinner images-spinner--tiny images-scan-page-ring', 'aria-hidden': 'true' });
    const number = h('span', { class: 'images-scan-page-number', 'aria-hidden': 'true' });
    const tile = h('button', { type: 'button', role: 'radio', class: 'images-scan-page' }, paper, ring, number);
    tile.pageId = id;
    tile.thumb = thumb;
    tile.paper = paper;
    tile.ring = ring;
    tile.number = number;
    tile.drawn = null;
    tile.addEventListener('click', () => model.selectScanPage(id));
    return tile;
  }

  /** The aspect a page shows at: its width to its height, turned; A4's while it isn't made yet. */
  const aspectOf = (item, beingCropped) => {
    if (beingCropped) return 0.707;
    const sideways = item.rotation % 180 !== 0;
    return sideways ? item.image.height / item.image.width : item.image.width / item.image.height;
  };

  function drawTile(tile, item, beingCropped) {
    tile.style.setProperty('--aspect', String(aspectOf(item, beingCropped)));
    tile.classList.toggle('is-cropping', beingCropped);
    tile.ring.hidden = !beingCropped;
    if (beingCropped) {
      tile.drawn = null;
      tile.thumb.width = 0;
      tile.thumb.height = 0;
      return;
    }
    const key = [item.image, item.look, item.brightness, item.contrast, item.rotation];
    if (tile.drawn && tile.drawn.every((v, i) => v === key[i])) return;
    tile.drawn = key;
    pagePicture(item).then((p) => {
      if (destroyed || tile.drawn !== key) return;
      drawTurnedInto(tile.thumb, p, item.rotation);
    }, () => { /* the paper stays blank */ });
  }

  // ---- The large page ----

  /** The page upright from its image, at most PAGE_MAX long: { image, bitmap }, one page's at a time. */
  let base = null;
  let baseRun = 0;
  /** The large page in its look: { base, look, brightness, contrast, picture }. */
  let preview = null;
  let previewRun = null;
  /** The page's thumbnail, in its look, shown at once while the large page is read. */
  let thumbnail = null;

  function wanted() {
    const page = current();
    if (!page) return null;
    const a = adjustments();
    return { look: page.look, brightness: a.brightness, contrast: a.contrast };
  }

  function drawLarge() {
    const page = current();
    if (!page) return;
    const being = model.cropping.has(page.id);
    cropping.hidden = !being;
    canvas.hidden = being;
    if (being) {
      bigSpinner.hidden = true;
      smallSpinner.hidden = true;
      return;
    }
    const want = wanted();
    const ready = preview && base && preview.base === base;
    const picture = ready ? preview.picture : (thumbnail?.image === page.image ? thumbnail.picture : null);
    if (picture && canvas.shown !== picture) {
      drawTurnedInto(canvas, picture, page.rotation);
      canvas.shown = picture;
      canvas.turn = page.rotation;
    } else if (picture && canvas.turn !== page.rotation) {
      drawTurnedInto(canvas, picture, page.rotation);
      canvas.turn = page.rotation;
    }
    const busy = !ready || preview.look !== want.look || preview.brightness !== want.brightness || preview.contrast !== want.contrast;
    // A file that can't be read stays as its thumbnail shows it, with no ring.
    const unread = base?.image === page.image && !base.bitmap;
    bigSpinner.hidden = !!picture || unread;
    smallSpinner.hidden = !picture || !busy || unread;
    area.setAttribute('aria-busy', String(busy && !unread));
    if (!unread) makePreview();
  }

  async function makeBase(page) {
    const run = ++baseRun;
    base?.bitmap?.close?.();
    base = null;
    preview = null;
    previewRun?.abort();
    previewRun = null;
    drawLarge();
    let bitmap = null;
    try {
      bitmap = await loadImage(page.image, { maxSide: PAGE_MAX });
    } catch {
      bitmap = null;
    }
    if (destroyed || run !== baseRun) {
      bitmap?.close?.();
      return;
    }
    base = { image: page.image, bitmap };
    drawLarge();
  }

  async function makePreview() {
    const want = wanted();
    if (!base?.bitmap || !want) return;
    const same = (p) => p && p.base === base && p.look === want.look && p.brightness === want.brightness && p.contrast === want.contrast;
    if (same(preview)) {
      // Back to what shows: a look still being made for a choice since undone is not wanted.
      previewRun?.abort();
      previewRun = null;
      return;
    }
    if (previewRun?.want && same(previewRun.want)) return;
    previewRun?.abort();
    if (want.look === 'original' && !want.brightness && !want.contrast) {
      previewRun = null;
      preview = { base, ...want, picture: base.bitmap };
      drawLarge();
      return;
    }
    const controller = new AbortController();
    controller.want = { base, ...want };
    previewRun = controller;
    try {
      // Only the choices changed: once they have stayed put.
      if (preview?.base === base) await delay(LOOK_DELAY_MS, controller.signal);
      let picture;
      try {
        picture = await applyLookAsync(base.bitmap, want.look, { brightness: want.brightness, contrast: want.contrast }, { output: 'dom', signal: controller.signal });
      } catch (e) {
        if (e instanceof CancelledError || controller.signal.aborted) throw e;
        // Without memory for it, the page shows as it is.
        picture = base.bitmap;
      }
      if (destroyed || previewRun !== controller) return;
      previewRun = null;
      preview = { base: controller.want.base, look: want.look, brightness: want.brightness, contrast: want.contrast, picture };
      drawLarge();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }
  }

  // ---- The looks' small pages ----

  /** image → { look → small picture }, the pages shown last first (at most SAMPLES_KEPT). */
  const kept = new Map();
  let samplesRun = null;
  let samplesFor = null;

  async function makeSamples(page) {
    if (samplesFor?.image === page.image && samplesFor.rotation === page.rotation) return;
    samplesFor = { image: page.image, rotation: page.rotation };
    samplesRun?.abort();
    samplesRun = null;
    looks.clearSamples();
    const known = kept.get(page.image);
    if (known) {
      kept.delete(page.image);
      kept.set(page.image, known);
      for (const [look, picture] of Object.entries(known)) looks.drawSample(look, picture, page.rotation);
      if (Object.keys(known).length === LOOKS.length) return;
    }
    const controller = new AbortController();
    samplesRun = controller;
    let plain;
    try {
      // Each look on the page, made from its plain thumbnail: the size the editor shows pages at.
      plain = await pagePicture({ image: page.image, look: 'original', brightness: 0, contrast: 0 });
    } catch {
      return;
    }
    const made = { ...(known ?? {}) };
    for (const look of LOOKS) {
      if (destroyed || controller.signal.aborted) return;
      if (made[look]) continue;
      try {
        const picture = look === 'original' ? plain : await applyLookAsync(plain, look, {}, { output: 'dom', signal: controller.signal });
        if (controller.signal.aborted) return;
        const sample = small(picture);
        // Its own copy: the plain thumbnail stays the editor's, which may let it go.
        made[look] = sample === plain ? copyOf(plain) : sample;
      } catch (e) {
        if (e instanceof CancelledError || controller.signal.aborted) return;
        continue;
      }
      kept.delete(page.image);
      kept.set(page.image, made);
      while (kept.size > SAMPLES_KEPT) kept.delete(kept.keys().next().value);
      looks.drawSample(look, made[look], page.rotation);
    }
  }

  // ---- Showing the model ----

  let revealing = false;
  /** The page shown and the look chosen come into view in their rows. */
  function reveal() {
    if (revealing) return;
    revealing = true;
    requestAnimationFrame(() => {
      revealing = false;
      if (destroyed) return;
      revealIn(strip, tiles.get(shownId));
      looks.reveal();
    });
  }

  function update() {
    const scan = model.scan;
    if (destroyed || scan?.stage !== 'looks') return;
    const pages = scan.pages.map((id) => model.item(id)).filter(Boolean);
    const page = model.item(shownPage(scan));
    if (!page) return;
    const changedPage = page.id !== shownId;
    if (changedPage) held = null;
    shownId = page.id;
    const index = pages.indexOf(page);
    const several = pages.length > 1;
    bar.setSubtitle(several ? t('scan_place', index + 1, pages.length) : null);

    // The row.
    strip.hidden = !several;
    const seen = new Set();
    pages.forEach((item, i) => {
      let tile = tiles.get(item.id);
      if (!tile) {
        tile = makeTile(item.id);
        tiles.set(item.id, tile);
      }
      seen.add(item.id);
      const being = model.cropping.has(item.id);
      const n = i + 1;
      tile.number.textContent = String(n);
      tile.setAttribute('aria-label', t(being ? 'cropping_page' : 'pdf_page_number', n));
      const on = item.id === page.id;
      tile.setAttribute('aria-checked', String(on));
      tile.classList.toggle('is-selected', on);
      tile.tabIndex = on ? 0 : -1;
      drawTile(tile, item, being);
    });
    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.remove();
        tiles.delete(id);
      }
    }
    let at = strip.firstChild;
    for (const item of pages) {
      const tile = tiles.get(item.id);
      if (tile !== at) strip.insertBefore(tile, at);
      else at = at.nextSibling;
      at = tile.nextSibling;
    }

    // The controls.
    looks.setLook(page.look);
    if (held && page.brightness === held.brightness && page.contrast === held.contrast) held = null;
    const a = adjustments();
    if (!brightness.held) brightness.setValue(a.brightness);
    if (!contrast.held) contrast.setValue(a.contrast);
    same.hidden = !several;
    same.setChecked(scan.sameLook);

    // The large page, and the looks on it.
    const being = model.cropping.has(page.id);
    croppingText.textContent = being ? t('cropping_page', index + 1) : '';
    if (changedPage || shownImage !== page.image) {
      shownImage = page.image;
      thumbnail = null;
      canvas.shown = null;
      if (being) {
        baseRun++;
        base = null;
        preview = null;
        previewRun?.abort();
        previewRun = null;
      } else {
        const image = page.image;
        pagePicture(page).then((picture) => {
          if (destroyed || current()?.image !== image) return;
          thumbnail = { image, picture };
          drawLarge();
        }, () => {});
        makeBase(page);
      }
    }
    if (!being) makeSamples(page);
    else if (samplesFor) {
      // Until it is made it is the photo: no looks to show on it.
      samplesRun?.abort();
      samplesFor = null;
      looks.clearSamples();
    }
    drawLarge();
    if (changedPage) reveal();
  }

  update();
  layout();

  return {
    el,
    update,
    back: () => actions.back(),
    focus() {
      const heading = bar.querySelector('h1');
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      // The screen is a pane, named as it comes in.
      announce(t('filter_title'));
    },
    destroy() {
      destroyed = true;
      resize.disconnect();
      previewRun?.abort();
      samplesRun?.abort();
      baseRun++;
      base?.bitmap?.close?.();
    },
  };
}
