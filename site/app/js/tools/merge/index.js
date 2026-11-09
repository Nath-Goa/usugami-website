// Merge PDF (PdfToolScreen.kt's MergeInputs and MergePages, with PdfToolsViewModel's addPdfs,
// moveInput, sortInputs, removeInput, the page list and runMerge): PDFs added and put in order (their
// buttons, a drag, or sorted by name), or in page mode their pages reordered, turned and left out,
// then joined into one PDF named as typed ("Merged_PDF").
import { h, ensureCss } from '../../core/dom.js';
import { t, tp, loadStrings } from '../../core/i18n.js';
import { icon } from '../../core/icons.js';
import {
  topBar, button, iconButton, bottomBar, textField, emptyState, dropZone, linearProgress, snackbar, uid,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf, reportFileProblems, preloadPdfJs } from '../../core/pdfdoc.js';
import { CancelledError, UserError } from '../../core/errors.js';
import { PageList, pageKey, pagesOf, samePages, turnedKey, enginePages } from './page-list.js';
import { reorderList } from './reorder-list.js';
import { problemText, runWithProgress, resultScreen, engineLoader, setOff } from './tool-run.js';
import { turnedThumb } from './thumbs.js';
import { defaultName as nameFor } from '../../engine/page-selection.js';

/** Renders Merge PDF into ctx.root. */
export async function mount(ctx) {
  // pdf.js (about 460 kB) loads while a PDF is being chosen; pdfdoc.js imports it only on demand.
  preloadPdfJs();
  await Promise.all([
    loadStrings('merge'),
    ensureCss(new URL('./merge.css', import.meta.url)),
  ]);
  // The engine (pdf-lib) loads behind the screen, which shows at once; Merge waits for it if need be.
  const loadEngine = engineLoader(() => import('../../engine/organize.js'));
  loadEngine().catch(() => {});
  const defaultName = nameFor('merge');

  /** The PDFs, in the order they are merged: { id, name, size, pageCount, src, bytes, password }. */
  let inputs = [];
  const pages = new PageList();
  let pageMode = false;
  let fileName = defaultName;
  let importing = false;
  let processing = false;
  let alive = true;
  // Leaving the tool takes a password question still open away with it.
  const leaving = new AbortController();
  let seq = 0;
  // A page list change made by the list itself (a drag step): it already shows it.
  let fromList = false;
  let dragging = false;

  const byId = (id) => inputs.find((i) => i.id === id);
  const allPages = () => pagesOf(inputs);

  // -------------------------------------------------------------------------------------------
  // The screen

  const bar = topBar({ title: t('tool_merge'), onBack: () => ctx.back() });
  const busy = h('div', { class: 'merge-busy' }, linearProgress({ value: null, label: t('web_adding_pdfs') }));
  const empty = emptyState({
    icon: 'add',
    title: t('add_pdfs'),
    onClick: () => pick(),
    onFiles: (items) => add(items),
    accept: 'pdf',
    multiple: true,
  });

  // Files | switch | Pages: the whole row flips it, and a screen reader hears what it turns on.
  const track = h('span', { class: 'ui-switch merge-switch', 'aria-hidden': 'true' },
    h('span', { class: 'ui-switch-thumb' }, icon('check', { size: 16 })));
  const modeRow = h('button', {
    type: 'button', role: 'switch', class: 'merge-mode', 'aria-label': t('pdf_page_mode_switch'),
    onClick: () => setPageMode(!pageMode),
  },
  h('span', { class: 'merge-mode-files', 'aria-hidden': 'true' }, t('pdf_file_mode')),
  track,
  h('span', { class: 'merge-mode-pages', 'aria-hidden': 'true' }, t('pdf_page_mode')));
  const hint = h('p', { class: 'merge-hint' });
  // Says why Merge can't be pressed yet, and a screen reader says it as it shows.
  const needTwo = h('p', { class: 'merge-error', 'aria-live': 'polite' });

  const fileList = reorderList({
    cls: 'merge-files',
    keyOf: (input) => input.id,
    create: fileRow,
    onMove: (from, to) => {
      const list = inputs.slice();
      list.splice(to, 0, ...list.splice(from, 1));
      setInputs(list);
    },
  });
  const sortRow = h('div', { class: 'merge-sort' },
    button({ label: t('pdf_sort_az'), variant: 'text', onClick: () => sortInputs(false) }),
    button({ label: t('pdf_sort_za'), variant: 'text', onClick: () => sortInputs(true) }));
  const filesSection = h('div', { class: 'merge-files-section merge-section' }, fileList, sortRow);

  const addButton = button({ label: t('add_pdfs'), variant: 'outlined', onClick: () => pick() });
  const resetButton = button({ label: t('pdf_reset_pages'), variant: 'text', onClick: () => pages.reset(allPages()) });
  const pageList = reorderList({
    cls: 'merge-pages',
    ariaLabel: t('pdf_page_mode'),
    keyOf: pageKey,
    create: pageRow,
    roving: true,
    lazy: true,
    onMove: (from, to) => {
      fromList = true;
      try {
        if (!dragging) pages.pushUndo();
        pages.moveAt(from, to);
      } finally {
        fromList = false;
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
  const noPages = h('p', { class: 'merge-error', 'aria-live': 'polite' });
  const pagesSection = h('div', { class: 'merge-pages-section merge-section' }, h('div', { class: 'merge-reset' }, resetButton), pageList, noPages);

  const nameField = textField({ label: t('file_name'), value: fileName, suffix: '.pdf', onInput: (v) => { fileName = v; } });
  const content = h('div', { class: 'merge-content' },
    modeRow,
    h('div', { class: 'merge-mode-text' }, hint, needTwo, filesSection),
    h('div', { class: 'merge-add' }, addButton, pagesSection),
    nameField);
  const page = h('main', { class: 'page page--narrow merge-page', 'data-main': '' }, busy, empty, content);
  const run = button({ label: t('pdf_merge_action'), onClick: () => merge() });
  const view = h('div', { class: 'merge-view' }, bar, page, bottomBar(run));
  ctx.root.append(view);
  // Files dropped or pasted once PDFs are listed are added too. Without any, the "Add PDFs" card
  // takes them: one drop zone at a time, as one around the other would stay marked after a drop
  // on the inner one (which keeps the drop to itself).
  let detachDrop = null;
  const pageDrop = (on) => {
    if (on && !detachDrop) {
      detachDrop = dropZone(page, { accept: 'pdf', multiple: true, onFiles: (items) => add(items) });
    } else if (!on && detachDrop) {
      detachDrop();
      detachDrop = null;
      page.classList.remove('is-dragover');
    }
  };

  const result = resultScreen(ctx, view, { onStartOver: () => startOver() });

  // -------------------------------------------------------------------------------------------
  // Rows

  /** A PDF in the list: its place, name and pages, and buttons naming the file they act on. */
  function fileRow(input) {
    const number = h('span', { class: 'merge-file-number', 'aria-hidden': 'true' });
    const up = iconButton({ icon: 'arrow_upward', label: t('move_file_earlier', input.name), onClick: () => fileList.moveBy(input.id, -1) });
    const down = iconButton({ icon: 'arrow_downward', label: t('move_file_later', input.name), onClick: () => fileList.moveBy(input.id, 1) });
    const remove = iconButton({ icon: 'close', label: t('remove_file', input.name), cls: 'merge-file-remove', onClick: () => removeInput(input.id) });
    const el = h('div', { class: 'merge-file' },
      number,
      h('div', { class: 'merge-file-text' },
        h('span', { class: 'merge-file-name' }, input.name),
        h('span', { class: 'merge-file-detail' }, tp('page_count', input.pageCount))),
      up, down, remove);
    return {
      el,
      update(item, index, count) {
        number.textContent = `${index + 1}.`;
        setDisabled(up, index === 0, down);
        setDisabled(down, index === count - 1, up);
      },
    };
  }

  /** A page in page mode: its picture turned as it will be, its place and PDF, Rotate and Remove. */
  function pageRow(ref) {
    const textId = uid('merge-page');
    const text = h('span', { class: 'merge-page-text', id: textId });
    const turned = h('span', { class: 'ui-visually-hidden', id: textId + '-turned' });
    const thumb = turnedThumb({ width: 55, height: 72 });
    const earlier = iconButton({ icon: 'arrow_upward', label: '', cls: 'merge-move', onClick: () => pageList.moveBy(pageKey(ref), -1) });
    const later = iconButton({ icon: 'arrow_downward', label: '', cls: 'merge-move', onClick: () => pageList.moveBy(pageKey(ref), 1) });
    const rotate = iconButton({ icon: 'rotate_right', label: '', onClick: () => pages.rotate(pageKey(ref), 90) });
    // A turn to the right is to the right whichever way the text runs (TurnIcon).
    rotate.querySelector('svg')?.classList.remove('icon-mirrored');
    const remove = iconButton({ icon: 'close', label: '', cls: 'merge-page-remove', onClick: () => removePage(pageKey(ref)) });
    for (const b of [earlier, later, rotate, remove]) b.dataset.rove = '';
    const el = h('div', { class: 'merge-row merge-page-row', 'aria-labelledby': `${textId} ${textId}-turned` },
      thumb.el,
      text, turned,
      h('div', { class: 'merge-moves' }, earlier, later),
      rotate, remove);
    return {
      el,
      handle: el,
      update(item, index, count) {
        ref = item;
        const input = byId(item.input);
        const n = index + 1;
        text.textContent = t('merge_page_line', n, input?.name ?? '', item.page + 1);
        const key = turnedKey(item.rotation);
        turned.textContent = key ? t(key) : '';
        earlier.setLabel(t('move_page_earlier', n));
        later.setLabel(t('move_page_later', n));
        setDisabled(earlier, index === 0, later);
        setDisabled(later, index === count - 1, earlier);
        rotate.setLabel(t('rotate_page_right', n));
        remove.setLabel(t('remove_page', n));
        thumb.setRotation(item.rotation ?? 0);
      },
      load() {
        const input = byId(ref.input);
        if (input) thumb.load((o) => input.src.thumbnail(ref.page, 55, { ...o, maxCssHeight: 72 }));
      },
      unload: () => thumb.unload(),
    };
  }

  /** Turns `b` off or on; the focus it had goes to `other`, as a button turned off can't keep it. */
  function setDisabled(b, off, other) {
    const focused = document.activeElement === b;
    b.disabled = off;
    if (focused && off && !other.disabled) other.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------------------------
  // Changes

  pages.onChange(() => {
    if (alive) render();
  });

  function setInputs(list) {
    inputs = list;
    // Each PDF's pages keep their order, turns and removals (followFileOrder).
    if (!pages.followOrder(inputs.map((i) => i.id))) render();
  }

  function sortInputs(reverse) {
    // Kotlin's sortedBy { it.name.lowercase() }: stable, by UTF-16 code units.
    const key = (i) => i.name.toLowerCase();
    const sorted = inputs.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    setInputs(reverse ? sorted.reverse() : sorted);
  }

  function removeInput(id) {
    const index = inputs.findIndex((i) => i.id === id);
    const input = inputs[index];
    if (!input) return;
    inputs = inputs.filter((i) => i.id !== id);
    if (!inputs.length) setName(defaultName);
    pages.dropInput(id);
    input.src.close();
    // The focus goes to the next file's Remove button, as the row with it has gone.
    const next = inputs[Math.min(index, inputs.length - 1)];
    if (next) fileList.rowOf(next.id)?.el.querySelector('.merge-file-remove')?.focus();
    // The last one gone, the list and Add PDFs are hidden: the "Add PDFs" card takes the focus.
    else empty.focus({ preventScroll: true });
  }

  function removePage(key) {
    const index = pages.indexOf(key);
    if (!pages.remove(key)) return;
    // The page that takes its place keeps the focus there, so several can go in a row.
    const next = pages.pages[Math.min(index, pages.length - 1)];
    if (next) pageList.rowOf(pageKey(next))?.el.querySelector('.merge-page-remove')?.focus();
    else resetButton.focus();
  }

  function setPageMode(on) {
    pageMode = on;
    render();
  }

  function setName(name) {
    fileName = name;
    nameField.setValue(name);
  }

  // -------------------------------------------------------------------------------------------
  // Adding PDFs

  async function pick() {
    if (importing || processing || !alive) return;
    const items = await pickFiles({ accept: 'pdf', multiple: true });
    if (items.length) await add(items);
  }

  /** Opens `items` one after another, asking for passwords in turn, and adds them at the end. */
  async function add(items) {
    if (!items?.length || importing || processing || !alive) return;
    importing = true;
    render();
    const refused = [];
    try {
      for (const item of items) {
        if (!alive) break;
        let src = null;
        try {
          // A password given on Choose a tool (item.password) is tried first.
          src = await openPdf(item, { signal: leaving.signal });
        } catch (error) {
          if (error instanceof CancelledError) break;
          refused.push({ name: item.name, error });
          continue;
        }
        // A password dialog cancelled leaves that PDF out, quietly.
        if (!src) continue;
        if (!alive) {
          src.close();
          break;
        }
        if (!src.pageCount) {
          src.close();
          refused.push({ name: item.name, error: new Error('No pages') });
          continue;
        }
        append(src);
      }
    } finally {
      if (alive) {
        importing = false;
        // One PDF picked is told about without its name.
        if (items.length === 1) refused.forEach((r) => snackbar(problemText(r.error, 'pdf_import_failed')));
        else if (refused.length) reportFileProblems(refused);
        render();
        // Add PDFs keeps the focus (it is only marked off meanwhile); the card picked from has
        // gone once PDFs are listed, so the focus goes to the switch above them.
        const a = document.activeElement;
        const lost = !a || a === document.body || !a.isConnected || empty.contains(a);
        if (inputs.length && lost) modeRow.focus({ preventScroll: true });
      }
    }
  }

  function append(src) {
    const input = { id: `f${++seq}`, name: src.name, size: src.size, pageCount: src.pageCount, src, bytes: src.bytes, password: src.password };
    const had = inputs.length > 0;
    inputs = [...inputs, input];
    // Merge's name doesn't depend on which PDF comes first; it starts afresh with the first one.
    if (!had) setName(defaultName);
    pages.insert(pagesOf([input]), null, { undoable: had });
  }

  // -------------------------------------------------------------------------------------------
  // Merging

  // Enough to merge; and not busy opening PDFs or making one.
  const enough = () => inputs.length >= 2 && (!pageMode || pages.length > 0);
  const ready = () => enough() && !importing && !processing;

  async function merge() {
    if (!ready()) return;
    processing = true;
    render();
    const sources = inputs.map((i) => ({ id: i.id, name: i.name, bytes: i.bytes, password: i.password || undefined }));
    const selected = pageMode ? enginePages(pages.pages) : null;
    // Leaving the tool stops the work, and takes its progress dialog away with it.
    const out = await runWithProgress(async (hooks) => {
      const engine = await loadEngine().catch(() => null);
      // Offline before the tool was ever used whole.
      if (!engine) throw new UserError('web_tool_load_failed', t('tool_merge'));
      return engine.mergePdfs(sources, { pages: selected, fileName }, hooks);
    }, { signal: leaving.signal });
    processing = false;
    if (!alive) return;
    render();
    if (out) result.show([out], { zipName: fileName, passwordRemoved: !!out.passwordRemoved });
  }

  function startOver() {
    for (const input of inputs) input.src.close();
    inputs = [];
    pageMode = false;
    pages.clearUndo();
    pages.set([]);
    setName(defaultName);
    render();
    empty.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  function render() {
    const has = inputs.length > 0;
    busy.hidden = !importing;
    empty.hidden = has;
    // Marked off rather than disabled, which would throw the keyboard focus out of it (to the
    // page itself, where a password dialog closing would leave it).
    setOff(empty, importing);
    pageDrop(has);
    content.hidden = !has;
    modeRow.setAttribute('aria-checked', String(pageMode));
    track.setAttribute('aria-checked', String(pageMode));
    hint.textContent = t(pageMode ? 'pdf_page_mode_hint' : 'pdf_file_mode_hint');
    setText(needTwo, inputs.length === 1 ? t('pdf_need_two') : '');
    filesSection.hidden = pageMode;
    fileList.setItems(inputs);
    pagesSection.hidden = !pageMode;
    if (pageMode && !fromList) pageList.setItems(pages.pages);
    setText(noPages, pageMode && !pages.length ? t('pdf_need_page') : '');
    setOff(addButton, importing);
    // While busy only marked off, so the focus stays on it (and comes back to it after Cancel).
    run.disabled = !enough();
    setOff(run, importing || processing);
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  render();
  if (ctx.files?.length) add(ctx.files);

  return {
    unmount() {
      alive = false;
      leaving.abort();
      pageDrop(false);
      empty.detachDrop?.();
      fileList.destroy();
      pageList.destroy();
      result.destroy();
      for (const input of inputs) input.src.close();
    },
    hasUnsavedWork() {
      if (result.showing) return !result.isSaved();
      // Merge's pages start as all its PDFs' pages, in order (hasUnsavedWork).
      return processing || !samePages(pages.pages, allPages());
    },
    onStep: (step) => result.onStep(step),
    // The state, for tests.
    get state() {
      return { inputs: inputs.map((i) => ({ id: i.id, name: i.name, pageCount: i.pageCount })), pages: pages.pages, pageMode, fileName, canUndo: pages.canUndo };
    },
  };
}
