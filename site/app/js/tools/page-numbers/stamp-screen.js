// The screen Add page numbers and Add watermark share (the batch-tool parts of PdfToolScreen.kt
// and PdfToolsViewModel.kt): pick one or several PDFs, the tool's choices, the name each new PDF
// gets, the main button, "PDF 2 of 5" while they are made, then the result screen. Each tool gives
// its own choices and how to run it. Its classes start with "stamps-", after the engine both use.
import { h, ensureCss, isWide, onWideChange } from '../../core/dom.js';
import { t, tp, formatSize } from '../../core/i18n.js';
import {
  topBar, button, bottomBar, emptyState, fileCard, textField, linearProgress, dropZone, snackbar,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf, reportFileProblems, preloadPdfJs } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { batchList, runBatch, BatchChoices } from '../../core/batch.js';
import { CancelledError, UserError } from '../../core/errors.js';
import { defaultName, outputNames, BATCH_NAMES } from '../../engine/stamps-layout.js';

/** The engines (with pdf-lib and the text engine), loaded once a PDF is added rather than with the screen. */
let engine = null;

/** Loads engine/stamps.js (once; again after a failure, back online say). */
export function loadStampsEngine() {
  engine ??= import('../../engine/stamps.js').catch((e) => {
    engine = null;
    throw e;
  });
  return engine;
}

/**
 * Turns a control off for a moment without `disabled`, which would throw the keyboard focus out of
 * it (the button just pressed, say); its click handler checks for itself.
 */
