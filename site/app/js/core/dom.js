// Small DOM helpers used by every screen. Nothing here touches the document until called, so
// engines may import yieldToUI() in a worker too.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Tags created in the SVG namespace by h(). ('a', 'title', 'style' and 'script' exist in both:
// h() makes HTML ones; use svg() for those.)
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text', 'tspan',
  'defs', 'use', 'symbol', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop',
  'image', 'foreignObject', 'marker', 'filter', 'feGaussianBlur', 'feColorMatrix', 'feOffset',
  'feMerge', 'feMergeNode', 'feFlood', 'feComposite', 'feBlend', 'textPath',
]);

// Set as properties rather than attributes, so they reflect the live state.
const PROPERTIES = new Set(['value', 'checked', 'selected', 'indeterminate', 'muted', 'volume', 'currentTime']);

function append(parent, child) {
  if (child == null || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
  } else if (child instanceof Node) {
    parent.appendChild(child);
  } else {
    parent.appendChild(document.createTextNode(String(child)));
  }
}

function setProps(el, props, isSvg) {
  for (const [key, value] of Object.entries(props)) {
    const aria = key.startsWith('aria-');
    // aria-* states are words: false must say "false", not leave the attribute out.
    if (value == null || (value === false && !aria)) continue;
    if (aria) {
      el.setAttribute(key, String(value));
      continue;
    }
    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else {
        for (const [prop, v] of Object.entries(value)) {
          if (v == null || v === false) continue;
          if (prop.startsWith('--') || prop.includes('-')) el.style.setProperty(prop, String(v));
          else el.style[prop] = String(v);
        }
      }
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = String(v);
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (/^on[A-Z]/.test(key) && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (!isSvg && PROPERTIES.has(key)) {
      el[key] = value;
    } else if (key === 'for') {
      el.setAttribute('for', String(value));
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

/**
 * Creates an element. `props`: class (string or array), style (object or string), id, for,
 * type, value, on<Event> handlers (onClick, onInput, onKeydown...), aria-*, data-*, role and
 * any other attribute (true sets it empty, false/null leaves it out), dataset (object), and
 * ref (called with the element). Children: strings, numbers, nodes, arrays; null and false
 * are skipped. SVG tags (svg, path, circle...) are made in the SVG namespace.
 * @example h('button', { class: 'x', onClick: go, 'aria-label': t('back') }, icon('arrow_back'))
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
  } else if (props) {
    setProps(el, props, isSvg);
  }
  append(el, children);
  return el;
}

/** Like h(), always in the SVG namespace (for <a>, <title> or <style> inside an SVG). */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) setProps(el, props, true);
  append(el, children);
  return el;
}

/** Removes all children of `el`. */
export function clear(el) {
  el.replaceChildren();
  return el;
}

const stylesheets = new Map();

/**
 * Adds <link rel="stylesheet"> for `url` (a URL object or string) once. Resolves when it has
 * loaded (or failed), so a screen can wait for its styles before showing.
 * @example await ensureCss(new URL('./split.css', import.meta.url));
 * @returns {Promise<void>}
 */
export function ensureCss(url) {
  const href = new URL(String(url), document.baseURI).href;
  if (stylesheets.has(href)) return stylesheets.get(href);
  const existing = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((l) => l.href === href);
  const promise = existing && existing.sheet ? Promise.resolve() : new Promise((resolve) => {
    const link = existing ?? h('link', { rel: 'stylesheet', href });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    if (!existing) document.head.appendChild(link);
  });
  stylesheets.set(href, promise);
  return promise;
}

/** Resolves at the next animation frame (or soon, when the page is hidden and frames stop). */
export function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
}

/**
 * Lets the browser paint and handle input during long work. Call it between pages.
 * @example for (const page of pages) { await work(page); await yieldToUI(); }
 */
export function yieldToUI() {
  const s = globalThis.scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let liveRegion = null;
let announceTimer = 0;

/** Says `text` politely to screen readers (without moving focus). */
export function announce(text) {
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'announcer' });
    document.body.appendChild(liveRegion);
  }
  // Emptied first, so the same message said twice is heard twice.
  liveRegion.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    liveRegion.textContent = String(text);
  }, 50);
}

const WIDE = '(min-width: 840px)';

/** Whether the screen is wide enough for the desktop and tablet layout (840 px or more). */
export function isWide() {
  return typeof matchMedia === 'function' && matchMedia(WIDE).matches;
}

/**
 * Calls `fn(wide)` when the screen crosses 840 px. Returns an unsubscribe function.
 * @param {(wide: boolean) => void} fn
 */
export function onWideChange(fn) {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia(WIDE);
  const handler = () => fn(mq.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/** Whether the user asked for less motion. */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
