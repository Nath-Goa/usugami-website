// The screen Split PDF, Delete pages and Rotate PDF share: the app's PdfToolScreen for a tool that
// works on one PDF. Its top bar, the "Choose PDF" card, the chosen PDF's card, the tool's own
// options, the file name, the main button at the bottom, the progress while the PDF is made, and
// the result screen. Each tool gives its options and its work through `spec.build` (see
// docs/api/organize-ui-a.md).
import { h, ensureCss, prefersReducedMotion } from '../../core/dom.js';
import { t, tp, loadStrings, formatSize } from '../../core/i18n.js';
import {
  topBar, button, bottomBar, emptyState, fileCard, textField, linearProgress, progressDialog,
  snackbar, alertDialog, dropZone,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf, preloadPdfJs } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { UserError, CancelledError } from '../../core/errors.js';

/** Matches Motion.MEDIUM: how long a section takes to open or close. */
const SECTION_MS = 250;

/**
 * A section that opens downwards while fading in and closes upwards while fading out, as the app's
 * pdfSectionEnter and pdfSectionExit. Closed, it is out of the tab order and hidden from screen
 * readers. el.setShown(shown, { animate }), el.shown, el.inner (holds the content).
 * @param {Node|Node[]} content
 * @param {{ shown?: boolean, cls?: string }} [options]
 * @returns {HTMLElement}
 */
export function collapsible(content, { shown = true, cls } = {}) {
  const inner = h('div', { class: 'onepdf-collapse-inner' }, content);
  const el = h('div', { class: ['onepdf-collapse', cls, shown ? 'is-settled' : 'is-collapsed'] }, inner);
  let now = shown;
  let timer = 0;
  if (!shown) {
    el.hidden = true;
    el.inert = true;
  }
  el.setShown = (show, { animate = true } = {}) => {
    show = !!show;
    if (show === now) return;
    now = show;
    clearTimeout(timer);
    const ms = animate && !prefersReducedMotion() ? SECTION_MS : 0;
    if (show) {
      el.hidden = false;
      el.inert = false;
      if (!ms) {
        el.classList.remove('is-collapsed');
        el.classList.add('is-settled');
        return;
      }
      el.classList.remove('is-settled');
      // Drawn closed once, so it opens from there.
      void el.offsetHeight;
      el.classList.remove('is-collapsed');
      timer = setTimeout(() => el.classList.add('is-settled'), ms);
    } else {
      el.classList.remove('is-settled');
      el.inert = true;
      el.classList.add('is-collapsed');
      if (ms) timer = setTimeout(() => { el.hidden = true; }, ms);
      else el.hidden = true;
    }
  };
  Object.defineProperty(el, 'shown', { get: () => now, configurable: true });
  el.inner = inner;
  return el;
}

/**
 * Makes `shown` (the Set a page grid was given as `selected`) hold the pages of `next`, and redraws
 * only those pages (the kit's `grid.refresh(indexes)`): typing in a long PDF's field then stays
 * quick.
 * @param {HTMLElement} grid  a pageGrid
 * @param {Set<number>} shown
 * @param {Iterable<number>} next
 */
export function updateSelection(grid, shown, next) {
  const want = new Set(next);
  const changed = [];
  for (const i of shown) if (!want.has(i)) changed.push(i);
  for (const i of want) if (!shown.has(i)) changed.push(i);
  if (!changed.length) return;
  shown.clear();
  for (const i of want) shown.add(i);
  grid.refresh(changed);
}

/**
 * Turns a control off for a moment (a PDF opening or being made) without `disabled`, which would
 * throw the keyboard focus out of it, to the page itself, where a dialog closing would leave it too.
 * Its click handler checks for itself; frame.css shows it as off.
 */
