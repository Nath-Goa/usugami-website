// The languages the web app's screens come in. Each needs a folder locales/<code>/ with the same
// namespace files as locales/en/ (a missing string falls back to English).
//
// To add French, Spanish or Hindi (the Android app's other languages), copy their strings from
// the app's values-fr, values-es and values-hi strings.xml into locales/fr/, locales/es/ and
// locales/hi/ (same keys), then add here, in this order:
//   { code: 'fr', name: 'Français', dir: 'ltr' },
//   { code: 'es', name: 'Español', dir: 'ltr' },
//   { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
// With more than one language, the app asks for one the first time it opens, as the Android app
// does, and Settings lists them. `name` is the language's own name.

export const LANGUAGES = [
  { code: 'en', name: 'English', dir: 'ltr' },
];
