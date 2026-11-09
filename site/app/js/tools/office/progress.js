// The dialog shown while Word, PowerPoint, Excel and EPUB files are converted: the app's
// OfficeProgressDialog (ui/OfficeOptions.kt). For one file: the page being drawn (a Word document's
// page count isn't known until the end), or the slide, chapter or page out of how many, then the
// PDF is compressed. For several: which file ("PDF 2 of 5") and its name too, the bar showing how
// far they all have got. Built on the kit's progressDialog, which shows after 400 ms.
import { h } from '../../core/dom.js';
import { t, tp } from '../../core/i18n.js';
import { progressDialog } from '../../core/ui.js';

/**
 * What the dialog shows for `progress` (`{ done, total, compressing }` as convertOffice reports it,
 * or null before the first report), converting a `kind` file, one of several when `many`, `batch`
 * being `{ number, total, name }` (null until the first starts).
 * @returns {{ fraction: number | null, text: string | null }} the bar (null: without end) and the
 *   line under it ("Page 3", "Chapter 2 of 9", "2 of 6 slides", "1 of 4 pages"), or null for none
 * @example officeProgressView({ done: 2, total: 6 }, 'powerpoint')  // { fraction: 0.333…, text: '2 of 6 slides' }
 */
export function officeProgressView(progress, kind, many = false, batch = null) {
  const done = progress?.done ?? 0;
  const total = progress && !progress.compressing && progress.total > 0 ? progress.total : null;
  // How far the file being converted has got; with several, it counts for its share of them all.
  const part = total != null ? Math.min(1, done / total) : progress?.compressing ? 1 : 0;
  let fraction;
  if (many) fraction = batch ? Math.min(1, (batch.number - 1 + part) / batch.total) : null;
  else fraction = total == null ? null : part;
  let text = null;
  if (progress && !progress.compressing && done > 0) {
    if (total == null) text = t('pdf_page_number', done);
    else if (kind === 'epub') text = t('progress_chapter', done, total);
    else if (kind === 'excel') text = tp('progress_pages', total, done, total);
    else text = tp('progress_slides', total, done, total);
  }
  return { fraction, text };
}

/**
 * Opens the conversion dialog for files of `kind` ('word', 'powerpoint', 'excel', 'epub'): "Creating
 * and compressing PDF…" (or "PDFs…" when `many`) with Cancel, which calls `onCancel`.
 * Returns `{ el, next(number, total, name), progress(done, total, info), close() }`: `next` when the
 * next file starts (several files), `progress` as convertOffice's onProgress reports.
 */
export function officeProgressDialog({ kind, many = false, onCancel, delay } = {}) {
  const dialog = progressDialog({
    title: t(many ? 'creating_pdfs' : 'creating_pdf'),
    onCancel,
    ...(delay != null ? { delay } : {}),
  });
  // The page, slide or chapter: a line of its own under the file's, and not read out at each page.
  const step = h('p', { class: 'office-progress-step' });
  step.hidden = true;
  (dialog.el.querySelector('.ui-dialog-body') ?? dialog.el).append(step);
  // The kit's lines ("PDF 2 of 5" and the name) take no room while they show nothing (one file),
  // so the step sits 12 px under the bar, as the app leaves the batch's Column out then.
  const textBlock = dialog.el.querySelector('.ui-progress-text');
  const fitText = () => {
    if (textBlock) textBlock.hidden = ![...textBlock.children].some((c) => !c.hidden);
  };
  fitText();
  let batch = null;
  let progress = null;
  const render = () => {
    const view = officeProgressView(progress, kind, many, batch);
    dialog.update(view.fraction);
    step.textContent = view.text ?? '';
    step.hidden = !view.text;
    fitText();
  };
  render();
  return {
    el: dialog.el,
    dialog: dialog.dialog,
    /** File `number` of `total`, named `name`, starts (several files). */
    next(number, total, name) {
      batch = { number, total, name };
      progress = null;
      // "PDF 2 of 5" is read out as it moves on to the next file.
      dialog.update(null, t('batch_progress', number, total), name ?? '');
      render();
    },
    /** convertOffice's onProgress(done, total, info). */
    progress(done, total, info) {
      progress = { done, total: total ?? null, compressing: !!info?.compressing };
      render();
    },
    close: () => dialog.close(),
  };
}
