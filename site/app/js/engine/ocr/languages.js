// The languages text recognition reads (the app's OcrLanguage), apart from the engine, so a screen
// can offer them without loading it. engine/ocr.js exports these too.

/** The languages text recognition offers (the app's OcrLanguage), in its order. */
export const OCR_LANGUAGES = ['en', 'fr', 'es', 'hi'];

/** The string key naming each language in "Text language" (strings.xml). */
export const OCR_LANGUAGE_NAMES = { en: 'ocr_english', fr: 'ocr_french', es: 'ocr_spanish', hi: 'ocr_hindi' };

/** Text recognition starts on the app's language (README), English when it has no model for it. */
export function defaultOcrLanguage(appLanguage) {
  const code = String(appLanguage ?? '').toLowerCase().split(/[-_]/)[0];
  return OCR_LANGUAGES.includes(code) ? code : 'en';
}
