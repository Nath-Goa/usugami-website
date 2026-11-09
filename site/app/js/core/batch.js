// Tools that work on several files one after another, each into a PDF of its own (ui/BatchList.kt,
// core/BatchChoices.kt and the batch parts of PdfToolsViewModel.kt): the list of files, each with
// the name its PDF gets and a choice of its own, and the run with "PDF 2 of 5" and the file's name,
// in which one file failing doesn't stop the others.
import { h, yieldToUI } from './dom.js';
import { t, tp } from './i18n.js';
import { fileCard, textField, segmented, button, progressDialog, snackbar, uid } from './ui.js';
import { UserError, CancelledError } from './errors.js';
import { listOfNames } from './names.js';

/**
 * The files of a tool that works on several, each in a card: its thumbnail (item.thumbnail, a node
 * or a promise of one), name and detail ("3 pages · 619 kB"), a Remove button named after it, what
 * `options(id)` gives (a node), its own choice (segmented buttons under choice.label) and the name
 * its PDF gets ("File name" with ".pdf" after it). Each card keeps what is typed in it when others
 * are removed or added. With onAdd, an "Add PDFs" button (addLabel) follows the list.
 * @param {object} o
 * @param {{ id: any, name: string, detail?: string, thumbnail?: Node|Promise<Node> }[]} o.items
 * @param {(id) => string} o.nameOf         the name its PDF gets now, without .pdf
 * @param {(id, name: string) => void} o.onRename   as typed
 * @param {(id) => void} o.onRemove
 * @param {() => void} [o.onAdd]
 * @param {{ label?: string, options: { value, label }[], valueOf(id), onChange(id, value) }} [o.choice]
 * @returns {HTMLElement} el.setItems(items), el.refreshChoices(), el.setAddDisabled(b)
 */
export function batchList({ items, nameOf, onRename, onRemove, onAdd, addLabel, choice, options, suffix = '.pdf', thumbnails = true } = {}) {
  const listEl = h('div', { class: 'ui-batch-list', role: 'list' });
  const root = h('div', { class: 'ui-batch' }, listEl);
  const cards = new Map();
  let addBtn = null;
  if (onAdd) {
    addBtn = button({ label: addLabel ?? t('add_pdfs'), variant: 'outlined', onClick: onAdd, cls: 'ui-batch-add' });
    root.append(addBtn);
  }

  const makeCard = (item) => {
    const parts = [];
    let choiceEl = null;
    if (options) {
      const extra = options(item.id);
      if (extra) parts.push(extra);
    }
    if (choice) {
      const labelId = uid('batch-choice');
      choiceEl = segmented({
        options: choice.options,
        value: choice.valueOf(item.id),
        labelledBy: choice.label ? labelId : undefined,
        label: choice.label ? undefined : choice.ariaLabel,
        onChange: (v) => choice.onChange(item.id, v),
      });
      parts.push(h('div', { class: 'ui-batch-choice' },
        choice.label ? h('span', { class: 'ui-batch-choice-label', id: labelId }, choice.label) : null,
        choiceEl));
    }
    const field = textField({
      label: t('file_name'),
      value: nameOf(item.id) ?? '',
      suffix,
      onInput: (v) => onRename?.(item.id, v),
    });
    // Every card has a "File name": named after its file, as its Remove button is, so a screen
    // reader tells them apart ("File name for Report.pdf").
    field.input.setAttribute('aria-label', t('web_file_name_for', item.name));
    parts.push(field);
    const cardEl = fileCard({
      name: item.name,
      detail: item.detail,
      thumbnail: thumbnails ? (item.thumbnail ?? undefined) : null,
      onRemove: onRemove ? () => onRemove(item.id) : null,
      options: h('div', { class: 'ui-batch-options' }, ...parts),
      size: 'small',
      placeholderIcon: item.icon ?? 'picture_as_pdf',
    });
    const wrap = h('div', { class: 'ui-batch-item', role: 'listitem' }, cardEl);
    return { wrap, card: cardEl, field, choiceEl, item };
  };

  const setItems = (next) => {
    const seen = new Set();
    const order = [];
    for (const item of next) {
      seen.add(item.id);
      let c = cards.get(item.id);
      if (!c) {
        c = makeCard(item);
        cards.set(item.id, c);
      } else {
        if (c.item.name !== item.name) {
          c.card.setName(item.name);
          c.field.input.setAttribute('aria-label', t('web_file_name_for', item.name));
        }
        if (c.item.detail !== item.detail) c.card.setDetail(item.detail);
        if (item.thumbnail && item.thumbnail !== c.item.thumbnail) c.card.setThumbnail(item.thumbnail);
        c.item = item;
      }
      order.push(c.wrap);
    }
    for (const [id, c] of cards) {
      if (!seen.has(id)) {
        cards.delete(id);
        c.wrap.remove();
      }
    }
    // Only cards out of place are moved: a card taken out of the page and put back loses the
    // focus, and typing in its name while PDFs are added must go on in it.
    let at = listEl.firstChild;
    for (const wrap of order) {
      if (wrap === at) { at = at.nextSibling; continue; }
      listEl.insertBefore(wrap, at);
    }
    while (at) { const next = at.nextSibling; at.remove(); at = next; }
  };
  setItems(items ?? []);

  // A card removed takes the focus with it: it moves to the next card's Remove button, or to Add.
  root.setItems = (next) => {
    const focused = [...cards.values()].find((c) => c.wrap.contains(document.activeElement));
    const ids = (next ?? []).map((i) => i.id);
    const at = focused ? [...cards.keys()].indexOf(focused.item.id) : -1;
    setItems(next ?? []);
    if (focused && !ids.includes(focused.item.id)) {
      const after = cards.get(ids[Math.min(at, ids.length - 1)]);
      (after?.card.removeButton ?? addBtn)?.focus();
    }
  };
  root.refreshChoices = () => {
    if (!choice) return;
    for (const [id, c] of cards) c.choiceEl?.setValue(choice.valueOf(id));
  };
  root.refreshNames = () => {
    for (const [id, c] of cards) if (document.activeElement !== c.field.input) c.field.setValue(nameOf(id) ?? '');
  };
  root.setAddDisabled = (b) => { if (addBtn) addBtn.disabled = !!b; };
  return root;
}

