// Scan document and Images to PDF (the app's editor, crop screen, Create PDF sheet and result, as
// UsugamiApp.kt routes "images"): one module for both tools. ctx.params.start === 'scan' starts a
// scan with ctx.files from Home's Scan document card: uploaded images go through the crop screen one
// after another; a photo (ctx.params.camera) goes through it with Take another and Done. Without
// files, or as Images to PDF, the editor shows, taking images picked, dropped, pasted or shared.
//
// The inner screens are history steps, so the browser's Back (a phone's Back) goes back as the
// app's does: from Filters to Crop page, from Crop page to the editor (a photo just taken is
// discarded, a scan stops), from the result to the editor.
import { h, ensureCss } from '../../core/dom.js';
import { loadStrings, t } from '../../core/i18n.js';
import { snackbar, alertDialog } from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { showResult } from '../../core/output.js';
import { IMAGE_ACCEPT } from '../../engine/images/image-type.js';
import { ImagesModel } from './model.js';
import { createEditor } from './editor.js';
import { createCropScreen, createScanWaiting } from './crop-screen.js';
import { openConvertSheet, convert, preloadConvert } from './convert.js';
import { forgetPreviews, clearPreviews } from './preview.js';

/** How deep each inner screen is in the browser's history above the tool (sheet: Create PDF's). */
const STEP_DEPTH = { crop: 1, waiting: 1, result: 1, sheet: 1, filters: 2 };
const depthOf = (step) => (step == null ? 0 : STEP_DEPTH[step] ?? 1);

/** Whether Home's Take photo opened the tool (its photo then goes through the crop screen as a photo). */
const fromCamera = (params) => ['1', 'true', true].includes(params?.camera) || params?.source === 'camera';

