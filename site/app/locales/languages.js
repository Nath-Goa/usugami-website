// The languages the web app's screens come in. Each needs a folder locales/<code>/ with the same
// namespace files as locales/en/ (a missing string falls back to English).
//
// To add French, Spanish or Hindi (the Android app's other languages); docs/ARCHITECTURE.md has
// the whole list:
//   1. node tools/import-strings.mjs fr   writes locales/fr/ from the app's values-fr strings.xml
//      and lists the web_ strings (the app has none like them) still to translate by hand;
//   2. translate those web_ strings (the file size units web_size_* first, as Android writes them
//      in that language);
//   3. add the language here, in this order:
//        { code: 'fr', name: 'Français', dir: 'ltr' },
//        { code: 'es', name: 'Español', dir: 'ltr' },
//        { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
//   4. add its code to LANGUAGES in sw.js, so the app opens in it offline (tests/shell.test.mjs
//      fails until the two lists agree);
//   5. npm test, and open the app once in a private window: the first launch's language screen.
// With more than one language, the app asks for one the first time it opens, as the Android app
// does, and Settings lists them. `name` is the language's own name.

export const LANGUAGES = [
  { code: 'en', name: 'English', dir: 'ltr' },
];