/**
 * Runs `work` on each item in turn, as the app makes a PDF of each file: a progress dialog ("Working
 * on your PDFs…", after 400 ms) says "PDF 2 of 5" and the file's name (item.name), with Cancel.
 * work(item, index, { signal, onProgress(done, total) | onProgress(fraction) | onProgress(done, null),
 * onStep(text|null) }) returns an OutputFile or several: onProgress(done, null) says the count
 * isn't known (the bar runs without end), onStep sets a third line under the name ("Page 3",
 * "Slide 2 of 6"), cleared as the next file starts. A file that fails is passed over and the
 * others still made; once done, the failures are named in snackbars with their reasons (a UserError's key, worded for one file or, with
 * key + '_many', for several; others "Couldn't process …"). With one item it works as the tools do
 * for one file: "Working on your PDF…" and the error itself.
 * Options: title, report (default true), named: { errorKey: pluralKey } for errors said of the files
 * together by a plural with their names (such as batch_nothing_to_number), fallback (the key for an
 * error that isn't a UserError when there is one item, default pdf_process_failed), delay.
 * @returns {Promise<{ outputs: OutputFile[], failures: { item, error }[], cancelled: boolean }>}
 *   Cancel ends it with nothing made (cancelled: true).
 */
export async function runBatch(items, work, { title, report = true, named = {}, fallback = 'pdf_process_failed', delay } = {}) {
  const list = Array.from(items ?? []);
  const many = list.length > 1;
  const controller = new AbortController();
  const dialog = progressDialog({
    title: title ?? t(many ? 'pdf_working_many' : 'pdf_working'),
    onCancel: () => controller.abort(),
    ...(delay != null ? { delay } : {}),
  });
  const outputs = [];
  const failures = [];
  const total = list.length;
  try {
    for (let i = 0; i < total; i++) {
      if (controller.signal.aborted) throw new CancelledError();
      const item = list[i];
      if (many) dialog.update(i / total, t('batch_progress', i + 1, total), item?.name ?? '', null);
      else dialog.setStep(null);
      const onProgress = (...args) => {
        const [done, of] = args;
        // onProgress(done, null): how many there are isn't known yet (a Word document's pages):
        // the bar runs without end for one file, and stays at this file's start for several.
        if (args.length >= 2 && of == null) {
          dialog.update(many ? i / total : null);
          return;
        }
        const f = of ? done / of : done;
        if (!Number.isFinite(f)) return;
        const clamped = Math.max(0, Math.min(1, f));
        dialog.update(many ? (i + clamped) / total : clamped);
      };
      // The page, slide or chapter being made: a line of its own, not read out at each one.
      const onStep = (text) => dialog.setStep(text ?? null);
      try {
        const out = await work(item, i, { signal: controller.signal, onProgress, onStep });
        if (controller.signal.aborted) throw new CancelledError();
        for (const o of [].concat(out ?? [])) outputs.push(o);
      } catch (error) {
        if (error instanceof CancelledError || controller.signal.aborted) throw new CancelledError();
        failures.push({ item, error });
      }
      await yieldToUI();
    }
  } catch (e) {
    await dialog.close();
    if (e instanceof CancelledError) return { outputs: [], failures: [], cancelled: true };
    throw e;
  }
  await dialog.close();
  if (report && failures.length) reportBatchFailures(failures, { many, named, fallback });
  return { outputs, failures, cancelled: false };
}

/**
 * Says which files of a batch couldn't be made into PDFs (PdfToolsViewModel.reportFailures): those
 * whose error is in `named` together by that plural with their names, those with a reason of their
 * own with it (the same reason together), and the rest together ("Couldn't process 2 files: a.pdf,
 * b.pdf. Check the files and free storage."). With many false (one file), just its error.
 */