function focusHeading(root) {
  const heading = root.querySelector('h1');
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

/** Renders Scan document or Images to PDF into ctx.root. */
export async function mount(ctx) {
  await Promise.all([loadStrings('images'), ensureCss(new URL('./images.css', import.meta.url))]);
  let destroyed = false;
  /** Aborted when the tool goes: a PDF still being made stops. */
  const life = new AbortController();
  let discarded = false;
  let leaving = false;
  /** The PDFs made, while the result screen shows: { files, name }. */
  let result = null;
  /** The inner screen showing: { kind, key, el, update(), focus(), destroy() }. */
  let screen = null;
  let sheet = null;
  /** The tool was opened by Home's Scan document, whose scan is still going on. */
  let scanFromHome = false;
  let editorScroll = 0;
  /** Set while the screens go back for the browser's Back, which has moved the history already. */
  let unwinding = false;

  const model = new ImagesModel({
    onChange: () => render(),
    onMessage: (text) => snackbar(text),
    // Images arriving put the result away, as in the app.
    onImagesComing: () => { if (result) putAwayResult(); },
    onForget: (image) => forgetPreviews(image),
  });

  // ---- Picking ----

  const addPhotos = () => pickFiles({ accept: 'image', multiple: true }).then((files) => { if (!destroyed) model.addImages(files); });
  const addFiles = () => pickFiles({ accept: IMAGE_ACCEPT, multiple: true }).then((files) => { if (!destroyed) model.addImages(files); });
  /** Opens the camera app (a picker on computers) for a photo, added and cropped when it comes back. Call from a click. */
  const takePhoto = () => {
    model.cameraOpen = true;
    model.changed();
    pickFiles({ accept: 'image', capture: 'environment' }).then((files) => {
      if (destroyed) return;
      model.cameraOpen = false;
      if (files.length) model.addPhoto(files[0]);
      else model.changed();
    });
  };

  // ---- Leaving ----

  /**
   * Leaves the tool once the history steps being undone are done, and the images being added have
   * said what couldn't be added (a scan of nothing readable ends here, and says why on Home).
   */
  async function leave() {
    if (leaving) return;
    leaving = true;
    while (expect != null) await waitStep();
    if (!discarded) await model.importChain;
    if (!destroyed) ctx.back();
  }

  /** The editor's back arrow: asks first while there are images (discard_title), as the app does. */
  async function leaveEditor() {
    if (model.converting) return;
    if (!model.items.length && model.pending === 0) { leave(); return; }
    const ok = await alertDialog({ title: t('discard_title'), message: t('discard_body'), confirm: t('discard'), dismiss: t('keep') });
    if (!ok || destroyed) return;
    discarded = true;
    model.clearAll();
    leave();
  }

  // ---- Making the PDF ----

  function openSheet() {
    // Not while a PDF is being made, nor while a photo's crop screen is opening.
    if (model.converting || model.openingCrop || !model.items.length || model.pending > 0) return;
    if (sheet?.open) return;
    const opened = openConvertSheet(model, async (choice) => {
      sheet = null;
      const made = await convert(model, choice, { say: (text) => snackbar(text), signal: life.signal });
      if (made && !destroyed) {
        result = made;
        render();
      }
    });
    sheet = opened;
    // The sheet is a history step, so the browser's (a phone's) Back closes it, as the app's Back
    // closes its bottom sheet, rather than asking to discard the images. However it closes, the
    // step goes.
    opened.closed.then(() => {
      if (sheet === opened) sheet = null;
      if (!destroyed && !unwinding) syncHistory();
    });
    syncHistory();
  }

  function putAwayResult() {
    if (!result) return;
    result = null;
    render();
  }

  const editor = createEditor({
    model,
    actions: { back: leaveEditor, addPhotos, addFiles, takePhoto, convert: openSheet, files: (files) => model.addImages(files) },
  });

  // ---- Inner screens ----

  function wanted() {
    if (result) return { kind: 'result', key: 'result' };
    if (model.crop) return { kind: 'crop', key: `crop:${model.crop.opened}` };
    if (model.scan) return { kind: 'waiting', key: 'waiting' };
    return { kind: 'editor', key: 'editor' };
  }

  function make(w) {
    if (w.kind === 'editor') {
      return {
        ...w,
        el: editor.el,
        update: () => editor.update(),
        focus: () => { if (!editor.focusAfterCrop()) focusHeading(editor.el); },
        destroy: () => editor.detach(),
      };
    }
    if (w.kind === 'crop') {
      const session = model.crop;
      const crop = createCropScreen({
        model,
        session,
        scan: () => (session.queued ? model.scan : null),
        // The images of the scan still being added are pages too: Apply to all pages reaches them.
        pageCount: () => model.items.length + (session.queued ? model.scan?.coming ?? 0 : 0),
        onStep: () => syncHistory(),
        actions: {
          done: (choices) => model.finishCrop(choices),
          // A second tap, once the first has closed the screen, opens no second camera.
          takeAnother: (choices) => { if (model.finishCrop(choices)) takePhoto(); },
          close: () => model.closeCrop(),
        },
      });
      return { ...w, el: crop.el, crop, update: () => crop.update(), focus: () => crop.focus(), destroy: () => crop.destroy() };
    }
    if (w.kind === 'waiting') {
      const waiting = createScanWaiting({ scan: () => model.scan, onClose: () => model.closeCrop() });
      return { ...w, el: waiting.el, update: () => waiting.update(), focus: () => waiting.focus(), destroy: () => waiting.destroy() };
    }
    const box = h('div', { class: 'images-result' });
    const shown = showResult(box, {
      files: result.files,
      zipName: result.name,
      onBack: () => putAwayResult(),
      onStartOver: () => { result = null; model.clearAll(); render(); },
      // Saving says what the app's editor says (MainViewModel), not the PDF tools' wording.
      wording: 'images',
    });
    return {
      ...w,
      el: box,
      update: () => {},
      focus: () => (box.querySelector('.ui-result-heading') ?? box.querySelector('h1'))?.focus({ preventScroll: true }),
      destroy: () => shown.destroy?.(),
    };
  }

  const depth = (s) => (!s ? 0 : s.kind === 'crop' ? (s.crop.step === 'filters' ? 2 : 1) : s.kind === 'editor' ? (sheet?.open ? 1 : 0) : 1);
  /** The history step name for the screen showing at depth `k`. */
  const stepName = (k) => (k === 2 ? 'filters' : screen.kind === 'editor' ? 'sheet' : screen.kind);

  function show(w) {
    const prev = screen;
    // Left empty, the editor comes back at its top (its pages, if any came meanwhile, start there).
    if (prev?.kind === 'editor') editorScroll = editor.el.classList.contains('is-empty') ? 0 : window.scrollY;
    prev?.destroy();
    const next = make(w);
    const forward = depth(next) >= depth(prev);
    screen = next;
    ctx.root.replaceChildren(next.el);
    if (prev) {
      next.el.classList.remove('images-in-forward', 'images-in-back');
      void next.el.offsetWidth;
      next.el.classList.add(forward ? 'images-in-forward' : 'images-in-back');
    }
    if (w.kind === 'editor') {
      editor.attach();
      editor.update();
      window.scrollTo(0, prev ? editorScroll : 0);
    } else {
      window.scrollTo(0, 0);
    }
    // The first screen is focused by the router once mounted.
    if (prev) next.focus();
  }

  function render() {
    if (destroyed) return;
    const w = wanted();
    if (!screen || screen.key !== w.key) show(w);
    else screen.update();
    if (sheet) {
      if (w.kind !== 'editor' || !model.items.length) { sheet.close(); sheet = null; } else sheet.update();
    }
    // Once the camera and the crop screen have closed, the scan from Home is over: with a page, the
    // editor is as it always is; with none, once nothing is still being added, back to Home.
    if (scanFromHome && !leaving && !model.scanUnderWay()) {
      if (model.items.length) scanFromHome = false;
      else if (model.pending === 0) { leave(); return; }
    }
    if (!unwinding) syncHistory();
  }

  // ---- History steps ----

  /** How deep the browser's history is above the tool, as far as this screen knows. */
  let actual = depthOf(ctx.step);
  /** The depth a step change under way will land on. */
  let expect = null;
  let wake = null;
  let syncing = false;
  let again = false;

  function waitStep() {
    return new Promise((resolve) => {
      const done = () => {
        if (wake === done) wake = null;
        resolve();
      };
      wake = done;
      // A browser that doesn't tell: taken as done.
      setTimeout(() => {
        if (wake !== done) return;
        if (expect != null) { actual = expect; expect = null; }
        done();
      }, 1500);
    });
  }

  /** Makes the browser's history as deep as the screen showing: a step added, or taken back. */
  async function syncHistory() {
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      do {
        again = false;
        while (expect != null) await waitStep();
        if (destroyed || leaving) return;
        const d = depth(screen);
        if (d > actual) {
          for (let k = actual + 1; k <= d; k++) ctx.pushStep(stepName(k));
          actual = d;
        } else if (d < actual) {
          expect = actual - 1;
          ctx.popStep();
          again = true;
        }
      } while (again);
    } finally {
      syncing = false;
    }
  }

  /** The browser's Back (or Forward) moved between the tool's steps. */
  function onStep(step) {
    const d = depthOf(step);
    if (expect != null && d === expect) {
      actual = d;
      expect = null;
      wake?.();
      return;
    }
    actual = d;
    expect = null;
    wake?.();
    // Back: each screen above goes back as the app's Back does.
    unwinding = true;
    try {
      for (let guard = 0; guard < 4 && depth(screen) > d; guard++) {
        const s = screen;
        if (s.kind === 'result') result = null;
        else if (s.kind === 'crop' && s.crop.step === 'filters') s.crop.setStep('crop');
        else if (s.kind === 'editor') {
          // The Create PDF sheet closes.
          const open = sheet;
          sheet = null;
          open?.close();
        } else model.closeCrop();
        render();
      }
    } finally {
      unwinding = false;
    }
    syncHistory();
  }

  // ---- Starting ----

  if (ctx.params?.start === 'scan' && ctx.files?.length) {
    scanFromHome = true;
    if (fromCamera(ctx.params)) {
      model.newScan();
      model.addPhoto(ctx.files[0]);
    } else {
      model.scanImages(ctx.files);
    }
  } else if (ctx.files?.length) {
    model.addImages(ctx.files);
  }
  render();
  // What making the PDF needs comes while the images are chosen (not before the tool shows).
  preloadConvert();

  return {
    unmount() {
      destroyed = true;
      // Images left behind (the router's Discard, on Back or a link) go, and the next document starts
      // afresh, as after the app's confirmDiscard (clearAll): its first photo starts on Enhanced.
      if (!discarded && (model.items.length > 0 || model.pending > 0)) model.newScan();
      life.abort();
      model.dispose();
      sheet?.close();
      if (screen?.kind !== 'editor') screen?.destroy();
      editor.destroy();
      clearPreviews();
    },
    hasUnsavedWork() {
      return !discarded && (model.items.length > 0 || model.pending > 0);
    },
    /**
     * The app's question before the images go (UsugamiApp's confirmDiscard), which the router asks
     * on the browser's Back too: null once there is nothing to lose. Not `destructive`, as the
     * app's dialog and the editor's back arrow ask it (for a router that reads it).
     */
    discardQuestion() {
      if (discarded || (!model.items.length && model.pending === 0)) return null;
      return {
        title: t('discard_title'), message: t('discard_body'), confirm: t('discard'), dismiss: t('keep'), destructive: false,
      };
    },
    onStep,
    /**
     * Images shared to the app while this shows (Images to PDF or Scan document) are added to the
     * pages, after any still being added, as the app's addImages: the result showing goes.
     */
    receiveFiles(files) {
      if (destroyed || !files?.length) return Promise.resolve();
      return model.addImages(files);
    },
  };
}
