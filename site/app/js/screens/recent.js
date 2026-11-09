// Recent files (RecentFilesScreen.kt): every file on the list, newest first, each opened with a
// tap and shared or taken off the list from its menu, and Clear list, which asks first. Home shows
// the last three with the same rows (recentRow).
import { h } from '../core/dom.js';
import { t, formatSize, formatDate } from '../core/i18n.js';
import { icon } from '../core/icons.js';
import { listRecent, getRecentBytes, removeRecent, clearRecent, onRecentChange } from '../core/recent.js';
import { topBar, alertDialog, menu, snackbar } from '../core/ui.js';

const ZIP = 'application/zip';

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * When a file was saved, in short: the time for one saved today, else the day, with the year for
 * one saved before this year (RecentFilesScreen.savedWhen).
 * @param {number} time  milliseconds
 * @param {Date} [now]
 */
export function savedWhen(time, now = new Date()) {
  const saved = new Date(time);
  if (sameDay(saved, now)) return formatDate(saved, { hour: 'numeric', minute: '2-digit' });
  if (saved.getFullYear() === now.getFullYear()) return formatDate(saved, { month: 'short', day: 'numeric' });
  return formatDate(saved, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The file as the kit's output functions take it, or null when its copy is gone. */
async function outputFile(file) {
  const bytes = await getRecentBytes(file.id);
  return bytes ? { name: file.name, type: file.type, bytes } : null;
}

/** Says the file can't be opened any more, and offers to take it off the list. */
async function lost(file) {
  const remove = await alertDialog({
    title: t('recent_lost_title'),
    message: t('web_recent_lost_body', file.name),
    confirm: t('recent_remove'),
    dismiss: t('keep'),
  });
  if (remove) await removeRecent(file.id);
}

/** Opens a listed file, as the result screen's Open does. */
export async function openRecent(file) {
  const out = await outputFile(file);
  if (!out) return lost(file);
  const output = await import('../core/output.js');
  await output.openFile(out);
}

/** Shares a listed file, as the result screen's Share does. */
export async function shareRecent(file) {
  const out = await outputFile(file);
  if (!out) return lost(file);
  const output = await import('../core/output.js');
  await output.share([out]);
}

function failSoftly(promise) {
  promise.catch((e) => {
    console.warn(e);
    snackbar(t('msg_unknown_error'));
  });
}

/**
 * A file on the list: an icon for its kind, its name, when it was saved and its size. A tap opens
 * it; its menu also shares it or takes it off the list.
 * @param {{ id: string, name: string, type: string, size: number, savedAt: number }} file
 */
export function recentRow(file, now = new Date()) {
  const when = savedWhen(file.savedAt, now);
  const size = file.size >= 0 ? formatSize(file.size) : null;
  const details = size ? t('result_details', when, size) : when;
  const label = [file.name, when, size].filter(Boolean).join(', ');
  const more = h('button', {
    type: 'button',
    class: 'recent-menu',
    'aria-label': t('web_more_options_for', file.name),
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    title: t('web_more_options'),
  }, icon('more_vert'));
  more.addEventListener('click', () => {
    menu(more, [
      { label: t('open'), icon: 'open_in_new', onClick: () => failSoftly(openRecent(file)) },
      { label: t('share'), icon: 'share', onClick: () => failSoftly(shareRecent(file)) },
      { label: t('recent_remove'), icon: 'remove_circle_outline', onClick: () => removeRecent(file.id) },
    ]);
  });
  return h('li', { class: 'recent-row', dataset: { id: file.id } },
    h('button', { type: 'button', class: 'recent-open', 'aria-label': label, onClick: () => failSoftly(openRecent(file)) },
      icon(file.type === ZIP ? 'folder_zip' : 'picture_as_pdf', { size: 26 }),
      h('span', { class: 'recent-text', 'aria-hidden': 'true' },
        h('span', { class: 'recent-name' }, file.name),
        h('span', { class: 'recent-detail' }, details))),
    more);
}

/** Renders the Recent files screen. */
export async function mount(ctx) {
  const listEl = h('ul', { class: 'recent-list' });
  const empty = h('p', { class: 'recent-empty', 'aria-live': 'polite' });
  const note = h('p', { class: 'recent-note' }, icon('info_outline', { size: 20 }), h('span', null, t('web_recent_note')));
  let files = [];

  const confirmClear = async () => {
    if (!files.length) return;
    const ok = await alertDialog({
      title: t('recent_clear_title'),
      message: t('recent_clear_body'),
      confirm: t('recent_clear'),
      dismiss: t('cancel'),
    });
    if (ok) await clearRecent();
  };
  const bar = topBar({
    title: t('recent_title'),
    onBack: () => ctx.back(),
    // A text button, as the app's (an action with a label and no icon).
    actions: [{ label: t('recent_clear'), onClick: confirmClear }],
  });
  const clearButton = bar.actions[0];

  // Changes can come quickly one after another: only the last look at the list is drawn.
  let seq = 0;
  const render = async () => {
    const mine = ++seq;
    const list = await listRecent();
    if (mine !== seq) return;
    files = list;
    const now = new Date();
    const focusedId = document.activeElement?.closest?.('.recent-row')?.dataset.id;
    listEl.replaceChildren(...files.map((f) => recentRow(f, now)));
    listEl.hidden = !files.length;
    note.hidden = !files.length;
    if (clearButton) clearButton.hidden = !files.length;
    // Also once the list is cleared: a screen reader hears it.
    empty.textContent = files.length ? '' : t('recent_empty');
    empty.hidden = !!files.length;
    if (focusedId && !listEl.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)) {
      // The file with the focus left the list: the focus goes to the list's next one, or the heading.
      (listEl.querySelector('.recent-open') ?? bar.querySelector('h1'))?.focus();
    }
  };

  ctx.root.append(bar, h('div', { class: 'page page--narrow', 'data-main': '' }, empty, listEl, note));
  await render();
  const stop = onRecentChange(() => { render(); });
  // Today moves on: "17:21" for a file saved yesterday becomes its day.
  const onVisible = () => { if (document.visibilityState === 'visible') render(); };
  document.addEventListener('visibilitychange', onVisible);
  return {
    unmount() {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    },
    hasUnsavedWork: () => false,
  };
}