export function reportBatchFailures(failures, { many = failures.length > 1, named = {}, fallback = 'pdf_process_failed' } = {}) {
  if (!failures.length) return;
  const nameOf = (f) => f.item?.name ?? String(f.item);
  if (!many) {
    const e = failures[0].error;
    snackbar(e instanceof UserError ? t(e.key, ...e.args) : t(fallback));
    return;
  }
  const plain = [];
  const byNamed = new Map();
  const byReason = new Map();
  for (const f of failures) {
    const e = f.error;
    if (e instanceof UserError && named[e.key]) {
      if (!byNamed.has(e.key)) byNamed.set(e.key, []);
      byNamed.get(e.key).push(nameOf(f));
    } else if (e instanceof UserError) {
      const key = e.key + '\u0000' + JSON.stringify(e.args ?? []);
      if (!byReason.has(key)) byReason.set(key, { e, names: [] });
      byReason.get(key).names.push(nameOf(f));
    } else {
      plain.push(nameOf(f));
    }
  }
  for (const { e, names } of byReason.values()) {
    let text = t(e.key, ...e.args);
    if (names.length > 1) {
      const m = t(e.key + '_many', ...e.args);
      if (m && m !== e.key + '_many') text = m;
    }
    snackbar(t('file_problem', listOfNames(names), text));
  }
  for (const [key, names] of byNamed) snackbar(tp(named[key], names.length, names.length, listOfNames(names)));
  if (plain.length) snackbar(tp('batch_failed', plain.length, plain.length, listOfNames(plain)));
}

/**
 * What a tool that works on several files keeps for each, by the file's id (BatchChoices.kt): the
 * name its PDF gets (null while it is the tool's own) and a choice, such as a compression level,
 * as its number among the tool's choices. `all` is the choice for every file at once: files added
 * later start with it. A file changed on its own keeps its choice until one is made for all again;
 * once the files listed all have the same choice again, that is the one for all.
 * Immutable: each change returns a new BatchChoices.
 */
export class BatchChoices {
  /** @param {{ id, name: string|null, choice: number }[]} files */
  constructor(files = [], all = 0) {
    this.files = Object.freeze(files.map((f) => Object.freeze({ id: f.id, name: f.name ?? null, choice: f.choice })));
    this.all = all;
    Object.freeze(this);
  }

  /** The choice file `id` has. */
  choiceOf(id) {
    return this.files.find((f) => f.id === id)?.choice ?? this.all;
  }

  /** The name file `id`'s PDF gets, or null for the tool's own. */
  nameOf(id) {
    return this.files.find((f) => f.id === id)?.name ?? null;
  }

  /** The choice every file has, or null while they differ. With no files, `all`. */
  get common() {
    const distinct = [...new Set(this.files.map((f) => f.choice))];
    if (!distinct.length) return this.all;
    return distinct.length === 1 ? distinct[0] : null;
  }

  /**
   * The choices for the files `ids`, in that order: those kept have theirs, those new to the list
   * start with the tool's name and the choice the files kept all have (or `all` while they differ,
   * or none is kept), and files no longer listed are forgotten.
   */
  following(ids) {
    const byId = new Map(this.files.map((f) => [f.id, f]));
    const unique = [...new Set(ids)];
    const kept = [...new Set(unique.filter((id) => byId.has(id)).map((id) => byId.get(id).choice))];
    const start = kept.length === 1 ? kept[0] : this.all;
    const list = unique.map((id) => byId.get(id) ?? { id, name: null, choice: start });
    const same = list.length === this.files.length && list.every((f, i) => f === this.files[i]);
    return same && start === this.all ? this : new BatchChoices(list, start);
  }

  /** Every file, and those added later, get `choice`. */
  withAll(choice) {
    return new BatchChoices(this.files.map((f) => ({ ...f, choice })), choice);
  }

  /** File `id` alone gets `choice`; nothing changes for a file not listed. */
  withChoice(id, choice) {
    return new BatchChoices(this.files.map((f) => (f.id === id ? { ...f, choice } : f)), this.all);
  }

  /** File `id`'s PDF is to be named `name` (as typed; null for the tool's own). */
  withName(id, name) {
    return new BatchChoices(this.files.map((f) => (f.id === id ? { ...f, name } : f)), this.all);
  }

  /** Whether `other` holds the same files, names, choices and choice for all. */
  equals(other) {
    return other instanceof BatchChoices && other.all === this.all && other.files.length === this.files.length
      && other.files.every((f, i) => f.id === this.files[i].id && f.name === this.files[i].name && f.choice === this.files[i].choice);
  }

  /** As plain data, to keep in sessionStorage, say. */
  toJSON() {
    return { files: this.files.map((f) => ({ ...f })), all: this.all };
  }

  /** The choices toJSON() gave; data that doesn't fit gives none, with `all`. */
  static from(data, all = 0) {
    if (!data || !Array.isArray(data.files)) return new BatchChoices([], data?.all ?? all);
    const ok = data.files.every((f) => f && 'id' in f && Number.isInteger(f.choice) && (f.name == null || typeof f.name === 'string'));
    return ok ? new BatchChoices(data.files, Number.isInteger(data.all) ? data.all : all) : new BatchChoices([], all);
  }
}
