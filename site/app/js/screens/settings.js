// Settings (SettingsScreen.kt): the language the app shows, its appearance (as the device is set,
// light or dark), its source code on GitHub, and About. Language and Appearance open a dialog of
// choices, applied at once and saved.
import { h } from '../core/dom.js';
import { t, getLanguage, setLanguage, LANGUAGES } from '../core/i18n.js';
import { getSetting, setSetting, onSettingChange } from '../core/settings.js';
import { icon } from '../core/icons.js';
import { topBar, listItem, alertDialog } from '../core/ui.js';

/** Where the web app's source code is published. */
export const WEBSITE_SOURCE_URL = 'https://github.com/Nath-Goa/usugami-website';

/**
 * The notices of everything by others the site includes (THIRD_PARTY_NOTICES.md), with the code
 * bundled inside the libraries, whose licenses (MIT, BSD, IJG, Leptonica...) want them reachable.
 */
export const WEBSITE_NOTICES_URL = 'https://github.com/Nath-Goa/usugami-website/blob/main/THIRD_PARTY_NOTICES.md';

/** How each appearance is named in Settings. */
export const APPEARANCES = [
  { value: 'system', label: 'appearance_system' },
  { value: 'light', label: 'appearance_light' },
  { value: 'dark', label: 'appearance_dark' },
];

/** The appearance chosen: 'system' until another is. */
export function currentAppearance() {
  const value = getSetting('appearance', 'system');
  return APPEARANCES.some((a) => a.value === value) ? value : 'system';
}

/** A language's own name, marked as being in that language, so a screen reader reads it so. */
export function nativeName(language) {
  return h('span', { lang: language.code, dir: language.dir }, language.name);
}

/**
 * A dialog of choices, each row a radio choice, as the app's: tapping one chooses it and closes
 * the dialog; Cancel keeps what was chosen. Resolves with the value chosen, or null.
 * @param {{ title: string, options: { value: string, label: string|Node }[], value: string }} o
 */
export async function chooseDialog({ title, options, value }) {
  let chosen = null;
  const rows = options.map((o) => h('div', {
    class: 'choice-row',
    role: 'option',
    'aria-selected': String(o.value === value),
    tabindex: o.value === value ? '0' : '-1',
    dataset: { value: o.value },
  }, h('span', { class: 'choice-radio', 'aria-hidden': 'true' }), h('span', null, o.label)));
  const list = h('div', { class: 'choice-list', role: 'listbox', 'aria-label': title }, rows);
  const close = () => list.closest('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }));
  const pick = (row) => {
    // Once: a second tap before the dialog has gone finds it answered.
    if (chosen !== null) return;
    chosen = row.dataset.value;
    for (const r of rows) r.setAttribute('aria-selected', String(r === row));
    close();
  };
  rows.forEach((row, i) => {
    row.addEventListener('click', () => pick(row));
    row.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowDown') next = (i + 1) % rows.length;
      else if (e.key === 'ArrowUp') next = (i - 1 + rows.length) % rows.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = rows.length - 1;
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(row);
        return;
      }
      if (next === null) return;
      e.preventDefault();
      rows.forEach((r, j) => r.setAttribute('tabindex', j === next ? '0' : '-1'));
      rows[next].focus();
    });
  });
  const closed = alertDialog({ title, message: list, confirm: t('cancel') });
  // The focus starts on the choice made, as a radio group's does.
  (rows.find((r) => r.dataset.value === value) ?? rows[0])?.focus();
  await closed;
  return chosen;
}

/** Asks for the appearance and applies it at once (main.js follows the setting). */
export async function chooseAppearance() {
  const value = currentAppearance();
  const chosen = await chooseDialog({
    title: t('settings_appearance'),
    options: APPEARANCES.map((a) => ({ value: a.value, label: t(a.label) })),
    value,
  });
  if (chosen && chosen !== value) setSetting('appearance', chosen);
}

/** Asks for the language and switches to it (the screen is then drawn again in it). */
export async function chooseLanguage() {
  const value = getLanguage();
  const chosen = await chooseDialog({
    title: t('settings_language'),
    options: LANGUAGES.map((l) => ({ value: l.code, label: nativeName(l) })),
    value,
  });
  if (chosen && chosen !== value) await setLanguage(chosen);
}

/** A row that opens another site (or page) in a new tab, with the app's "opens elsewhere" icon. */
export function externalRow({ icon: name, title, detail, href }) {
  const row = listItem({
    icon: name,
    title: [title, h('span', { class: 'visually-hidden' }, ' ' + t('web_opens_elsewhere'))],
    detail,
    href,
    trailing: h('span', { class: 'settings-external', 'aria-hidden': 'true' }, icon('open_in_new')),
  });
  const link = row.querySelector('a');
  if (link) {
    link.target = '_blank';
    link.rel = 'noopener';
  }
  return row;
}

/** Renders Settings. */
export async function mount(ctx) {
  const language = () => LANGUAGES.find((l) => l.code === getLanguage()) ?? LANGUAGES[0];
  const appearanceLabel = () => t(APPEARANCES.find((a) => a.value === currentAppearance()).label);

  const appearanceRow = () => listItem({ icon: 'brightness_medium', title: t('settings_appearance'), detail: appearanceLabel(), onClick: chooseAppearance });
  let appearance = appearanceRow();
  const list = h('div', { class: 'settings-list' },
    listItem({ icon: 'language', title: t('settings_language'), detail: nativeName(language()), onClick: chooseLanguage }),
    appearance,
    externalRow({ icon: 'code', title: t('settings_github'), detail: t('web_source_detail'), href: WEBSITE_SOURCE_URL }),
    listItem({ icon: 'info_outline', title: t('about'), detail: t('settings_about_detail'), onClick: () => ctx.navigate('/settings/about') }));
  ctx.root.append(
    topBar({ title: t('settings'), onBack: () => ctx.back() }),
    h('div', { class: 'page page--narrow page--list', 'data-main': '' }, list));

  // The row says the appearance chosen, also when it changes in another tab.
  const stop = onSettingChange('appearance', () => {
    const focused = appearance.contains(document.activeElement);
    const next = appearanceRow();
    appearance.replaceWith(next);
    appearance = next;
    if (focused) appearance.querySelector('button, a')?.focus();
  });
  return {
    unmount: stop,
    hasUnsavedWork: () => false,
  };
}
