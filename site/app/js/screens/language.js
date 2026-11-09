// The first launch's language choice (LanguageScreen.kt), shown only while the app comes in more
// than one language and none has been chosen: the language for its screens, which can be changed
// later in Settings.
import { h } from '../core/dom.js';
import { t, setLanguage, LANGUAGES } from '../core/i18n.js';
import { card } from '../core/ui.js';
import { nativeName } from './settings.js';

/** Renders the language choice. */
export async function mount(ctx) {
  // A second tap before the screen goes away must not switch again.
  let chosen = false;
  const choose = async (code) => {
    if (chosen) return;
    chosen = true;
    await setLanguage(code);
    ctx.navigate('/', { replace: true });
  };
  ctx.root.append(h('main', { class: 'language-page', 'data-main': '' },
    h('div', { class: 'app-icon' }, h('img', { src: new URL('../../icons/icon-maskable-512.png', import.meta.url).href, alt: '' })),
    h('h1', null, t('language_title')),
    h('p', null, t('language_subtitle')),
    LANGUAGES.map((l) => card({ title: nativeName(l), onClick: () => choose(l.code) }))));
  return { unmount() {}, hasUnsavedWork: () => false };
}
