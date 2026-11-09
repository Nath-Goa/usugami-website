// About (AboutScreen.kt): the app's version, what it does with data, its privacy policy, the
// open-source licenses, its license, and where its source code and the Android app are.
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { icon } from '../core/icons.js';
import { topBar, listItem } from '../core/ui.js';
import { externalRow, WEBSITE_SOURCE_URL, WEBSITE_NOTICES_URL } from './settings.js';

/** The web app's version, shown on About. */
export const APP_VERSION = '1.0.0';

/** Where the Android app's source code is published (AboutScreen.SOURCE_CODE_URL). */
export const ANDROID_SOURCE_URL = 'https://github.com/Nath-Goa/usugami';

const GPL_URL = 'https://www.gnu.org/licenses/gpl-3.0.html';

/** The app icon: its background colour with its artwork, cropped to the part a launcher shows. */
export function appIcon() {
  return h('div', { class: 'app-icon', 'aria-hidden': 'true' },
    h('img', { src: new URL('../../icons/icon-maskable-512.png', import.meta.url).href, alt: '', width: 108, height: 108 }));
}

/** Renders About. */
export async function mount(ctx) {
  const site = (path) => new URL(path, new URL('../../', import.meta.url)).href;
  const header = h('div', { class: 'about-header' },
    appIcon(),
    h('p', { class: 'about-name' }, t('home_title')),
    h('p', { class: 'about-line' }, t('about_version', APP_VERSION)),
    h('p', { class: 'about-line' }, t('web_about_edition')));
  const privacy = h('div', { class: 'about-privacy' },
    icon('lock'),
    h('div', null,
      h('p', null, t('web_about_privacy')),
      h('p', null, t('web_about_storage'))));
  const rows = [
    externalRow({ icon: 'policy', title: t('about_privacy_policy'), href: site('../privacy/') }),
    listItem({ icon: 'library_books', title: t('about_licenses'), detail: t('about_licenses_detail'), onClick: () => ctx.navigate('/settings/about/licenses') }),
    externalRow({ icon: 'article', title: t('web_about_notices'), detail: t('web_about_notices_detail'), href: WEBSITE_NOTICES_URL }),
    externalRow({ icon: 'gavel', title: t('about_license'), detail: t('about_license_detail'), href: GPL_URL }),
    externalRow({ icon: 'code', title: t('about_source'), detail: t('web_source_detail'), href: WEBSITE_SOURCE_URL }),
    externalRow({ icon: 'code', title: t('web_about_android'), detail: t('about_source_detail'), href: ANDROID_SOURCE_URL }),
    externalRow({ icon: 'install_mobile', title: t('web_about_get_android'), detail: t('web_about_get_android_detail'), href: site('../download/') }),
  ];
  ctx.root.append(
    topBar({ title: t('about_title'), onBack: () => ctx.back() }),
    h('div', { class: 'page page--narrow page--list', 'data-main': '' },
      header, privacy,
      h('div', { class: 'settings-list' }, rows),
      h('p', { class: 'about-copyright' }, t('about_copyright'))));
  return { unmount() {}, hasUnsavedWork: () => false };
}
