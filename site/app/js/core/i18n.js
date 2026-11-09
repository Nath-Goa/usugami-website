// Strings and formatting in the language the user picked (Settings), else the browser's, else
// English. Strings live in locales/<lang>/<namespace>.js; a string missing in a language falls
// back to English, and a key missing everywhere shows as the key itself.
import { LANGUAGES } from '../../locales/languages.js';
import { getSetting, setSetting } from './settings.js';

export { LANGUAGES };

const localesBase = new URL('../../locales/', import.meta.url);

let language = 'en';
/** Strings of the current language, then English, merged per key. */
let strings = Object.create(null);
let english = Object.create(null);
/** The keys the language showing has strings of its own for (not English standing in). */
let ownKeys = new Set();
/** The namespaces loaded so far, in order, so a new language can reload them. */
const namespaces = [];
const loading = new Map();
const languageListeners = new Set();

function supported(code) {
  return LANGUAGES.some((l) => l.code === code);
}

/** The language to show: the one picked in Settings, else the first of the browser's we have. */
function pickLanguage() {
  const chosen = getSetting('language');
  if (typeof chosen === 'string' && supported(chosen)) return chosen;
  const wanted = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const tag of wanted) {
    const code = String(tag || '').toLowerCase().split('-')[0];
    if (supported(code)) return code;
  }
  return 'en';
}

function applyToDocument() {
  if (typeof document === 'undefined') return;
  const info = LANGUAGES.find((l) => l.code === language) ?? { dir: 'ltr' };
  document.documentElement.lang = language;
  document.documentElement.dir = info.dir || 'ltr';
}

async function importStrings(lang, ns) {
  const mod = await import(new URL(`${lang}/${ns}.js`, localesBase).href);
  return mod.default ?? {};
}

/** Loads one namespace in English and, when another language shows, in that language too. */
function loadNamespace(ns) {
  const key = `${language}/${ns}`;
  if (loading.has(key)) return loading.get(key);
  const promise = (async () => {
    const en = await importStrings('en', ns);
    Object.assign(english, en);
    let local = {};
    if (language !== 'en') {
      // Not translated yet: English stands in.
      local = { ...await importStrings(language, ns).catch(() => ({})) };
      for (const k of Object.keys(local)) ownKeys.add(k);
      // Without the language's common strings (offline before they were kept, say) the screens
      // are in English: screen readers are told so.
      if (ns === 'common' && !Object.keys(local).length && typeof document !== 'undefined') document.documentElement.lang = 'en';
    }
    for (const k of Object.keys(en)) if (!(k in local)) local[k] = en[k];
    Object.assign(strings, local);
    if (!namespaces.includes(ns)) namespaces.push(ns);
  })();
  loading.set(key, promise);
  promise.catch(() => loading.delete(key));
  return promise;
}

/**
 * Picks the language (Settings, else the browser's), sets <html lang dir>, and loads the
 * 'common' strings. Call once at start.
 */
export async function initI18n() {
  language = pickLanguage();
  applyToDocument();
  await loadNamespace('common');
}

/**
 * Loads locales/<lang>/<ns>.js for each namespace (with English for what is missing). Call it
 * before rendering a screen that uses those strings.
 * @example await loadStrings('split');
 * @param {...string} list
 */
export async function loadStrings(...list) {
  await Promise.all(list.map((ns) => loadNamespace(ns)));
}

function fill(text, args) {
  return text.replace(/\{(\d+)\}/g, (m, n) => {
    const v = args[Number(n) - 1];
    return v === undefined ? m : String(v);
  });
}

function lookup(key) {
  return key in strings ? strings[key] : english[key];
}

/**
 * The string `key` with `{1}`, `{2}`... replaced by `args`. A plural string gives its 'other' form
 * (use tp for counts). An unknown key comes back as the key itself.
 * @example t('remove_file', 'Report.pdf')  // 'Remove Report.pdf'
 * @param {string} key
 * @param {...*} args
 * @returns {string}
 */
export function t(key, ...args) {
  const value = lookup(key);
  if (value == null) return key;
  const text = typeof value === 'string' ? value : (value.other ?? Object.values(value)[0] ?? key);
  return fill(text, args);
}

/** Whether a string `key` is loaded (in this language or English). */
export function hasString(key) {
  return lookup(key) != null;
}

