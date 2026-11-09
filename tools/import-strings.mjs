// Imports the Android app's translations into the web app's strings (site/app/locales/<lang>/).
// The web app's keys are the app's strings.xml names, so a language is mostly a copy:
//
//   node tools/import-strings.mjs fr             writes site/app/locales/fr/*.js from the app's
//                                                values-fr/strings.xml, then lists what is left
//   node tools/import-strings.mjs fr --missing   only lists the keys still in English
//   node tools/import-strings.mjs fr --check     exit code 1 if locales/fr differs from the app's
//   node tools/import-strings.mjs en --check     the self-check: locales/en against values/
//   options: --app <folder>  the app's repository (default: ../pdfer next to this one)
//            --out <folder>  write the files there instead of site/app/locales/<lang>/
//
// Each key goes into the namespace file its English lives in, in the same order. Strings the
// app marks translatable="false" stay out (English stands in). web_ keys (the web app's own
// strings) have no source in the app: those already translated in locales/<lang>/ are kept,
// the rest are listed for translating by hand. A translation whose {1} {2}... don't match the
// English is left out and reported. locales/en/ is the source and is never written.
//
// Android's rules, as aapt2 applies them: XML entities decoded, markup tags (<b>, <xliff:g>)
// dropped, \' \" \\ \n \t \uXXXX unescaped, runs of white space outside "double quotes"
// collapsed to one space and trimmed; then %1$s / %1$d become {1}, %s / %d count up, %% is %.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCALES = join(repoRoot, 'site', 'app', 'locales');
const DEFAULT_APP = resolve(repoRoot, '..', 'pdfer');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** An element's text as XML gives it: CDATA kept as is, tags dropped, entities decoded. */
function xmlText(raw) {
  let out = '';
  for (const part of raw.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)) {
    if (part.startsWith('<![CDATA[')) out += part.slice(9, -3);
    else out += decodeEntities(part.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, ''));
  }
  return out;
}

/**
 * One Android string resource's value as the app shows it, from its text in strings.xml.
 * @param {string} text  the element's text (entities decoded, markup dropped)
 * @returns {string}
 */
export function androidUnescape(text) {
  // Each piece: [character, true if it is collapsible white space outside quotes].
  const pieces = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      const d = text[++i];
      if (d === 'n') pieces.push(['\n', false]);
      else if (d === 't') pieces.push(['\t', false]);
      else if (d === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
        pieces.push([String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)), false]);
        i += 4;
      } else pieces.push([d, false]);
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(c)) {
      if (!pieces.length || !pieces.at(-1)[1]) pieces.push([' ', true]);
    } else {
      pieces.push([c, false]);
    }
  }
  while (pieces.length && pieces[0][1]) pieces.shift();
  while (pieces.length && pieces.at(-1)[1]) pieces.pop();
  return pieces.map((p) => p[0]).join('');
}

/**
 * Android's format arguments as the web app's: %1$s and %1$d become {1}, %s and %d count up
 * ({1}, {2}...), %% becomes %.
 * @param {string} s
 * @returns {string}
 */
export function androidToPlaceholders(s) {
  let next = 0;
  return s.replace(/%(?:(\d+)\$)?([sd%])/g, (m, n, kind) => (kind === '%' ? '%' : `{${n ?? ++next}}`));
}

/**
 * Parses an Android strings.xml.
 * @param {string} xml
 * @returns {{ strings: Map<string, string | Record<string, string>>, untranslatable: Set<string> }}
 *   strings: name -> text, or for <plurals> an object of CLDR category -> text; untranslatable:
 *   the names marked translatable="false"
 */
