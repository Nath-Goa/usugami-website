// What Scan document and Images to PDF hold while they show: the pages in order, the images still
// being added, the scan going on, the crop screen and the choices for the PDF. A port of the images
// part of the app's MainViewModel.kt (and data/ImageItem.kt). The screens draw from it and call its
// actions; it calls onChange() after each change (batched to one call a turn).
import { t, tp } from '../../core/i18n.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { naturalCompare, sanitizeName, baseName, defaultPdfName } from '../../core/names.js';
import { yieldToUI } from '../../core/dom.js';
import { importImage, unsupportedMessageKey, isUnnamedPhoto } from '../../engine/images/decode.js';
import {
  findPageOnImage, startingCorners, uprightQuad, cropImage, isWhole, isUsable, isCloseTo, WHOLE,
} from '../../engine/images/crop.js';
import { PAGE_SIZES, ORIENTATIONS, MARGINS, COMPRESSION, DEFAULT_LAYOUT } from '../../engine/images/page-layout.js';

/** The name a PDF gets when the one typed is blank (PdfExporter.DEFAULT_NAME). */
export const DEFAULT_NAME = 'Usugami';

/** Sort orders of the editor's Sort menu (SortMode). */
export const SORT_MODES = ['name_asc', 'name_desc', 'reverse'];

/** The stages of a scan, in order (ScanStage): its photos taken, each image cropped, the pages' looks. */
export const SCAN_STAGES = ['photos', 'crop', 'looks'];

/** The look a scan's pages start on, as a scanner's pages are (MainViewModel.toLooks). */
export const SCAN_LOOK = 'enhanced';

const floorMod = (x, m) => ((x % m) + m) % m;
const pad = (n) => String(n).padStart(2, '0');

/** "Scan_20261109_134512.jpg": what the app names a photo taken with its Take photo. */
export function scanName(date = new Date()) {
  return `Scan_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.jpg`;
}

/** What a page is cropped from: the image as added, with the page's corners on it (ImageItem.source). */
export function sourceOf(item) {
  return item.original ?? { image: item.image, corners: WHOLE };
}

/** The page's width and height as it shows on its page, turned by its rotation (ImageItem.shownWidth). */
export function shownSize(item) {
  const sideways = item.rotation % 180 !== 0;
  return sideways ? [item.image.height, item.image.width] : [item.image.width, item.image.height];
}

/** Whether the page shows otherwise than its image (ImageItem.styled). */
export function isStyled(item) {
  return item.look !== 'original' || item.brightness !== 0 || item.contrast !== 0;
}

function readLayout() {
  const pageSize = getSetting('images.pageSize', DEFAULT_LAYOUT.pageSize);
  const orientation = getSetting('images.orientation', DEFAULT_LAYOUT.orientation);
  const margin = getSetting('images.margin', DEFAULT_LAYOUT.margin);
  return {
    pageSize: pageSize in PAGE_SIZES ? pageSize : DEFAULT_LAYOUT.pageSize,
    orientation: ORIENTATIONS.includes(orientation) ? orientation : DEFAULT_LAYOUT.orientation,
    margin: margin in MARGINS ? margin : DEFAULT_LAYOUT.margin,
  };
}

/**
 * A scan (ScanQueue), from its first photo (or the images picked with Home's Upload images) until
 * Save puts its pages in the editor, at `stage` ('photos', 'crop' or 'looks'). `pages` are its
 * images still there, in the order taken or picked: `camera` says they are photos taken for it.
 * While they are cropped, `waiting` have not been through the crop screen yet (the first is the one
 * it shows: they are always the last of `pages`), and `whole` were left whole there. `coming` are
 * images picked that are still being added. On the looks, `selected` is the page shown large (see
 * shownPage), and `sameLook` gives a look to every page of the scan; `styled` says its pages have
 * had their first look, which they get once. Its pages are in the model's items from the moment
 * each is added, but the editor and its PDF wait for Save.
 */
function newScan(fields) {
  return { stage: 'crop', camera: false, pages: [], waiting: [], whole: [], coming: 0, selected: 0, sameLook: false, styled: false, ...fields };
}