/**
 * The web app's wording of the app's string `key` where the app speaks of "this phone": the
 * string `web_<key>` when there is one, else `key` (e.g. tool_word_detail). In a language that
 * has the app's translation of `key` but not yet one of `web_<key>`, the app's translation
 * shows rather than the English web wording.
 */
export function tWeb(key, ...args) {
  const web = 'web_' + key;
  if (!hasString(web)) return t(key, ...args);
  if (language !== 'en' && !ownKeys.has(web) && ownKeys.has(key)) return t(key, ...args);
  return t(web, ...args);
}

let pluralRules = null;
let pluralRulesLang = '';

/**
 * The plural string `key` for `count` (its form picked by Intl.PluralRules in the current
 * language), with `{1}`, `{2}`... replaced by `args`. With no args, `{1}` is the count.
 * @example tp('page_count', 3)                          // '3 pages'
 * @example tp('share_unsupported', 2, 2, 'a.txt, b.txt') // as Android's getQuantityString(res, n, n, names)
 * @param {string} key
 * @param {number} count
 * @param {...*} args
 * @returns {string}
 */
export function tp(key, count, ...args) {
  const value = lookup(key);
  if (value == null) return key;
  const fillWith = args.length ? args : [count];
  if (typeof value === 'string') return fill(value, fillWith);
  if (!pluralRules || pluralRulesLang !== language) {
    pluralRules = new Intl.PluralRules(language);
    pluralRulesLang = language;
  }
  const form = value[pluralRules.select(count)] ?? value.other ?? Object.values(value)[0];
  return fill(form, fillWith);
}

/** The language shown, such as 'en'. */
export function getLanguage() {
  return language;
}

/** 'ltr' or 'rtl' for the language shown. */
export function getDirection() {
  return LANGUAGES.find((l) => l.code === language)?.dir ?? 'ltr';
}

/**
 * Switches to `code` (one of LANGUAGES), saves the choice, reloads the strings loaded so far and
 * tells the listeners (the router then draws the screen again).
 * @param {string} code
 */
export async function setLanguage(code) {
  if (!supported(code)) throw new Error(`Unknown language: ${code}`);
  setSetting('language', code);
  if (code === language) return;
  language = code;
  strings = Object.create(null);
  english = Object.create(null);
  ownKeys = new Set();
  numberFormats.clear();
  loading.clear();
  applyToDocument();
  await loadStrings(...namespaces);
  for (const fn of languageListeners) fn(code);
}

/** Calls `fn(code)` after the language has changed. Returns an unsubscribe function. */
export function onLanguageChange(fn) {
  languageListeners.add(fn);
  return () => languageListeners.delete(fn);
}

// Made once per language and options: a long list of sizes (a result of 300 files) would make
// hundreds of them otherwise.
const numberFormats = new Map();

function numberFormat(options) {
  const key = language + '|' + (options ? JSON.stringify(options) : '');
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(language, options);
    if (numberFormats.size > 64) numberFormats.clear();
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * A file size as Android shows it (Formatter.formatShortFileSize): 1000-based units, a decimal
 * below 10 and two below 1, such as '532 B', '619 kB', '2.4 MB', '0.95 MB'.
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  const units = ['web_size_b', 'web_size_kb', 'web_size_mb', 'web_size_gb', 'web_size_tb', 'web_size_pb'];
  let value = Math.abs(Number(bytes) || 0);
  let unit = 0;
  while (value > 900 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  let digits = 0;
  if (unit > 0 && value < 100) digits = value < 1 ? 2 : (value < 10 ? 1 : 0);
  const sign = bytes < 0 ? '-' : '';
  const number = numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);
  return t('web_size_format', sign + number, t(units[unit]));
}

/**
 * A number in the current language's way.
 * @param {number} n
 * @param {Intl.NumberFormatOptions} [options]
 */
export function formatNumber(n, options) {
  return numberFormat(options).format(n);
}

/**
 * A date (Date or milliseconds) in the current language's way; by default like "Nov 3, 2026".
 * @param {Date|number} date
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export function formatDate(date, options = { dateStyle: 'medium' }) {
  return new Intl.DateTimeFormat(language, options).format(date instanceof Date ? date : new Date(date));
}
