// The editor's live page previews (PagePreview.kt, data/Thumbnails.kt): each page drawn as it will
// come out in the PDF, its shape, margins and the image's place from the same layout the PDF uses,
// with its look. Small upright pictures (512 px) are kept in memory, one per image and look; the
// user's turn is applied when drawing, so turning a page decodes nothing.
import { h } from '../../core/dom.js';
import { loadImage } from '../../engine/images/decode.js';
import { applyLookAsync } from '../../engine/images/looks.js';
import { computeLayout } from '../../engine/images/page-layout.js';
import { shownSize, isStyled } from './model.js';

/** The previews' long side, in pixels (Thumbnails.TARGET_SIZE). */
const TARGET_SIZE = 512;
/** At most this many bytes of previews are kept. */
const CACHE_BYTES = 96 * 1024 * 1024;
/** Previews made at a time (the app decodes three at once). */
const PARALLEL = 3;

const ids = new WeakMap();
let nextKey = 1;
const keyOf = (image) => {
  if (!ids.has(image)) ids.set(image, nextKey++);
  return ids.get(image);
};

/** key → { promise, picture, bytes } in the order last used. */
const cache = new Map();
let cachedBytes = 0;
let running = 0;
const waiting = [];

function limited(work) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => {
        running--;
        waiting.shift()?.();
      });
    };
    if (running < PARALLEL) start(); else waiting.push(start);
  });
}

function release(picture) {
  if (!picture) return;
  if (typeof picture.close === 'function') picture.close();
  else if ('width' in picture) { picture.width = 0; picture.height = 0; }
}

function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  cachedBytes += entry.bytes;
  for (const [k, e] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    if (k === key || !e.picture) continue;
    cache.delete(k);
    cachedBytes -= e.bytes;
    release(e.picture);
  }
}

function cached(key, make) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }
  const entry = { promise: null, picture: null, bytes: 0 };
  entry.promise = make().then((picture) => {
    if (cache.get(key) !== entry) return picture;
    entry.picture = picture;
    entry.bytes = picture.width * picture.height * 4;
    // Counted as the newest, and older ones let go past the budget.
    remember(key, entry);
    return picture;
  }, (e) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw e;
  });
  cache.set(key, entry);
  return entry.promise;
}

/** The plain upright preview of `image` (an ImageBitmap about 512 px long). */
function plainPreview(image) {
  return cached(`${keyOf(image)}`, () => limited(() => loadImage(image, { maxSide: TARGET_SIZE })));
}

/**
 * The preview of page `item` as it shows in the PDF: its image upright with its look and
 * brightness and contrast (an ImageBitmap or canvas). Not turned: the drawing turns it.
 */
export function pagePicture(item) {
  const plain = plainPreview(item.image);
  if (!isStyled(item)) return plain;
  const key = `${keyOf(item.image)}#${item.look}#${item.brightness}#${item.contrast}`;
  return cached(key, () => plain.then((bitmap) => limited(() => applyLookAsync(bitmap, item.look, { brightness: item.brightness, contrast: item.contrast }, { output: 'dom' }))));
}

/** Forgets every preview of `image`, whatever its look (a page removed or cropped again). */
export function forgetPreviews(image) {
  if (!image || !ids.has(image)) return;
  const id = String(ids.get(image));
  for (const [k, e] of [...cache]) {
    if (k === id || k.startsWith(id + '#')) {
      cache.delete(k);
      cachedBytes -= e.bytes;
      release(e.picture);
    }
  }
}

/** Forgets every preview (the tool has gone). */
export function clearPreviews() {
  for (const e of cache.values()) release(e.picture);
  cache.clear();
  cachedBytes = 0;
}

/**
 * A page as it will come out: a white page of the layout's shape, the image in its place, turned as
 * the page is. Returns the element; el.update(item, layout) draws it for a page and layout,
 * el.show(visible) draws its picture only while it is near the screen.
 */
export function pagePreview() {
  const canvas = h('canvas', { class: 'images-preview-canvas', 'aria-hidden': 'true' });
  const box = h('div', { class: 'images-preview-image' }, canvas);
  const page = h('div', { class: 'images-preview-page' }, box);
  const el = h('div', { class: 'images-preview' }, page);
  let current = null;
  let drawnKey = null;
  let visible = false;
  let token = 0;

  const pictureKey = (item) => `${keyOf(item.image)}#${item.look}#${item.brightness}#${item.contrast}`;

  const draw = () => {
    if (!current || !visible) return;
    const key = pictureKey(current);
    if (key === drawnKey) return;
    const mine = ++token;
    pagePicture(current).then((picture) => {
      if (mine !== token || !visible) return;
      canvas.width = picture.width;
      canvas.height = picture.height;
      canvas.getContext('2d').drawImage(picture, 0, 0);
      drawnKey = key;
      box.classList.add('has-picture');
    }, () => { /* the placeholder stays */ });
  };

  el.update = (item, layout) => {
    current = item;
    const [w, hgt] = shownSize(item);
    const g = computeLayout(w, hgt, layout);
    page.style.setProperty('--ratio', String(g.pageWidth / g.pageHeight));
    box.style.left = `${(g.imageX / g.pageWidth) * 100}%`;
    box.style.top = `${(g.imageTop / g.pageHeight) * 100}%`;
    box.style.width = `${(g.imageWidth / g.pageWidth) * 100}%`;
    box.style.height = `${(g.imageHeight / g.pageHeight) * 100}%`;
    // The picture is upright: turned sideways, it is as wide as its box is tall.
    const r = item.rotation;
    if (r % 180 === 0) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    } else {
      canvas.style.width = `${(g.imageHeight / g.imageWidth) * 100}%`;
      canvas.style.height = `${(g.imageWidth / g.imageHeight) * 100}%`;
    }
    canvas.style.transform = `translate(-50%, -50%) rotate(${r}deg)`;
    draw();
  };

  el.show = (on) => {
    if (on === visible) return;
    visible = on;
    if (on) {
      draw();
    } else {
      // Far from the screen, its picture goes; the cache keeps it to draw again.
      token++;
      canvas.width = 0;
      canvas.height = 0;
      drawnKey = null;
      box.classList.remove('has-picture');
    }
  };
  return el;
}
