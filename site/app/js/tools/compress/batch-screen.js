// The screen Compress PDF and Flatten PDF share: the batch parts of PdfToolScreen.kt (CompressBatch,
// CompressOptions, PdfBatchList, FlattenOptions), BatchList.kt and PdfToolsViewModel.kt (addPdfs,
// runCompressAll, runFlattenAll, processEach). Pick one or several PDFs, add more or remove one at any
// time, the tool's choices, the name each new PDF gets, the main button ("Compress 3 PDFs"), "PDF 2
// of 5" while they are made one after another, then the result screen and the app's messages.
// Its classes start with "compress-", after the folder it lives in.
import { h, ensureCss } from '../../core/dom.js';
import { t, tp, formatSize } from '../../core/i18n.js';
import {
  topBar, button, bottomBar, emptyState, fileCard, textField, linearProgress, dropZone, snackbar,
  segmented, uid,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf, reportFileProblems, preloadPdfJs } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { batchList, runBatch, BatchChoices } from '../../core/batch.js';
import { CancelledError, UserError } from '../../core/errors.js';
import { uniqueNames } from '../../core/names.js';

/**
 * Turns a control off for a moment without `disabled`, which would throw the keyboard focus out of
 * it (the button just pressed, say); its click handler checks for itself.
 */
