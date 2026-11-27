// The links out to where Usugami takes donations: the "Buy me a coffee" button, in Donate's first
// step (screens/donate.js) and floating at the bottom of the app's own screens.
//
// Buy Me a Coffee's own button is a script loaded from its site, and Usugami loads nothing from
// other sites: the button is drawn here instead, as an ordinary link in its colours.
import { h } from './dom.js';
import { t, onLanguageChange } from './i18n.js';
import { icon } from './icons.js';
import { onRouteChange, currentRoute } from './router.js';

/** Usugami's page on Buy Me a Coffee, which takes donations (DonateScreen.DONATE_URL). */
export const DONATE_URL = 'https://buymeacoffee.com/usugami';

/**
 * The screens the floating button shows on: the app's own, where the corner is free. Not while
 * files are being worked on (a tool, whose bottom corner holds its main button or the page being
 * edited, and Choose a tool); not on Donate and GitHub Sponsors, which are where it leads; not
 * while the first launch asks for a language.
 */
const FLOAT_ROUTES = new Set(['home', 'recent', 'settings', 'about', 'licenses']);

/**
 * A link drawn as a button that opens another site in a new tab: an icon, then its words, which a
 * screen reader hears with "(opens in a new tab)".
 * @param {{ href: string, label: string, icon: string, cls: string, iconSize?: number }} o
 * @returns {HTMLAnchorElement} el.setLabel(text) changes its words
 */
export function linkButton({ href, label, icon: name, cls, iconSize = 18 }) {
  const words = h('span', { class: 'ui-btn-label' }, label);
  const elsewhere = h('span', { class: 'visually-hidden' }, ' ' + t('web_opens_elsewhere'));
  const link = h('a', {
    class: cls,
    href,
    target: '_blank',
    // The other site isn't told it was opened from Usugami.
    rel: 'noopener noreferrer',
  }, icon(name, { size: iconSize }), words, elsewhere);
  link.setLabel = (text) => {
    words.textContent = text;
    elsewhere.textContent = ' ' + t('web_opens_elsewhere');
  };
  return link;
}

/** The "Buy me a coffee" button: a cup and the words, on Buy Me a Coffee's yellow. */
export function coffeeButton(cls) {
  return linkButton({ href: DONATE_URL, label: t('web_donate_coffee'), icon: 'coffee', cls, iconSize: 24 });
}

/**
 * The "Buy me a coffee" button that stays at the bottom corner of the window: main.js adds it to
 * the page once, and it shows and hides with the screen (FLOAT_ROUTES). While it shows, <html> has
 * the class has-coffee-float, which leaves room for it under the screen's content and lifts
 * snackbars over it (css/app.css).
 * @returns {HTMLAnchorElement}
 */
export function coffeeFloat() {
  const link = coffeeButton('coffee-float');
  const follow = (route) => {
    const shown = FLOAT_ROUTES.has(route?.name);
    link.hidden = !shown;
    document.documentElement.classList.toggle('has-coffee-float', shown);
  };
  follow(currentRoute());
  onRouteChange(follow);
  onLanguageChange(() => link.setLabel(t('web_donate_coffee')));
  return link;
}
