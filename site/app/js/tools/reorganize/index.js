// Reorganize PDF (PageGrids.kt's ReorganizeOptions, PageActions, ReorganizeTile and AddPagesButton,
// with PdfToolsViewModel's page list, selected pages, prepareInsert, addBlankPage, undo,
// resetToOriginal and runReorganize): a PDF's pages in a grid. Pages are selected by tapping them,
// by typing their numbers like "2,5-7" or with Select all; the field and the pages stay in step.
// The bar above the grid turns or removes every selected page at once and, while one page is
// selected, moves it too. Pages are also dragged (a long press on touch screens). "Add pages" puts
// the pages of another PDF, or a blank page the size of the page before it, after the last
// selected page (or at the end). Undo takes back one change at a time; Save PDF makes the new PDF.
import { h, ensureCss, announce, prefersReducedMotion } from '../../core/dom.js';
import { t, tp, loadStrings, formatSize } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import {
  topBar, button, iconButton, bottomBar, textField, emptyState, fileCard, linearProgress, snackbar,
  alertDialog, menu, dropZone,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf, preloadPdfJs } from '../../core/pdfdoc.js';
import { pageGrid } from '../../core/pagegrid.js';
import { CancelledError, UserError } from '../../core/errors.js';
import { defaultName } from '../../engine/page-selection.js';
import { readPages, pagesProblem, places as placesOf, following, fieldText } from '../../engine/page-choice.js';
import { PageList, pageKey, pagesOf, samePages, isBlank, turnedKey, enginePages } from '../merge/page-list.js';
import { problemText, runWithProgress, resultScreen, engineLoader, setOff } from '../merge/tool-run.js';
import { blankPicture } from '../merge/thumbs.js';

/** Room kept round a page scrolled into sight in the grid, for the outline the keyboard focus draws. */
const SIGHT_MARGIN = 4;