function setOff(el, off) {
  if (off) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

/** A signal aborted when either `a` or `b` is. */
function eitherSignal(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const both = new AbortController();
  const stop = () => both.abort();
  if (a.aborted || b.aborted) stop();
  a.addEventListener('abort', stop, { once: true });
  b.addEventListener('abort', stop, { once: true });
  return both.signal;
}

/**
 * Mounts Compress PDF or Flatten PDF into ctx.root and returns the router's handle.
 * @param {object} ctx the router's mount context
 * @param {object} spec
 * @param {string} spec.id                 'compress' | 'flatten'
 * @param {string} spec.action             the main button for one PDF ("Compress PDF")
 * @param {string} spec.actionMany         its plural for several ("Compress 3 PDFs")
 * @param {(src) => string} spec.defaultName   the name a PDF's new PDF gets until another is typed
 * @param {string} spec.fallback           the name for one left blank ("Compressed")
 * @param {string} spec.batchName          what several are called together, as their ZIP file is
 * @param {() => Promise<object>} spec.engine  loads the engine module
 * @param {(engine, src, { name, choice }, hooks) => Promise<OutputFile>} spec.work  makes one PDF
 * @param {(engine, outcomes) => object[]} spec.notes  the messages after a run ({ key, count?, args })
 * @param {string} [spec.note]             a line saying what the tool does (Flatten PDF)
 * @param {object} [spec.choice]           a choice for all PDFs that one PDF can also have of its
 *   own (Compress PDF's level): { options: [{ value, label }], all, title, forAllTitle, note, forAllNote }
 */
export async function mountPdfBatchTool(ctx, spec) {
  // pdf.js (about 460 kB) loads while a PDF is being chosen; pdfdoc.js imports it only on demand.
  preloadPdfJs();
  await ensureCss(new URL('./compress.css', import.meta.url));

  /** The PDFs picked, in order: { id, src } (src a PdfSource). */
  let sources = [];
  let choices = new BatchChoices([], spec.choice?.all ?? 0);
  let importing = 0;
  let adding = Promise.resolve();
  // Changes when the PDFs being opened are abandoned (Start over), so those still opening stay out
  // (the app's importGeneration); `importStop`, aborted then and when the screen goes, closes a
  // password question they still ask.
  let generation = 0;
  let importStop = new AbortController();
  let processing = false;
  let closed = false;
  let resultEl = null;
  let lastResult = null;
  let stepPushed = false;
  // Aborted when the screen goes: stops a run (whose own Cancel is the progress dialog's).
  const leaving = new AbortController();

  // The engine is loaded while the PDFs are picked, so it is there when the button is pressed.
  let enginePromise = null;
  const engine = () => {
    enginePromise ??= spec.engine().catch((e) => {
      enginePromise = null;
      throw e;
    });
    return enginePromise;
  };
  engine().catch(() => { /* tried again when the button is pressed */ });

  const sourceOf = (id) => sources.find((s) => s.id === id)?.src;
  const nameOf = (id) => choices.nameOf(id) ?? spec.defaultName(sourceOf(id));
  const details = (src) => t('result_details', tp('page_count', src.pageCount), formatSize(src.size));

  // ---- The editing screen's parts, made once and put in place as the PDFs come and go ----

  const bar = topBar({ title: t(ctx.tool.title), onBack: () => ctx.back() });
  const progress = linearProgress({ value: null, label: t('web_opening_pdfs') });
  progress.classList.add('compress-progress');
  const content = h('div', { class: 'compress-content' });
  // The screen's main part, which "Skip to content" goes to (past the top bar).
  const page = h('main', { class: 'page compress-page', 'data-main': '' }, progress, content);
  const runButton = button({ label: t(spec.action), onClick: () => run(), cls: 'compress-run' });
  const bottom = bottomBar(runButton);

  const empty = emptyState({
    icon: 'add',
    title: t('pick_pdfs'),
    detail: t('pick_several_hint'),
    onClick: () => pick(),
    onFiles: (items) => add(items),
    accept: 'pdf',
  });
  // One "Add PDFs" button, under the card of one PDF and after the list of several, so it keeps
  // the focus when a second PDF turns the card into the list.
  const addButton = button({ label: t('add_pdfs'), variant: 'outlined', cls: 'compress-add', onClick: () => pick() });

  // What goes for every PDF: the choice for all (with its title and note), or the tool's note.
  const options = h('section', { class: 'compress-options' });
  let allChoice = null;
  let optionsTitle = null;
  let optionsNote = null;
  if (spec.choice) {
    const titleId = uid('compress-level');
    optionsTitle = h('h2', { class: 'compress-heading', id: titleId });
    allChoice = segmented({
      options: spec.choice.options,
      value: choices.all,
      labelledBy: titleId,
      onChange: (v) => setForAll(v),
    });
    optionsNote = h('p', { class: 'compress-note' });
    options.append(optionsTitle, allChoice, optionsNote);
  } else {
    options.append(h('p', { class: 'compress-text' }, spec.note ?? ''));
  }

  // One PDF: its card (Remove starts over) and the name its PDF gets, made for each PDF anew.
  let single = null;
  // Several: the app's BatchList, each card with its own choice and name.
  let list = null;
  const listItems = new Map();
  let detachDrop = null;

  const singleFor = (entry) => {
    if (single?.id === entry.id) return single;
    const card = fileCard({
      name: entry.src.name,
      detail: details(entry.src),
      thumbnail: entry.src.thumbnail(0, 58).catch(() => null),
      onRemove: () => startOver(),
    });
    card.classList.add('compress-card');
    const name = textField({
      label: t('file_name'),
      value: nameOf(entry.id),
      suffix: '.pdf',
      onInput: (v) => { choices = choices.withName(entry.id, v); },
    });
    name.classList.add('compress-name');
    single = { id: entry.id, card, name };
    return single;
  };

  const itemFor = (entry) => {
    let item = listItems.get(entry.id);
    if (!item) {
      item = { id: entry.id, name: entry.src.name, detail: details(entry.src), thumbnail: entry.src.thumbnail(0, 44).catch(() => null) };
      listItems.set(entry.id, item);
    }
    return item;
  };

  const ensureList = () => {
    list ??= batchList({
      items: [],
      nameOf,
      onRename: (id, v) => { choices = choices.withName(id, v); },
      onRemove: (id) => remove(id),
      choice: spec.choice ? {
        label: spec.choice.title,
        options: spec.choice.options,
        valueOf: (id) => choices.choiceOf(id),
        onChange: (id, v) => {
          choices = choices.withChoice(id, v);
          // None is chosen for all while the PDFs' levels differ.
          allChoice.setValue(choices.common);
        },
      } : undefined,
    });
    return list;
  };

  /** Every PDF, and those added later, get `v` (setBatchChoiceForAll). */
  const setForAll = (v) => {
    choices = choices.withAll(v);
    list?.refreshChoices();
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

  /** Puts the parts in place for the PDFs there are now, as the app's screen lays them out. */
  const arrange = () => {
    if (closed || resultEl) return;
    const focused = content.contains(document.activeElement) ? document.activeElement : null;
    progress.hidden = !importing;
    // Picking is off while PDFs are being added, as in the app (off, but keeping the focus).
    setOff(empty, !!importing);
    setOff(addButton, !!importing);
    const count = sources.length;
    content.classList.toggle('compress-content--empty', !count);
    content.classList.toggle('compress-content--one', count === 1);
    content.classList.toggle('compress-content--many', count > 1);
    options.classList.toggle('compress-options--many', count > 1);
    if (allChoice) {
      // One PDF: its own level, which a change gives every PDF (CompressOptions); several: the level
      // they all have, or none while they differ (CompressBatch).
      optionsTitle.textContent = count > 1 ? spec.choice.forAllTitle : spec.choice.title;
      optionsNote.textContent = count > 1 ? spec.choice.forAllNote : spec.choice.note;
      allChoice.setValue(count === 1 ? choices.choiceOf(sources[0].id) : choices.common);
    }
    if (!count) {
      place(content, [empty]);
    } else if (count === 1) {
      const one = singleFor(sources[0]);
      place(content, [one.card, addButton, options, one.name]);
    } else {
      // What goes for all of them comes first, then each with its own level and the name its PDF gets.
      ensureList().setItems(sources.map(itemFor));
      list.refreshChoices();
      place(content, [options, list, addButton]);
      // Back to one PDF, its card and name are made afresh, with the name it may have been given in
      // the list meanwhile (the app composes OutputNameField anew).
      single = null;
    }
    // Files dropped or pasted on the screen are added too (the empty state takes its own).
    if (count && !detachDrop) detachDrop = dropZone(page, { accept: 'pdf', multiple: true, onFiles: (items) => add(items) });
    else if (!count && detachDrop) {
      detachDrop();
      detachDrop = null;
    }
    for (const id of [...listItems.keys()]) if (!sources.some((s) => s.id === id)) listItems.delete(id);
    if (single && !sources.some((s) => s.id === single.id)) single = null;
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
    const count = sources.length;
    runButton.setLabel(count > 1 ? tp(spec.actionMany, count) : t(spec.action));
    runButton.disabled = !count;
    // Off for a moment while PDFs are opened or made, keeping the focus to come back to it.
    setOff(runButton, !!importing || processing);
  };

  // Snackbars show above the bottom bar while it is there, as the app's Scaffold puts them: the
  // kit lifts them above any .ui-bottombar on screen.
  const showEditing = () => {
    if (closed) return;
    if (resultEl) {
      resultEl.destroy();
      resultEl = null;
    }
    ctx.root.replaceChildren(bar, page, bottom);
    choices = choices.following(sources.map((s) => s.id));
    if (single) single.name.setValue(nameOf(single.id));
    list?.refreshNames();
    arrange();
  };

  // ---- Files ----

  const pick = async () => {
    if (importing || processing) return;
    const items = await pickFiles({ accept: 'pdf', multiple: true });
    if (items.length) await add(items);
  };

  /** Adds `items` once those being added before are in (a drop while opening others waits its turn). */
  const add = (items) => {
    if (closed || !items?.length) return adding;
    const gen = generation;
    const signal = importStop.signal;
    importing++;
    arrange();
    adding = adding.then(() => addNow(items, gen, signal)).catch(() => {}).finally(() => {
      // Abandoned, they no longer count: Start over has set the count for those to come.
      if (gen === generation) importing--;
      arrange();
    });
    return adding;
  };

  /**
   * Opens `items` one after another, each joining the list as soon as it is open (a locked one
   * asks for its password in turn; cancelled, it is left out quietly). Those that can't be opened
   * are left out and named once all are tried; one picked alone is told about without its name.
   * Abandoned (Start over, or the screen gone), the rest are left out and nothing is said, as the
   * app's import abandoned by startOver.
   */
  const addNow = async (items, gen, signal) => {
    const gone = () => closed || gen !== generation;
    const failed = [];
    for (const item of items) {
      if (gone()) return;
      try {
        // A PDF whose password was given on Choose a tool carries it, tried first; abandoning takes
        // a password question still open away with it.
        const src = await openPdf(item, { signal });
        if (!src) continue;
        if (gone()) {
          src.close();
          return;
        }
        sources.push({ id: src.id, src });
        choices = choices.following(sources.map((s) => s.id));
        arrange();
      } catch (error) {
        if (error instanceof CancelledError) break;
        failed.push({ name: item.name, error });
      }
    }
    if (gone() || !failed.length) return;
    if (items.length === 1) snackbar(failed[0].error instanceof UserError ? t(failed[0].error.key, ...failed[0].error.args) : t('pdf_import_failed'));
    else reportFileProblems(failed);
  };

  const remove = (id) => {
    const at = sources.findIndex((s) => s.id === id);
    if (at < 0 || processing) return;
    sources[at].src.close();
    sources.splice(at, 1);
    choices = choices.following(sources.map((s) => s.id));
    arrange();
  };

  const startOver = () => {
    // A PDF still being opened belongs to the PDFs put away: it is abandoned rather than added once
    // open, and picking is on again at once (PdfToolsViewModel.startOver).
    abandonImports();
    for (const s of sources) s.src.close();
    sources = [];
    choices = choices.following([]);
    lastResult = null;
    arrange();
  };

  const abandonImports = () => {
    generation++;
    importStop.abort();
    importStop = new AbortController();
    importing = 0;
  };

  // ---- Making the PDFs ----

  /** A message from the engine's notes, in words: its arguments may be messages themselves. */
  const say = (m) => {
    const args = (m.args ?? []).map((a) => (a && typeof a === 'object' && 'key' in a ? say(a) : a));
    return m.count !== undefined ? tp(m.key, m.count, ...args) : t(m.key, ...args);
  };

  const run = async () => {
    if (processing || importing || !sources.length || closed) return;
    const taken = sources.slice();
    // Two PDFs to be named alike are told apart: "Report" and "Report (2)" (compressEach, flattenEach).
    const names = uniqueNames(taken.map((s) => nameOf(s.id)), spec.fallback);
    const picked = taken.map((s) => choices.choiceOf(s.id));
    processing = true;
    refreshButton();
    const results = new Array(taken.length);
    let made;
    let mod;
    const stop = leaving.signal;
    try {
      try {
        mod = await engine();
      } catch {
        snackbar(t('web_tool_load_failed', t(ctx.tool.title)));
        return;
      }
      if (closed) return;
      made = await runBatch(
        taken.map((s) => ({ name: s.src.name, src: s.src })),
        async (item, index, hooks) => {
          if (stop.aborted) throw new CancelledError();
          const signal = eitherSignal(hooks.signal, stop);
          results[index] = await spec.work(mod, item.src, { name: names[index], choice: picked[index] }, { ...hooks, signal });
          return results[index];
        },
        // Said below in the app's own words for this tool, after the result shows.
        { report: false },
      );
    } finally {
      processing = false;
      refreshButton();
    }
    if (closed || !made || made.cancelled) return;
    const failures = new Map(made.failures.map((f) => [f.item.src, f.error]));
    // Each PDF's outcome, its PDF as the result screen has it (`shown`: the same PDFs in the same
    // order, with the Usugami watermark when it is on).
    const outcomesOf = (shown) => {
      const now = new Map(made.outputs.map((o, i) => [o, shown?.[i] ?? o]));
      return taken.map((s, i) => (failures.has(s.src)
        ? { name: s.src.name, error: failures.get(s.src) }
        : { name: s.src.name, result: now.get(results[i]) ?? results[i] }));
    };
    const tell = (shown) => {
      if (closed) return;
      for (const m of spec.notes(mod, outcomesOf(shown))) snackbar(say(m));
    };
    if (made.outputs.length) {
      lastResult = {
        files: made.outputs,
        // Several are called together what a ZIP file of them is; one by its own name.
        zipName: taken.length > 1 ? spec.batchName : names[0],
        passwordRemoved: taken.some((s) => !!s.src.password),
      };
      // Told of the PDFs as they come out, with the Usugami watermark when it is on (the app's
      // afterResult): Compress PDF doesn't keep a PDF as it was once the watermark goes on it,
      // which adds a little too, so one that came out no smaller says so.
      showOutputs(tell);
      ctx.pushStep?.('result');
      stepPushed = !!ctx.pushStep;
    } else {
      tell(null);
    }
  };

  /** Shows the result; `onReady` (only for a run just made) once its PDFs have the watermark the setting asks for. */
  const showOutputs = (onReady) => {
    resultEl?.destroy();
    resultEl = showResult(ctx.root, {
      ...lastResult,
      onReady,
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

  showEditing();
  // Opened on the result's step (a reload there): the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();
  if (ctx.files?.length) add(ctx.files);

  return {
    unmount() {
      closed = true;
      leaving.abort();
      importStop.abort();
      detachDrop?.();
      empty.detachDrop?.();
      resultEl?.destroy();
      for (const s of sources) s.src.close();
      sources = [];
    },
    hasUnsavedWork() {
      // As the app: a result not saved yet; the PDFs and choices alone aren't work to lose. While
      // the PDFs are being made the app ignores Back; here leaving asks first, and stops the run.
      return processing || (!!resultEl && !resultEl.isSaved());
    },
    onStep(step) {
      if (step == null && resultEl) {
        stepPushed = false;
        showEditing();
      } else if (step === 'result' && !resultEl && lastResult) {
        stepPushed = true;
        showOutputs();
      } else if (step === 'result' && !resultEl) {
        // Forward to a result put away (Start over) or lost with a reload: there is none to show.
        ctx.popStep?.();
      }
    },
    /** For tests: the PDFs listed and what each has. */
    get state() {
      return sources.map((s) => ({ id: s.id, name: s.src.name, outputName: nameOf(s.id), choice: choices.choiceOf(s.id) }));
    },
    /** For tests: resolves once the PDFs being opened are in, or left out (abandoned ones too). */
    get settled() {
      return adding;
    },
  };
}