/** The image of a scan the crop screen shows, or comes to next, counted from 1 (ScanQueue.place). */
export const scanPlace = (scan) => scan.pages.length - scan.waiting.length + 1;

/** How many images a scan has, those dropped (unreadable, or removed) left out (ScanQueue.total). */
export const scanTotal = (scan) => scan.pages.length + scan.coming;

/** The page a scan's looks show large: the one selected, or else the first (ScanQueue.shownPage). */
export const shownPage = (scan) => (scan.pages.includes(scan.selected) ? scan.selected : scan.pages[0] ?? null);

/**
 * The state of the images screens. A page (an "item") is
 * `{ id, name, image, rotation, look, brightness, contrast, original }`: `image` is what goes in the
 * PDF (the image as added, or the page cropped from it: `{ bytes, type, format, width, height, name }`,
 * upright), `original` null or `{ image, corners }`, the image as added and where the page was
 * cropped on it. Items are never changed in place: a changed page is a new object.
 */
export class ImagesModel {
  /**
   * @param {{ onChange?: () => void, onMessage?: (text: string) => void, onImagesComing?: () => void,
   *   onForget?: (image: object) => void }} hooks onImagesComing: images are about to be added (the
   *   result screen goes, as in the app); onForget: an image is no longer shown (thumbnails go)
   */
  constructor({ onChange = () => {}, onMessage = () => {}, onImagesComing = () => {}, onForget = () => {} } = {}) {
    this.hooks = { onChange, onMessage, onImagesComing, onForget };
    /** The pages in order. */
    this.items = [];
    this.layout = readLayout();
    this.merge = getSetting('images.merge', true) !== false;
    const compression = getSetting('images.compression', 'recommended');
    this.compression = compression in COMPRESSION ? compression : 'recommended';
    /** Images being added, and pages being cropped: a PDF waits for them. */
    this.pending = 0;
    /** The crop screen, while it shows (CropSession). */
    this.crop = null;
    /** The ids of the pages whose crop is being made. */
    this.cropping = new Set();
    /** id → the crop being made for it, which settles once the page is in place (or isn't). */
    this.cropRuns = new Map();
    /** The crop screen is being opened (its page looked for): a second tap does nothing. */
    this.openingCrop = false;
    /** The scan going on, from its photos to its pages' looks (see newScan), or null. */
    this.scan = null;
    /** The camera app is open for a photo (a picker with capture is waiting). */
    this.cameraOpen = false;
    /**
     * The photos taken for a scan that are still being added (MainViewModel.pendingPhotos): one
     * taken out of it before it is added (its scan discarded, or every image) isn't added.
     */
    this.pendingPhotos = new Set();
    /** A PDF is being made. */
    this.converting = false;
    /** The choices of the last attempt that made no PDF, so the Create PDF sheet opens with them. */
    this.lastChoices = null;
    this.importBatches = 0;
    this.allPagesChoice = null;
    this.generation = 0;
    this.importChain = Promise.resolve();
    this.nextId = 1;
    this.openings = 0;
    this.scans = 0;
    this.scheduled = false;
    this.disposed = false;
  }

