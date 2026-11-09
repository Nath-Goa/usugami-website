// Images to PDF's editor (EditorScreen.kt, Options.kt's OptionsRow): the pages with live previews,
// the page size, orientation and margin chips over them, Sort and Remove all in the bar, and Add
// images and Convert to PDF at the bottom; before the first image, a screen with Photos, Files and
// Take photo. On computers, images can also be dropped on it or pasted.
import { h } from '../../core/dom.js';
import { t, tp, tWeb } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import { topBar, button, dropdown, linearProgress, bottomBar, menu, alertDialog, dropZone } from '../../core/ui.js';
import { pageList } from './page-list.js';

/** The page size, orientation and margin choices, in the app's order (PageSize, PageOrientation, Margin). */
export const PAGE_SIZE_OPTIONS = [
  { value: 'fit', label: 'size_fit', short: 'size_fit_short' },
  { value: 'a4', label: 'size_a4' },
  { value: 'letter', label: 'size_letter' },
  { value: 'legal', label: 'size_legal' },
  { value: 'a3', label: 'size_a3' },
  { value: 'a5', label: 'size_a5' },
];
export const ORIENTATION_OPTIONS = [
  { value: 'auto', label: 'orientation_auto' },
  { value: 'portrait', label: 'orientation_portrait' },
  { value: 'landscape', label: 'orientation_landscape' },
];
export const MARGIN_OPTIONS = [
  { value: 'none', label: 'margin_none' },
  { value: 'small', label: 'margin_small' },
  { value: 'big', label: 'margin_big' },
];

const translated = (options) => options.map((o) => ({ value: o.value, label: t(o.label), short: o.short ? t(o.short) : undefined }));

/** Whether a mouse (or pen) is what points here, so the hint speaks of dragging rather than long presses. */
const finePointer = () => window.matchMedia?.('(pointer: fine)').matches;

/**
 * @param {object} o
 * @param {import('./model.js').ImagesModel} o.model
 * @param {{ back(), addPhotos(), addFiles(), takePhoto(), convert(), files(items) }} o.actions
 * @returns {{ el: HTMLElement, update(), attach(), detach(), focusAfterCrop(id), destroy() }}
 */
