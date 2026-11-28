// Scan document and Images to PDF (the app's editor, a scan's screens, the crop screen, the Create
// PDF sheet and the result, as UsugamiApp.kt routes "images"): one module for both tools.
// ctx.params.start === 'scan' starts a scan with ctx.files from Home's Scan document card: a photo
// (ctx.params.camera) joins the scan's Photos, where Take another and Done follow; uploaded images go
// through the crop screen one after another. Either way the scan then has one Filters screen for all
// its pages, and Save puts them in the editor. Without files, or as Images to PDF, the editor shows,
// taking images picked, dropped, pasted or shared; its own Take photo starts the same kind of scan.
//
// The inner screens are history steps, so the browser's Back (a phone's Back) goes back as the
// app's does: from the result to the editor; from a page's Filters to its Crop page, and from there
// to the editor; and on a scan's screens, which are one step above the editor, as each screen's own
// back arrow (the photos ask before they go; an image goes back to the one before; Filters goes back
// to the last image).
import { h, ensureCss } from '../../core/dom.js';
import { loadStrings, t } from '../../core/i18n.js';
import { snackbar, alertDialog } from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { showResult } from '../../core/output.js';
import { IMAGE_ACCEPT } from '../../engine/images/image-type.js';
import { ImagesModel, scanPlace } from './model.js';
import { createEditor } from './editor.js';
import { createCropScreen, createScanWaiting } from './crop-screen.js';
import { createScanPhotos } from './scan-photos.js';
import { createScanLooks } from './scan-looks.js';
import { openConvertSheet, convert, preloadConvert } from './convert.js';
import { forgetPreviews, clearPreviews } from './preview.js';

