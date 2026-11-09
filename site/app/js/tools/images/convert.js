// The last step before the PDF (ConvertSheet.kt) and making it (MainViewModel.convert,
// PdfOcr.apply): one PDF or one per image, the file name, the compression level with what it means,
// and Make text searchable (OCR) with its language; then the progress dialog while the PDFs are made
// (and the text read), and what to say when something goes wrong.
import { h } from '../../core/dom.js';
import { t, tp, getLanguage } from '../../core/i18n.js';
import { bottomSheet, switchRow, textField, segmented, button, progressDialog, alertDialog, uid } from '../../core/ui.js';
import { UserError, CancelledError, checkCancelled } from '../../core/errors.js';
import { baseName, withSuffix, uniqueName } from '../../core/names.js';
import { loadImage } from '../../engine/images/decode.js';
import { defaultOcrLanguage, OCR_LANGUAGES, OCR_LANGUAGE_NAMES } from '../../engine/ocr/languages.js';
import { ocrScale } from '../../engine/ocr/scale.js';
import { DEFAULT_NAME, shownSize } from './model.js';

/**
 * What making a PDF needs, loaded once a PDF is made (the PDF writer, its fonts and the OCR engine
 * are about 1 MB), not before the tool shows; preloadConvert() starts it early.
 */
let engines = null;
function loadEngines() {
  engines ??= Promise.all([
    import('../../engine/images/build-pdf.js'),
    import('../../engine/pdf-common.js'),
    import('../../engine/ocr.js'),
  ]).then(([build, common, ocr]) => ({
    buildImagesPdf: build.buildImagesPdf,
    loadPdf: common.loadPdf,
    savePdf: common.savePdf,
    createRecognizer: ocr.createRecognizer,
    addTextLayer: ocr.addTextLayer,
  })).catch((e) => {
    engines = null;
    throw e;
  });
  return engines;
}

/**
 * Starts loading what making a PDF needs, without waiting for it: call once the tool shows, so the
 * PDF can be made at once later. A failure here is only met (and said) when a PDF is made.
 */
export function preloadConvert() {
  loadEngines().catch(() => {});
}

const COMPRESSIONS = ['less', 'recommended', 'extreme'];
const PAGE_SIZE_LABEL = { fit: 'size_fit', a4: 'size_a4', letter: 'size_letter', legal: 'size_legal', a3: 'size_a3', a5: 'size_a5' };
const ORIENTATION_LABEL = { auto: 'orientation_auto', portrait: 'orientation_portrait', landscape: 'orientation_landscape' };
const MARGIN_LONG = { none: 'margin_none', small: 'margin_small_long', big: 'margin_big_long' };
/** Text is read at this many pixels on the long side, smaller images enlarged at most this much (PdfOcr). */
const READ_SIDE = 3000;
const MAX_ENLARGE = 2.5;

/** "3 images · A4 · Portrait · No margin" (ConvertSheet.summary). */
export function summary(count, layout) {
  const parts = [tp('image_count', count), t(PAGE_SIZE_LABEL[layout.pageSize])];
  if (layout.pageSize !== 'fit') parts.push(t(ORIENTATION_LABEL[layout.orientation]));
  parts.push(t(MARGIN_LONG[layout.margin]));
  return parts.join(' · ');
}

/**
 * Opens the Create PDF sheet. `onCreate({ merge, fileName, compression, ocrLanguage })` is called
 * with the choices (ocrLanguage null with OCR off). Returns { update(), close() }: update() follows
 * the images (shared images arriving meanwhile, which Create waits for).
 * @param {import('./model.js').ImagesModel} model
 */