/** Renders Reorganize PDF into ctx.root. */
export async function mount(ctx) {
  // pdf.js (about 460 kB) loads while a PDF is being chosen; pdfdoc.js imports it only on demand.
  preloadPdfJs();
  await Promise.all([
    loadStrings('reorganize'),
    ensureCss(new URL('../merge/merge.css', import.meta.url)),
    ensureCss(new URL('./reorganize.css', import.meta.url)),
  ]);
  // The engine (pdf-lib) loads behind the screen, which shows at once; it is only needed to save
  // (and, rarely, for a blank page's size).
  const loadEngine = engineLoader(() => import('../../engine/organize.js'));
  loadEngine().catch(() => {});

  /** The PDF reorganized: { id, name, size, pageCount, src, bytes, password }. */
  let main = null;
  /** PDFs pages were added from ("Add pages" → "Pages from a PDF"), in the order added. */
  let extras = [];
  /** The PDF's own pages as they are: what the list starts as, and Reset goes back to. */
  let original = [];
  const pages = new PageList();

  /** The selected pages, by their keys: they stay selected wherever they are moved (ChosenPages). */
  let chosen = new Set();
  /** Their places in the list as it is now, going up; and the same as the set the grid reads. */
  let places = [];
  const chosenSet = new Set();
  /** What was typed into the Selected pages field, and the page count it was typed for. */
  let typed = '';
  let typedFor = 0;
  /** Typing is done (Enter, the field left, or a page tapped): what can't be read is now explained. */
  let showProblem = false;
  /** Remove was pressed with every page selected: a PDF keeps at least one. */
  let keepOne = false;
  /** The selection was last made by typing: a page typed alone is then scrolled into sight. */
  let typedLast = false;
  /** The page selected alone when the scrolling rule last ran, and what it last ran for. */
  let lastSingle = null;
  let followed = { place: -1, key: null };
  /** While Remove takes pages out: the place the keyboard focus goes to if the bar's buttons had it. */
  let handFocusTo = -1;
  /** What the field's support line says in place of its hint, so it is only written when it changes. */
  let said = null;

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
  /** Each page's check mark, by its key: a tile drawn again gets the same one back. */
  const checkMarks = new Map();

  const inputOf = (id) => (main?.id === id ? main : extras.find((e) => e.id === id));
  /** The selected page that comes last in the list (pages added go after it), or null with none. */
  const lastChosen = () => (places.length ? pages.pages[places[places.length - 1]] : null);

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

  // "12 pages", said again as pages are added or removed; Select all, or Select none while every
  // page is selected; and Undo.
  const countEl = h('h2', { class: 'reorganize-count', 'aria-live': 'polite', tabindex: '-1' });
  const selectAll = button({ label: t('reorganize_select_all'), variant: 'text', onClick: () => selectAllOrNone() });
  const undoButton = iconButton({ icon: 'undo', label: t('undo'), onClick: () => undo() });

  // The selected pages, typed like "2,5-7". Under the field its hint, or what is wrong in its
  // place: the field's own support line, which a screen reader hears change.
  const pagesField = textField({
    label: t('reorganize_pages_field'),
    helper: t('reorganize_pages_hint'),
    autocomplete: 'off',
    spellcheck: false,
    onInput: (text) => typedPages(text),
    onEnter: () => doneTyping(),
  });
  pagesField.classList.add('reorganize-pages-field');
  const pagesInput = pagesField.input;
  pagesInput.setAttribute('autocapitalize', 'off');
  pagesInput.setAttribute('autocorrect', 'off');
  pagesInput.setAttribute('enterkeyhint', 'done');
  // Leaving the field ends the typing: what can't be read is explained now, not while it is typed.
  // Not when only the window lost the focus (another window or tab looked at): the field is still
  // the one to type in on the way back.
  pagesInput.addEventListener('blur', () => {
    if (!alive || document.activeElement === pagesInput) return;
    showProblem = true;
    render();
  });
  // Every text the support line can show, unseen in the same place (reorganize.css): the line is
  // as tall whichever shows, so the bar and the grid under it never move when the hint and an
  // error swap, as they do when a page is tapped while what is typed can't be read.
  const rangeRoom = h('span');
  pagesField.append(h('div', { class: 'ui-field-support reorganize-room', 'aria-hidden': 'true' },
    h('span', {}, t('reorganize_pages_hint')),
    h('span', {}, t('pdf_pages_format')),
    rangeRoom,
    h('span', {}, t('pdf_pages_reversed')),
    h('span', {}, t('pdf_need_page'))));
  // The cross at the field's end, there while the field holds text.
  const clearButton = iconButton({ icon: 'close', label: t('reorganize_pages_clear'), cls: 'reorganize-clear', onClick: () => clearPages() });
  // Pressed with a mouse or a finger it doesn't take the focus: the field would count as left
  // (and a phone's keyboard would close) just before it is emptied.
  clearButton.addEventListener('mousedown', (e) => e.preventDefault());
  const selectBox = h('div', { class: 'reorganize-select' }, pagesField, clearButton);

  // The bar above the grid: always there and as tall whatever is selected, with nothing between
  // it and the grid, so the grid never moves under the finger that taps a page. A screen reader
  // hears its text as pages are selected.
  const barLabel = h('span', { class: 'reorganize-bar-label', 'aria-live': 'polite' });
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
  const hint = h('p', { class: 'reorganize-hint' }, t('reorganize_move_hint'));
  const pagesPane = h('div', { class: 'reorganize-pages' }, actionBar, gridSlot, hint);

  const addButton = button({ label: t('reorganize_add'), icon: 'add', variant: 'outlined', onClick: () => openAddMenu() });
  addButton.setAttribute('aria-haspopup', 'menu');
  addButton.setAttribute('aria-expanded', 'false');
  const resetButton = button({ label: t('pdf_reset_pages'), variant: 'text', onClick: () => resetPages() });
  const options = h('div', { class: 'reorganize-options' },
    h('div', { class: 'reorganize-head' }, countEl, selectAll, undoButton),
    selectBox,
    pagesPane,
    h('div', { class: 'reorganize-actions' }, addButton, resetButton));

  const nameField = textField({ label: t('file_name'), value: '', suffix: '.pdf', onInput: (v) => { fileName = v; } });
  nameField.classList.add('reorganize-name');
  const content = h('div', { class: 'merge-content' }, cardSlot, options, nameField);
  const page = h('main', { class: 'page merge-page reorganize-page', 'data-main': '' }, busy, empty, content);
  const save = button({ label: t('pdf_reorganize_action'), onClick: () => saveReorganized() });
  const view = h('div', { class: 'merge-view reorganize-view' }, bar, page, bottomBar(save));
  ctx.root.append(view);

  const result = resultScreen(ctx, view, { onStartOver: () => startOver() });
  // On computers a PDF dropped (or pasted) once the pages show adds its pages, as "Pages from a PDF".
  const detachDrop = dropZone(content, {
    accept: 'pdf',
    multiple: false,
    onFiles: ([item]) => addPagesOf(item, lastChosen()),
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
      // Each page is a check box, as the app's tiles: tapped, it goes into the selection or out of it.
      selectable: true,
      selected: chosenSet,
      onToggle: (i) => tapped(i),
      badge: (i) => checkMark(i),
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

  /**
   * The check mark in the corner of page `i`: every page has one, which reorganize.css shows while
   * the page is selected, so it fades in and out. Only for the eye: the check box says its state.
   */
  function checkMark(i) {
    const ref = pages.pages[i];
    if (!ref) return null;
    const key = pageKey(ref);
    let mark = checkMarks.get(key);
    if (!mark) {
      mark = h('span', { class: 'reorganize-check', 'aria-hidden': 'true' }, icon('check', { size: 16 }));
      checkMarks.set(key, mark);
    }
    return mark;
  }

  /** The tile of the page at `place` in the grid, or undefined. */
  const tileAt = (place) => grid?.querySelectorAll('.ui-page-tile')[place];

  /** Whether any of the page at `place` shows in the grid's own scrolling area. */
  function inSight(place) {
    const tile = tileAt(place);
    if (!tile) return true;
    const top = tile.offsetTop - grid.scrollTop;
    return top + tile.offsetHeight > 0 && top < grid.clientHeight;
  }

  /**
   * Scrolls the grid, and only the grid, until the row of the page at `place` is the first that
   * shows, as the app's animateScrollToItem: right under the bar and the field. Scrolled by the
   * least that shows the page instead, a page further down would stop at the grid's foot, which
   * on a phone lies under Save PDF or below the screen. Not scrollIntoView, which also scrolls the
   * window: the field being typed in would leave a phone's screen. The last rows can't reach the
   * top: the grid stops at its end, as the app's does.
   */
  function bringIntoSight(place) {
    const tile = tileAt(place);
    if (!tile) return;
    const to = Math.max(0, tile.offsetTop - SIGHT_MARGIN);
    if (to !== grid.scrollTop) grid.scrollTo({ top: to, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  /**
   * The page selected alone is scrolled into sight when it is out of it and was moved (with the
   * bar's buttons or the keyboard, or by Undo or Reset pages changing its place), or typed. A
   * page left selected alone by taps is not: the grid never moves under the finger that taps a
   * page, also when the one left is out of sight. Never during a drag either (PageGrids.kt's
   * LaunchedEffect on the single selected page).
   */
  function followSingle() {
    const place = places.length === 1 ? places[0] : -1;
    const key = place >= 0 ? pageKey(pages.pages[place]) : null;
    // As the app's effect, this runs only when the page selected alone, or its place, has changed.
    if (place === followed.place && key === followed.key) return;
    followed = { place, key };
    const moved = key !== null && key === lastSingle;
    lastSingle = key;
    if (place < 0 || dragging || !(moved || typedLast)) return;
    if (!inSight(place)) bringIntoSight(place);
  }

  /**
   * Gives the keyboard focus to the page at `place` (or, with -1, to the page the grid's Tab stop
   * is on) and shows it, as the grid does for a page its arrow keys go to: the grid scrolls by the
   * least that shows the page, and so does the window. In one column the grid's foot lies under
   * Save PDF or below the screen, so the grid alone would leave the focus where it can't be seen.
   * No field is being typed in here, so the window may move.
   */
  function focusPage(place) {
    const buttons = grid ? [...grid.querySelectorAll('.ui-page')] : [];
    const at = place >= 0 ? Math.min(place, buttons.length - 1) : buttons.findIndex((b) => b.tabIndex === 0);
    if (!buttons[at]) {
      // No page to go to: the page count, as after the last Undo.
      countEl.focus({ preventScroll: true });
      return;
    }
    buttons[at].focus({ preventScroll: true });
    buttons[at].scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------------------------------------
  // Selecting pages: taps, the field, Select all

  /**
   * A page tapped goes into the selection, or out of it. Not while what is typed can't be read:
   * then the tap selects nothing, leaves the text as it is, and the reason shows (tapped).
   */
  function tapped(i) {
    const ref = pages.pages[i];
    if (!ref) return;
    keepOne = false;
    typedLast = false;
    if (readPages(typed, pages.length) === null) {
      showProblem = true;
    } else {
      const key = pageKey(ref);
      const next = new Set(chosen);
      if (!next.delete(key)) next.add(key);
      chosen = next;
    }
    sync();
  }

  /** Every change to the field's text makes the pages it names the selection: none while it can't be read. */
  function typedPages(text) {
    typed = text;
    showProblem = false;
    keepOne = false;
    typedLast = true;
    const list = pages.pages;
    chosen = new Set((readPages(text, list.length) ?? []).map((place) => pageKey(list[place])));
    sync();
  }

  /** Enter (a phone's Done): typing is done. */
  function doneTyping() {
    showProblem = true;
    render();
    // On a phone, Done also puts the keyboard away, as the app's does; with a real keyboard the
    // focus stays in the field.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) pagesInput.blur();
  }

  /** Forgets what was typed and what it led to, and makes the pages with `keys` the selection. */
  function choose(keys) {
    typed = '';
    showProblem = false;
    keepOne = false;
    typedLast = false;
    chosen = keys;
    sync();
  }

  function selectAllOrNone() {
    const keys = pages.pages.map(pageKey);
    const all = keys.length > 0 && keys.every((key) => chosen.has(key));
    choose(all ? new Set() : new Set(keys));
  }

  function clearPages() {
    const hadFocus = document.activeElement === clearButton;
    choose(new Set());
    // The cross goes with the text: pressed from the keyboard, the focus goes to the field it emptied.
    if (hadFocus) pagesInput.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------------------------
  // The bar's buttons

  function moveChosen(offset) {
    if (places.length !== 1 || !grid) return;
    const from = places[0];
    const to = from + offset;
    if (to < 0 || to >= pages.length) return;
    // The grid moves the page (its tiles glide) and tells the list through onMove.
    if (grid.move(from, to)) announce(t('web_page_moved', to + 1, pages.length));
  }

  /** Turns every selected page, as one change for Undo (rotateChosen). */
  function turnChosen(degrees) {
    pages.rotateKeys(chosen, degrees);
  }

  /**
   * Takes the selected pages out, as one change for Undo. Not when that would leave no page (every
   * page selected, or the only page): nothing goes, and the field says a PDF keeps at least one
   * until not every page is selected (removeChosen).
   */
  function removeChosen() {
    if (!chosen.size) return;
    handFocusTo = places[0];
    const removed = pages.removeKeys(chosen);
    handFocusTo = -1;
    if (removed) return;
    keepOne = true;
    render();
  }

  function undo() {
    if (!pages.canUndo) return;
    // A PDF whose pages were added stays, so its pages can come back.
    pages.undo(new Set([main?.id, ...extras.map((e) => e.id)]));
  }

  /** Back to the PDF's own pages. The pages still selected stay selected (resetToOriginal). */
  function resetPages() {
    pages.resetTo(original);
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
      setName(defaultName('reorganize', main));
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

  /**
   * "Pages from a PDF": its pages go after the last selected page, or at the end. The page is the
   * one selected when the PDF is asked for, also if the selection changes while it is picked
   * (prepareInsert).
   */
  async function addPdf() {
    if (importing || processing || !main) return;
    const after = lastChosen();
    const [item] = await pickFiles({ accept: 'pdf', multiple: false });
    if (item) await addPagesOf(item, after);
  }

  /**
   * Opens `item` (asking for its password) and puts its pages after the page `after`, or at the
   * end when there is none or it has gone meanwhile. The pages added are not selected.
   */
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
      pages.insert(pagesOf([input]), after ? pageKey(after) : null, { undoable: true });
    });
  }

  /**
   * "Blank page": after the last selected page (or at the end), the size that page shows, sideways
   * when it is turned a quarter (addBlankPage). Busy while a PDF page's size is read, so asked for
   * again meanwhile it adds no second page, and the PDF can't be saved without it.
   */
  async function addBlank() {
    if (importing || processing || !main) return;
    const list = pages.pages;
    const neighbour = lastChosen() ?? list[list.length - 1];
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
        // shownPageSize gives A4 for a page it can't read; so does an engine that couldn't load.
        const engine = await loadEngine().catch(() => null);
        size = engine
          ? await engine.shownPageSize({ name: source.name, bytes: source.bytes, password: source.password || undefined }, neighbour.page)
          : { width: 595.27563, height: 841.8898 };
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
  }

  // -------------------------------------------------------------------------------------------
  // Saving

  // The pages differ from the PDF's own. A selection alone is nothing to save, or to lose.
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
    // Leaving the tool stops the work, and takes its progress dialog away with it.
    const out = await runWithProgress(async (hooks) => {
      const engine = await loadEngine().catch(() => null);
      // Offline before the tool was ever used whole.
      if (!engine) throw new UserError('web_tool_load_failed', t('tool_reorganize'));
      return engine.reorganizePdf(input, { pages: enginePages(list), fileName }, others, hooks);
    }, { signal: leaving.signal });
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
    chosen = new Set();
    places = [];
    chosenSet.clear();
    typed = '';
    typedFor = 0;
    showProblem = false;
    keepOne = false;
    typedLast = false;
    lastSingle = null;
    followed = { place: -1, key: null };
    pages.clearUndo();
    pages.set([]);
    grid?.destroy();
    grid = null;
    gridSlot.replaceChildren();
    checkMarks.clear();
    shown = [];
    shownPages = [];
    card = null;
    cardSlot.replaceChildren();
  }

  function startOver() {
    clearAll();
    render();
    empty.focus({ preventScroll: true });
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

  /** Brings the selection, the field, the grid and the bar in step with the pages. */
  function sync() {
    const list = pages.pages;
    const keys = list.map(pageKey);
    // The selection follows the pages: those that have gone leave it, and nothing is ever added
    // to it, so pages Undo or Reset bring back are not selected again (ChosenPages.follow).
    chosen = following(keys, chosen);
    places = placesOf(keys, chosen);
    // Numbers typed for a list of another length name other pages now: the field shows the
    // selection as ranges instead.
    if (keys.length !== typedFor) {
      typed = '';
      typedFor = keys.length;
    }
    // What was typed stays while it names the selected pages; later typing goes on from the text shown.
    typed = fieldText(typed, places, keys.length);
    // "Keep at least one page." goes for good once not every page is selected: pages added and
    // then undone, say, don't bring it back with no Remove pressed again.
    if (!keys.length || places.length !== keys.length) keepOne = false;

    // The pages whose check box changes.
    const changed = new Set(chosenSet);
    for (const place of places) {
      if (!changed.delete(place)) changed.add(place);
    }
    chosenSet.clear();
    for (const place of places) chosenSet.add(place);
    if (grid) {
      if (fromGrid) {
        // The grid moves the page itself, and redraws the pages between.
      } else if (keys.length === shown.length && keys.every((k, i) => k === shown[i])) {
        // The same pages in the same places: only those turned, and those selected or let go, are
        // drawn again, so a long PDF stays quick.
        list.forEach((ref, i) => { if (ref !== shownPages[i]) changed.add(i); });
        grid.refresh(changed);
      } else {
        // Drawn afresh (pages added, removed or brought back by Undo): a page that had the focus
        // hands it to the page now in its place.
        const tilesBefore = [...grid.querySelectorAll('.ui-page-tile')];
        const focused = tilesBefore.findIndex((tileEl) => tileEl.contains(document.activeElement));
        const there = new Set(keys);
        for (const key of checkMarks.keys()) if (!there.has(key)) checkMarks.delete(key);
        grid.setCount(keys.length);
        if (focused >= 0 && keys.length) grid.focusIndex(Math.min(focused, keys.length - 1));
      }
    }
    shown = keys;
    shownPages = list;
    render();
    // After a move of the grid's own, once the grid has put the page's tile in its new place.
    if (fromGrid) queueMicrotask(() => { if (alive) followSingle(); });
    else followSingle();
  }

  function render() {
    const has = !!main;
    busy.hidden = !importing;
    empty.hidden = has;
    // Marked off rather than disabled, which would throw the keyboard focus out of it (to the
    // page itself, where a password dialog closing would leave it).
    setOff(empty, importing);
    content.hidden = !has;
    const count = pages.length;
    const every = count > 0 && places.length === count;
    selectAll.setLabel(t(every ? 'reorganize_select_none' : 'reorganize_select_all'));
    selectAll.disabled = count === 0;
    // The last change taken back, the focus goes to the page count beside Undo.
    setDisabled(undoButton, !pages.canUndo, countEl);
    renderField(count, every);
    renderBar(count);
    // Written once the bar has handed the focus on (after a Remove): a screen reader then says
    // the new count after the page the focus went to, rather than having it cut short by that page.
    setText(countEl, tp('page_count', count, count));
    setOff(addButton, importing || processing);
    // Reset, the focus goes to Add pages beside it.
    setDisabled(resetButton, !hasChanges(), addButton);
    // While busy only marked off, so the focus stays on it (and comes back to it after Cancel).
    save.disabled = !hasChanges();
    setOff(save, importing || processing);
  }

  /** The Selected pages field: its text, its cross, and its hint or what is wrong in its place. */
  function renderField(count, every) {
    // Written only when it differs, so typing keeps its place in the text.
    if (pagesField.value !== typed) pagesField.setValue(typed);
    clearButton.hidden = typed === '';
    selectBox.classList.toggle('has-clear', typed !== '');
    setText(rangeRoom, t('pdf_pages_range', count));
    // The one place for what is wrong with the selection. Typed pages that can't be used come
    // first; "Keep at least one page." shows while every page is still selected.
    const problem = showProblem ? pagesProblem(typed, count) : null;
    const now = problem ? t(problem.key, ...problem.args) : keepOne && every ? t('pdf_need_page') : null;
    if (now !== said) {
      said = now;
      pagesField.setError(now);
    }
  }

  /** The bar: what is selected, and the buttons for one page or for several. */
  function renderBar(count) {
    const any = places.length > 0;
    const one = places.length === 1;
    const index = one ? places[0] : -1;
    const focused = barButtons.contains(document.activeElement) ? document.activeElement : null;
    actionBar.classList.toggle('is-chosen', any);
    // Five buttons: reorganize.css makes room for them on the narrowest phones.
    actionBar.classList.toggle('is-one', one);
    barButtons.hidden = !any;
    earlier.hidden = !one;
    later.hidden = !one;
    if (one) {
      const n = index + 1;
      earlier.setLabel(t('move_page_earlier', n));
      later.setLabel(t('move_page_later', n));
      turnLeft.setLabel(t('rotate_page_left', n));
      turnRight.setLabel(t('rotate_page_right', n));
      // Also on for the only page: pressed, it says a PDF keeps at least one.
      removeButton.setLabel(t('remove_page', n));
      const first = index === 0;
      const last = index === count - 1;
      setDisabled(earlier, first, last ? turnLeft : later);
      setDisabled(later, last, first ? turnLeft : earlier);
    } else if (any) {
      turnLeft.setLabel(t('rotate_selected_left'));
      turnRight.setLabel(t('rotate_selected_right'));
      removeButton.setLabel(tp('remove_selected_pages', places.length, places.length));
    }
    // A button that had the focus and has gone hands it on rather than dropping it to the top of
    // the page: to the buttons left, or with none left (the pages were removed, or the selected
    // page went with an Undo) to a page in the grid.
    if (focused && (!any || focused.hidden)) {
      if (any) turnLeft.focus({ preventScroll: true });
      else focusPage(handFocusTo);
    }
    // The bar's own text last, for the same reason as the page count: said after a focus handed on.
    setText(barLabel, !any ? t('reorganize_tap_pages')
      : one ? t('pdf_page_number', index + 1)
        : t('reorganize_selected_count', places.length, count));
  }

  /** Writes `text` into `node` only when it differs, so a live region says it once. */
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /** Turns `b` off or on; the focus it had goes to `other`, as a button turned off can't keep it. */
  function setDisabled(b, off, other) {
    const focused = document.activeElement === b;
    b.disabled = off;
    if (focused && off) (other && !other.disabled ? other : null)?.focus({ preventScroll: true });
  }

  /**
   * Runs `work` with adding busy: Add pages is marked off meanwhile (keeping the focus), and gets
   * the focus back after if it, or the menu that it opened, had it.
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
        // The selected pages' keys, in the pages' order.
        chosen: places.map((place) => pageKey(pages.pages[place])),
        fileName,
        canUndo: pages.canUndo,
      };
    },
  };
}
