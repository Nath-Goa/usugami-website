// A scan's first screen, Photos (ScanPhotosScreen.kt): the photos taken so far, in the order taken,
// as they were taken (no turn, no look), each with its number and a button that takes it out, and
// Take another and Done at the foot. A photo still being added shows as blank paper with a ring.
// On a phone the hint is the grid's first row and scrolls away with the photos; on a wide screen it
// stands in a 320 px column beside them, over the buttons. Leaving with photos asks first whether to
// discard them.
import { h, announce, prefersReducedMotion } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { topBar, iconButton, alertDialog } from '../../core/ui.js';
import { sourceOf } from './model.js';
import { pagePicture } from './preview.js';
import { stepButtons, isWideStep } from './crop-screen.js';

/**
 * @param {object} o
 * @param {import('./model.js').ImagesModel} o.model
 * @param {{ takePhoto(), done(), remove(id), discard() }} o.actions  takePhoto: the camera for the
 *   next page; done: on to cropping; remove: a photo out of the scan; discard: the scan ended
 *   without its photos
 * @returns {{ el, update(), back(), focus(), destroy() }}
 */
export function createScanPhotos({ model, actions }) {
  let destroyed = false;
  let asking = false;
  /** The tiles: id → tile, and the places of photos being added. */
  const tiles = new Map();
  const coming = [];
  let shownCount = null;

  const bar = topBar({ title: t('scan_photos_title'), onBack: () => back(), backLabel: t('back') });
  const hint = h('p', { class: 'images-photos-hint' }, t('scan_photos_hint'));
  const hintItem = h('div', { class: 'images-photos-hint-item' }, hint);
  const grid = h('div', { class: 'images-photos-grid', role: 'list', 'aria-label': t('scan_photos_title') });
  // A photo goes here: the camera is opening.
  const outline = h('div', { class: 'images-photos-outline', 'aria-hidden': 'true' }, icon('photo_camera', { size: 32 }));
  const empty = h('div', { class: 'images-photos-empty' }, outline);
  const area = h('div', { class: 'images-photos-area' }, hintItem, grid, empty);
  const buttons = stepButtons(
    { label: t('crop_done'), icon: 'check', onClick: () => done() },
    { label: t('crop_take_another'), icon: 'photo_camera', onClick: () => actions.takePhoto() },
  );
  const side = h('div', { class: 'images-photos-side' }, h('div', { class: 'images-step-buttons' }, buttons));
  const body = h('div', { class: 'images-photos' }, area, side);
  const el = h('div', { class: 'images-crop images-scan-photos' }, bar, body);

  // On a wide screen (wider than tall, with room beside the column) the hint stands beside the
  // photos, over the buttons.
  const layout = () => {
    const wide = isWideStep(body.getBoundingClientRect());
    body.classList.toggle('is-wide', wide);
    if (wide && hint.parentElement !== side) side.prepend(hint);
    else if (!wide && hint.parentElement !== hintItem) hintItem.append(hint);
  };
  const resize = new ResizeObserver(layout);
  resize.observe(body);

  function photos() {
    const scan = model.scan;
    if (!scan) return [];
    return scan.pages.map((id) => model.item(id)).filter(Boolean);
  }

  const isEmpty = () => !photos().length && model.photosAdding === 0;

  function done() {
    const scan = model.scan;
    if (!scan || !scan.pages.length || model.photosAdding > 0) return;
    actions.done();
  }

  /** Back: with photos, asks first; with none, the scan just ends. */
  async function back() {
    if (asking || destroyed) return;
    if (isEmpty()) {
      actions.discard();
      return;
    }
    asking = true;
    let ok = false;
    try {
      ok = await alertDialog({
        title: t('scan_discard_title'), message: t('scan_discard_body'), confirm: t('discard'), dismiss: t('keep'), destructive: true,
      });
    } finally {
      asking = false;
    }
    if (ok && !destroyed) actions.discard();
  }

  /** A photo's tile: the photo as taken on white paper, its number, and a button that takes it out. */
  function makeTile(item) {
    const canvas = h('canvas', { class: 'images-photo-canvas', 'aria-hidden': 'true' });
    const paper = h('div', { class: 'images-photo-paper' }, canvas);
    const picture = h('div', { class: 'images-photo-picture', role: 'img' }, paper);
    const number = h('span', { class: 'images-photo-number', 'aria-hidden': 'true' });
    const remove = iconButton({ icon: 'close', label: '', variant: 'tonal', cls: 'images-photo-remove', onClick: () => removePhoto(item.id) });
    const tile = h('div', { class: 'images-photo', role: 'listitem' }, picture, number, remove);
    tile.number = number;
    tile.picture = picture;
    tile.removeButton = remove;
    // As it was taken: the photo itself (a page already cropped from it shows whole again), upright,
    // neither turned nor in a look.
    const source = sourceOf(item).image;
    paper.style.setProperty('--ratio', String(source.width / source.height));
    pagePicture({ image: source, look: 'original', brightness: 0, contrast: 0 }).then((p) => {
      if (destroyed) return;
      canvas.width = p.width;
      canvas.height = p.height;
      canvas.getContext('2d').drawImage(p, 0, 0);
      paper.style.setProperty('--ratio', String(p.width / p.height));
      paper.classList.add('has-picture');
    }, () => { /* the paper stays blank */ });
    return tile;
  }

  /** The place of a photo still being added: blank paper with a ring. */
  function makeComing() {
    const ring = h('div', { class: 'images-spinner images-spinner--small images-photo-ring', role: 'img', 'aria-label': t('scan_adding_photo') });
    const paper = h('div', { class: 'images-photo-paper is-blank' }, ring);
    const number = h('span', { class: 'images-photo-number', 'aria-hidden': 'true' });
    const tile = h('div', { class: 'images-photo is-coming', role: 'listitem' }, h('div', { class: 'images-photo-picture' }, paper), number);
    tile.number = number;
    return tile;
  }

  function removePhoto(id) {
    const list = photos();
    const at = list.findIndex((p) => p.id === id);
    actions.remove(id);
    // The focus goes on to the next photo's button, or the one before, as a list does; with none
    // left, to Take another.
    queueMicrotask(() => {
      if (destroyed) return;
      const left = photos();
      const next = left[Math.min(at, left.length - 1)];
      const target = next ? tiles.get(next.id)?.removeButton : buttons.other;
      target?.focus({ preventScroll: true });
    });
  }

  function update() {
    if (destroyed || !model.scan || model.scan.stage !== 'photos') return;
    const list = photos();
    const adding = model.photosAdding;
    const seen = new Set();
    const order = [];
    list.forEach((item, i) => {
      let tile = tiles.get(item.id);
      if (!tile) {
        tile = makeTile(item);
        tiles.set(item.id, tile);
      }
      seen.add(item.id);
      const n = i + 1;
      tile.number.textContent = String(n);
      tile.picture.setAttribute('aria-label', t('pdf_page_number', n));
      tile.removeButton.setLabel(t('remove_page', n));
      order.push(tile);
    });
    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.remove();
        tiles.delete(id);
      }
    }
    while (coming.length < adding) coming.push(makeComing());
    while (coming.length > adding) coming.pop().remove();
    coming.forEach((tile, i) => { tile.number.textContent = String(list.length + i + 1); });
    order.push(...coming);
    let at = grid.firstChild;
    for (const tile of order) {
      if (tile !== at) grid.insertBefore(tile, at);
      else at = at.nextSibling;
      at = tile.nextSibling;
    }
    const none = !order.length;
    grid.hidden = none;
    empty.hidden = !none;
    el.classList.toggle('is-empty', none);
    // With no photo yet, the first is taken with Take photo; Done waits for a photo and for those
    // still being added.
    buttons.other.querySelector('.ui-btn-label').textContent = t(none ? 'add_from_camera' : 'crop_take_another');
    buttons.main.disabled = !list.length || adding > 0;
    // A photo that arrives comes into view: the newest is the last, which may be below the fold.
    const count = order.length;
    if (shownCount != null && count > shownCount) {
      order.at(-1).scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    shownCount = count;
  }

  update();
  layout();

  return {
    el,
    update,
    back,
    focus() {
      const heading = bar.querySelector('h1');
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      // The screen is a pane, named as it comes in.
      announce(t('scan_photos_title'));
    },
    destroy() {
      destroyed = true;
      resize.disconnect();
    },
  };
}
