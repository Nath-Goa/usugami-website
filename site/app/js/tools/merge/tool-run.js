// What Merge PDF and Reorganize PDF share around their engines (PdfToolsViewModel.process and the
// app's result screen): the progress dialog while the PDF is made, the messages for what went
// wrong, and the result screen over the tool, which Back (the browser's too) leaves for the tool
// as it was.
import { h } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { progressDialog, snackbar } from '../../core/ui.js';
import { showResult } from '../../core/output.js';
import { UserError, CancelledError, PasswordError } from '../../core/errors.js';

/**
 * The message for a PDF that couldn't be opened (`fallback`, pdf_import_failed) or made
 * (pdf_process_failed): a UserError's own words, else the fallback's.
 * @param {Error} error
 * @param {string} [fallback]
 */
export function problemText(error, fallback = 'pdf_process_failed') {
  if (error instanceof UserError) return t(error.key, ...error.args);
  if (error instanceof PasswordError) return t('pdf_wrong_password');
  return t(fallback);
}

/**
 * Runs `work({ signal, onProgress })` with "Working on your PDF…" (shown once it takes 400 ms, as
 * the app's), Cancel stopping it. Resolves with what work made, or null when it was cancelled or
 * failed (the failure said in a snackbar, as the view model's process does).
 * @template T
 * @param {(hooks: { signal: AbortSignal, onProgress: (done: number, total: number) => void }) => Promise<T>} work
 * @returns {Promise<T|null>}
 */
export async function runWithProgress(work) {
  const controller = new AbortController();
  const dialog = progressDialog({ title: t('pdf_working'), onCancel: () => controller.abort() });
  try {
    const out = await work({
      signal: controller.signal,
      onProgress: (done, total) => dialog.update(total > 0 ? Math.min(1, done / total) : null),
    });
    await dialog.close();
    return controller.signal.aborted ? null : out;
  } catch (e) {
    await dialog.close();
    if (!(e instanceof CancelledError) && !controller.signal.aborted) {
      if (!(e instanceof UserError)) console.warn(e);
      snackbar(problemText(e));
    }
    return null;
  }
}

/**
 * The result screen for a tool mounted in `ctx`: `view` (the tool's own elements) is hidden while it
 * shows, and comes back as it was with "Back to editing", the browser's Back or onStep(null).
 * @param {object} ctx    the tool's mount context (root, pushStep, popStep)
 * @param {HTMLElement} view
 * @param {{ onStartOver: () => void, onBack?: () => void }} handlers
 */
export function resultScreen(ctx, view, { onStartOver, onBack }) {
  let screen = null;
  let holder = null;
  let stepped = false;

  const hide = () => {
    if (!screen) return false;
    screen.destroy?.();
    holder.remove();
    screen = null;
    holder = null;
    view.hidden = false;
    return true;
  };

  /** Leaves the result for the tool, also undoing the history step the result added. */
  const leave = () => {
    const was = hide();
    if (stepped) {
      stepped = false;
      ctx.popStep?.();
    }
    return was;
  };

  // Opened on the result's step (a reload there): the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();

  return {
    /** Shows `files` (OutputFiles) with `options` for showResult (zipName, passwordRemoved...). */
    show(files, options = {}) {
      hide();
      holder = h('div', { class: 'merge-result' });
      view.hidden = true;
      ctx.root.append(holder);
      screen = showResult(holder, {
        ...options,
        files,
        onBack: () => {
          leave();
          onBack?.();
        },
        onStartOver: () => {
          leave();
          onStartOver();
        },
      });
      window.scrollTo(0, 0);
      if (ctx.pushStep) {
        ctx.pushStep('result');
        stepped = true;
      }
    },
    /**
     * The router's step (handle.onStep): back to the tool's first step (the browser's Back) shows
     * the tool again as it was; forward to a result that has gone goes back to where it was.
     */
    onStep(step) {
      if (step == null) {
        stepped = false;
        if (hide()) onBack?.();
      } else if (!screen) {
        ctx.popStep?.();
      } else {
        stepped = true;
      }
    },
    get showing() {
      return !!screen;
    },
    isSaved() {
      return screen ? screen.isSaved() : true;
    },
    destroy() {
      hide();
    },
  };
}