export function openConvertSheet(model, onCreate) {
  const initial = model.initialChoices();
  let merge = model.merge;
  let name = initial.fileName;
  let compression = model.compression;
  let ocrOn = initial.ocrLanguage != null;
  // Text recognition reads the app's language unless another was picked for these images.
  let ocrLanguage = initial.ocrLanguage ?? defaultOcrLanguage(getLanguage());

  const summaryEl = h('p', { class: 'images-sheet-summary' });
  const mergeRow = switchRow({
    label: t('merge_title'), detail: t(merge ? 'merge_on_summary' : 'merge_off_summary'), checked: merge,
    onChange: (on) => { merge = on; mergeRow.setDetail(t(on ? 'merge_on_summary' : 'merge_off_summary')); render(); },
  });
  const nameField = textField({
    label: t('file_name'), value: name, suffix: '.pdf', autocomplete: 'off', spellcheck: false,
    onInput: (v) => { name = v; },
    onEnter: () => create(),
  });
  nameField.input.setAttribute('autocapitalize', 'off');
  nameField.input.setAttribute('enterkeyhint', 'done');
  const nameBox = h('div', { class: 'images-sheet-name' }, nameField);
  const compressionId = uid('images-compression');
  const languageId = uid('images-ocr-language');
  const compressionTitle = h('h3', { class: 'images-sheet-heading', id: compressionId }, t('compression_title'));
  const levels = segmented({
    labelledBy: compressionId, value: compression,
    options: COMPRESSIONS.map((c) => ({ value: c, label: t(`compression_${c}`) })),
    onChange: (v) => { compression = v; render(); },
  });
  const levelSummary = h('p', { class: 'images-sheet-note', 'aria-live': 'polite' });
  const ocrRow = switchRow({ label: t('ocr_title'), detail: t('ocr_detail'), checked: ocrOn, onChange: (on) => { ocrOn = on; render(); } });
  const languages = segmented({
    labelledBy: languageId, value: ocrLanguage,
    options: OCR_LANGUAGES.map((l) => ({ value: l, label: t(OCR_LANGUAGE_NAMES[l]) })),
    onChange: (v) => { ocrLanguage = v; },
  });
  const ocrBox = h('div', { class: 'images-sheet-ocr' },
    h('h3', { class: 'images-sheet-heading', id: languageId }, t('ocr_language')),
    languages,
    h('p', { class: 'images-sheet-note' }, t('web_ocr_note')));
  const adding = h('p', { class: 'images-sheet-note images-sheet-adding' }, t('adding_images'));
  const createButton = button({ label: t('create_pdf'), variant: 'filled', cls: 'images-create-button', onClick: () => create() });

  const sheet = bottomSheet({
    title: t('convert_title'),
    cls: 'images-sheet',
    content: [summaryEl, mergeRow, nameBox, compressionTitle, levels, levelSummary, ocrRow, ocrBox],
    actions: [adding, createButton],
  });
  let open = true;
  const closed = sheet.closed.then(() => { open = false; });

  function importing() {
    // A photo just taken is still to go through the crop screen while its page is looked for.
    return model.pending > 0 || model.openingCrop;
  }

  function render() {
    const count = model.items.length;
    const oneFile = merge || count === 1;
    summaryEl.textContent = summary(count, model.layout);
    mergeRow.hidden = count < 2;
    nameBox.hidden = !oneFile;
    levelSummary.textContent = t(`compression_${compression}_summary`);
    ocrBox.hidden = !ocrOn;
    adding.hidden = !importing();
    createButton.disabled = importing();
    createButton.setLabel(oneFile ? t('create_pdf') : tp('create_pdfs', count));
  }

  function create() {
    if (!open || importing()) return;
    const choice = { merge, fileName: name, compression, ocrLanguage: ocrOn ? ocrLanguage : null };
    sheet.close();
    onCreate(choice);
  }

  render();
  return {
    update() {
      if (!open) return;
      if (!model.items.length) sheet.close(); else render();
    },
    close: () => sheet.close(),
    get open() { return open; },
    /** Resolves once the sheet has closed, however it was closed. */
    closed,
  };
}

/** The picture text is read from: the page's own image, turned as its page is, no larger than reading needs. */
async function readingPicture(page, signal) {
  const [w, hgt] = shownSize(page);
  const scale = Math.min(1, ocrScale(w, hgt, READ_SIDE, MAX_ENLARGE));
  return loadImage(page.image, { maxSide: Math.max(1, Math.ceil(Math.max(w, hgt) * scale)), rotation: page.rotation, signal });
}

/**
 * Adds a searchable text layer to `files` (PdfOcr.apply), read from the images they were made from
 * as the pages show them, not from the compressed copies. A file with text is renamed
 * <name>_searchable.pdf; one without any text stays as it is. If reading fails, every file stays as
 * it was and the failure is said (ocr_failed).
 */
async function addTextLayers(files, recognizer, { dialog, signal, say, loadPdf, savePdf, addTextLayer }) {
  const total = files.reduce((n, f) => n + f.pageCount, 0);
  dialog.setTitle(t('ocr_reading'));
  dialog.update(0, tp('progress_pages', total, 0, total), null);
  try {
    const results = [];
    const taken = new Set(files.map((f) => baseName(f.name)));
    let done = 0;
    let lines = 0;
    for (const file of files) {
      const doc = await loadPdf(file.bytes);
      const pages = doc.getPages();
      let fileLines = 0;
      for (let i = 0; i < file.images.length; i++) {
        checkCancelled(signal);
        const { item, placement } = file.images[i];
        const picture = await readingPicture(item.page, signal);
        let recognition;
        try {
          recognition = await recognizer.recognize(picture, { signal });
        } finally {
          picture.close?.();
        }
        fileLines += await addTextLayer(doc, pages[i], recognition, placement);
        done++;
        // Once every page is read, only writing the text layer is left.
        if (done < total) {
          dialog.update(done / total, tp('progress_pages', total, done, total));
        } else {
          dialog.setTitle(t('ocr_adding_text'));
          dialog.update(null, '');
        }
      }
      checkCancelled(signal);
      if (fileLines === 0) {
        results.push(file);
      } else {
        const bytes = await savePdf(doc);
        const named = uniqueName(withSuffix(baseName(file.name), '_searchable', DEFAULT_NAME), taken);
        taken.add(named);
        results.push({ ...file, name: `${named}.pdf`, bytes });
      }
      lines += fileLines;
    }
    if (lines === 0) say(t('ocr_no_text'));
    return results;
  } catch (e) {
    if (e instanceof CancelledError || signal.aborted) throw new CancelledError();
    say(t('ocr_failed'));
    return files;
  }
}

