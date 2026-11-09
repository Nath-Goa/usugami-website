// Settings, kept in this browser only: one JSON object in localStorage['usugami.settings'], for
// example {"appearance":"dark","language":"en","images.pageSize":"a4"}. The website pages read
// "appearance" from it too, so they match the theme chosen in the app. Storage can be missing
// (private windows, blocked site data): the app then works with the defaults for this visit.

const STORAGE_KEY = 'usugami.settings';

/** @type {Record<string, unknown> | null} */
let cache = null;
/** @type {Map<string, Set<(value: unknown) => void>>} */
const listeners = new Map();

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function all() {
  if (!cache) cache = read();
  return cache;
}

function notify(key, value) {
  for (const fn of listeners.get(key) ?? []) {
    try {
      fn(value);
    } catch (e) {
      // One listener's mistake must not stop the others.
      setTimeout(() => { throw e; });
    }
  }
}

/**
 * The value saved for `key`, or `fallback` when there is none.
 * Keys: 'language', 'appearance' ('system' | 'light' | 'dark'), and tool choices as
 * '<toolId>.<name>' (e.g. 'images.pageSize').
 * @param {string} key
 * @param {*} [fallback]
 */
export function getSetting(key, fallback) {
  const s = all();
  return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : fallback;
}

/**
 * Saves `value` for `key` (undefined removes it) and tells the listeners. Saving can fail
 * (storage full or blocked): the value then still holds until the page is closed.
 * @param {string} key
 * @param {*} value  anything JSON can hold
 */
export function setSetting(key, value) {
  const s = all();
  const before = s[key];
  if (value === undefined) delete s[key];
  else s[key] = value;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Kept in memory only.
  }
  if (JSON.stringify(before) !== JSON.stringify(value)) notify(key, value);
}

/**
 * Calls `fn(value)` whenever `key` changes, here or in another tab of this site.
 * @param {string} key
 * @param {(value: unknown) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onSettingChange(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

// Another tab changed the settings: pick up what changed.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    const before = all();
    const after = read();
    cache = after;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) notify(key, after[key]);
    }
  });
}
