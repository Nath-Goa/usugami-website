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

/**
 * The look chosen last on the crop screen, which the next photo taken (or image of a scan) starts
 * with, so pages scanned one after another look alike; null for Enhanced, which a new scan starts
 * on. Kept beside the screens, as the app keeps it beside its editor, until a new scan or Remove all.
 */
let lastLook = null;

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
    /** The crop screen is being opened (its page looked for): a second tap does nothing. */
    this.openingCrop = false;
    /** The images picked with Upload images that are still to go through the crop screen (ScanQueue). */
    this.scan = null;
    /** The camera app is open for a photo (a picker with capture is waiting). */
    this.cameraOpen = false;
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
   * Adds the images picked with Home's Upload images, and takes each through the crop screen in
   * turn, the first as soon as it is added: a new scan.
   */
  scanImages(files) {
    if (!files.length) return null;
    this.newScan();
    const scan = ++this.scans;
    this.scan = { waiting: [], coming: files.length, done: 0 };
    this.changed();
    return this.importImages(files, (added) => {
      const queue = this.scan;
      if (scan === this.scans && queue) {
        this.scan = { ...queue, waiting: added ? [...queue.waiting, added.id] : queue.waiting, coming: queue.coming - 1 };
        this.advanceScan();
      }
    });
  }

  /** A scan from Home starts a new document, whose first page starts on Enhanced again. */
  newScan() {
    lastLook = null;
  }

  /** The look the next photo or image of a scan starts with. */
  get lastLook() {
    return lastLook ?? 'enhanced';
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
   * Adds a photo just taken after any images still being added, and opens the crop screen for it.
   * A photo the browser gives no useful name is named as the app names its photos, Scan_ and the
   * time.
   */
  addPhoto(file) {
    this.pending++;
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
      if (r.status === 'added') {
        const item = this.newItem(r.image);
        this.setItems([...this.items, item]);
        this.openCropFor(item, { fromCamera: true });
      } else {
        this.message(tp('msg_failed_import', 1));
      }
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

  /** Removes every image, including those still being added. */
  clearAll() {
    this.generation++;
    this.pending = 0;
    this.scan = null;
    // What comes next starts a new document.
    this.newScan();
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
    // A scan's images that have gone are left out of it at once, so it counts and ends right.
    const scan = this.scan;
    if (scan) {
      const ids = new Set(list.map((i) => i.id));
      if (!scan.waiting.every((id) => ids.has(id))) this.scan = { ...scan, waiting: scan.waiting.filter((id) => ids.has(id)) };
    }
    // The crop screen's image has gone: there is nothing to crop. A scan goes on with its next.
    const session = this.crop;
    if (session && !list.some((i) => i.id === session.itemId)) {
      this.crop = null;
      if (session.queued) this.advanceScan();
    }
    this.changed();
  }

  replaceItem(item) {
    this.setItems(this.items.map((i) => (i.id === item.id ? item : i)));
  }

  // ---- Cropping ----

  /** Opens the crop screen for page `id`, with its corners on the page if one is found. */
  openCrop(id) {
    const item = this.item(id);
    // Not while its last crop is being made: it would start from the page before.
    if (!item || this.cropping.has(id)) return;
    this.openCropFor(item, { fromCamera: false });
  }

  /**
   * Opens the crop screen for `item` once its page has been looked for: a photo just taken
   * (fromCamera) or an image of a scan (queued) starts with the look chosen last, any other page
   * with its own. An image of a scan that can't be opened is left out of it.
   */
  openCropFor(item, { fromCamera, queued = false }) {
    if (this.openingCrop || this.crop || this.converting) return;
    this.openingCrop = true;
    this.changed();
    const generation = this.generation;
    (async () => {
      try {
        const source = sourceOf(item);
        let outline = null;
        try {
          outline = await findPageOnImage(source.image);
        } catch {
          outline = null;
        }
        if (generation !== this.generation) return;
        // Removed or cropped meanwhile, or being made into a PDF; or the scan stopped meanwhile.
        const current = this.item(item.id);
        if (!current || sourceOf(current).image !== source.image || this.converting) return;
        if (queued && this.scan?.waiting[0] !== item.id) return;
        const { corners: reset, foundPage } = startingCorners(outline);
        this.crop = {
          itemId: item.id,
          fromCamera,
          rotation: current.rotation,
          start: current.original?.corners ?? reset,
          found: reset,
          foundPage,
          opened: ++this.openings,
          look: fromCamera || queued ? this.lastLook : current.look,
          adjustments: { brightness: current.brightness, contrast: current.contrast },
          queued,
        };
      } finally {
        this.openingCrop = false;
        if (queued && !this.crop && generation === this.generation) {
          if (this.scan) this.scan = { ...this.scan, waiting: this.scan.waiting.filter((x) => x !== item.id) };
          this.advanceScan();
        }
        this.changed();
      }
    })();
  }

  /**
   * Opens the crop screen for the scan's next image, unless it shows already, or ends the scan once
   * each image has been through it. Images removed meanwhile are left out; one still being added
   * is waited for.
   */
  advanceScan() {
    const scan = this.scan;
    if (!scan) return;
    const ids = new Set(this.items.map((i) => i.id));
    const left = { ...scan, waiting: scan.waiting.filter((id) => ids.has(id)) };
    // A PDF being made has the pages as they are.
    if ((!left.waiting.length && left.coming === 0) || this.converting) {
      this.scan = null;
      this.changed();
      return;
    }
    this.scan = left;
    this.changed();
    if (this.crop || this.openingCrop) return;
    const next = left.waiting[0];
    if (next == null) return;
    this.openCropFor(this.item(next), { fromCamera: false, queued: true });
  }

  /**
   * Crops the crop screen's page to `corners` (as the screen shows the image, turned `rotation`
   * degrees clockwise, which the page takes), gives it `look` and `adjustments` (and every page,
   * with `allPages`) and closes the screen; the page is made in the background, and a scan goes on
   * with its next image. The whole image puts the page back as it was added. Returns false, the
   * screen staying open, when the corners don't make a page.
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
    const source = sourceOf(picked);
    const turn = floorMod(rotation ?? session.rotation, 360);
    const quad = uprightQuad(corners, turn);
    const whole = isWhole(quad);
    if (!whole && !isUsable(quad, source.image.width, source.image.height)) return false;
    this.crop = null;
    // The look first, so the page cropped in the background keeps it.
    const chosen = look ?? picked.look;
    const adjusted = adjustments ?? { brightness: picked.brightness, contrast: picked.contrast };
    // The next photo starts with the look chosen, not with one a page only kept.
    if (look != null && (session.fromCamera || session.queued || allPages || look !== session.look)) lastLook = look;
    if (allPages) {
      this.setItems(this.items.map((i) => ({ ...i, look: chosen, brightness: adjusted.brightness, contrast: adjusted.contrast })));
      // And the images still being added, such as the rest of a scan, as each comes.
      this.allPagesChoice = { look: chosen, brightness: adjusted.brightness, contrast: adjusted.contrast, through: this.importBatches };
    }
    const base = this.item(session.itemId) ?? picked;
    const item = { ...base, look: chosen, brightness: adjusted.brightness, contrast: adjusted.contrast, rotation: turn };
    this.replaceItem(item);
    const unchanged = whole ? item.original == null : (item.original != null && isCloseTo(item.original.corners, quad));
    if (!unchanged) {
      if (whole) {
        this.hooks.onForget(item.image);
        this.replaceItem({ ...item, image: source.image, original: null });
      } else {
        this.cropPage(item, source, quad);
      }
    }
    if (session.queued && this.scan) {
      this.scan = { ...this.scan, waiting: this.scan.waiting.filter((id) => id !== session.itemId), done: this.scan.done + 1 };
      this.advanceScan();
    }
    this.changed();
    return true;
  }

  /**
   * Leaves the crop screen without cropping. A photo just taken is discarded. A scan stops, also
   * while its next image is awaited: the images not through the crop screen stay as they are.
   */
  closeCrop() {
    const session = this.crop;
    if (!session || session.queued) this.scan = null;
    this.changed();
    if (!session) return;
    this.crop = null;
    if (session.fromCamera) this.remove(session.itemId);
  }

  /**
   * Whether a scan's page is still to reach the editor: the camera app is open, or the crop screen
   * shows, is being opened, or awaits a scan's next image.
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
    (async () => {
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

  /** Whether a PDF can be made now: pages, nothing still being added, no crop screen showing or opening. */
  canConvert() {
    return this.items.length > 0 && !this.converting && this.pending === 0 && !this.crop && !this.openingCrop;
  }

  setConverting(on) {
    this.converting = !!on;
    this.changed();
  }
}
