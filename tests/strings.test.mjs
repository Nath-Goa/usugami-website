// The web app's strings (site/app/locales/), with Node only, no browser:
// - every key is defined in exactly one locales/en/*.js file, and other languages follow it;
// - every literal key the code uses (t, tp, tWeb, new UserError) is defined;
// - tools/import-strings.mjs reads Android's strings.xml the way the app does;
// - when the Android app's repository is next to this one (../pdfer, not on GitHub's runners),
//   every app-named English string equals its strings.xml text, and its French, Spanish and
//   Hindi translations import cleanly.
//
//   node tests/strings.test.mjs
//   USUGAMI_APP_REPO=<folder> node tests/strings.test.mjs   the app's repository is elsewhere
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { assert, root } from './harness.mjs';
import { stripJsComments } from '../tools/check-site.mjs';
import {
  parseStringsXml, androidUnescape, androidToPlaceholders, placeholders, importLanguage, readLocale,
  writeLocale, compareLocales, checkTranslation,
} from '../tools/import-strings.mjs';

const started = Date.now();
let count = 0;
async function test(name, fn) {
  const t = Date.now();
  await fn();
  count++;
  console.log(`ok - ${name} (${Date.now() - t} ms)`);
}

const locales = join(root, 'site/app/locales');
const appJs = join(root, 'site/app/js');
// The Android app's repository: next to this one, or where USUGAMI_APP_REPO says.
const appRepo = resolve(process.env.USUGAMI_APP_REPO || join(root, '..', 'pdfer'));
const appXml = join(appRepo, 'app/src/main/res/values/strings.xml');

/** Every locales/<lang>/*.js file, as lang -> ns -> strings. */
async function allLocales() {
  const out = new Map();
  for (const e of await readdir(locales, { withFileTypes: true })) {
    if (e.isDirectory()) out.set(e.name, await readLocale(join(locales, e.name)));
  }
  return out;
}

async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

const isString = (v) => typeof v === 'string';
const isPlural = (v) => v && typeof v === 'object' && !Array.isArray(v) && isString(v.other) && Object.values(v).every(isString);

const all = await allLocales();
const english = all.get('en');
/** key -> [namespaces that define it] in English. */
const definedIn = new Map();
for (const [ns, strings] of english) {
  for (const k of Object.keys(strings)) definedIn.set(k, [...(definedIn.get(k) ?? []), ns]);
}

await test('every English key is defined in exactly one locales/en file, as a string or a plural with "other"', async () => {
  assert(english.size >= 10, `namespaces: ${[...english.keys()]}`);
  for (const ns of ['common', 'kit', 'mark']) assert(english.has(ns), `${ns}.js (loaded at start) is there`);
  const twice = [...definedIn].filter(([, list]) => list.length > 1).map(([k, list]) => `${k} (${list.join(', ')})`);
  assert(!twice.length, `keys defined in more than one file: ${twice.join('; ')}`);
  assert(definedIn.size > 600, `keys: ${definedIn.size}`);
  for (const [ns, strings] of english) {
    for (const [k, v] of Object.entries(strings)) {
      assert(/^[a-z][a-z0-9_]*$/.test(k), `${ns}.js: key "${k}" is lower case with underscores`);
      assert(isString(v) || isPlural(v), `${ns}.js: ${k} is a string or { one, other... }: ${JSON.stringify(v)}`);
      const forms = isString(v) ? [v] : Object.values(v);
      for (const s of forms) assert(!/%(\d+\$)?[sd]/.test(s), `${ns}.js: ${k} uses {1}, not Android's %1$s: ${s}`);
    }
  }
});

await test('other languages: each listed in locales/languages.js has a folder, with the keys where English has them', async () => {
  const { LANGUAGES } = await import(pathToFileURL(join(locales, 'languages.js')).href);
  assert(LANGUAGES[0]?.code === 'en', 'English comes first');
  for (const { code, name, dir } of LANGUAGES) {
    assert(name && (dir === 'ltr' || dir === 'rtl'), `${code}: a name and dir`);
    assert(all.get(code)?.has('common'), `locales/${code}/common.js exists`);
  }
  for (const [lang, files] of all) {
    if (lang === 'en') continue;
    const seen = new Map();
    for (const [ns, strings] of files) {
      assert(english.has(ns), `locales/${lang}/${ns}.js has no English file`);
      for (const [k, v] of Object.entries(strings)) {
        assert(!seen.has(k), `${lang}: ${k} is in ${seen.get(k)}.js and ${ns}.js`);
        seen.set(k, ns);
        assert(k in english.get(ns), `${lang}/${ns}.js: ${k} is in locales/en/${definedIn.get(k) ?? '(none)'}, not in ${ns}.js`);
        const why = checkTranslation(english.get(ns)[k], v);
        assert(!why, `${lang}/${ns}.js: ${k} ${why}`);
      }
    }
  }
});

