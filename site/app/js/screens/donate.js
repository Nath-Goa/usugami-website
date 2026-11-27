// Donate (DonateScreen.kt): how to donate through Buy Me a Coffee, in four steps, the first with
// the button that opens Usugami's page there (core/coffee.js draws it). Under the steps, the other
// way to donate, GitHub Sponsors, opens a page of its own (sponsors.js).
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { coffeeButton } from '../core/coffee.js';
import { topBar, button } from '../core/ui.js';

/**
 * One step (DonateStep): its number in a circle, then what to do; under the first one's words,
 * the address its button opens and the button.
 */
function donateStep(number, { text, address, link }) {
  return h('li', { class: 'donate-step' },
    h('span', { class: 'donate-step-number' }, String(number)),
    h('div', { class: 'donate-step-body' },
      h('p', { class: 'donate-step-text' }, text),
      address ? h('p', { class: 'donate-step-address' }, address) : null,
      link ?? null));
}

/**
 * A page of steps to donate (DonatePage): `title` on the bar, the intro, the steps on one sheet,
 * "Thank you!", then `after` (Donate's way to GitHub Sponsors).
 * @param {object} ctx  the screen's mount(ctx)
 * @param {{ title: string, intro: string, steps: { text: string, address?: string, link?: Node }[], after?: Node }} page
 * @returns the screen's handle
 */
export function donatePage(ctx, { title, intro, steps, after = null }) {
  ctx.root.append(
    topBar({ title, onBack: () => ctx.back() }),
    h('div', { class: 'page page--narrow donate', 'data-main': '' },
      h('p', { class: 'donate-intro' }, intro),
      // A list still, with its markers drawn as the circles (Safari drops the role otherwise).
      h('ol', { class: 'donate-steps', role: 'list' }, steps.map((step, i) => donateStep(i + 1, step))),
      h('p', { class: 'donate-thanks' }, t('donate_thanks')),
      after));
  return { unmount() {}, hasUnsavedWork: () => false };
}

/** Renders Donate. */
export async function mount(ctx) {
  return donatePage(ctx, {
    title: t('settings_donate'),
    intro: t('donate_intro'),
    steps: [
      { text: t('donate_coffee_step_open'), address: t('donate_coffee_detail'), link: coffeeButton('donate-coffee') },
      { text: t('donate_coffee_step_amount') },
      { text: t('donate_coffee_step_message') },
      { text: t('donate_coffee_step_pay') },
    ],
    // The other way to donate, quieter than the steps' button.
    after: button({ label: t('donate_github_instead'), variant: 'text', cls: 'donate-other', onClick: () => ctx.navigate('/settings/donate/github') }),
  });
}