/** Says what made text recognition unavailable, instead of making the PDF (OcrProblemDialog). */
export function ocrProblemDialog(key) {
  return alertDialog({
    title: t('ocr_problem_title'),
    message: h('div', { class: 'images-ocr-problem' }, h('p', null, t(key)), h('p', null, t('ocr_problem_retry'))),
    confirm: t('ok'),
  });
}

/**
 * Makes the PDFs of the pages as they are now (MainViewModel.convert), with the progress dialog and
 * Cancel. Resolves with { files, name } (the name the sheet had, for a ZIP of them), or null when
 * no PDF was made (cancelled, failed, or text recognition unavailable: said or asked as the app does).
 * What goes wrong (or OCR's "No text was recognized") is said once the progress dialog has closed:
 * a message announced while it is up is never heard, the rest of the screen being inert.
 * @param {import('./model.js').ImagesModel} model
 * @param {{ merge: boolean, fileName: string, compression: string, ocrLanguage: string|null }} choice
 * @param {{ say(text: string), signal?: AbortSignal }} hooks  signal: the screen has gone, the work stops
 */
export async function convert(model, choice, { say: sayNow, signal: gone }) {
  const snapshot = model.items;
  if (!model.canConvert() || gone?.aborted) return null;
  const { merge, fileName, compression, ocrLanguage } = choice;
  if (snapshot.length > 1) model.setMerge(merge);
  model.setCompression(compression);
  model.lastChoices = { fileName, ocrLanguage };
  model.setConverting(true);
  const controller = new AbortController();
  const { signal } = controller;
  gone?.addEventListener('abort', () => controller.abort(), { once: true });
  const count = snapshot.length;
  const dialog = progressDialog({ title: t('creating_pdf'), onCancel: () => controller.abort() });
  dialog.update(0, tp('progress_images', count, 0, count));
  /** What to say once the dialog has gone. */
  const said = [];
  const say = (text) => { said.push(text); };
  let recognizer = null;
  let problem = null;
  try {
    const { buildImagesPdf, createRecognizer, loadPdf, savePdf, addTextLayer } = await loadEngines();
    checkCancelled(signal);
    if (ocrLanguage) {
      // Before any PDF work, so a missing recognizer is said straight away.
      dialog.setTitle(t('ocr_downloading'));
      dialog.update(null, '', t('web_ocr_download_note'));
      recognizer = await createRecognizer(ocrLanguage, {
        signal,
        onProgress: (done, total) => {
          const fraction = total > 0 ? Math.min(1, done / total) : null;
          dialog.update(fraction, fraction == null ? '' : t('ocr_download_percent', Math.floor(fraction * 100)), t('web_ocr_download_note'));
        },
      });
      dialog.setTitle(t('creating_pdf'));
      dialog.update(0, tp('progress_images', count, 0, count), null);
    }
    const pages = snapshot.map((p) => ({
      name: p.name, bytes: p.image.bytes, rotation: p.rotation, look: p.look, brightness: p.brightness, contrast: p.contrast, page: p,
    }));
    let files = await buildImagesPdf(pages, {
      ...model.layout,
      compression,
      merge: merge || count === 1,
      name: fileName,
    }, {
      signal,
      onProgress: (done, total) => dialog.update(done / total, tp('progress_images', total, done, total)),
    });
    if (recognizer) files = await addTextLayers(files, recognizer, { dialog, signal, say, loadPdf, savePdf, addTextLayer });
    model.lastChoices = null;
    return { files, name: fileName };
  } catch (e) {
    if (e instanceof CancelledError || signal.aborted) return null;
    if (e instanceof UserError && (e.key === 'ocr_problem_download' || e.key === 'ocr_problem_failed')) {
      problem = e.key;
      return null;
    }
    if (e instanceof UserError && (e.key === 'msg_image_unreadable' || e.key === 'msg_out_of_memory' || e.key === 'msg_out_of_space')) {
      say(t('msg_convert_failed', t(e.key, ...e.args)));
    } else {
      console.warn('PDF generation failed', e);
      say(t('msg_convert_failed', t('msg_unknown_error')));
    }
    return null;
  } finally {
    recognizer?.terminate();
    await dialog.close();
    model.setConverting(false);
    for (const text of said) sayNow(text);
    if (problem) await ocrProblemDialog(problem);
  }
}
