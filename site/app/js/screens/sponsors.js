// GitHub Sponsors (DonateScreen.kt's GitHubSponsorsScreen): the other way to donate, in four
// steps, from the Sponsor button on Usugami's page on GitHub, which the first step's button opens.
// Back returns to Donate.
import { t } from '../core/i18n.js';
import { linkButton } from '../core/coffee.js';
import { ANDROID_SOURCE_URL } from './about.js';
import { donatePage } from './donate.js';

/** Renders GitHub Sponsors. */
export async function mount(ctx) {
  return donatePage(ctx, {
    title: t('donate_github_title'),
    intro: t('donate_github_intro'),
    steps: [
      {
        text: t('donate_github_step_open'),
        address: t('about_source_detail'),
        // The page with the Sponsor button the next step names, as in the app.
        link: linkButton({ href: ANDROID_SOURCE_URL, label: t('donate_open_github'), icon: 'open_in_new', cls: 'ui-btn ui-btn--filled donate-open' }),
      },
      { text: t('donate_github_step_sponsor') },
      { text: t('donate_github_step_amount') },
      { text: t('donate_github_step_pay') },
    ],
  });
}