function setOff(el, off) {
  if (off) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

/** The message a problem shows: a UserError's own, else `fallback`'s. */
export function problemText(error, fallback) {
  return error instanceof UserError ? t(error.key, ...(error.args ?? [])) : t(fallback);
}

/**
 * Mounts the screen of a tool that works on one PDF.
 * @param {object} ctx  the router's mount context
 * @param {{
 *   id: 'split' | 'delete-pages' | 'rotate',
 *   namespace: string,
 *   action: string,
 *   css?: URL,
 *   build: (src: object, api: { engine: object, refresh: () => void }) => {
 *     nodes: Node[], ready: () => boolean, unsaved?: () => boolean, prepare: () => any,
 *     run: (input: object, plan: any, fileName: string, hooks: object) => Promise<object|object[]>,
 *     destroy?: () => void,
 *   },
 * }} spec
 * @returns {Promise<{ unmount(): void, hasUnsavedWork(): boolean, onStep(step: string|null): void }>}
 */
export async function mountPdfTool(ctx, spec) {
  // pdf.js (about 460 kB) loads while a PDF is being chosen; pdfdoc.js imports it only on demand.
  preloadPdfJs();
  await Promise.all([
    loadStrings(spec.namespace),
    ensureCss(new URL('./frame.css', import.meta.url)),
    spec.css ? ensureCss(spec.css) : null,
  ]);

  let src = null;          // the PdfSource being worked on
  let tool = null;         // what spec.build made for it
  let card = null;
  let nameField = null;
  let fileName = '';
  let importing = false;
  let processing = false;
  let run = null;          // the AbortController of the work under way
  let result = null;       // the result screen while it shows
  let stepPushed = false;
  let gone = false;
  let opening = 0;         // the latest PDF being opened; an older one is let go
  let empty = null;
  // Leaving the tool takes a password question still open away with it.
  const leaving = new AbortController();

  const main = button({ label: t(spec.action), onClick: () => start() });
  const bar = topBar({ title: t(ctx.tool.title), onBack: () => ctx.back() });
  const loading = collapsible(linearProgress({ value: null, label: t('web_opening_pdf') }), { shown: false, cls: 'onepdf-loading' });
  const body = h('div', { class: 'onepdf-body' });
  const content = h('main', { class: 'page page--narrow onepdf-main', 'data-main': '' }, loading, body);
  const screen = h('div', { class: ['onepdf', `${spec.id}-screen`] }, bar, content, bottomBar(main));
  ctx.root.append(screen);

  const refresh = () => {
    // Busy, the buttons are only marked off: the one pressed keeps the focus.
    main.disabled = !src || !tool || !tool.ready();
    setOff(main, importing || processing);
    if (empty) setOff(empty, importing);
    if (card) for (const b of card.querySelectorAll('.onepdf-another')) setOff(b, importing || processing);
  };

  const hasChanges = () => !!(src && tool?.unsaved?.());

  const confirmDiscard = () => alertDialog({
    title: t('tool_discard_title'),
    confirm: t('discard'),
    dismiss: t('keep'),
    destructive: true,
  });

  const focusIfLost = (target) => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || !screen.contains(active)) target?.focus?.({ preventScroll: true });
  };

  // Back on the tool from its result: the main button, else the top bar's back arrow (the title
  // can't take the focus).
  const focusTool = () => (main.disabled ? bar.querySelector('.ui-topbar-nav') : main)?.focus?.({ preventScroll: true });

  const setImporting = (b) => {
    importing = b;
    loading.setShown(b);
    content.toggleAttribute('aria-busy', b);
    refresh();
  };

  const closeSource = () => {
    try { tool?.destroy?.(); } catch (e) { setTimeout(() => { throw e; }); }
    tool = null;
    src?.close();
    src = null;
    card = null;
    nameField = null;
  };

  // Files dropped or pasted onto the screen while a PDF is open take its place (asked first when
  // it has changes). Without one, the "Choose PDF" card takes them: one drop zone at a time, as
  // one inside another would keep the outer one marked after a drop on the inner.
  let detachDrop = null;
  const screenDrop = (on) => {
    if (on && !detachDrop) {
      detachDrop = dropZone(screen, {
        accept: 'pdf',
        multiple: false,
        onFiles: (items) => { if (!result && !processing) choose(items[0]); },
      });
    } else if (!on && detachDrop) {
      detachDrop();
      detachDrop = null;
      screen.classList.remove('is-dragover');
    }
  };

  const showEmpty = () => {
    screenDrop(false);
    empty?.detachDrop?.();
    empty = emptyState({
      icon: 'add',
      title: t('pick_pdf'),
      onClick: () => pick(),
      onFiles: (items) => choose(items[0]),
      accept: 'pdf',
      multiple: false,
    });
    body.replaceChildren(empty);
    refresh();
  };

  const showChosen = () => {
    empty?.detachDrop?.();
    empty = null;
    screenDrop(true);
    const another = button({ label: t('web_choose_another_pdf'), variant: 'text', icon: 'upload_file', cls: 'onepdf-another', onClick: () => pickAnother() });
    card = fileCard({
      name: src.name,
      detail: t('result_details', tp('page_count', src.pageCount), formatSize(src.size)),
      thumbnail: src.thumbnail(0, 58, { maxCssHeight: 78 }).catch(() => null),
      onRemove: () => remove(),
      actions: [another],
    });
    card.tabIndex = -1;
    card.classList.add('onepdf-card');
    nameField = textField({
      label: t('file_name'),
      value: fileName,
      suffix: '.pdf',
      autocomplete: 'off',
      spellcheck: false,
      onInput: (v) => { fileName = v; },
    });
    nameField.classList.add('onepdf-name');
    body.replaceChildren(card, ...tool.nodes, nameField);
    refresh();
  };

  /**
   * Opens `item` as the PDF to work on, in place of the one there, whose changes are asked about
   * first (unless `asked`). The one there stays when the new one can't be opened.
   */
  const choose = async (item, { asked = false } = {}) => {
    if (gone || !item || processing || importing || result) return;
    if (!asked && hasChanges() && !(await confirmDiscard())) return;
    if (gone || processing || importing || result) return;
    const mine = ++opening;
    setImporting(true);
    let opened = null;
    let engine = null;
    // The tool's engine loads while the PDF opens (and its password is asked for).
    const loadingEngine = import('../../engine/organize.js').then((m) => { engine = m; }, (e) => e);
    try {
      // A password given on Choose a tool (item.password) is tried first, so it isn't asked again.
      opened = await openPdf(item, { signal: leaving.signal });
      const failed = await loadingEngine;
      if (opened && failed) {
        opened.close();
        opened = null;
        // Offline before the tool was ever used whole.
        if (mine === opening && !gone) snackbar(t('web_tool_load_failed', t(ctx.tool.title)));
      }
    } catch (e) {
      if (mine === opening && !gone && !(e instanceof CancelledError)) snackbar(problemText(e, 'pdf_import_failed'));
    } finally {
      if (mine === opening && !gone) setImporting(false);
    }
    if (!opened) {
      // Nothing opened (a password asked for and cancelled, say): the focus stays where it was, or
      // goes back to the card picked from.
      if (mine === opening && !gone) focusIfLost(empty ?? card);
      return;
    }
    // Left, or another PDF picked meanwhile: this one belongs to nothing now.
    if (mine !== opening || gone) {
      opened.close();
      return;
    }
    if (!(opened.pageCount >= 1)) {
      opened.close();
      snackbar(t('pdf_import_failed'));
      return;
    }
    closeSource();
    src = opened;
    fileName = engine.defaultName(spec.id, { name: src.name, pageCount: src.pageCount });
    tool = spec.build(src, { engine, refresh });
    showChosen();
    // The card tapped or the button in the card that was replaced: the focus goes to the new card.
    focusIfLost(card);
  };

  const pick = async () => {
    if (importing || processing || gone) return;
    const items = await pickFiles({ accept: 'pdf', multiple: false });
    if (items.length && !gone) await choose(items[0]);
  };

  // A web extra: another PDF without removing this one first. Changes made to this one are asked
  // about first, so the picker opens straight from that tap.
  const pickAnother = async () => {
    if (importing || processing || gone) return;
    if (hasChanges()) {
      if (!(await confirmDiscard()) || gone) return;
      const items = await pickFiles({ accept: 'pdf', multiple: false });
      if (items.length && !gone) await choose(items[0], { asked: true });
      return;
    }
    await pick();
  };

  const startOver = () => {
    closeSource();
    fileName = '';
    showEmpty();
  };

  const remove = async () => {
    if (processing || importing) return;
    if (hasChanges() && !(await confirmDiscard())) return;
    if (gone) return;
    startOver();
    empty?.focus({ preventScroll: true });
  };

  /** Runs the tool: its choices checked first (a problem said in a snackbar), then the work, then the result. */
  const start = async () => {
    if (!src || !tool || importing || processing || result || !tool.ready()) return;
    let plan;
    try {
      plan = tool.prepare();
    } catch (e) {
      snackbar(problemText(e, 'pdf_invalid_pages'));
      return;
    }
    processing = true;
    refresh();
    const controller = new AbortController();
    run = controller;
    const dialog = progressDialog({ title: t('pdf_working'), onCancel: () => controller.abort() });
    const source = src;
    const name = fileName;
    let files = null;
    let failure = null;
    try {
      const input = { name: source.name, bytes: source.bytes, ...(source.password ? { password: source.password } : {}) };
      const made = await tool.run(input, plan, name, {
        signal: controller.signal,
        onProgress: (done, total) => dialog.update(total > 0 ? done / total : null),
      });
      files = [].concat(made);
    } catch (e) {
      failure = e;
    } finally {
      await dialog.close();
      processing = false;
      if (run === controller) run = null;
    }
    // Said once the dialog has gone: while it is open, the rest of the page (the snackbar and the
    // announcer with it) is out of a screen reader's reach.
    if (failure && !(failure instanceof CancelledError) && !controller.signal.aborted && !gone) snackbar(problemText(failure, 'pdf_process_failed'));
    if (gone || !files?.length || src !== source) {
      refresh();
      return;
    }
    showResultScreen(files, name, source);
  };

  const showResultScreen = (files, name, source) => {
    result = showResult(ctx.root, {
      files,
      zipName: name,
      passwordRemoved: files.some((f) => f.passwordRemoved) || !!source.password,
      onBack: () => backToEditing(),
      onStartOver: () => {
        leaveResult();
        startOver();
        if (stepPushed) {
          stepPushed = false;
          ctx.popStep?.();
        }
        empty?.focus({ preventScroll: true });
      },
    });
    ctx.pushStep?.('result');
    stepPushed = true;
  };

  /** The result goes and the tool shows again as it was. False when no result showed. */
  const leaveResult = () => {
    if (!result) return false;
    result.destroy();
    result = null;
    ctx.root.replaceChildren(screen);
    // A paste on the result screen let go of the screen's paste zone while it was out of the page:
    // it is made again, so a PDF pasted on the tool still takes the open one's place.
    if (src) {
      screenDrop(false);
      screenDrop(true);
    }
    refresh();
    return true;
  };

  const backToEditing = () => {
    if (leaveResult()) focusTool();
    if (stepPushed) {
      stepPushed = false;
      ctx.popStep?.();
    }
  };

  showEmpty();
  // A reload on the result step: the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();
  if (ctx.files?.length) choose(ctx.files[0]);

  return {
    unmount() {
      gone = true;
      opening++;
      leaving.abort();
      run?.abort();
      screenDrop(false);
      empty?.detachDrop?.();
      result?.destroy();
      result = null;
      closeSource();
    },
    hasUnsavedWork() {
      if (processing) return true;
      if (result) return !result.isSaved();
      return hasChanges();
    },
    onStep(step) {
      if (step == null) {
        stepPushed = false;
        if (leaveResult()) focusTool();
      } else if (!result) {
        // Forward to a result that has gone: back to where it was.
        ctx.popStep?.();
      } else {
        stepPushed = true;
      }
    },
  };
}