export function parseStringsXml(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const strings = new Map();
  const untranslatable = new Set();
  const value = (raw) => androidToPlaceholders(androidUnescape(xmlText(raw)));
  for (const m of body.matchAll(/<(string|plurals)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (!attrs.name) continue;
    if (attrs.translatable === 'false') untranslatable.add(attrs.name);
    if (m[1] === 'string') {
      strings.set(attrs.name, value(m[3] ?? ''));
    } else {
      const forms = {};
      for (const it of (m[3] ?? '').matchAll(/<item\b[^>]*\bquantity\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/item\s*>/g)) forms[it[1]] = value(it[2]);
      strings.set(attrs.name, forms);
    }
  }
  return { strings, untranslatable };
}

/** The {n} placeholders a string (or every form of a plural) uses, sorted. */
export function placeholders(v) {
  const texts = typeof v === 'string' ? [v] : Object.values(v ?? {});
  return [...new Set(texts.flatMap((s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => +m[1])))].sort((a, b) => a - b);
}

/**
 * Why `translated` can't stand in for `english` (a string or plural object), or null when it can:
 * the same {n} placeholders (a plural form may leave one out, never add one), a plural for a
 * plural, and an "other" form.
 * @param {string | Record<string, string>} english
 * @param {string | Record<string, string>} translated
 * @returns {string | null}
 */
export function checkTranslation(english, translated) {
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (typeof english === 'string') {
    if (typeof translated !== 'string') return 'is a plural in the app but not in English';
    if (!same(placeholders(english), placeholders(translated))) return `uses {${placeholders(translated)}} where English uses {${placeholders(english)}}`;
    return null;
  }
  if (typeof translated !== 'object') return 'is a plain string but a plural in English';
  if (typeof translated.other !== 'string') return 'has no "other" form';
  // A form may leave a number out ("un fichier"), but never use one English lacks.
  const allowed = new Set(placeholders(english));
  const extra = placeholders(translated).filter((n) => !allowed.has(n));
  if (extra.length) return `uses {${extra}}, which English doesn't`;
  return null;
}

/**
 * Reads every locales/<lang>/<ns>.js in a folder.
 * @param {string} dir
 * @returns {Promise<Map<string, Record<string, string | Record<string, string>>>>} ns -> strings,
 *   in file name order; empty when the folder doesn't exist
 */
export async function readLocale(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.js')).sort()) {
    // A query makes Node read the file again when it has changed since an earlier import.
    const url = pathToFileURL(join(dir, f)).href + `?t=${Date.now()}-${Math.random()}`;
    out.set(f.slice(0, -3), { ...(await import(url)).default });
  }
  return out;
}

/** The Android resource folder for a language: values for English, else values-<lang>. */
const valuesFolder = (lang) => (lang === 'en' ? 'values' : `values-${lang}`);

/**
 * Works out locales/<lang>/ from the app's translation, without writing anything.
 * @param {{ lang: string, appDir?: string, localesDir?: string, existingDir?: string }} opts
 *   appDir: the app's repository (default ../pdfer); localesDir: the web app's locales folder;
 *   existingDir: the folder whose web_ translations are kept (default localesDir/<lang>)
 * @returns {Promise<{ files: Map<string, Record<string, string | Record<string, string>>>,
 *   translated: number, missing: string[], untranslatable: string[], problems: string[] }>}
 *   files: ns -> strings to write; missing: keys still in English (web_ first); problems:
 *   translations left out, and app keys the web app has but the app doesn't
 */