export function createEditor({ model, actions }) {
  const bar = topBar({
    title: t('editor_title'),
    onBack: () => actions.back(),
    actions: [
      { icon: 'sort', label: t('sort'), onClick: () => sortMenu() },
      { icon: 'delete_sweep', label: t('clear_all'), onClick: () => confirmClear() },
    ],
  });
  const [sortButton, clearButton] = bar.actions;
  sortButton.setAttribute('aria-haspopup', 'menu');
  sortButton.setAttribute('aria-expanded', 'false');

  const progress = linearProgress({ value: null, label: t('adding_images') });
  progress.classList.add('images-import-progress');

  // ---- Options ----
  const sizeChip = dropdown({
    label: t('option_page_size'), options: translated(PAGE_SIZE_OPTIONS), value: model.layout.pageSize,
    onChange: (v) => model.setLayout({ ...model.layout, pageSize: v }),
  });
  const orientationChip = dropdown({
    label: t('option_orientation'), options: translated(ORIENTATION_OPTIONS), value: model.layout.orientation,
    onChange: (v) => model.setLayout({ ...model.layout, orientation: v }),
  });
  const marginChip = dropdown({
    label: t('option_margin'), options: translated(MARGIN_OPTIONS), value: model.layout.margin,
    onChange: (v) => model.setLayout({ ...model.layout, margin: v }),
  });
  const options = h('div', { class: 'images-options' }, sizeChip, orientationChip, marginChip);

  // ---- Pages ----
  const hint = h('p', { class: 'images-reorder-hint' });
  const pages = pageList({
    onCrop: (id) => { lastCropped = id; model.openCrop(id); },
    onRotate: (id, degrees) => model.rotate(id, degrees),
    onRemove: (id) => removePage(id),
    onMove: (from, to) => model.move(from, to),
    onAddMore: (anchor) => addMenu(anchor),
  });
  const content = h('div', { class: 'images-content' }, options, hint, pages);

  // ---- Before the first image ----
  const emptyTitle = h('h2', { class: 'images-empty-title' });
  const photosButton = button({ label: t('add_from_photos'), icon: 'photo_library', variant: 'filled', onClick: () => actions.addPhotos() });
  const filesButton = button({ label: t('add_from_files'), icon: 'folder_open', variant: 'tonal', onClick: () => actions.addFiles() });
  const cameraButton = button({ label: t('add_from_camera'), icon: 'photo_camera', variant: 'tonal', onClick: () => actions.takePhoto() });
  const empty = h('div', { class: 'images-empty' },
    h('div', { class: 'images-empty-icon', 'aria-hidden': 'true' }, icon('add_photo_alternate', { size: 56 })),
    emptyTitle,
    h('p', { class: 'images-empty-body' }, tWeb('empty_body')),
    h('div', { class: 'images-empty-buttons' }, photosButton, filesButton, cameraButton),
    h('p', { class: 'images-empty-hint' }, tWeb('empty_share_hint')));

  // ---- Bottom bar ----
  const addButton = button({ label: t('add_images'), icon: 'add', variant: 'outlined', cls: 'images-add-button', onClick: () => addMenu(addButton) });
  addButton.setAttribute('aria-haspopup', 'menu');
  addButton.setAttribute('aria-expanded', 'false');
  const convertButton = button({ label: t('convert'), icon: 'picture_as_pdf', variant: 'filled', cls: 'images-convert-button', onClick: () => actions.convert() });
  const bottom = bottomBar(addButton, convertButton);
  bottom.classList.add('images-bottombar');

  const main = h('main', { class: 'images-main' }, empty, content);
  const el = h('div', { class: 'images-editor' }, bar, progress, main, bottom);
  let lastCropped = null;
  let detachDrop = null;
  let wasEmpty = null;

  function addMenu(anchor) {
    menu(anchor, [
      { label: t('add_from_photos'), icon: 'photo_library', onClick: () => actions.addPhotos() },
      { label: t('add_from_files'), icon: 'folder_open', onClick: () => actions.addFiles() },
      { label: t('add_from_camera'), icon: 'photo_camera', onClick: () => actions.takePhoto() },
    ]);
  }

  function sortMenu() {
    menu(sortButton, [
      { label: t('sort_name_az'), onClick: () => model.sort('name_asc') },
      { label: t('sort_name_za'), onClick: () => model.sort('name_desc') },
      { label: t('sort_reverse'), onClick: () => model.sort('reverse') },
    ]);
  }

  async function confirmClear() {
    if (!model.items.length) return;
    const ok = await alertDialog({ title: t('clear_title'), message: t('discard_body'), confirm: t('clear_all'), dismiss: t('keep') });
    if (ok) model.clearAll();
  }

  function removePage(id) {
    const index = model.items.findIndex((i) => i.id === id);
    model.remove(id);
    // The focus goes on to the next page's Remove, or the one before, as a list does.
    queueMicrotask(() => {
      const next = model.items[Math.min(index, model.items.length - 1)];
      if (next) pages.focusPage(next.id, 'remove');
      else if (!content.hidden) pages.focusAddMore();
    });
  }

  function update() {
    const items = model.items;
    const isEmpty = items.length === 0;
    const importing = model.pending > 0;
    bar.setSubtitle(isEmpty ? null : tp('image_count', items.length));
    sortButton.hidden = items.length < 2;
    clearButton.hidden = isEmpty;
    progress.hidden = !importing;
    empty.hidden = !isEmpty;
    content.hidden = isEmpty;
    bottom.hidden = isEmpty;
    el.classList.toggle('is-empty', isEmpty);
    emptyTitle.textContent = t(importing ? 'adding_images' : 'empty_title');
    for (const b of [photosButton, filesButton, cameraButton]) b.disabled = importing;
    convertButton.disabled = importing;
    hint.hidden = items.length < 2;
    hint.textContent = finePointer() ? t('web_reorder_hint_mouse') : t('reorder_hint');
    const fit = model.layout.pageSize === 'fit';
    sizeChip.setValue(model.layout.pageSize);
    orientationChip.setValue(model.layout.orientation);
    orientationChip.setDisabled(fit, fit ? t('orientation_fit_note') : null);
    marginChip.setValue(model.layout.margin);
    pages.update(items, { layout: model.layout, cropping: model.cropping });
    if (wasEmpty === true && !isEmpty && document.activeElement && el.contains(document.activeElement) && document.activeElement.closest('.images-empty')) {
      // The button pressed has gone with the empty screen: the focus goes to the first page.
      pages.focusPage(items[0].id, 'handle');
    }
    wasEmpty = isEmpty;
  }

  return {
    el,
    update,
    /** On screen: it takes dropped and pasted images. */
    attach() {
      detachDrop?.();
      detachDrop = dropZone(main, { accept: () => true, multiple: true, onFiles: (files) => actions.files(files) });
    },
    detach() {
      detachDrop?.();
      detachDrop = null;
    },
    /** Back from the crop screen: the focus returns to the page's crop button, else the heading. */
    focusAfterCrop() {
      const id = lastCropped;
      lastCropped = null;
      return id != null && pages.focusPage(id, 'crop');
    },
    destroy() {
      detachDrop?.();
      pages.destroy();
    },
  };
}
