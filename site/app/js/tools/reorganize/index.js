// Reorganize PDF (PageGrids.kt's ReorganizeOptions, PageActions and AddPagesButton, with
// PdfToolsViewModel's page list, prepareInsert, addBlankPage, undo, resetToOriginal and
// runReorganize): a PDF's pages in a grid; a page tapped is chosen, and the bar above the grid moves,
// turns or removes it; pages are also dragged (a long press on touch screens); "Add pages" puts the
// pages of another PDF, or a blank page the size of the page before it, after the chosen page (or at
// the end); Undo takes back one change at a time; Save PDF makes the new PDF.
import { h, ensureCss, announce } from '../../core/dom.js';
import { t, tp, loadStrings, formatSize } from '../../core/i18n.js';
import {
  topBar, button, iconButton, bottomBar, textField, emptyState, fileCard, linearProgress, snackbar,
  alertDialog, menu, dropZone,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf } from '../../core/pdfdoc.js';
import { pageGrid } from '../../core/pagegrid.js';
import { CancelledError } from '../../core/errors.js';
import { PageList, pageKey, pagesOf, samePages, isBlank, turnedKey, enginePages } from '../merge/page-list.js';
import { problemText, runWithProgress, resultScreen } from '../merge/tool-run.js';
import { blankPicture } from '../merge/thumbs.js';

