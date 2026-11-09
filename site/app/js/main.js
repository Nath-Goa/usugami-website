// Starts the web app: appearance, strings, the screens, the service worker (offline use and files
// shared to the installed app) and files shared to or opened with it.
import { getSetting, onSettingChange } from './core/settings.js';
import { initI18n, loadStrings, t, LANGUAGES, onLanguageChange } from './core/i18n.js';
import { h } from './core/dom.js';
import { startRouter } from './core/router.js';
import { initShareInbox } from './core/share-inbox.js';

const THEME_COLORS = { light: '#fff8f7', dark: '#171717' };

/**
 * Applies 'system', 'light' or 'dark' at once: <html data-theme> (which tokens.css follows) and
 * the browser's bar colour.
 */
function applyAppearance(value) {
  const root = document.documentElement;
  if (value === 'light' || value === 'dark') root.dataset.theme = value;
  else delete root.dataset.theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = meta.getAttribute('media')?.includes('dark') ? 'dark' : 'light';
    meta.setAttribute('content', THEME_COLORS[value === 'light' || value === 'dark' ? value : own]);
  }
}

/** The link that skips the screen's top bar, for keyboard users. */
function skipLink() {
  const link = h('a', {
    class: 'skip-link',
    href: '#content',
    onClick: (e) => {
      e.preventDefault();
      const screen = document.querySelector('#app .screen');
      const target = screen?.querySelector('[data-main], main') ?? screen;
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus();
    },
  }, t('web_skip_to_content'));
  onLanguageChange(() => { link.textContent = t('web_skip_to_content'); });
  return link;
}

/** Whether the app runs installed (its own window, as from the home screen). */
function installed() {
  try {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch {
    return false;
  }
}

/**
 * Asks the browser to keep this site's storage (the service worker and its caches) when space
 * runs low. Files shared to the installed app reach it through the service worker, which keeps
 * them on the device; were it cleared away, the system would still offer the app for sharing and
 * send the files to the site instead. Installed apps get this without a question in Chromium.
 */
function keepStorage() {
  try {
    navigator.storage?.persist?.()?.catch?.(() => {});
  } catch {
    // Not offered here: nothing more to do.
  }
}

function registerServiceWorker() {
  if (installed()) keepStorage();
  window.addEventListener('appinstalled', keepStorage);
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).href })
      .catch(() => {
        // Without it the app still works, only not offline.
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

async function start() {
  applyAppearance(getSetting('appearance', 'system'));
  onSettingChange('appearance', applyAppearance);
  await initI18n();
  // The UI kit's strings; the app still starts without them (their keys then show).
  await loadStrings('kit', 'mark').catch(() => {});
  document.body.prepend(skipLink());
  const app = document.getElementById('app');
  // With more than one language, the first launch asks for one, as the Android app does; the
  // screen the address named shows once it is chosen.
  const firstLaunch = LANGUAGES.length > 1 && getSetting('language') == null;
  if (firstLaunch && !location.hash.startsWith('#/language')) {
    const wanted = decodeURIComponent(location.hash.replace(/^#/, ''));
    const next = wanted && wanted !== '/' ? '?next=' + encodeURIComponent(wanted) : '';
    history.replaceState(null, '', location.pathname + location.search + '#/language' + next);
  }
  await startRouter(app);
  await initShareInbox();
  registerServiceWorker();
  document.documentElement.dataset.ready = 'true';
}

start().catch((e) => {
  console.error(e);
  // Something essential failed to load: say so rather than show an empty page.
  const app = document.getElementById('app');
  if (app && !app.childElementCount) {
    app.replaceChildren(h('div', { class: 'shell-problem', role: 'alert' },
      h('p', null, t('web_tool_load_failed', t('home_title'))),
      h('button', { type: 'button', class: 'shell-button shell-button-filled', onClick: () => location.reload() }, t('web_try_again'))));
  }
});