await test('every literal key the code uses is defined (t, tp, tWeb, new UserError)', async () => {
  // Whole literal keys only: one built at run time (t('color_' + name)) can't be checked here.
  const calls = /(?<![\w$.])(t|tp|tWeb|hasString|new\s+UserError)\s*\(\s*(['"])([a-z][a-z0-9_]*)\2(?=\s*[,)])/g;
  const missing = [];
  let found = 0;
  for (const file of await jsFiles(appJs)) {
    const code = stripJsComments(await readFile(file, 'utf8'));
    for (const m of code.matchAll(calls)) {
      const [, fn, , key] = m;
      found++;
      // tWeb('x') shows web_x when there is one, else x; hasString('x') may ask about either.
      const ok = definedIn.has(key) || (/^(tWeb|hasString)$/.test(fn) && definedIn.has('web_' + key));
      if (!ok && fn !== 'hasString') missing.push(`${relative(root, file).split('\\').join('/')}: ${fn}('${key}')`);
    }
  }
  assert(found > 400, `literal keys found: ${found}`);
  assert(!missing.length, `keys used but defined in no locales/en file:\n  ${missing.join('\n  ')}`);
});

await test('import-strings reads Android strings as the app shows them', async () => {
  const cases = [
    ['Couldn\\\'t open it', 'Couldn\'t open it'],
    ['  two   words\n  here ', 'two words here'],
    ['"  kept   as is  "', '  kept   as is  '],
    ['a\\nb\\tc', 'a\nb\tc'],
    ['\\"quoted\\" \\\\ \\@ \\?', '"quoted" \\ @ ?'],
    ['caf\\u00e9', 'café'],
    ['line\\n  next', 'line\n next'],
  ];
  for (const [xml, shown] of cases) {
    const got = androidUnescape(xml);
    assert(got === shown, `${JSON.stringify(xml)} -> ${JSON.stringify(got)}, not ${JSON.stringify(shown)}`);
  }
  assert(androidToPlaceholders('%1$s of %2$d (%3$d%%)') === '{1} of {2} ({3}%)', 'positional');
  assert(androidToPlaceholders('%d of %d, %s') === '{1} of {2}, {3}', 'counted');
  assert(placeholders({ one: '{2}', other: '{1} files: {2}' }).join() === '1,2', 'placeholders of a plural');
  const { strings, untranslatable } = parseStringsXml(`<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:tools="http://schemas.android.com/tools" xmlns:xliff="urn:oasis:names:tc:xliff:document:1.2">
    <!-- <string name="commented">no</string> -->
    <string name="app_name" translatable="false">Usugami</string>
    <string name="amp">Word &amp; Excel &lt;3 &#8230;</string>
    <string name="markup">Open <b>%1$s</b> <xliff:g id="n">%2$d</xliff:g></string>
    <string name="cdata"><![CDATA[<b>&amp;</b>]]></string>
    <string name="empty"/>
    <plurals name="pages" tools:ignore="ImpliedQuantity">
        <item quantity="one">%d page</item>
        <item quantity="other">%d pages</item>
    </plurals>
</resources>`);
  assert(!strings.has('commented'), 'comments skipped');
  assert(untranslatable.has('app_name') && untranslatable.size === 1, 'translatable="false"');
  assert(strings.get('amp') === 'Word & Excel <3 …', strings.get('amp'));
  assert(strings.get('markup') === 'Open {1} {2}', strings.get('markup'));
  assert(strings.get('cdata') === '<b>&amp;</b>', strings.get('cdata'));
  assert(strings.get('empty') === '', 'empty');
  assert(JSON.stringify(strings.get('pages')) === '{"one":"{1} page","other":"{1} pages"}', JSON.stringify(strings.get('pages')));
  assert(checkTranslation('{1} of {2}', '{2} sur {1}') === null, 'reordered placeholders are fine');
  assert(checkTranslation('{1} of {2}', '{1} sur') !== null, 'a lost placeholder is reported');
  assert(checkTranslation({ one: '{2}', other: '{1}: {2}' }, { one: 'un : {2}', other: '{1} : {2}' }) === null, 'a plural form may leave the count out');
  assert(checkTranslation({ one: '{1}', other: '{1}' }, { one: '{1}' }) !== null, 'a plural needs "other"');
  assert(checkTranslation({ other: '{1}' }, { other: '{1} {2}' }) !== null, 'no placeholder English lacks');
});

await test('import-strings writes each key into its English file, keeps web_ translations, leaves bad ones out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usugami-strings-'));
  try {
    const res = join(dir, 'app/app/src/main/res');
    await mkdir(join(res, 'values'), { recursive: true });
    await mkdir(join(res, 'values-xx'), { recursive: true });
    await writeFile(join(res, 'values/strings.xml'), `<resources>
      <string name="app_name" translatable="false">Usugami</string>
      <string name="open_file">Open %1$s</string>
      <string name="ok">OK</string>
      <string name="split_it">Split %1$s into %2$d</string>
      <plurals name="page_count"><item quantity="one">%d page</item><item quantity="other">%d pages</item></plurals>
    </resources>`);
    await writeFile(join(res, 'values-xx/strings.xml'), `<resources>
      <string name="open_file">Ouvrir %1$s</string>
      <string name="ok">D\\'accord</string>
      <string name="split_it">Diviser %1$s</string>
      <plurals name="page_count"><item quantity="one">%d page</item><item quantity="many">%d de pages</item><item quantity="other">%d pages</item></plurals>
      <string name="unused">Pas utilisé</string>
    </resources>`);
    // ES modules, as site/app's are (else Node warns as it guesses).
    await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n');
    const loc = join(dir, 'locales');
    await mkdir(join(loc, 'en'), { recursive: true });
    await mkdir(join(loc, 'xx'), { recursive: true });
    await writeFile(join(loc, 'en/common.js'), `export default { app_name: 'Usugami', open_file: 'Open {1}', ok: 'OK', web_hello: 'Hello', web_bye: 'Bye' };\n`);
    await writeFile(join(loc, 'en/split.js'), `export default { split_it: 'Split {1} into {2}', page_count: { one: '{1} page', other: '{1} pages' } };\n`);
    await writeFile(join(loc, 'xx/common.js'), `export default { web_hello: 'Bonjour', web_gone: 'Plus là', ok: 'Vieux' };\n`);
    const result = await importLanguage({ lang: 'xx', appDir: join(dir, 'app'), localesDir: loc });
    assert(JSON.stringify(Object.fromEntries(result.files)) === JSON.stringify({
      common: { open_file: 'Ouvrir {1}', ok: 'D\'accord', web_hello: 'Bonjour' },
      split: { page_count: { one: '{1} page', many: '{1} de pages', other: '{1} pages' } },
    }), JSON.stringify(Object.fromEntries(result.files)));
    assert(result.translated === 3, `translated: ${result.translated}`);
    assert(JSON.stringify(result.missing) === '["web_bye","split_it"]', `missing: ${result.missing}`);
    assert(JSON.stringify(result.untranslatable) === '["app_name"]', `untranslatable: ${result.untranslatable}`);
    assert(result.problems.length === 1 && /split_it uses \{1\} where English uses \{1,2\}/.test(result.problems[0]), result.problems.join('\n'));
    // Written and read back, the same; a second import keeps what the first wrote.
    await writeLocale(join(loc, 'xx'), 'xx', result.files);
    const back = await readLocale(join(loc, 'xx'));
    assert(!compareLocales(result.files, back).length, compareLocales(result.files, back).join('\n'));
    const text = await readFile(join(loc, 'xx/common.js'), 'utf8');
    assert(text.includes("ok: 'D\\'accord',") && text.startsWith('// common strings in "xx"'), text);
    const again = await importLanguage({ lang: 'xx', appDir: join(dir, 'app'), localesDir: loc });
    assert(!compareLocales(again.files, back).length, 'the same again');
    // English is the source: compared with values/, the one string that differs is reported.
    await writeFile(join(loc, 'en/common.js'), `export default { app_name: 'Usugami', open_file: 'Open {1}!', ok: 'OK', web_hello: 'Hello', web_bye: 'Bye' };\n`);
    const en = await importLanguage({ lang: 'en', appDir: join(dir, 'app'), localesDir: loc });
    const diff = compareLocales(en.files, await readLocale(join(loc, 'en')));
    assert(diff.length === 1 && diff[0].startsWith('common.js: open_file'), diff.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

if (!existsSync(appXml)) {
  console.log(`skip - the comparisons with the Android app's strings.xml: ${appXml} isn't here (it is on the maintainer's PC, not on GitHub's runners)`);
} else {
  await test('every app-named English string is the app\'s strings.xml text, exactly (plurals too)', async () => {
    const result = await importLanguage({ lang: 'en', appDir: appRepo, localesDir: locales });
    assert(!result.problems.length, result.problems.join('\n'));
    const diff = compareLocales(result.files, english);
    assert(!diff.length, `differences from strings.xml (node tools/import-strings.mjs en --check):\n${diff.join('\n')}`);
    const appNamed = [...definedIn.keys()].filter((k) => !k.startsWith('web_')).length;
    assert(result.translated === appNamed && appNamed > 500, `app strings compared: ${result.translated} of ${appNamed}`);
  });

  await test('the app\'s French, Spanish and Hindi import with every placeholder in place', async () => {
    const { untranslatable } = parseStringsXml(await readFile(appXml, 'utf8'));
    for (const lang of ['fr', 'es', 'hi']) {
      const result = await importLanguage({ lang, appDir: appRepo, localesDir: locales, existingDir: join(tmpdir(), 'usugami-no-such-folder') });
      assert(!result.problems.length, `${lang}: ${result.problems.join('\n')}`);
      const app = result.missing.filter((k) => !k.startsWith('web_'));
      assert(!app.length, `${lang}: app strings not translated in the app: ${app}`);
      assert(result.untranslatable.every((k) => untranslatable.has(k)), `${lang}: left out only what the app doesn't translate`);
      assert(result.translated > 500, `${lang}: ${result.translated} strings`);
      for (const strings of result.files.values()) {
        for (const [k, v] of Object.entries(strings)) assert(isString(v) || isPlural(v), `${lang}: ${k} is a string or a plural with "other"`);
      }
    }
  });
}

console.log(`${count} tests passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