function setOff(el, off) {
  if (!el) return;
  if (off) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

/**
 * Mounts a batch stamp tool into ctx.root and returns its handle.
 * @param {object} ctx the router's mount context
 * @param {object} spec
 * @param {'page-numbers'|'watermark'} spec.id
 * @param {string} spec.action        the main button's string key ("Add page numbers")
 * @param {string} spec.actionMany    its plural for several PDFs ("Add page numbers to 3 PDFs")
 * @param {string} spec.forAllHint    the line saying the choices go for every PDF
 * @param {(hooks: { changed: () => void }) => { el: HTMLElement, ready(): boolean, setSource?(src): void, destroy?(): void }} spec.options
 *   the tool's choices; `changed()` tells the screen to look at ready() again
 * @param {(sources: PdfSource[]) => Promise<null | ((src, index, name, hooks) => Promise<OutputFile>)>} spec.prepare
 *   checks the choices (saying what is wrong and giving null) and returns how to make each PDF
 */
export async function mountStampTool(ctx, spec) {
  // pdf.js (about 460 kB) loads while a PDF is being chosen; pdfdoc.js imports it only on demand.
  preloadPdfJs();
  await ensureCss(new URL('./stamp-screen.css', import.meta.url));

  /** The PDFs picked, in order: { id, src } (src a PdfSource). */
  let sources = [];
  let choices = new BatchChoices([], 0);
  let importing = 0;
  let processing = false;
  let closed = false;
  let resultEl = null;
  let lastResult = null;
  let stepPushed = false;
  // Leaving the tool stops a run under way (the progress dialog closes with it).
  const leaving = new AbortController();

  const nameOf = (id) => choices.nameOf(id) ?? defaultName(spec.id, sources.find((s) => s.id === id)?.src);
  const details = (src) => t('result_details', tp('page_count', src.pageCount), formatSize(src.size));

  const options = spec.options({ changed: () => refreshButton() });

  // ---- The editing screen's parts, made once and moved about as the PDFs come and go ----

  const bar = topBar({ title: t(ctx.tool.title), onBack: () => ctx.back() });
  const progress = linearProgress({ value: null, label: t('web_opening_pdfs') });
  progress.classList.add('stamps-progress');
  const content = h('div', { class: 'stamps-content' });
  // The screen's main landmark, which the skip link goes to.
  const page = h('main', { class: 'page stamps-page', 'data-main': '' }, progress, content);
  const runButton = button({ label: t(spec.action), onClick: () => run() });
  const bottom = bottomBar(runButton);
  bottom.classList.add('stamps-bottombar');

  const empty = emptyState({
    icon: 'add',
    title: t('pick_pdfs'),
    detail: t('pick_several_hint'),
    onClick: () => pick(),
    onFiles: (items) => add(items),
    accept: 'pdf',
  });
  const addButton = button({ label: t('add_pdfs'), variant: 'outlined', cls: 'stamps-add', onClick: () => pick() });
  const hint = h('p', { class: 'stamps-hint' }, t(spec.forAllHint));

  // One PDF: its card (Remove starts over) and the name its PDF gets, made for each PDF anew.
  let single = null;
  // Several: the app's BatchList, each card with its name field, and Add PDFs after them.
  let list = null;
  /** The PDFs the list shows, in its order, so a card can be told by its place. */
  let listOrder = [];
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
    const name = textField({
      label: t('file_name'),
      value: nameOf(entry.id),
      suffix: '.pdf',
      onInput: (v) => { choices = choices.withName(entry.id, v); },
    });
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
      onAdd: () => pick(),
      addLabel: t('add_pdfs'),
    });
    return list;
  };

  const filesPane = h('div', { class: 'stamps-pane' });
  const optionsPane = h('div', { class: 'stamps-pane' });

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

  /** The PDF whose name field `el` is in (the one-PDF field or a card's), or null. */
  const nameOwner = (el) => {
    if (single?.name.contains(el)) return single.id;
    if (!list?.contains(el)) return null;
    const cards = [...list.querySelectorAll('.ui-batch-item')];
    const at = cards.findIndex((c) => c.contains(el));
    return at >= 0 && el.tagName === 'INPUT' ? listOrder[at] ?? null : null;
  };

  /** The name field of PDF `id` as laid out now. */
  const nameInputOf = (id) => {
    if (sources.length === 1) return single?.id === id ? single.name.input : null;
    const at = sources.findIndex((x) => x.id === id);
    return at >= 0 ? list?.querySelectorAll('.ui-batch-item')[at]?.querySelector('input') ?? null : null;
  };

  /** Puts the parts in place for the PDFs there are now, as the app's screen lays them out. */
  const arrange = () => {
    if (closed || resultEl) return;
    // What has the focus keeps it (PDFs added while a name is typed, say), as in the app.
    const active = document.activeElement;
    const hadFocus = content.contains(active);
    const typingFor = hadFocus ? nameOwner(active) : null;
    progress.hidden = !importing;
    // Off while PDFs open, but still in the focus order: `disabled` would throw the focus out of the
    // button just pressed, and a cancelled password dialog would have nowhere to give it back.
    setOff(empty, !!importing);
    setOff(addButton, !!importing);
    setOff(list?.querySelector('.ui-batch-add'), !!importing);
    const wide = isWide();
    const count = sources.length;
    options.setSource?.(sources[0]?.src ?? null);
    content.classList.toggle('stamps-content--empty', !count);
    // The main button lines up with the column above it (the kit's --ui-column).
    bottom.classList.toggle('stamps-bottombar--empty', !count);
    content.classList.toggle('stamps-content--panes', !!count && wide);
    if (!count) {
      place(content, [empty]);
    } else if (count === 1) {
      const one = singleFor(sources[0]);
      // The name the PDF will get, which may have been changed in the list meanwhile.
      if (document.activeElement !== one.name.input) one.name.setValue(nameOf(one.id));
      if (wide) {
        // The PDF and its name on one side, the choices on the other.
        place(filesPane, [one.card, addButton, one.name]);
        place(optionsPane, [options.el]);
        place(content, [filesPane, optionsPane]);
      } else {
        place(content, [one.card, addButton, options.el, one.name]);
      }
    } else {
      // What goes for all of them comes first, then each with the name its PDF gets.
      ensureList().setItems(sources.map(itemFor));
      listOrder = sources.map((x) => x.id);
      // The names the PDFs will get (one may have been typed in the one-PDF field); the field being
      // typed in is left alone.
      list.refreshNames();
      if (wide) {
        place(filesPane, [list]);
        place(optionsPane, [options.el, hint]);
        place(content, [filesPane, optionsPane]);
      } else {
        place(content, [options.el, hint, list]);
      }
    }
    // Files dropped or pasted on the screen are added too (the empty state takes its own).
    if (count && !detachDrop) detachDrop = dropZone(page, { accept: 'pdf', multiple: true, onFiles: (items) => add(items) });
    else if (!count && detachDrop) { detachDrop(); detachDrop = null; }
    for (const id of [...listItems.keys()]) if (!sources.some((s) => s.id === id)) listItems.delete(id);
    if (single && !sources.some((s) => s.id === single.id)) single = null;
    if (hadFocus && document.activeElement !== active) {
      if (active.isConnected && content.contains(active)) {
        // Put back after being moved: typing goes on there.
        active.focus({ preventScroll: true });
      } else if (typingFor != null && nameInputOf(typingFor)) {
        // The one-PDF field became a card's, or the other way: the same PDF's name, in its new
        // place, typing going on at its end.
        const input = nameInputOf(typingFor);
        input.focus({ preventScroll: true });
        input.setSelectionRange?.(input.value.length, input.value.length);
      } else if (!content.contains(document.activeElement)) {
        // A control removed with the focus in it (Choose PDFs once PDFs came): Add PDFs, or the
        // empty card. Never a Remove button, which the next Space would press.
        const next = count ? content.querySelector('.stamps-add, .ui-batch-add') : empty;
        next?.focus({ preventScroll: true });
      }
    }
    refreshButton();
  };

  const refreshButton = () => {
    const count = sources.length;
    runButton.setLabel(count > 1 ? tp(spec.actionMany, count) : t(spec.action));
    runButton.disabled = !count || !!importing || processing || !options.ready();
  };

  // The editing screen. Snackbars show above its bottom bar, as the app's Scaffold puts them: the
  // kit's snackbar measures the bar itself.
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

  /** Opens `items` one after another (passwords asked in turn) and adds those that open. */
  const add = async (items) => {
    if (closed || !items?.length) return;
    importing++;
    arrange();
    const failed = [];
    const opened = [];
    try {
      for (const item of items) {
        if (closed) break;
        try {
          // A PDF whose password was given on Choose a tool carries it, tried first; leaving takes
          // a password question still open away with it.
          const src = await openPdf(item, { signal: leaving.signal });
          if (src) opened.push(src);
        } catch (error) {
          if (error instanceof CancelledError) break;
          failed.push({ name: item.name, error });
        }
      }
    } finally {
      importing--;
    }
    if (closed) {
      for (const src of opened) src.close();
      return;
    }
    for (const src of opened) sources.push({ id: src.id, src });
    choices = choices.following(sources.map((s) => s.id));
    if (failed.length === 1 && items.length === 1) {
      // One PDF picked is told about without its name, as the app's addPdfs.
      const { error } = failed[0];
      snackbar(error instanceof UserError ? t(error.key, ...(error.args ?? [])) : t('pdf_import_failed'));
    } else if (failed.length) {
      reportFileProblems(failed);
    }
    arrange();
    // Loaded while the choices are made, so the main button doesn't wait for it.
    if (sources.length) loadStampsEngine().catch(() => {});
  };

  const remove = (id) => {
    const at = sources.findIndex((s) => s.id === id);
    if (at < 0) return;
    sources[at].src.close();
    sources.splice(at, 1);
    choices = choices.following(sources.map((s) => s.id));
    arrange();
  };

  const startOver = () => {
    for (const s of sources) s.src.close();
    sources = [];
    choices = choices.following([]);
    lastResult = null;
    arrange();
  };

  // ---- Making the PDFs ----

  const run = async () => {
    if (processing || importing || !sources.length || !options.ready()) return;
    const taken = sources.slice();
    const names = outputNames(spec.id, taken.map((s) => nameOf(s.id)));
    processing = true;
    refreshButton();
    let made;
    try {
      try {
        await loadStampsEngine();
      } catch {
        snackbar(t('web_tool_load_failed', t(ctx.tool.title)));
        return;
      }
      let work;
      try {
        work = await spec.prepare(taken.map((s) => s.src));
      } catch (e) {
        snackbar(e instanceof UserError ? t(e.key, ...e.args) : t('pdf_process_failed'));
        return;
      }
      if (!work || closed) return;
      made = await runBatch(
        taken.map((s) => ({ name: s.src.name, src: s.src })),
        (item, index, hooks) => work(item.src, index, names[index], { ...hooks, signal: either(hooks.signal, leaving.signal) }),
        { named: { page_numbers_all_skipped: 'batch_nothing_to_number' } },
      );
    } finally {
      processing = false;
      refreshButton();
    }
    if (closed || made.cancelled || !made.outputs.length) return;
    lastResult = {
      files: made.outputs,
      // Several are called together what a ZIP file of them is; one by its own name.
      zipName: taken.length > 1 ? BATCH_NAMES[spec.id] : names[0],
      passwordRemoved: taken.some((s) => !!s.src.password),
    };
    showOutputs();
    ctx.pushStep?.('result');
    stepPushed = !!ctx.pushStep;
  };

  const showOutputs = () => {
    resultEl?.destroy();
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

  const unwide = onWideChange(() => {
    if (resultEl || closed) return;
    arrange();
  });
  showEditing();
  // Opened on the result's step (a reload there): the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();
  if (ctx.files?.length) add(ctx.files);

  return {
    unmount() {
      closed = true;
      leaving.abort();
      unwide();
      detachDrop?.();
      empty.detachDrop?.();
      resultEl?.destroy();
      options.destroy?.();
      for (const s of sources) s.src.close();
      sources = [];
    },
    hasUnsavedWork() {
      // As the app: a result not saved yet; the choices alone aren't work to lose. While the PDFs
      // are being made the app ignores Back; here leaving asks first (as the other tools do), and
      // stops the run.
      return processing || (!!resultEl && !resultEl.isSaved());
    },
    onStep(step) {
      if (step == null) {
        stepPushed = false;
        if (resultEl) showEditing();
      } else if (resultEl) {
        stepPushed = true;
      } else if (lastResult) {
        // Forward to the result left with Back: it shows again.
        stepPushed = true;
        showOutputs();
      } else {
        // Forward to a result that has gone (Start over): back to where it was.
        ctx.popStep?.();
      }
    },
  };
}

/** A signal aborted when either of `a` and `b` is. */
function either(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const both = new AbortController();
  const stop = () => both.abort();
  if (a.aborted || b.aborted) stop();
  a.addEventListener('abort', stop, { once: true });
  b.addEventListener('abort', stop, { once: true });
  return both.signal;
}

/** A title over a group of choices ("Position", "Color"), named so the group can say it. */
export function optionHeading(text, id) {
  return h('h2', { class: 'stamps-heading', id }, text);
}