export async function importLanguage({ lang, appDir = DEFAULT_APP, localesDir = DEFAULT_LOCALES, existingDir } = {}) {
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(lang || '')) throw new Error(`Not a language code: ${lang}`);
  const xmlPath = join(appDir, 'app', 'src', 'main', 'res', valuesFolder(lang), 'strings.xml');
  if (!existsSync(xmlPath)) throw new Error(`No ${xmlPath}`);
  const { strings: app } = parseStringsXml(await readFile(xmlPath, 'utf8'));
  const { untranslatable } = lang === 'en' ? { untranslatable: new Set() }
    : parseStringsXml(await readFile(join(appDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8'));
  const english = await readLocale(join(localesDir, 'en'));
  if (!english.size) throw new Error(`No strings in ${join(localesDir, 'en')}`);
  const existing = await readLocale(existingDir ?? join(localesDir, lang));
  const kept = new Map();
  for (const ns of existing.values()) for (const [k, v] of Object.entries(ns)) kept.set(k, v);

  const files = new Map();
  const missingWeb = [];
  const missingApp = [];
  const leftOut = [];
  const problems = [];
  let translated = 0;
  for (const [ns, en] of english) {
    const out = {};
    for (const [key, text] of Object.entries(en)) {
      let value;
      if (key.startsWith('web_')) {
        value = kept.get(key);
      } else if (untranslatable.has(key)) {
        leftOut.push(key);
        continue;
      } else if (app.has(key)) {
        value = app.get(key);
      } else {
        if (lang === 'en') problems.push(`${ns}.js: ${key} isn't in the app's strings.xml (a string of the web app's own needs a web_ key)`);
        value = kept.get(key);
      }
      const why = value === undefined ? null : checkTranslation(text, value);
      if (why) {
        problems.push(`${ns}.js: ${key} ${why}, so it was left out: ${JSON.stringify(value)}`);
        value = undefined;
      }
      if (value === undefined) {
        (key.startsWith('web_') ? missingWeb : missingApp).push(key);
        continue;
      }
      out[key] = value;
      if (!key.startsWith('web_')) translated++;
    }
    files.set(ns, out);
  }
  return { files, translated, missing: [...missingWeb, ...missingApp], untranslatable: leftOut, problems };
}

/** A string as a single-quoted JavaScript literal. */
function literal(s) {
  const escapes = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  let out = "'";
  for (const c of s) out += escapes[c] ?? c;
  return out + "'";
}

/**
 * One namespace file's source.
 * @param {string} lang
 * @param {string} ns
 * @param {Record<string, string | Record<string, string>>} strings
 * @returns {string}
 */
export function localeSource(lang, ns, strings) {
  const lines = Object.entries(strings).map(([k, v]) => typeof v === 'string'
    ? `  ${k}: ${literal(v)},`
    : `  ${k}: { ${Object.entries(v).map(([c, s]) => `${c}: ${literal(s)}`).join(', ')} },`);
  return `// ${ns} strings in "${lang}", in the order of locales/en/${ns}.js. Strings with the Android app's\n` +
    `// keys come from its values-${lang}/strings.xml (node tools/import-strings.mjs ${lang}); web_ strings are\n` +
    `// translated here by hand and kept when the import runs again. A missing key shows in English.\n` +
    `export default {\n${lines.join('\n')}${lines.length ? '\n' : ''}};\n`;
}

/** Writes the files importLanguage worked out into `dir`. */
export async function writeLocale(dir, lang, files) {
  await mkdir(dir, { recursive: true });
  for (const [ns, strings] of files) await writeFile(join(dir, `${ns}.js`), localeSource(lang, ns, strings));
}

/** Differences between two locales (ns -> strings), as lines. */
export function compareLocales(expected, actual) {
  const lines = [];
  for (const [ns, want] of expected) {
    const have = actual.get(ns) ?? {};
    for (const k of new Set([...Object.keys(want), ...Object.keys(have)])) {
      const a = JSON.stringify(want[k]);
      const b = JSON.stringify(have[k]);
      if (a !== b) lines.push(`${ns}.js: ${k}\n    app: ${a ?? '(none)'}\n    web: ${b ?? '(none)'}`);
    }
  }
  for (const ns of actual.keys()) if (!expected.has(ns)) lines.push(`${ns}.js: no such namespace in locales/en`);
  return lines;
}

// ---------- Command line ----------

async function main(args) {
  let lang = null;
  let appDir = DEFAULT_APP;
  let outDir = null;
  let mode = 'write';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--app') appDir = resolve(args[++i] ?? '');
    else if (a === '--out') outDir = resolve(args[++i] ?? '');
    else if (a === '--missing') mode = 'missing';
    else if (a === '--check') mode = 'check';
    else if (!a.startsWith('--') && !lang) lang = a;
    else {
      console.error(`Unknown argument: ${a}\nUsage: node tools/import-strings.mjs <lang> [--missing | --check] [--app <folder>] [--out <folder>]`);
      return 2;
    }
  }
  if (!lang) {
    console.error('Usage: node tools/import-strings.mjs <lang> [--missing | --check] [--app <folder>] [--out <folder>]');
    return 2;
  }
  if (lang === 'en' && mode === 'write') {
    console.error('locales/en is the source of the keys and is never written: use "en --check" to compare it with the app.');
    return 2;
  }
  // Written to --out, web_ translations are kept from that folder.
  const result = await importLanguage({ lang, appDir, existingDir: mode === 'write' && outDir ? outDir : undefined });
  for (const p of result.problems) console.log(`problem: ${p}`);
  if (mode === 'check') {
    const diff = compareLocales(result.files, await readLocale(join(DEFAULT_LOCALES, lang)));
    for (const d of diff) console.log(d);
    const appKeys = [...result.files.values()].reduce((n, f) => n + Object.keys(f).filter((k) => !k.startsWith('web_')).length, 0);
    console.log(diff.length || result.problems.length
      ? `\nlocales/${lang} differs from the app's ${valuesFolder(lang)}/strings.xml: ${diff.length} difference(s), ${result.problems.length} problem(s).`
      : `locales/${lang} matches the app's ${valuesFolder(lang)}/strings.xml (${appKeys} app strings).`);
    return diff.length || result.problems.length ? 1 : 0;
  }
  if (mode === 'write') {
    const dir = outDir ?? join(DEFAULT_LOCALES, lang);
    await writeLocale(dir, lang, result.files);
    console.log(`Wrote ${result.files.size} files to ${dir}: ${result.translated} strings from the app.`);
  }
  const web = result.missing.filter((k) => k.startsWith('web_'));
  const app = result.missing.filter((k) => !k.startsWith('web_'));
  if (web.length) console.log(`\n${web.length} web_ strings to translate by hand (in the namespace file each is in):\n  ${web.join('\n  ')}`);
  if (app.length) console.log(`\n${app.length} app strings the app hasn't translated (English stands in):\n  ${app.join('\n  ')}`);
  if (result.untranslatable.length) console.log(`\nNot translated, as in the app (translatable="false"): ${result.untranslatable.join(', ')}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