  /** Tells the screens, once this turn's changes are done. */
  changed() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.disposed) this.hooks.onChange();
    });
  }

  message(text) {
    if (!this.disposed) this.hooks.onMessage(text);
  }

  /** Stops telling the screens: the tool has gone. Work still running ends quietly. */
  dispose() {
    this.disposed = true;
    this.generation++;
  }

  item(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  newItem(image) {
    return { id: this.nextId++, name: image.name, image, rotation: 0, look: 'original', brightness: 0, contrast: 0, original: null };
  }

  // ---- Picking images ----

  /** Adds images picked, dropped, pasted or shared, after any still being added. */
  addImages(files) {
    return this.importImages(files);
  }

  /**
   * Adds the images picked with Home's Upload images as a scan, which takes each through the crop
   * screen in turn, the first as soon as it is added, then on to their looks. Over a scan already
   * going on, they are added as images picked in the editor are.
   */
  scanImages(files) {
    if (!files.length) return null;
    if (this.scan) return this.addImages(files);
    const scan = ++this.scans;
    this.setScan(newScan({ stage: 'crop', coming: files.length }));
    return this.importImages(files, (added) => {
      const queue = this.scan;
      if (scan !== this.scans || !queue) return;
      const left = { ...queue, coming: queue.coming - 1 };
      if (!added) {
        this.setScan(left);
      } else if (left.stage === 'looks') {
        // Stopped cropping while it was being added: it is one of the pages given their looks.
        this.replaceItem(this.withScanLook(added, left));
        this.setScan({ ...left, pages: [...left.pages, added.id] });
      } else {
        this.setScan({ ...left, pages: [...left.pages, added.id], waiting: [...left.waiting, added.id] });
      }
      this.advanceScan();
      this.endScanIfEmpty();
    });
  }

  /** How many photos taken for a scan are still being added. */
  get photosAdding() {
    return this.pendingPhotos.size;
  }

  /**
   * Adds `files` after any still being added (one batch at a time, in the order they came);
   * `each(item | null)` hears of each in turn. Says how many were skipped or couldn't be read.
   */
  importImages(files, each = () => {}) {
    if (!files?.length) return null;
    const batch = ++this.importBatches;
    this.hooks.onImagesComing();
    this.pending += files.length;
    this.changed();
    const generation = this.generation;
    const run = this.importChain.then(async () => {
      let unsupported = 0;
      let failed = 0;
      try {
        for (const file of files) {
          // Discarded while waiting its turn.
          if (generation !== this.generation) return;
          let r;
          try {
            r = await importImage(file);
          } catch {
            r = { status: 'failed' };
          }
          // Discarded while it was being read.
          if (generation !== this.generation) return;
          let added = null;
          if (r.status === 'added') {
            added = this.withAllPagesChoice(this.newItem(r.image), batch);
            this.setItems([...this.items, added]);
          } else if (r.status === 'unsupported') {
            unsupported++;
          } else {
            failed++;
          }
          this.pending--;
          this.changed();
          each(added);
          await yieldToUI();
        }
      } finally {
        // Nothing to report about images the user has discarded.
        if (generation === this.generation) {
          if (unsupported > 0) this.message(tp(await unsupportedMessageKey(), unsupported));
          if (failed > 0) this.message(tp('msg_failed_import', failed));
        }
      }
    });
    this.importChain = run.catch(() => {});
    return run;
  }

  /** `item`, just added from batch `batch`, with the look Apply to all pages gave every page meanwhile. */
  withAllPagesChoice(item, batch) {
    const choice = this.allPagesChoice;
    if (!choice || batch > choice.through) return item;
    return { ...item, look: choice.look, brightness: choice.brightness, contrast: choice.contrast };
  }

  // ---- Taking photos ----

  /**
   * Starts a scan with its camera, unless one is going on already, as when Take another opens the
   * camera for the next photo. Returns whether the scan takes photos now: not while another scan is
   * past its photos, a page's crop screen shows or opens, or a PDF is being made.
   */
  startScan() {
    if (this.scan) return this.scan.stage === 'photos' && this.scan.camera;
    if (this.crop || this.openingCrop || this.converting) return false;
    this.scans++;
    this.setScan(newScan({ stage: 'photos', camera: true }));
    return true;
  }

  /**
   * The camera app (the picker) has closed: with `file`, the photo taken, which is added to the scan
   * taking photos; without, nothing, and a scan that has no photo is then over.
   */
  photoTaken(file) {
    this.cameraOpen = false;
    if (file) this.addPhoto(file);
    else this.endScanIfEmpty();
    this.changed();
  }

  /**
   * Adds a photo just taken after any images still being added, as the scan's next photo. A photo
   * the browser gives no useful name is named as the app names its photos, Scan_ and the time. One
   * whose scan was discarded while it was being added isn't added; with no scan taking photos, it
   * is a page as it is.
   */
  addPhoto(file) {
    this.pending++;
    const photo = {};
    this.pendingPhotos.add(photo);
    this.changed();
    const generation = this.generation;
    const named = isUnnamedPhoto(file.name) ? { ...file, name: scanName(new Date()) } : file;
    const run = this.importChain.then(async () => {
      if (generation !== this.generation) return;
      let r;
      try {
        r = await importImage(named);
      } catch {
        r = { status: 'failed' };
      }
      if (generation !== this.generation) return;
      this.pending--;
      // Its scan was discarded while it was being added (see discardScan).
      const dropped = !this.pendingPhotos.delete(photo);
      if (r.status === 'added' && !dropped) {
        const scan = this.scan?.stage === 'photos' && this.scan.camera ? this.scan : null;
        // Taken after going back to the photos of a scan whose pages have had their first look: it
        // starts as they did (see toLooks), which is given only once.
        const item = scan?.styled ? this.withScanLook(this.newItem(r.image), scan) : this.newItem(r.image);
        this.setItems([...this.items, item]);
        // In the same step as it joins the list: the scan is never seen without it.
        const now = this.scan;
        if (scan && now?.stage === 'photos' && now.camera) this.setScan({ ...now, pages: [...now.pages, item.id] });
      } else if (!dropped) {
        this.message(tp('msg_failed_import', 1));
      }
      // A scan whose only photo couldn't be added is over.
      this.endScanIfEmpty();
      this.changed();
    });
    this.importChain = run.catch(() => {});
    return run;
  }

  // ---- Editing ----

  rotate(id, degrees) {
    this.setItems(this.items.map((i) => (i.id === id ? { ...i, rotation: floorMod(i.rotation + degrees, 360) } : i)));
  }

  remove(id) {
    const item = this.item(id);
    if (!item) return;
    this.setItems(this.items.filter((i) => i !== item));
    this.forget(item);
  }

  /** Removes every image, including those still being added, and ends a scan going on. */
  clearAll() {
    this.generation++;
    this.pending = 0;
    this.pendingPhotos.clear();
    this.scan = null;
    this.crop = null;
    const all = this.items;
    this.setItems([]);
    all.forEach((i) => this.forget(i));
  }

  forget(item) {
    this.hooks.onForget(item.image);
    if (item.original) this.hooks.onForget(item.original.image);
  }

  /** Moves the page at `from` to `to` (places in the list). */
  move(from, to) {
    const list = this.items.slice();
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return false;
    list.splice(to, 0, ...list.splice(from, 1));
    this.setItems(list);
    return true;
  }

  /** Moves page `id` one place earlier (-1) or later (+1). */
  moveBy(id, offset) {
    const from = this.items.findIndex((i) => i.id === id);
    if (from < 0) return false;
    return this.move(from, from + offset);
  }

  sort(mode) {
    const list = this.items.slice();
    const byName = () => list.sort((a, b) => naturalCompare(a.name, b.name));
    if (mode === 'name_asc') byName();
    else if (mode === 'name_desc') byName().reverse();
    else list.reverse();
    this.setItems(list);
  }

  setLayout(layout) {
    this.layout = { ...layout };
    setSetting('images.pageSize', layout.pageSize);
    setSetting('images.orientation', layout.orientation);
    setSetting('images.margin', layout.margin);
    this.changed();
  }

  setMerge(merge) {
    this.merge = !!merge;
    setSetting('images.merge', this.merge);
  }

  setCompression(level) {
    this.compression = level;
    setSetting('images.compression', level);
  }

  setItems(list) {
    this.items = list;
    if (!list.length) this.lastChoices = null;
    // A scan's images that have gone are left out of it at once, so that it counts its images and
    // finishes on its last as it is now. A scan left with none is over.
    const scan = this.scan;
    if (scan) {
      const ids = new Set(list.map((i) => i.id));
      if (!scan.pages.every((id) => ids.has(id))) {
        const kept = (l) => l.filter((id) => ids.has(id));
        this.scan = {
          ...scan, pages: kept(scan.pages), waiting: kept(scan.waiting), whole: kept(scan.whole), selected: ids.has(scan.selected) ? scan.selected : 0,
        };
        this.endScanIfEmpty();
      }
    }
    // The crop screen's image has gone: there is nothing to crop. A scan goes on with its next.
    const session = this.crop;
    if (session && !list.some((i) => i.id === session.itemId)) {
      this.crop = null;
      if (session.staged) this.advanceScan();
    }
    this.changed();
  }

  setScan(scan) {
    this.scan = scan;
    this.changed();
  }

  replaceItem(item) {
    this.setItems(this.items.map((i) => (i.id === item.id ? item : i)));
  }

  // ---- Cropping ----

  /**
   * Opens the crop screen for page `id`, the editor's, with its corners on the page if one is found.
   * Not while a scan goes on, whose pages the editor doesn't show.
   */
  openCrop(id) {
    const item = this.item(id);
    // Not while its last crop is being made: it would start from the page before.
    if (!item || this.cropping.has(id) || this.scan) return;
    this.openCropFor(item, { fromCamera: false });
  }

  /**
   * Opens the crop screen for `item` once its page has been looked for, with its own look. An image
   * of a scan (`staged`, the first it waits for) whose page is still being made is opened once it
   * is, with the corners it was made with; one that can't be opened is left out of the scan's
   * cropping.
   */
  openCropFor(item, { fromCamera, staged = false }) {
    if (this.openingCrop || this.crop || this.converting) return;
    this.openingCrop = true;
    this.changed();
    const generation = this.generation;
    // The scan's next image, as long as it still is: Back may go to the image before meanwhile.
    const next = () => !staged || (this.scan?.stage === 'crop' && this.scan.waiting[0] === item.id);
    (async () => {
      try {
        // Gone back to, as its page is made: opened now, it would be cropped again from the photo,
        // and the page being made would then take the place of the new one.
        let opening = item;
        if (staged && this.cropRuns.has(item.id)) {
          await this.cropRuns.get(item.id);
          if (generation !== this.generation || !next()) return;
          opening = this.item(item.id);
          if (!opening) return;
        }
        const source = sourceOf(opening);
        let outline = null;
        try {
          outline = await findPageOnImage(source.image);
        } catch {
          outline = null;
        }
        if (generation !== this.generation) return;
        // Removed or cropped meanwhile, or being made into a PDF; or the scan it is next in went
        // back, or on, while its page was looked for.
        const current = this.item(item.id);
        if (!current || sourceOf(current).image !== source.image || this.converting || !next()) return;
        const { corners: reset, foundPage } = startingCorners(outline);
        const scan = staged ? this.scan : null;
        this.crop = {
          itemId: item.id,
          fromCamera: fromCamera || !!scan?.camera,
          rotation: current.rotation,
          // A scan's image left whole comes back whole, as a page cropped comes back on its corners.
          start: scan?.whole.includes(item.id) ? WHOLE : current.original?.corners ?? reset,
          found: reset,
          foundPage,
          opened: ++this.openings,
          look: current.look,
          adjustments: { brightness: current.brightness, contrast: current.contrast },
          staged,
        };
      } finally {
        this.openingCrop = false;
        if (staged && !this.crop && generation === this.generation) {
          // It couldn't be opened, and is left as it is. Once the scan has gone back to the image
          // before (or on), that one opens instead.
          const scan = this.scan;
          if (scan?.stage === 'crop' && scan.waiting[0] === item.id) this.setScan({ ...scan, waiting: scan.waiting.slice(1) });
          this.advanceScan();
        }
        this.changed();
      }
    })();
  }

  /**
   * While a scan's images are cropped, opens the crop screen for the next, unless it shows (or
   * opens) already, and goes on to the looks once each image has been through it; a scan left with
   * none is over. One still being added is waited for.
   */
  advanceScan() {
    const scan = this.scan;
    if (scan?.stage !== 'crop') return;
    if (!scan.waiting.length && scan.coming === 0) {
      if (!scan.pages.length) this.setScan(null);
      else this.toLooks(scan);
      return;
    }
    // Not over a PDF being made, which has the pages as they are (and none is made during a scan).
    if (this.crop || this.openingCrop || this.converting) return;
    const next = scan.waiting[0];
    if (next == null) return;
    this.openCropFor(this.item(next), { fromCamera: false, staged: true });
  }

  /**
   * The scan goes on to its pages' looks, the first page shown large: the first time, each page
   * starts on Enhanced, as a scanner's pages are. Only the scan's pages: those in the editor before
   * keep theirs.
   */
  toLooks(scan) {
    if (!scan.styled) {
      const ids = new Set(scan.pages);
      this.setItems(this.items.map((i) => (ids.has(i.id) ? { ...i, look: SCAN_LOOK, brightness: 0, contrast: 0 } : i)));
    }
    this.setScan({ ...(this.scan ?? scan), stage: 'looks', waiting: [], styled: true });
  }

  /** Ends the scan once it has nothing left: no image, none still being added, and no photo on its way. */
  endScanIfEmpty() {
    const scan = this.scan;
    if (!scan) return;
    const photoComing = scan.stage === 'photos' && (this.cameraOpen || this.pendingPhotos.size > 0);
    if (!scan.pages.length && scan.coming === 0 && !photoComing) this.setScan(null);
  }

  /**
   * Done on a scan's photos: each is cropped in turn, in the order taken. Not while a photo is still
   * on its way, which would miss its turn.
   */
  cropScan() {
    const scan = this.scan;
    if (scan?.stage !== 'photos' || !scan.pages.length || this.cameraOpen || this.pendingPhotos.size) return;
    this.setScan({ ...scan, stage: 'crop', waiting: scan.pages.slice() });
    this.advanceScan();
  }

  /**
   * Back while a scan's images are cropped: the image before, with the corners it was given (once
   * its page is made, if it still is being made). On the first image, a scan's photos show again,
   * nothing lost; images picked stop being cropped (see stopScanCropping). The corners moved on the
   * image left, and not given to it with Next, are forgotten.
   */
  scanBack() {
    const scan = this.scan;
    if (scan?.stage !== 'crop') return;
    const done = scan.pages.length - scan.waiting.length;
    if (done === 0) {
      if (!scan.camera) {
        this.stopScanCropping();
        return;
      }
      this.crop = null;
      this.setScan({ ...scan, stage: 'photos', waiting: [] });
      return;
    }
    this.crop = null;
    this.setScan({ ...scan, waiting: [scan.pages[done - 1], ...scan.waiting] });
    this.advanceScan();
  }

  /**
   * A scan's photo on the crop screen discarded: it goes, and the scan goes on with the next (or to
   * the looks, after its last; the scan is over with none left).
   */
  discardScanPhoto() {
    const session = this.crop;
    if (!session?.staged || !this.scan?.camera) return;
    // Which closes the screen and goes on (see setItems).
    this.remove(session.itemId);
  }

  /**
   * Stop cropping, on a scan of images picked: those not cropped yet stay whole, also those still
   * being added, and the scan goes on to its pages' looks. With none added yet, the scan is over,
   * and they are added as they come, as images picked in the editor are.
   */
  stopScanCropping() {
    const scan = this.scan;
    if (scan?.stage !== 'crop' || scan.camera) return;
    this.crop = null;
    if (!scan.pages.length) this.setScan(null);
    else this.toLooks(scan);
  }

  /** Leaving a scan's photos for good: they go, also those still being added, and the scan is over. */
  discardScan() {
    const scan = this.scan;
    if (scan?.stage !== 'photos' || !scan.camera) return;
    // A photo taken out of the list while it is being added isn't added (see addPhoto).
    this.pendingPhotos.clear();
    this.setScan(null);
    const ids = new Set(scan.pages);
    const gone = this.items.filter((i) => ids.has(i.id));
    this.setItems(this.items.filter((i) => !ids.has(i.id)));
    gone.forEach((i) => this.forget(i));
  }

  /** Shows the scan's page `id` large on its looks. */
  selectScanPage(id) {
    const scan = this.scan;
    if (scan?.stage !== 'looks' || !scan.pages.includes(id)) return;
    this.setScan({ ...scan, selected: id });
  }

  /** Gives `look` to the page shown large on the scan's looks, or to each of its pages with sameLook. */
  setScanLook(look) {
    this.styleScan((i) => ({ ...i, look }));
  }

  /** As setScanLook, for the brightness and contrast: `{ brightness, contrast }`. */
  setScanAdjustments({ brightness, contrast }) {
    this.styleScan((i) => ({ ...i, brightness, contrast }));
  }

  /**
   * The same look for every page of the scan, or not: turned on, each takes the look, brightness
   * and contrast of the page shown; turned off, each keeps what it has.
   */
  setScanSameLook(on) {
    const scan = this.scan;
    if (scan?.stage !== 'looks') return;
    this.setScan({ ...scan, sameLook: !!on });
    if (!on) return;
    const shown = this.item(shownPage(scan));
    if (shown) this.styleScan((i) => ({ ...i, look: shown.look, brightness: shown.brightness, contrast: shown.contrast }));
  }

  /** `style` given to the page shown large on the scan's looks, or to each of its pages with sameLook. */
  styleScan(style) {
    const scan = this.scan;
    if (scan?.stage !== 'looks') return;
    const ids = new Set(scan.sameLook ? scan.pages : [shownPage(scan)]);
    this.setItems(this.items.map((i) => (ids.has(i.id) ? style(i) : i)));
  }

  /** `item`, a page coming to the scan's looks late, with the look the scan's pages start on. */
  withScanLook(item, scan) {
    const shown = scan.sameLook ? this.item(shownPage(scan)) : null;
    return { ...item, look: shown?.look ?? SCAN_LOOK, brightness: shown?.brightness ?? 0, contrast: shown?.contrast ?? 0 };
  }

  /** Back on the scan's looks: its last image's crop screen again. */
  scanLooksBack() {
    const scan = this.scan;
    if (scan?.stage !== 'looks') return;
    const last = scan.pages.at(-1);
    if (last == null) return;
    this.setScan({ ...scan, stage: 'crop', waiting: [last] });
    this.advanceScan();
  }

  /**
   * Save on the scan's looks: the scan is over, and its pages are in the editor, in its order, after
   * the pages that were there.
   */
  saveScan() {
    const scan = this.scan;
    if (scan?.stage !== 'looks') return;
    this.setScan(null);
    const ids = new Set(scan.pages);
    const byId = new Map(this.items.map((i) => [i.id, i]));
    this.setItems([...this.items.filter((i) => !ids.has(i.id)), ...scan.pages.map((id) => byId.get(id)).filter(Boolean)]);
  }

  /**
   * Crops the crop screen's page to `corners` (as the screen shows the image, turned `rotation`
   * degrees clockwise, which the page takes), gives it `look` and `adjustments` (and every page,
   * with `allPages`) and closes the screen; the page is made in the background. The whole image
   * puts the page back as it was added. Returns false, the screen staying open, when the corners
   * don't make a page. An image of a scan takes its corners and turn alone, and the scan goes on
   * (see finishScanImage).
   */
  finishCrop({ corners, look = null, allPages = false, adjustments = null, rotation = null }) {
    const session = this.crop;
    if (!session) return false;
    const picked = this.item(session.itemId);
    if (!picked) {
      this.crop = null;
      this.changed();
      return false;
    }
    if (session.staged) return this.finishScanImage(session, picked, corners, rotation);
    const source = sourceOf(picked);
    const turn = floorMod(rotation ?? session.rotation, 360);
    const quad = uprightQuad(corners, turn);
    const whole = isWhole(quad);
    if (!whole && !isUsable(quad, source.image.width, source.image.height)) return false;
    this.crop = null;
    // The look first, so the page cropped in the background keeps it.
    const chosen = look ?? picked.look;
    const adjusted = adjustments ?? { brightness: picked.brightness, contrast: picked.contrast };
    if (allPages) {
      this.setItems(this.items.map((i) => ({ ...i, look: chosen, brightness: adjusted.brightness, contrast: adjusted.contrast })));
      // And the images still being added, such as those shared meanwhile, as each comes.
      this.allPagesChoice = { look: chosen, brightness: adjusted.brightness, contrast: adjusted.contrast, through: this.importBatches };
    }
    const base = this.item(session.itemId) ?? picked;
    const item = { ...base, look: chosen, brightness: adjusted.brightness, contrast: adjusted.contrast, rotation: turn };
    this.replaceItem(item);
    this.cropTo(item, source, quad);
    this.changed();
    return true;
  }

  /**
   * Next on a scan's image: its page is cropped to `corners` (as the screen shows the image, turned
   * `rotation` degrees clockwise, which the page takes) in the background, and the scan goes on with
   * its next image, or to its pages' looks after the last. As finishCrop, false keeps the screen.
   */
  finishScanImage(session, picked, corners, rotation) {
    const source = sourceOf(picked);
    const turn = floorMod(rotation ?? session.rotation, 360);
    const quad = uprightQuad(corners, turn);
    const whole = isWhole(quad);
    if (!whole && !isUsable(quad, source.image.width, source.image.height)) return false;
    this.crop = null;
    const item = picked.rotation === turn ? picked : { ...picked, rotation: turn };
    if (item !== picked) this.replaceItem(item);
    this.cropTo(item, source, quad);
    const scan = this.scan;
    if (scan) {
      const others = scan.whole.filter((id) => id !== item.id);
      this.setScan({ ...scan, waiting: scan.waiting.filter((id) => id !== item.id), whole: whole ? [...others, item.id] : others });
    }
    // In the same step: the next image's opening (or the looks) follows this one at once.
    this.advanceScan();
    this.changed();
    return true;
  }

  /** `item`'s page made from `source`, cropped inside `quad`, in the background; the whole image puts it back as it was. */
  cropTo(item, source, quad) {
    const whole = isWhole(quad);
    const unchanged = whole ? item.original == null : (item.original != null && isCloseTo(item.original.corners, quad));
    if (unchanged) return;
    if (whole) {
      this.hooks.onForget(item.image);
      this.replaceItem({ ...item, image: source.image, original: null });
    } else {
      this.cropPage(item, source, quad);
    }
  }

  /**
   * Leaves the crop screen without cropping: a page cropped again stays as it was. A scan's image
   * has ways of its own (scanBack, discardScanPhoto, stopScanCropping).
   */
  closeCrop() {
    const session = this.crop;
    if (!session || session.staged) return;
    this.crop = null;
    this.changed();
  }

  /**
   * Whether a scan's page is still to reach the editor: the camera app is open, a scan goes on (at
   * any stage), or the crop screen shows or is being opened. A page cropped again in the background
   * is in the editor already.
   */
  scanUnderWay() {
    return this.cameraOpen || this.openingCrop || this.crop != null || this.scan != null;
  }

  /** Makes `item`'s page from `source`, straightened inside `quad`, and puts it in place. */
  cropPage(item, source, quad) {
    const id = item.id;
    const generation = this.generation;
    this.cropping.add(id);
    this.pending++;
    this.changed();
    // The page as it was when its corners were chosen, if it still is: not removed, nor its image changed.
    const stillAsChosen = () => {
      const now = this.item(id);
      return now && now.image === item.image && sourceOf(now).image === source.image ? now : null;
    };
    const run = (async () => {
      let page = null;
      try {
        // Not made for a page removed while it waited its turn.
        if (stillAsChosen()) page = await cropImage(source.image, quad);
      } catch {
        page = null;
      } finally {
        this.cropping.delete(id);
      }
      if (generation !== this.generation) {
        this.changed();
        return;
      }
      this.pending--;
      const current = stillAsChosen();
      if (!current) {
        // Removed meanwhile: nothing to say about it.
      } else if (!page) {
        this.message(t('crop_failed'));
      } else {
        this.hooks.onForget(current.image === source.image ? null : current.image);
        this.replaceItem({ ...current, image: { ...page, name: source.image.name }, original: { image: source.image, corners: quad } });
      }
      this.changed();
    })();
    const settled = run.catch(() => {}).finally(() => { if (this.cropRuns.get(id) === settled) this.cropRuns.delete(id); });
    this.cropRuns.set(id, settled);
  }

  // ---- Converting ----

  /** What the Create PDF sheet starts with: the last attempt's choices if it made no PDF, else the defaults. */
  initialChoices() {
    return this.lastChoices ?? { fileName: this.defaultFileName(), ocrLanguage: null };
  }

  /** The name suggested for a merged PDF: the image's own for one image, else a time stamp. */
  defaultFileName() {
    if (this.items.length === 1) return sanitizeName(baseName(this.items[0].name), DEFAULT_NAME);
    return defaultPdfName();
  }

  /**
   * Whether a PDF can be made now: pages, nothing still being added, no crop screen showing or
   * opening, and no scan going on, whose photos are in the list before they are cropped and given
   * their looks.
   */
  canConvert() {
    return this.items.length > 0 && !this.converting && this.pending === 0 && !this.crop && !this.openingCrop && !this.scan;
  }

  setConverting(on) {
    this.converting = !!on;
    this.changed();
  }
}
