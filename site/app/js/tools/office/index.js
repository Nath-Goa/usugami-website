// Word, PowerPoint, Excel and EPUB to PDF: one screen for the four tools (ctx.params.kind), ported
// from the office parts of the app's PdfToolScreen.kt, OfficeOptions.kt (DocumentInputCard,
// OfficeNote, BookPageOptions, SheetPageOptions, OfficeProgressDialog) and PdfToolsViewModel.kt
// (addDocuments, addShared, removeDocument, runConvertAll, processEach, reportFailures).
// Pick one or several files (or share them to the app), add more or remove one at any time, the
// choices for all of them (a book's page size; a workbook's paper, orientation, Fit columns to page
// width and Gridlines), the name each PDF gets, then "Convert 3 files to PDF", "PDF 2 of 5" while
// they are made one after another, and the result screen. One that can't be converted is named
// with the reason and the others are still made.
// Its classes start with "office-".
import { h, ensureCss, yieldToUI } from '../../core/dom.js';
import { t, tp, tWeb, hasString, formatSize, loadStrings } from '../../core/i18n.js';
import {
  topBar, button, bottomBar, emptyState, fileCard, textField, linearProgress, dropZone, snackbar,
  segmented, dropdown, switchRow, alertDialog, uid,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { showResult } from '../../core/output.js';
import { batchList, reportBatchFailures, BatchChoices } from '../../core/batch.js';
// pdfdoc.js loads pdf.js only when a PDF is opened, so the screen doesn't load it before a file is picked.
import { reportFileProblems } from '../../core/pdfdoc.js';
import { CancelledError, UserError } from '../../core/errors.js';
import { baseName, uniqueNames } from '../../core/names.js';
import { icon } from '../../core/icons.js';
// Only what the screen shows before a file is picked; the engine that checks and converts files
// (ZIP and XML reading, the converters and their libraries) is loaded meanwhile (see loadEngine).
import {
  OFFICE_KINDS, BOOK_PAGES, SHEET_PAPERS, SHEET_ORIENTATIONS, defaultOfficeOptions, officeErrorKey,
} from '../../engine/office/kinds.js';
import { OfficeNotRecognized } from '../../engine/office/problems.js';
import { officeProgressDialog } from './progress.js';

/** The office engine (engine/office/index.js), loaded once, again after a failure (offline). */
let engineLoading = null;
function loadEngine() {
  engineLoading ??= import(new URL('../../engine/office/index.js', import.meta.url).href).catch((e) => {
    engineLoading = null;
    throw e;
  });
  return engineLoading;
}

/** What each kind of file is called and shown with (OfficeOptions.kt, PdfToolScreen.kt). */
export const OFFICE_SCREENS = Object.freeze({
  word: Object.freeze({ pick: 'pick_word', add: 'add_word', document: 'document_word', note: 'office_note_word', icon: 'description' }),
  powerpoint: Object.freeze({ pick: 'pick_powerpoint', add: 'add_powerpoint', document: 'document_powerpoint', note: 'office_note_powerpoint', icon: 'slideshow' }),
  excel: Object.freeze({ pick: 'pick_excel', add: 'add_excel', document: 'document_excel', note: 'office_note_excel', icon: 'table_chart' }),
  epub: Object.freeze({ pick: 'pick_epub', add: 'add_epub', document: 'document_epub', note: 'office_note_epub', icon: 'auto_stories' }),
});

/** What several PDFs made together are called, as a ZIP file of them is (runConvertAll). */
export const BATCH_NAME = 'Converted_PDFs';

/**
 * The names (without .pdf) the PDFs made of `documents` get: each the one typed for it (`typed`,
 * matching `documents`; null or missing: the file's own name, "Report.docx" becoming "Report"),
 * made safe and told apart when two ask for one name, as OfficeConverter.convertEach names them. A
 * blank name becomes the kind's (Document, Presentation, Spreadsheet, Book).
 * @example officeNames([{ name: 'a.docx' }, { name: 'b.docx' }], 'word', ['Plan', 'plan'])  // ['Plan', 'plan (2)']
 */
export function officeNames(documents, kind, typed = []) {
  const wanted = documents.map((d, i) => typed?.[i] ?? baseName(d?.name ?? ''));
  return uniqueNames(wanted, OFFICE_KINDS[kind]?.fallbackName ?? 'Document');
}

/**
 * The key a message about `error` (from verifyOfficeFile or convertOffice) is said with, for a
 * file of `kind`: the app's, or the web app's where the app says "on a phone".
 */
export function messageKey(error, kind, many = false) {
  const key = officeErrorKey(error, kind, many);
  return hasString('web_' + key) ? 'web_' + key : key;
}

/**
 * `error` as the kit's batch messages take it: a UserError whose key is the web app's wording
 * where it has one, or a plain Error for a file that failed for no reason of its own ("Couldn't
 * process name. Check the file and free storage.", as the app names those).
 */
function reportable(error, kind) {
  if (!(error instanceof UserError) || (error.key === 'office_convert_failed' && !error.problem)) {
    const plain = new Error('Conversion failed');
    plain.cause = error;
    return plain;
  }
  const key = messageKey(error, kind);
  if (key === error.key) return error;
  const e = new UserError(key, ...error.args);
  e.cause = error;
  return e;
}

/**
 * Turns a control off for a moment without `disabled`, which would throw the keyboard focus out of
 * it (the button just pressed, say); its click handler checks for itself.
 */
function setOff(el, off) {
  if (off) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

/** Where the PDF tools show a PDF's first page: a file to convert has none until it is converted (DocumentIcon). */
function documentIcon(kind) {
  return h('span', { class: 'office-doc-icon', 'aria-hidden': 'true' }, icon(OFFICE_SCREENS[kind].icon, { size: 32 }));
}

/**
 * Renders Word, PowerPoint, Excel or EPUB to PDF into ctx.root (ctx.params.kind: 'word',
 * 'powerpoint', 'excel' or 'epub') and returns the router's handle.
 */
export async function mount(ctx) {
  const kind = ctx.params?.kind ?? ctx.tool?.params?.kind;
  const info = OFFICE_SCREENS[kind];
  const officeKind = OFFICE_KINDS[kind];
  if (!info || !officeKind) throw new RangeError(`Unknown kind of document: ${kind}`);
  await Promise.all([loadStrings('office'), ensureCss(new URL('./office.css', import.meta.url))]);

  /** The files picked, in order: { id, item (a FileItem), name, size }. */
  let documents = [];
  let nextId = 1;
  // The names typed for them, by id (BatchChoices: its choice isn't used here).
  let choices = new BatchChoices([], 0);
  // The choices for all of them, for as long as the screen shows (rememberSaveable in the app).
  const options = defaultOfficeOptions(kind);
  let importing = 0;
  let adding = Promise.resolve();
  // Starting over abandons the files still being checked (PdfToolsViewModel's importGeneration).
  let generation = 0;
  let importStop = new AbortController();
  let processing = false;
  let closed = false;
  let resultEl = null;
  let lastResult = null;
  let stepPushed = false;
  // Stops the run when the screen goes (the run's own Cancel is the progress dialog's).
  let leaving = null;
  // Files shared to the app while it converts, or while a result not saved yet shows and the user
  // chose to keep it: they wait (see receiveFiles).
  let waiting = [];

  // The engine and the kind's converter are loaded while files are picked, so they are there
  // when a file is checked and the button is pressed (convertOffice imports the same module); the
  // empty screen shows without waiting for them. Failing to load (offline before they were saved
  // for offline use) is said as such, not as a problem with the file.
  let converter = null;
  const loadConverter = () => {
    converter ??= import(new URL(officeKind.module, new URL('../../engine/office/', import.meta.url)).href).catch((e) => {
      converter = null;
      throw e;
    });
    return converter;
  };
  loadEngine().catch(() => { /* tried again when a file is added */ });
  loadConverter().catch(() => { /* tried again when the button is pressed */ });
  const toolName = () => t(ctx.tool?.title ?? `tool_${kind}`);

  const documentOf = (id) => documents.find((d) => d.id === id);
  const nameOf = (id) => choices.nameOf(id) ?? baseName(documentOf(id)?.name ?? '');
  // "Word document · 25 kB" (documentDetails).
  const details = (d) => t('result_details', t(info.document), formatSize(d.size));

  // ---- The editing screen's parts, made once and put in place as the files come and go ----

  const bar = topBar({ title: t(ctx.tool?.title ?? `tool_${kind}`), onBack: () => ctx.back() });
  const progress = linearProgress({ value: null, label: t('web_opening_files') });
  progress.classList.add('office-progress');
  const content = h('div', { class: 'office-content' });
  // The screen's main landmark, which the app's "Skip to content" link moves to.
  const page = h('main', { class: 'page office-page', 'data-main': '' }, progress, content);
  const runButton = button({ label: t('convert'), onClick: () => run(), cls: 'office-run' });
  const bottom = bottomBar(runButton);

  // Every file is taken and checked: one of another kind is named with the reason, as when picked.
  const takeAll = () => true;
  const empty = emptyState({
    icon: 'add',
    title: t(info.pick),
    detail: t('pick_several_hint'),
    onClick: () => pick(),
    onFiles: (items) => add(items),
    accept: takeAll,
  });
  // One "Add Word files" button, under the card of one file and after the list of several, so it
  // keeps the focus when a second file turns the card into the list.
  const addButton = button({ label: t(info.add), variant: 'outlined', cls: 'office-add', onClick: () => pick() });

  // What converts, and what changes (OfficeNote), then the kind's choices for all files.
  const note = h('p', { class: 'office-note' }, tWeb(info.note));
  const optionParts = [];
  let refreshOptions = () => {};
  if (kind === 'epub') {
    // BookPageOptions: "Page size", A5 or A4, and what each suits.
    const headingId = uid('office-page');
    const heading = h('h2', { class: 'office-heading', id: headingId }, t('option_page_size'));
    const sizes = segmented({
      options: BOOK_PAGES.map((p) => ({ value: p.value, label: t(p.label) })),
      value: options.bookPage,
      labelledBy: headingId,
      onChange: (v) => { options.bookPage = v; },
    });
    sizes.classList.add('office-book-page');
    optionParts.push(heading, sizes, h('p', { class: 'office-detail' }, t('book_page_note')));
  } else if (kind === 'excel') {
    // SheetPageOptions: paper and orientation chips (as each sheet says, or one for all), then the two switches.
    const asFile = t('sheet_as_file');
    const paper = dropdown({
      label: t('option_page_size'),
      options: SHEET_PAPERS.map((p) => ({ value: p.value, label: t(p.label) })),
      value: options.paper,
      onChange: (v) => { options.paper = v; },
    });
    const orientation = dropdown({
      label: t('option_orientation'),
      options: SHEET_ORIENTATIONS.map((o) => ({ value: o.value, label: o.value == null ? asFile : t(o.label) })),
      value: options.landscape,
      onChange: (v) => { options.landscape = v; },
    });
    const fit = switchRow({
      label: t('sheet_fit_width'),
      detail: t(options.fitWidth ? 'sheet_fit_width_on' : 'sheet_fit_width_off'),
      checked: options.fitWidth,
      onChange: (b) => {
        options.fitWidth = b;
        fit.setDetail(t(b ? 'sheet_fit_width_on' : 'sheet_fit_width_off'));
      },
    });
    const grid = switchRow({
      label: t('sheet_gridlines'),
      detail: t('sheet_gridlines_detail'),
      checked: options.gridlines,
      onChange: (b) => { options.gridlines = b; },
    });
    optionParts.push(h('div', { class: 'office-sheet' }, h('div', { class: 'office-chips' }, paper, orientation), fit, grid));
    refreshOptions = () => {
      paper.setValue(options.paper);
      orientation.setValue(options.landscape);
      fit.setChecked(options.fitWidth);
      fit.setDetail(t(options.fitWidth ? 'sheet_fit_width_on' : 'sheet_fit_width_off'));
      grid.setChecked(options.gridlines);
    };
  }

  // One file: its card (Remove starts over) and the name its PDF gets, made for each file anew.
  let single = null;
  // Several: the app's BatchList, each card with the name its PDF gets.
  let list = null;
  const listItems = new Map();
  let detachDrop = null;

  const singleFor = (d) => {
    if (single?.id === d.id) return single;
    const card = fileCard({
      name: d.name,
      detail: details(d),
      thumbnail: documentIcon(kind),
      placeholderIcon: info.icon,
      onRemove: () => startOver(),
    });
    card.classList.add('office-card');
    const name = textField({
      label: t('file_name'),
      value: nameOf(d.id),
      suffix: '.pdf',
      onInput: (v) => { choices = choices.withName(d.id, v); },
    });
    name.classList.add('office-name');
    single = { id: d.id, card, name };
    return single;
  };

  const itemFor = (d) => {
    let item = listItems.get(d.id);
    if (!item) {
      item = { id: d.id, name: d.name, detail: details(d), thumbnail: documentIcon(kind), icon: info.icon };
      listItems.set(d.id, item);
    }
    return item;
  };

  const ensureList = () => {
    list ??= batchList({
      items: [],
      nameOf,
      onRename: (id, v) => { choices = choices.withName(id, v); },
      onRemove: (id) => remove(id),
    });
    list.classList.add('office-list');
    return list;
  };

  /**
   * Makes `children` the children of `parent`, moving nothing that is in place already: a node
   * taken out of the page, even for a moment, loses the focus.
   */
  const place = (parent, children) => {
    const now = [...parent.children];
    if (now.length === children.length && now.every((n, i) => n === children[i])) return;
    for (const n of now) if (!children.includes(n)) n.remove();
    children.forEach((child, i) => {
      if (parent.children[i] !== child) parent.insertBefore(child, parent.children[i] ?? null);
    });
  };

  /** Puts the parts in place for the files there are now, as the app's screen lays them out. */
  const arrange = () => {
    if (closed || resultEl) return;
    const focused = content.contains(document.activeElement) ? document.activeElement : null;
    progress.hidden = !importing;
    // Picking is off while files are being added, as in the app (off, but keeping the focus).
    setOff(empty, !!importing);
    setOff(addButton, !!importing);
    const count = documents.length;
    content.classList.toggle('office-content--empty', !count);
    content.classList.toggle('office-content--one', count === 1);
    content.classList.toggle('office-content--many', count > 1);
    if (!count) {
      place(content, [empty]);
    } else if (count === 1) {
      // The file, a button to add more (to convert all of them at once), what converts, the
      // choices, and the name its PDF gets.
      const one = singleFor(documents[0]);
      place(content, [one.card, addButton, note, ...optionParts, one.name]);
    } else {
      // What goes for all of them comes first, then each with the name its PDF gets.
      ensureList().setItems(documents.map(itemFor));
      place(content, [note, ...optionParts, list, addButton]);
    }
    // Files dropped or pasted on the screen are added too (the empty state takes its own).
    if (count && !detachDrop) detachDrop = dropZone(page, { accept: takeAll, multiple: true, onFiles: (items) => add(items) });
    else if (!count && detachDrop) {
      detachDrop();
      detachDrop = null;
    }
    for (const id of [...listItems.keys()]) if (!documents.some((d) => d.id === id)) listItems.delete(id);
    if (single && !documents.some((d) => d.id === single.id)) single = null;
    if (list && count < 2) list.setItems([]);
    // A control moved keeps the focus; one removed leaves it to the next sensible place.
    if (focused && document.activeElement !== focused) {
      if (focused.isConnected && content.contains(focused) && !focused.disabled) focused.focus({ preventScroll: true });
      else if (!content.contains(document.activeElement)) {
        const next = content.querySelector('.ui-file-card .ui-file-head .ui-icon-btn') ?? (addButton.isConnected ? addButton : null) ?? empty;
        next.focus({ preventScroll: true });
      }
    }
    refreshButton();
  };

  const refreshButton = () => {
    const count = documents.length;
    runButton.setLabel(count > 1 ? tp('convert_many', count) : t('convert'));
    runButton.disabled = !count;
    // Off for a moment while files are checked or converted, keeping the focus to come back to it.
    setOff(runButton, !!importing || processing);
  };

  /**
   * Snackbars show above the bottom bar while it is there, as the app's Scaffold puts them (the
   * bar's own room for the phone's gesture bar is counted by the snackbar already).
   */
  const liftSnackbars = (on) => {
    const style = document.documentElement.style;
    if (!on) {
      style.removeProperty('--snackbar-offset');
      return;
    }
    const computed = getComputedStyle(bottom);
    const extra = parseFloat(computed.paddingBottom) - parseFloat(computed.paddingTop);
    style.setProperty('--snackbar-offset', `${Math.max(0, bottom.offsetHeight - Math.max(0, extra))}px`);
  };

  const showEditing = () => {
    if (closed) return;
    if (resultEl) {
      resultEl.destroy();
      resultEl = null;
    }
    ctx.root.replaceChildren(bar, page, bottom);
    choices = choices.following(documents.map((d) => d.id));
    if (single) single.name.setValue(nameOf(single.id));
    list?.refreshNames();
    refreshOptions();
    arrange();
    liftSnackbars(true);
    // Files shared while the result showed join the list now (the app adds them once it has gone).
    if (waiting.length && !processing) {
      const files = waiting;
      waiting = [];
      add(files);
    }
  };

  // ---- Files ----

  const pick = async () => {
    if (importing || processing) return;
    const items = await pickFiles({ accept: officeKind.accept, multiple: true });
    if (items.length) await add(items);
  };

  /** Adds `items` once those being added before are in (a drop while others are checked waits its turn). */
  const add = (items) => {
    if (closed || !items?.length) return adding;
    importing++;
    arrange();
    const mine = generation;
    adding = adding.then(() => addNow(items, mine)).catch(() => {}).finally(() => {
      importing--;
      arrange();
    });
    return adding;
  };

  /**
   * Checks `items` one after another, as the app does when files are picked (OfficeConverter.verify),
   * each joining the list once it passes. Those that can't be converted are left out and named
   * once all are tried, those with the same reason together; one picked alone is told about
   * without its name (addDocuments).
   */
  const addNow = async (items, mine) => {
    const failed = [];
    const abandoned = () => closed || mine !== generation;
    let engine;
    try {
      engine = await loadEngine();
    } catch {
      // Offline before the engine was saved for offline use: said as such, not as a problem with the files.
      if (!abandoned()) snackbar(t('web_tool_load_failed', toolName()));
      return;
    }
    for (const item of items) {
      if (abandoned()) return;
      const name = item.name || `${officeKind.fallbackName}.${officeKind.extension}`;
      try {
        await engine.verifyOfficeFile(kind, item, { signal: importStop.signal });
        if (abandoned()) return;
        documents.push({ id: nextId++, item, name, size: item.size ?? item.bytes?.length ?? 0 });
        choices = choices.following(documents.map((d) => d.id));
        arrange();
      } catch (error) {
        if (error instanceof CancelledError || abandoned()) return;
        failed.push({ name, error: reportable(error, kind) });
      }
      await yieldToUI();
    }
    if (abandoned() || !failed.length) return;
    if (items.length === 1) {
      const e = failed[0].error;
      snackbar(e instanceof UserError ? t(e.key, ...e.args) : t(officeErrorKey(new OfficeNotRecognized(), kind)));
    } else {
      reportFileProblems(failed, { fallback: officeErrorKey(new OfficeNotRecognized(), kind) });
    }
  };

  /** Puts away file `id` (removeDocument). */
  const remove = (id) => {
    const at = documents.findIndex((d) => d.id === id);
    if (at < 0 || processing) return;
    documents.splice(at, 1);
    choices = choices.following(documents.map((d) => d.id));
    arrange();
  };

  /** Puts every file away, and those still being checked (startOver). */
  const startOver = () => {
    generation++;
    importStop.abort();
    importStop = new AbortController();
    documents = [];
    choices = choices.following([]);
    lastResult = null;
    arrange();
  };

  // ---- Converting ----

  const run = async () => {
    if (processing || importing || !documents.length || closed) return;
    const taken = documents.slice();
    const many = taken.length > 1;
    // Each into a PDF of its own name, two asking for one told apart: "Report" and "Report (2)".
    const names = officeNames(taken, kind, taken.map((d) => choices.nameOf(d.id)));
    const chosen = { ...options };
    processing = true;
    refreshButton();
    let engine;
    try {
      engine = await loadEngine();
      await loadConverter();
    } catch {
      processing = false;
      refreshButton();
      if (!closed) snackbar(t('web_tool_load_failed', toolName()));
      return;
    }
    if (closed) return;
    leaving = new AbortController();
    const stop = leaving.signal;
    const dialog = officeProgressDialog({ kind, many, onCancel: () => leaving?.abort() });
    const outputs = [];
    const failures = [];
    let cancelled = false;
    try {
      for (let i = 0; i < taken.length; i++) {
        if (stop.aborted) throw new CancelledError();
        if (many) dialog.next(i + 1, taken.length, taken[i].name);
        try {
          const out = await engine.convertOffice(kind, taken[i].item, { ...chosen, name: names[i] }, {
            signal: stop,
            onProgress: (done, total, more) => dialog.progress(done, total, more),
          });
          if (stop.aborted) throw new CancelledError();
          outputs.push(out);
        } catch (error) {
          if (error instanceof CancelledError || error?.name === 'CancelledError' || stop.aborted) throw new CancelledError();
          failures.push({ item: { name: taken[i].name }, error: reportable(error, kind) });
        }
        await yieldToUI();
      }
      // Cancelled once the last was made, before they show: nothing is made, as in the app.
      if (stop.aborted) throw new CancelledError();
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      cancelled = true;
    } finally {
      await dialog.close();
      processing = false;
      leaving = null;
      refreshButton();
    }
    if (closed) return;
    if (cancelled) {
      // Cancelled: nothing made, nothing said; shared files that waited join the list.
      takeWaiting();
      return;
    }
    if (outputs.length) {
      lastResult = { files: outputs, zipName: many ? BATCH_NAME : names[0] };
      showOutputs();
      ctx.pushStep?.('result');
      stepPushed = !!ctx.pushStep;
    }
    // Once the result shows, those that couldn't be made are named, each with its reason.
    reportBatchFailures(failures, { many, fallback: 'office_convert_failed' });
    if (!outputs.length) runButton.focus({ preventScroll: true });
    takeWaiting();
  };

  const showOutputs = () => {
    resultEl?.destroy();
    liftSnackbars(false);
    resultEl = showResult(ctx.root, {
      ...lastResult,
      onBack: () => backToEditing(),
      onStartOver: () => {
        startOver();
        backToEditing();
      },
    });
  };

  const backToEditing = () => {
    const pushed = stepPushed;
    stepPushed = false;
    showEditing();
    if (pushed) ctx.popStep?.();
  };

  // ---- Files shared to the app while this screen shows ----

  /**
   * As the app takes files shared while its tool shows: added to the list; while converting, they
   * wait ("The files you shared will open once this is done."); over a result, the tool starts
   * afresh with them, asking first while the result isn't saved (Keep: they wait until the result
   * has gone).
   */
  const receive = async (files) => {
    if (closed || !files?.length) return;
    if (processing) {
      if (!waiting.length) snackbar(t('share_waits'));
      waiting.push(...files);
      return;
    }
    if (!resultEl) {
      await add(files);
      return;
    }
    if (!resultEl.isSaved()) {
      const discard = await alertDialog({
        title: t('pdf_discard_title'),
        message: t('share_discard_body'),
        confirm: t('discard'),
        dismiss: t('keep'),
        destructive: true,
      });
      if (closed) return;
      if (!discard || !resultEl) {
        if (resultEl) waiting.push(...files);
        else await add(files);
        return;
      }
    }
    startOver();
    backToEditing();
    await add(files);
  };

  /** After a run: files shared meanwhile are taken as they would have been then. */
  const takeWaiting = () => {
    if (!waiting.length) return;
    const files = waiting;
    waiting = [];
    receive(files);
  };

  showEditing();
  // Opened on the result's step (a reload there): the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();
  if (ctx.files?.length) add(ctx.files);

  return {
    unmount() {
      closed = true;
      leaving?.abort();
      importStop.abort();
      liftSnackbars(false);
      detachDrop?.();
      empty.detachDrop?.();
      resultEl?.destroy();
      // Leaving the tool the shared files were waiting for, the user doesn't want them any more (exitTool).
      waiting = [];
      documents = [];
    },
    hasUnsavedWork() {
      // As the app: a result not saved yet; the files and choices alone aren't work to lose. While
      // the PDFs are being made the app ignores Back; here leaving asks first, and stops the run.
      return processing || (!!resultEl && !resultEl.isSaved());
    },
    /**
     * The router's step, as the other tools take it: the browser's Back from the result returns to
     * the files; Forward shows the result left with Back again, and one that has gone (Start over,
     * a run since) goes back to where it was.
     */
    onStep(step) {
      if (step == null) {
        stepPushed = false;
        if (resultEl) showEditing();
      } else if (resultEl) {
        stepPushed = true;
      } else if (lastResult && !processing) {
        stepPushed = true;
        showOutputs();
      } else {
        ctx.popStep?.();
      }
    },
    receiveFiles: (files) => receive(files),
    /** For tests: the files listed, the names their PDFs get, and the choices for all. */
    get state() {
      return {
        kind,
        documents: documents.map((d) => ({ id: d.id, name: d.name, outputName: nameOf(d.id) })),
        options: { ...options },
        importing: importing > 0,
        processing,
        result: !!resultEl,
      };
    },
  };
}
