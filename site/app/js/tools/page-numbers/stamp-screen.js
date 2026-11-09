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
import { openPdf, reportFileProblems } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { batchList, runBatch, BatchChoices } from '../../core/batch.js';
import { CancelledError, UserError } from '../../core/errors.js';
import { defaultName, outputNames, BATCH_NAMES } from '../../engine/stamps.js';

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
  const page = h('div', { class: 'page stamps-page' }, progress, content);
  const runButton = button({ label: t(spec.action), onClick: () => run() });
  const bottom = bottomBar(runButton);

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

  /** Puts the parts in place for the PDFs there are now, as the app's screen lays them out. */
  const arrange = () => {
    if (closed || resultEl) return;
    const hadFocus = content.contains(document.activeElement);
    progress.hidden = !importing;
    empty.disabled = !!importing;
    addButton.disabled = !!importing;
    list?.setAddDisabled(!!importing);
    const wide = isWide();
    const count = sources.length;
    options.setSource?.(sources[0]?.src ?? null);
    content.classList.toggle('stamps-content--empty', !count);
    content.classList.toggle('stamps-content--panes', !!count && wide);
    if (!count) {
      place(content, [empty]);
    } else if (count === 1) {
      const one = singleFor(sources[0]);
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
    // A control removed with the focus in it leaves it to the next sensible place.
    if (hadFocus && !content.contains(document.activeElement)) {
      const next = content.querySelector('.ui-file-card button[aria-label], .ui-empty, .stamps-add, .ui-batch-add');
      next?.focus();
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
    if (failed.length) reportFileProblems(failed);
    arrange();
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