/** How deep each inner screen is in the browser's history above the tool (sheet: Create PDF's). */
const STEP_DEPTH = { crop: 1, waiting: 1, result: 1, sheet: 1, photos: 1, looks: 1, filters: 2 };
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
  /**
   * Opens the camera app (a picker on computers) for the scan's next photo, a scan starting with it
   * if none is going on; the photo joins the scan's Photos when it comes back. Once per tap: not
   * while the camera is open. Call from a click.
   */
  const takePhoto = () => {
    if (model.cameraOpen || !model.startScan()) return;
    model.cameraOpen = true;
    model.changed();
    pickFiles({ accept: 'image', capture: 'environment' }).then((files) => {
      if (!destroyed) model.photoTaken(files[0] ?? null);
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
    // Not while a PDF is being made, nor while a page's crop screen is opening, nor once a scan has
    // started, whose photos are to be cropped first.
    if (model.converting || model.openingCrop || model.scan || !model.items.length || model.pending > 0) return;
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
    const scan = model.scan;
    if (scan?.stage === 'photos') return { kind: 'photos', key: 'photos' };
    if (scan?.stage === 'looks') return { kind: 'looks', key: 'looks' };
    // Cropping, the next image awaited (still being added, or its page looked for).
    if (scan) return { kind: 'waiting', key: `waiting:${scanPlace(scan)}` };
    return { kind: 'editor', key: 'editor' };
  }

  /**
   * Where a screen is in a scan, to slide the later one in over the earlier: its stage, then the
   * image among the scan's (null for a screen that isn't a scan's).
   */
  function scanPosition(s) {
    if (!s) return null;
    if (s.kind === 'photos') return [0, 0];
    if (s.kind === 'looks') return [2, 0];
    if (s.kind === 'waiting') return [1, s.place];
    if (s.kind === 'crop' && s.crop.staged) return [1, s.place];
    return null;
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
        scan: () => (session.staged ? model.scan : null),
        pageCount: () => model.items.length,
        onStep: () => syncHistory(),
        actions: {
          done: (choices) => model.finishCrop(choices),
          close: () => model.closeCrop(),
          back: () => model.scanBack(),
          discard: () => model.discardScanPhoto(),
          stop: () => model.stopScanCropping(),
        },
      });
      const place = session.staged && model.scan ? model.scan.pages.indexOf(session.itemId) + 1 : 0;
      return { ...w, el: crop.el, crop, place, update: () => crop.update(), focus: () => crop.focus(), back: () => crop.back(), destroy: () => crop.destroy() };
    }
    if (w.kind === 'waiting') {
      const waiting = createScanWaiting({ scan: () => model.scan, onBack: () => model.scanBack(), onStop: () => model.stopScanCropping() });
      return {
        ...w, el: waiting.el, place: scanPlace(model.scan), update: () => waiting.update(), focus: () => waiting.focus(), back: () => model.scanBack(), destroy: () => waiting.destroy(),
      };
    }
    if (w.kind === 'photos') {
      const photos = createScanPhotos({
        model,
        actions: {
          takePhoto: () => takePhoto(),
          done: () => model.cropScan(),
          remove: (id) => model.remove(id),
          discard: () => model.discardScan(),
        },
      });
      return { ...w, el: photos.el, update: () => photos.update(), focus: () => photos.focus(), back: () => photos.back(), destroy: () => photos.destroy() };
    }
    if (w.kind === 'looks') {
      const looks = createScanLooks({ model, actions: { back: () => model.scanLooksBack(), save: () => model.saveScan() } });
      return { ...w, el: looks.el, update: () => looks.update(), focus: () => looks.focus(), back: () => looks.back(), destroy: () => looks.destroy() };
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
    // A scan's later stage, or later image, comes in over the one before, and the one before comes
    // back from the other side; elsewhere a deeper screen comes over. The image awaited takes the
    // place of its wait without a slide.
    const from = scanPosition(prev);
    const to = scanPosition(next);
    const awaited = prev?.kind === 'waiting' && next.kind === 'crop' && from && to && from[1] === to[1];
    const forward = from && to ? (to[0] - from[0] || to[1] - from[1]) >= 0 : depth(next) >= depth(prev);
    screen = next;
    ctx.root.replaceChildren(next.el);
    if (prev && !awaited) {
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
    // Once the camera and the scan's screens have closed, the scan from Home is over: with a page,
    // the editor is as it always is; with none, once nothing is still being added, back to Home,
    // straight from the scan's screen rather than by way of the empty editor (the photos discarded,
    // the last photo removed or discarded, cropping stopped before an image came, nothing that
    // could be read).
    if (scanFromHome && !leaving && !model.scanUnderWay()) {
      if (model.items.length) scanFromHome = false;
      else if (model.pending === 0) { leave(); return; }
    }
    if (leaving && screen && screen.kind !== 'editor') return;
    const w = wanted();
    if (!screen || screen.key !== w.key) show(w);
    else screen.update();
    if (sheet) {
      if (w.kind !== 'editor' || !model.items.length) { sheet.close(); sheet = null; } else sheet.update();
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

  /**
   * The browser's Back (or Forward) moved between the tool's steps. Each step gone back over is the
   * Back of the screen showing then, as the app's Back: the result goes, a page's Filters goes back
   * to Crop page and Crop page to the editor, the sheet closes; a scan's screen does what its back
   * arrow does, and stays a step above the editor while the scan goes on.
   */
  function onStep(step) {
    const d = depthOf(step);
    if (expect != null && d === expect) {
      actual = d;
      expect = null;
      wake?.();
      return;
    }
    const lost = actual - d;
    actual = d;
    expect = null;
    wake?.();
    unwinding = true;
    try {
      for (let k = 0; k < Math.min(lost, 4) && depth(screen) > 0; k++) {
        const s = screen;
        if (s.kind === 'result') result = null;
        else if (s.kind === 'crop' && s.crop.step === 'filters') s.crop.setStep('crop');
        else if (s.kind === 'editor') {
          // The Create PDF sheet closes.
          const open = sheet;
          sheet = null;
          open?.close();
        } else if (s.back) s.back();
        else model.closeCrop();
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
      // Home's Take photo: the camera has given its photo, the scan's first.
      model.startScan();
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