/** Renders Reorganize PDF into ctx.root. */
export async function mount(ctx) {
  const [engine] = await Promise.all([
    import('../../engine/organize.js'),
    loadStrings('reorganize'),
    ensureCss(new URL('../merge/merge.css', import.meta.url)),
    ensureCss(new URL('./reorganize.css', import.meta.url)),
  ]);

  /** The PDF reorganized: { id, name, size, pageCount, src, bytes, password }. */
  let main = null;
  /** PDFs pages were added from ("Add pages" → "Pages from a PDF"), in the order added. */
  let extras = [];
  /** The PDF's own pages as they are: what the list starts as, and Reset goes back to. */
  let original = [];
  const pages = new PageList();
  /** The chosen page, by its key (it keeps being chosen as it moves). */
  let chosen = null;
  const chosenSet = new Set();
  let fileName = '';
  let importing = false;
  let processing = false;
  let alive = true;
  // Leaving the tool takes a password question still open away with it.
  const leaving = new AbortController();
  let seq = 0;
  let dragging = false;
  // A change the grid made itself (a move): it shows it already.
  let fromGrid = false;
  /** The page keys the grid shows, in order, and the pages themselves (entries never change in place). */
  let shown = [];
  let shownPages = [];
  let grid = null;
  let card = null;

  const inputOf = (id) => (main?.id === id ? main : extras.find((e) => e.id === id));
  const indexOfChosen = () => (chosen == null ? -1 : pages.indexOf(chosen));

  // -------------------------------------------------------------------------------------------
  // The screen

  const bar = topBar({ title: t('tool_reorganize'), onBack: () => ctx.back() });
  const busy = h('div', { class: 'merge-busy' }, linearProgress({ value: null, label: t('web_adding_pages') }));
  const empty = emptyState({
    icon: 'add',
    title: t('pick_pdf'),
    onClick: () => pickMain(),
    onFiles: (items) => openMain(items[0]),
    accept: 'pdf',
    multiple: false,
  });
  const cardSlot = h('div', { class: 'reorganize-card' });

  // "12 pages", said again as pages are added or removed, and Undo.
  const countEl = h('h2', { class: 'reorganize-count', 'aria-live': 'polite', tabindex: '-1' });
  const undoButton = iconButton({ icon: 'undo', label: t('undo'), onClick: () => undo() });
  const hint = h('p', { class: 'reorganize-hint' }, t('reorganize_hint'));

  // The bar above the grid: always there and as tall with or without a page chosen, so the grid
  // never moves under the finger that taps a page.
  const barLabel = h('span', { class: 'reorganize-bar-label' });
  const earlier = iconButton({ icon: 'arrow_back', label: '', onClick: () => moveChosen(-1) });
  const later = iconButton({ icon: 'arrow_forward', label: '', onClick: () => moveChosen(1) });
  const turnLeft = iconButton({ icon: 'rotate_left', label: '', onClick: () => turnChosen(-90) });
  const turnRight = iconButton({ icon: 'rotate_right', label: '', onClick: () => turnChosen(90) });
  // A turn to the left is to the left whichever way the text runs (TurnIcon).
  for (const b of [turnLeft, turnRight]) b.querySelector('svg')?.classList.remove('icon-mirrored');
  const removeButton = iconButton({ icon: 'delete', label: '', onClick: () => removeChosen() });
  const barButtons = h('div', { class: 'reorganize-bar-buttons' }, earlier, later, turnLeft, turnRight, removeButton);
  const actionBar = h('div', { class: 'reorganize-bar' }, barLabel, barButtons);
  const gridSlot = h('div', { class: 'reorganize-grid-slot' });
  const pagesPane = h('div', { class: 'reorganize-pages' }, actionBar, gridSlot);

  const addButton = button({ label: t('reorganize_add'), icon: 'add', variant: 'outlined', onClick: () => openAddMenu() });
  addButton.setAttribute('aria-haspopup', 'menu');
  addButton.setAttribute('aria-expanded', 'false');
  const resetButton = button({ label: t('pdf_reset_pages'), variant: 'text', onClick: () => resetPages() });
  const options = h('div', { class: 'reorganize-options' },
    h('div', { class: 'reorganize-head' }, countEl, undoButton),
    hint,
    pagesPane,
    h('div', { class: 'reorganize-actions' }, addButton, resetButton));

  const nameField = textField({ label: t('file_name'), value: '', suffix: '.pdf', onInput: (v) => { fileName = v; } });
  nameField.classList.add('reorganize-name');
  const content = h('div', { class: 'merge-content' }, cardSlot, options, nameField);
  const page = h('div', { class: 'page merge-page reorganize-page', 'data-main': '' }, busy, empty, content);
  const save = button({ label: t('pdf_reorganize_action'), onClick: () => saveReorganized() });
  const view = h('div', { class: 'merge-view' }, bar, page, bottomBar(save));
  ctx.root.append(view);

  const result = resultScreen(ctx, view, { onStartOver: () => startOver() });
  // On computers a PDF dropped (or pasted) once the pages show adds its pages, as "Pages from a PDF".
  const detachDrop = dropZone(content, {
    accept: 'pdf',
    multiple: false,
    onFiles: ([item]) => addPagesOf(item, chosen != null && pages.indexOf(chosen) >= 0 ? chosen : null),
  });

  // Ctrl+Z (⌘Z) takes back the latest change, as Undo, outside text fields.
  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
    if (view.hidden || !view.isConnected || document.querySelector('dialog[open]')) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if (!pages.canUndo || importing || processing) return;
    e.preventDefault();
    undo();
  };
  document.addEventListener('keydown', onKey);

  // -------------------------------------------------------------------------------------------
  // The grid

  function makeGrid() {
    grid?.destroy();
    grid = pageGrid({
      count: pages.length,
      thumbnail: (i, width, o) => thumbnailOf(pages.pages[i], width, o),
      tileLabel: (i) => tileName(i),
      // One page chosen at a time, as the app's selectable tiles: a listbox of options.
      selectable: 'single',
      selected: chosenSet,
      onToggle: (i) => choose(i),
      reorderable: true,
      moveButtons: false,
      ariaLabel: t('tool_reorganize'),
      rotation: (i) => pages.pages[i]?.rotation ?? 0,
      onMove: (from, to) => {
        fromGrid = true;
        try {
          // A drag is one change for Undo; each move of the keyboard is one of its own.
          if (!dragging) pages.pushUndo();
          pages.moveAt(from, to);
        } finally {
          fromGrid = false;
        }
      },
      onMoveStart: () => {
        dragging = true;
        pages.beginDrag();
      },
      onMoveEnd: () => {
        dragging = false;
        pages.endDrag();
      },
    });
    grid.classList.add('reorganize-grid');
    gridSlot.replaceChildren(grid);
    shown = pages.pages.map(pageKey);
    shownPages = pages.pages;
  }

  function thumbnailOf(ref, width, o) {
    if (!ref) return Promise.reject(new CancelledError());
    if (isBlank(ref)) return Promise.resolve(blankPicture(ref.width, ref.height, t('reorganize_blank'), width));
    const input = inputOf(ref.input);
    if (!input) return Promise.reject(new CancelledError());
    return input.src.thumbnail(ref.page, width, o);
  }

  /** What a screen reader calls page `i`: "Page 3", "Page 3, from Other.pdf" or "Page 3, blank", and its turn. */
  function tileName(i) {
    const ref = pages.pages[i];
    if (!ref) return '';
    const n = i + 1;
    const input = inputOf(ref.input);
    const name = isBlank(ref) || !input ? t('reorganize_page_blank', n)
      : ref.input !== main?.id ? t('reorganize_page_from', n, input.name)
        : t('pdf_page_number', n);
    const turned = turnedKey(ref.rotation);
    return turned ? `${name}, ${t(turned)}` : name;
  }

  // -------------------------------------------------------------------------------------------
  // Choosing a page and the bar's buttons

  function choose(i) {
    const key = pageKey(pages.pages[i]);
    chosen = key === chosen ? null : key;
    sync();
  }

  function moveChosen(offset) {
    const from = indexOfChosen();
    const to = from + offset;
    if (from < 0 || to < 0 || to >= pages.length || !grid) return;
    if (grid.move(from, to)) {
      announce(t('web_page_moved', to + 1, pages.length));
      // A page moved out of sight with the buttons is scrolled back into it.
      grid.scrollToIndex(to);
    }
  }

  function turnChosen(degrees) {
    if (chosen != null) pages.rotate(chosen, degrees);
  }

  function removeChosen() {
    const index = indexOfChosen();
    if (index < 0 || pages.length <= 1) return;
    const key = chosen;
    // The page that takes its place is chosen next, so several can go in a row.
    const after = pages.pages.filter((p) => pageKey(p) !== key);
    const next = after[index] ?? after[index - 1];
    chosen = next ? pageKey(next) : null;
    pages.remove(key);
  }

  function undo() {
    if (!pages.canUndo) return;
    // A PDF whose pages were added stays, so its pages can come back.
    pages.undo(new Set([main?.id, ...extras.map((e) => e.id)]));
  }

  function resetPages() {
    pages.resetTo(original);
    chosen = null;
    sync();
  }

  function openAddMenu() {
    if (importing || processing) return;
    menu(addButton, [
      { label: t('reorganize_add_pdf'), icon: 'picture_as_pdf', onClick: () => addPdf() },
      { label: t('reorganize_add_blank'), icon: 'note_add', onClick: () => addBlank() },
    ]);
  }

  // -------------------------------------------------------------------------------------------
  // Opening the PDF and adding pages

  async function pickMain() {
    if (importing || processing) return;
    const [item] = await pickFiles({ accept: 'pdf', multiple: false });
    if (item) await openMain(item);
  }

  /** Opens `item` as the PDF to reorganize, in place of any before. */
  async function openMain(item) {
    if (!item || importing || processing || !alive) return;
    clearAll();
    importing = true;
    render();
    try {
      const src = await openSource(item);
      if (!src || !alive) {
        src?.close();
        return;
      }
      main = { id: `p${++seq}`, name: src.name, size: src.size, pageCount: src.pageCount, src, bytes: src.bytes, password: src.password };
      original = pagesOf([main]);
      pages.set(original);
      pages.clearUndo();
      setName(engine.defaultName('reorganize', main));
      card = fileCard({
        name: main.name,
        detail: t('result_details', tp('page_count', main.pageCount), formatSize(main.size)),
        thumbnail: main.src.thumbnail(0, 58, { maxCssHeight: 78 }).catch(() => null),
        onRemove: () => removeMain(),
      });
      cardSlot.replaceChildren(card);
      makeGrid();
    } finally {
      if (alive) {
        importing = false;
        render();
        // The card picked from has gone: the focus goes to the pages.
        const a = document.activeElement;
        if (main && (!a || a === document.body || empty.contains(a))) countEl.focus({ preventScroll: true });
      }
    }
  }

  /** Opens a picked PDF (asking for its password): its source, or null (cancelled, or said why not). */
  async function openSource(item) {
    try {
      // A password given on Choose a tool (item.password) is tried first.
      const src = await openPdf(item, { signal: leaving.signal });
      if (src && !src.pageCount) {
        src.close();
        snackbar(t('pdf_import_failed'));
        return null;
      }
      return src;
    } catch (error) {
      if (!(error instanceof CancelledError) && alive) snackbar(problemText(error, 'pdf_import_failed'));
      return null;
    }
  }

  /** "Pages from a PDF": its pages go after the chosen page, or at the end (prepareInsert). */
  async function addPdf() {
    if (importing || processing || !main) return;
    const after = chosen != null && pages.indexOf(chosen) >= 0 ? chosen : null;
    const [item] = await pickFiles({ accept: 'pdf', multiple: false });
    if (item) await addPagesOf(item, after);
  }

  /** Opens `item` (asking for its password) and puts its pages after the page `after`, or at the end. */
  async function addPagesOf(item, after) {
    if (!item || importing || processing || !alive || !main) return;
    await busyWith(async () => {
      const src = await openSource(item);
      if (!src) return;
      if (!alive || !main) {
        src.close();
        return;
      }
      const input = { id: `p${++seq}`, name: src.name, size: src.size, pageCount: src.pageCount, src, bytes: src.bytes, password: src.password };
      extras = [...extras, input];
      pages.insert(pagesOf([input]), after, { undoable: true });
    });
  }

  /**
   * "Blank page": after the chosen page (or at the end), the size that page shows, sideways when
   * it is turned a quarter (addBlankPage). Busy while a PDF page's size is read, so asked for
   * again meanwhile it adds no second page, and the PDF can't be saved without it.
   */
  async function addBlank() {
    if (importing || processing || !main) return;
    const list = pages.pages;
    const at = chosen != null ? list.findIndex((p) => pageKey(p) === chosen) : -1;
    const neighbour = list[at >= 0 ? at : list.length - 1];
    if (!neighbour) return;
    if (isBlank(neighbour)) {
      pages.insertBlank(neighbour, neighbour.width, neighbour.height);
      return;
    }
    const source = inputOf(neighbour.input);
    if (!source) return;
    await busyWith(async () => {
      let size;
      try {
        size = await source.src.pageSize(neighbour.page);
      } catch {
        size = await engine.shownPageSize({ name: source.name, bytes: source.bytes, password: source.password || undefined }, neighbour.page);
      }
      // Put away meanwhile, the PDF takes its blank page with it.
      if (alive && inputOf(source.id)) pages.insertBlank(neighbour, size.width, size.height);
    });
  }

  async function removeMain() {
    if (importing || processing) return;
    if (hasChanges()) {
      const discard = await alertDialog({ title: t('tool_discard_title'), confirm: t('discard'), dismiss: t('keep'), destructive: true });
      if (!discard || !alive) return;
    }
    startOver();
    empty.focus?.();
  }

  // -------------------------------------------------------------------------------------------
  // Saving

  const hasChanges = () => !!main && pages.length > 0 && !samePages(pages.pages, original);

  async function saveReorganized() {
    if (!hasChanges() || importing || processing) return;
    processing = true;
    render();
    const list = pages.pages;
    // Only the PDFs whose pages are still in the list.
    const used = extras.filter((e) => list.some((p) => p.input === e.id));
    const input = { id: main.id, name: main.name, bytes: main.bytes, password: main.password || undefined };
    const others = used.map((e) => ({ id: e.id, name: e.name, bytes: e.bytes, password: e.password || undefined }));
    const out = await runWithProgress((hooks) => engine.reorganizePdf(input, { pages: enginePages(list), fileName }, others, hooks));
    processing = false;
    if (!alive) return;
    render();
    if (out) result.show([out], { zipName: fileName, passwordRemoved: !!out.passwordRemoved });
  }

  function clearAll() {
    main?.src.close();
    for (const e of extras) e.src.close();
    main = null;
    extras = [];
    original = [];
    chosen = null;
    chosenSet.clear();
    pages.clearUndo();
    pages.set([]);
    grid?.destroy();
    grid = null;
    gridSlot.replaceChildren();
    shown = [];
    shownPages = [];
    card = null;
    cardSlot.replaceChildren();
  }

  function startOver() {
    clearAll();
    render();
  }

  function setName(name) {
    fileName = name;
    nameField.setValue(name);
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  pages.onChange(() => {
    if (alive) sync();
  });

  /** Brings the grid, the chosen page and the bar in step with the pages. */
  function sync() {
    const list = pages.pages;
    const keys = list.map(pageKey);
    const before = [...chosenSet];
    chosenSet.clear();
    const ci = chosen == null ? -1 : keys.indexOf(chosen);
    if (ci >= 0) chosenSet.add(ci);
    if (grid) {
      if (fromGrid) {
        // The grid moves the page itself, and redraws the pages between.
      } else if (keys.length === shown.length && keys.every((k, i) => k === shown[i])) {
        // The same pages in the same places: only those changed (a turn), and the pages chosen
        // before and now, are drawn again, so a long PDF stays quick.
        const changed = new Set([...before, ...chosenSet]);
        list.forEach((ref, i) => { if (ref !== shownPages[i]) changed.add(i); });
        grid.refresh(changed);
      } else {
        // Drawn afresh (pages added, removed or brought back by Undo): a page that had the focus
        // hands it to the page now in its place.
        const tilesBefore = [...grid.querySelectorAll('.ui-page-tile')];
        const focused = tilesBefore.findIndex((tileEl) => tileEl.contains(document.activeElement));
        grid.setCount(keys.length);
        if (focused >= 0 && keys.length) grid.focusIndex(Math.min(focused, keys.length - 1));
      }
    }
    shown = keys;
    shownPages = list;
    render();
  }

  function render() {
    const has = !!main;
    busy.hidden = !importing;
    empty.hidden = has;
    empty.disabled = importing;
    content.hidden = !has;
    const count = pages.length;
    const countText = tp('page_count', count, count);
    if (countEl.textContent !== countText) countEl.textContent = countText;
    setDisabled(undoButton, !pages.canUndo);
    const index = indexOfChosen();
    const ref = index >= 0 ? pages.pages[index] : null;
    actionBar.classList.toggle('is-chosen', !!ref);
    barButtons.hidden = !ref;
    barLabel.textContent = ref ? t('pdf_page_number', index + 1) : t('reorganize_choose_page');
    if (ref) {
      const n = index + 1;
      earlier.setLabel(t('move_page_earlier', n));
      later.setLabel(t('move_page_later', n));
      turnLeft.setLabel(t('rotate_page_left', n));
      turnRight.setLabel(t('rotate_page_right', n));
      removeButton.setLabel(t('remove_page', n));
      setDisabled(earlier, index === 0, later);
      setDisabled(later, index === count - 1, earlier);
      // A PDF keeps at least one page.
      setDisabled(removeButton, count <= 1, turnRight);
    }
    addButton.disabled = importing || processing;
    resetButton.disabled = !hasChanges();
    save.disabled = !hasChanges() || importing || processing;
  }

  /** Turns `b` off or on; the focus it had goes to `other`, as a button turned off can't keep it. */
  function setDisabled(b, off, other) {
    const focused = document.activeElement === b;
    b.disabled = off;
    if (focused && off) (other && !other.disabled ? other : null)?.focus({ preventScroll: true });
  }

  /**
   * Runs `work` with adding busy: Add pages is off meanwhile, and gets the focus back after if it
   * had it (or the menu that it opened had it), as a button turned off loses it.
   */
  async function busyWith(work) {
    const refocus = document.activeElement === addButton || document.activeElement === document.body || !document.activeElement;
    importing = true;
    render();
    try {
      return await work();
    } finally {
      if (alive) {
        importing = false;
        render();
        const a = document.activeElement;
        if (refocus && main && (!a || a === document.body)) addButton.focus({ preventScroll: true });
      }
    }
  }

  render();
  if (ctx.files?.length) openMain(ctx.files[0]);

  return {
    unmount() {
      alive = false;
      leaving.abort();
      document.removeEventListener('keydown', onKey);
      detachDrop();
      empty.detachDrop?.();
      grid?.destroy();
      result.destroy();
      main?.src.close();
      for (const e of extras) e.src.close();
    },
    hasUnsavedWork() {
      if (result.showing) return !result.isSaved();
      // The pages differ from the PDF's own, also with pages added from other PDFs.
      return processing || hasChanges();
    },
    onStep: (step) => result.onStep(step),
    // The state, for tests.
    get state() {
      return {
        main: main && { id: main.id, name: main.name, pageCount: main.pageCount },
        extras: extras.map((e) => ({ id: e.id, name: e.name, pageCount: e.pageCount })),
        pages: pages.pages,
        chosen,
        fileName,
        canUndo: pages.canUndo,
      };
    },
  };
}
