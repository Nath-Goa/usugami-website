// Redact PDF's screen: the app's RedactOptions.kt and the redact parts of PdfToolScreen.kt and
// PdfToolsViewModel.kt. Choose a PDF; type a word or phrase in Find text to box it on every page,
// or drag on a page to draw a box over what to hide; tap a box to move, resize or delete it (also
// with buttons, or the keyboard), or add one with Add box; then Redact PDF makes the new PDF, in
// which the pages with boxes are pictures with the boxes solid black (engine/redact.js).
//
// The boxes, the page showing and the chosen box are kept here as the app's view model keeps
// them, and every button acts on them as they are when it is pressed, not as the screen last
// showed them: two quick presses of Delete box delete one box, two of Move right move it twice.
import { h, clear, ensureCss, isWide, onWideChange } from '../../core/dom.js';
import { t, tp, loadStrings, formatSize } from '../../core/i18n.js';
import {
  topBar, button, iconButton, textField, fileCard, emptyState, bottomBar, progressDialog,
  snackbar, alertDialog, linearProgress, uid,
} from '../../core/ui.js';
import { pickFiles } from '../../core/files.js';
import { openPdf } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { UserError, CancelledError } from '../../core/errors.js';
import { createEditor } from './editor.js';
import { pageStrip } from './strip.js';

/** Renders Redact PDF into ctx.root. See docs/api/redact-ui.md. */
export async function mount(ctx) {
  // The engine (pdf-lib and the rest) loads while a PDF is being chosen.
  const engineLoad = import('../../engine/redact.js');
  engineLoad.catch(() => {});
  await Promise.all([loadStrings('redact'), ensureCss(new URL('./redact.css', import.meta.url))]);

  /** What the app's view model keeps for Redact PDF, and the screen's own state. */
  const s = {
    source: null,
    boxes: [],
    page: 0,
    selected: -1,
    // What Find text looked for in this PDF, as typed: form fields holding it go too.
    searched: [],
    query: '',
    fileName: '',
    opening: false,
    finding: false,
    processing: false,
    result: null,
  };
  let E = null;
  let unmounted = false;
  /** Aborted when the screen goes: a password dialog still open closes with it. */
  const life = new AbortController();
  let openToken = 0;
  let findController = null;
  let runController = null;
  let resultEl = null;
  let showing = 'editor';
  let editorScroll = 0;
  /** The parts of the screen for the PDF chosen (built by buildLoaded). */
  let ui = null;
  /** "Choose PDF", while there is no PDF. */
  let empty = null;

  // ---- The screen's frame: top bar, page, bottom bar ----

  const makeBar = () => topBar({ title: t('tool_redact'), onBack: () => ctx.back() });
  let bar = makeBar();
  // The screen's main landmark, where Skip to content goes.
  const page = h('main', { class: 'page redact-page', 'data-main': '' });
  const opening = linearProgress({ value: null, label: t('pdf_working') });
  opening.classList.add('redact-opening');
  opening.hidden = true;
  const runButton = button({ label: t('pdf_redact_action'), onClick: () => run(), disabled: true });
  const bottom = bottomBar(runButton);
  ctx.root.classList.add('redact-screen');
  ctx.root.append(bar, page, bottom);

  // Messages show above the bottom bar, as the app's snackbar host sits above its button: the
  // kit's snackbar lifts itself over a bottom bar showing (and not over the result screen).

  // ---- The app's view model, for Redact PDF ----

  const inRange = (b) => s.source && b.page >= 0 && b.page < s.source.pageCount;

  function showPage(index) {
    if (!s.source) return;
    const next = Math.max(0, Math.min(s.source.pageCount - 1, index));
    if (next === s.page) return;
    s.page = next;
    s.selected = -1;
    changed({ page: true });
  }

  function selectBox(index) {
    s.selected = index >= 0 && index < s.boxes.length ? index : -1;
    changed();
  }

  /** Adds `box` and chooses it; says so instead when there are as many boxes as Usugami keeps. */
  function addBox(box) {
    if (s.boxes.length >= E.MAX_BOXES) {
      snackbar(t('redact_too_many', E.MAX_BOXES));
      return false;
    }
    s.boxes = [...s.boxes, E.clamp(box)];
    s.selected = s.boxes.length - 1;
    changed();
    return true;
  }

  /**
   * Puts `box` in the place of box `was`, at `index` when the change began, wherever it is now.
   * Once `was` itself has gone (deleted, or changed by something else meanwhile), nothing changes.
   */
  function changeBox(index, was, box) {
    const at = E.findBox(s.boxes, index, was);
    if (at < 0) return;
    const next = s.boxes.slice();
    next[at] = E.clamp(box);
    s.boxes = next;
    changed();
  }

  /** Changes the chosen box by `step` from where it is now: a second quick press goes on from the first. */
  function stepChosen(step) {
    const index = s.selected;
    const box = s.boxes[index];
    if (!box) return;
    changeBox(index, box, step(box));
  }

  /** Deletes the chosen box. Pressed again at once, it finds none chosen. */
  function deleteChosen() {
    const index = s.selected;
    if (index < 0 || index >= s.boxes.length) return false;
    s.boxes = s.boxes.filter((_, i) => i !== index);
    s.selected = -1;
    changed();
    return true;
  }

  function clearBoxes() {
    s.boxes = [];
    s.searched = [];
    s.selected = -1;
    changed();
  }

  // ---- Choosing and putting away the PDF ----

  async function pick() {
    if (s.opening || s.processing) return;
    const items = await pickFiles({ accept: 'pdf' });
    if (items[0]) open(items[0]);
  }

  async function open(item) {
    if (s.opening || s.processing || unmounted) return;
    const token = ++openToken;
    s.opening = true;
    renderBody();
    let source = null;
    try {
      try {
        E = await engineLoad;
      } catch {
        snackbar(t('web_tool_load_failed', t('tool_redact')));
        return;
      }
      source = await openPdf(item, { ...(item.password != null ? { password: item.password } : {}), signal: life.signal });
      if (!source) return;
      if (token !== openToken || unmounted) {
        source.close();
        return;
      }
      await setSource(source);
    } catch (e) {
      source?.close();
      if (token !== openToken || unmounted || e instanceof CancelledError) return;
      snackbar(e instanceof UserError ? t(e.key, ...e.args) : t('pdf_import_failed'));
    } finally {
      if (token === openToken && !unmounted) {
        s.opening = false;
        renderBody();
      }
    }
  }

  async function setSource(source) {
    const pdf = await source.pdfjs();
    s.source = source;
    s.boxes = [];
    s.searched = [];
    s.page = 0;
    s.selected = -1;
    s.query = '';
    s.fileName = E.redactedName(source.name);
    buildLoaded(pdf);
    // Choose PDF, pressed to get here, has gone: the focus goes to the PDF's card in its place.
    focusIfLost(ui?.card);
  }

  /** Focuses `target` when the focus has nowhere to be (it was on something that went). */
  function focusIfLost(target) {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || !ctx.root.contains(active)) target?.focus?.({ preventScroll: true });
  }

  /** Redact PDF starts again: its boxes belong to the PDF they were drawn on. */
  function startOver() {
    openToken++;
    findController?.abort();
    findController = null;
    runController?.abort();
    s.finding = false;
    s.opening = false;
    putAwayResult();
    destroyLoaded();
    s.source?.close();
    s.source = null;
    s.boxes = [];
    s.searched = [];
    s.page = 0;
    s.selected = -1;
    s.query = '';
    s.fileName = '';
    renderBody();
    showEditor();
  }

  async function removePdf() {
    if (s.processing) return;
    if (hasUnsavedWork()) {
      const discard = await alertDialog({ title: t('tool_discard_title'), confirm: t('discard'), dismiss: t('keep'), destructive: true });
      if (!discard || unmounted) return;
    }
    startOver();
    // The focus goes where the PDF was: to the button that chooses another.
    empty?.focus({ preventScroll: true });
  }

  // ---- Find text ----

  async function find() {
    const query = s.query;
    if (!s.source || !query.trim() || s.finding || s.processing) return;
    const source = s.source;
    // The keyboard goes away on a phone, so the page and the message under it show.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ui?.findField.input.blur();
    s.finding = true;
    ui?.findProgress.setValue(null);
    updateFind();
    updateRun();
    const controller = new AbortController();
    findController = controller;
    try {
      const found = await E.findText(source, query, {
        signal: controller.signal,
        onProgress: (done, total) => ui?.findProgress.setValue(total ? done / total : null),
      });
      if (controller.signal.aborted || s.source !== source || unmounted) return;
      const r = E.addFound(s.boxes, found);
      if (!found.length) {
        snackbar(t('redact_find_none'));
      } else if (r.tooMany) {
        snackbar(t('redact_find_too_many', E.MAX_BOXES));
      } else {
        s.boxes = r.boxes;
        if (!s.searched.includes(query)) s.searched = [...s.searched, query];
        // Shows a page with matches, unless the one showing has some.
        const moved = !r.pages.includes(s.page);
        if (moved) s.page = r.pages[0];
        s.selected = -1;
        changed({ page: moved });
        snackbar(tp('redact_found', r.matches, r.matches));
      }
    } catch (e) {
      if (controller.signal.aborted || e instanceof CancelledError || unmounted) return;
      snackbar(t('redact_find_failed'));
    } finally {
      // A search for another PDF may have started since this one was abandoned.
      if (findController === controller) {
        findController = null;
        s.finding = false;
        updateFind();
        updateRun();
      }
    }
  }

  /** Stops the search under way; the boxes stay as they were. */
  function stopFind() {
    if (!findController) return;
    findController.abort();
    findController = null;
    s.finding = false;
    updateFind();
    updateRun();
  }

  // ---- Redact PDF ----

  async function run() {
    const source = s.source;
    if (!source || s.finding || s.processing || s.opening) return;
    const boxes = s.boxes.filter(inRange);
    if (!boxes.length) return;
    s.processing = true;
    updateRun();
    const controller = new AbortController();
    runController = controller;
    const dialog = progressDialog({ title: t('pdf_working'), onCancel: () => controller.abort() });
    let out = null;
    let failure = null;
    try {
      out = await E.redactPdf(source, boxes.map((box) => ({ pageIndex: box.page, box })), {
        signal: controller.signal,
        onProgress: (done, total) => dialog.update(total ? done / total : null),
        searched: s.searched,
        name: s.fileName,
      });
    } catch (e) {
      failure = e;
    } finally {
      // Gone before anything else shows: while it is up the rest of the screen is inert, so a
      // message wouldn't be heard and the result's heading couldn't take the focus.
      await dialog.close();
      if (runController === controller) runController = null;
      s.processing = false;
      if (!unmounted) updateRun();
    }
    if (failure && !(failure instanceof CancelledError) && !controller.signal.aborted && !unmounted) {
      snackbar(failure instanceof UserError ? t(failure.key, ...failure.args) : t('pdf_process_failed'));
    }
    if (!out || unmounted || s.source !== source) return;
    s.result = out;
    showResultScreen();
    ctx.pushStep('result');
  }

  // ---- The result screen, a step of this screen ----

  function showResultScreen() {
    if (!s.result) return;
    if (showing === 'editor') editorScroll = window.scrollY;
    showing = 'result';
    resultEl?.destroy();
    resultEl = showResult(ctx.root, {
      files: [s.result],
      passwordRemoved: !!s.source?.password,
      onBack: () => {
        putAwayResult();
        showEditor();
        ctx.popStep();
      },
      onStartOver: () => {
        startOver();
        ctx.popStep();
      },
    });
    window.scrollTo(0, 0);
  }

  function putAwayResult() {
    resultEl?.destroy();
    resultEl = null;
    s.result = null;
  }

  function showEditor() {
    if (showing === 'editor') return;
    showing = 'editor';
    clear(ctx.root);
    // A new bar: the one put away has stopped following the page's scrolling.
    bar = makeBar();
    ctx.root.append(bar, page, bottom);
    ui?.editor.relayout();
    window.scrollTo(0, editorScroll);
    const heading = bar.querySelector('h1');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  // ---- Drawing the screen ----

  /** The empty state, or the PDF and its options, as the state is. */
  function renderBody() {
    opening.hidden = !s.opening;
    if (s.source && ui) {
      if (ui.el.parentNode !== page) {
        clear(page);
        page.append(opening, ui.el);
      }
    } else {
      empty ??= emptyState({
        icon: 'add',
        title: t('pick_pdf'),
        onClick: pick,
        onFiles: (items) => open(items[0]),
        accept: 'pdf',
        multiple: false,
      });
      // Picking is off while a PDF is being opened: a second pick then would be ignored. Not with
      // `disabled`, which would throw the keyboard focus out of the button just pressed (and the
      // password dialog would give it back to nothing); pick() and open() check for themselves.
      if (s.opening) empty.setAttribute('aria-disabled', 'true');
      else empty.removeAttribute('aria-disabled');
      if (empty.parentNode !== page) {
        clear(page);
        page.append(opening, empty);
      }
    }
    updateRun();
  }

  function destroyLoaded() {
    if (!ui) return;
    ui.editor.destroy();
    ui.strip?.destroy();
    ui = null;
  }

  /** Builds the options for the PDF just chosen (RedactOptions), between its card and its name. */
  function buildLoaded(pdf) {
    destroyLoaded();
    const source = s.source;
    const count = source.pageCount;

    const card = fileCard({
      name: source.name,
      detail: t('result_details', tp('page_count', count, count), formatSize(source.size)),
      thumbnail: source.thumbnail(0, 58).catch(() => null),
      onRemove: removePdf,
    });
    // It takes the focus from Choose PDF once the PDF has opened.
    card.tabIndex = -1;

    const note = h('p', { class: 'redact-note' }, t('redact_note'));

    // Find text: a word or phrase to box on every page, with a button and the keyboard's search key.
    const findField = textField({
      label: t('redact_find'),
      helper: t('redact_find_hint'),
      autocomplete: 'off',
      onInput: (v) => {
        s.query = v;
        updateFind();
      },
      onEnter: () => find(),
    });
    findField.input.setAttribute('enterkeyhint', 'search');
    findField.classList.add('redact-find');
    const findButton = iconButton({ icon: 'search', label: t('redact_find_action'), onClick: () => find(), cls: 'redact-find-button' });
    // A long PDF takes a while to search: meanwhile the button stops the search instead.
    const stopButton = iconButton({ icon: 'close', label: t('cancel'), onClick: () => stopFind(), cls: 'redact-find-button' });
    stopButton.hidden = true;
    findField.querySelector('.ui-field-box').append(findButton, stopButton);
    // While searching, a bar takes the place of the hint, so the field doesn't jump.
    const findProgress = linearProgress({ value: null, label: t('redact_find') });
    const findBusy = h('div', { class: 'redact-find-progress', hidden: true }, findProgress);
    findField.append(findBusy);

    const side = h('div', { class: 'redact-side' }, card, note, findField);

    const markedId = uid('redact-marked');
    const marked = h('span', { class: 'visually-hidden', id: markedId }, t('redact_page_marked'));
    let strip = null;
    if (count > 1) {
      const headingId = uid('redact-page');
      strip = pageStrip({ source, count, selected: s.page, labelledBy: headingId, markedId, onSelect: (i) => showPage(i) });
      side.append(h('section', { class: 'redact-pages' }, h('h2', { class: 'redact-title', id: headingId }, t('redact_page')), strip, marked));
    }

    // The page, its boxes, and how to change them.
    const keysId = uid('redact-keys');
    const keys = h('p', { class: 'redact-keys', id: keysId }, t('web_redact_keys_hint'));
    const editor = createEditor({
      engine: E,
      state: () => s,
      describedBy: keysId,
      onSelect: (i) => selectBox(i),
      onAdd: (box) => {
        if (addBox(box)) editor.focusBox(s.selected);
      },
      onChange: (index, was, box) => changeBox(index, was, box),
      onKeyStep: (index, step) => {
        if (s.selected !== index) selectBox(index);
        stepChosen(step);
      },
      onKeyDelete: (index) => {
        if (s.selected !== index) selectBox(index);
        deleteFocusingNext({ toNext: true });
      },
      onPage: (i) => showPage(i),
      onReady: () => updateActions(),
    });
    const markHeading = h('h2', { class: 'redact-title' }, t('redact_mark'));
    const head = h('div', { class: 'redact-head' }, markHeading, editor.zoomBar);
    const hint = h('p', { class: 'redact-hint' }, t('redact_mark_hint'));

    const controls = boxControls();
    const addButton = button({
      label: t('redact_add_box'),
      icon: 'add',
      variant: 'outlined',
      onClick: () => {
        // Boxes can be added and then moved and sized with buttons, without drawing.
        const frame = editor.frame();
        if (!frame) return;
        const onPage = s.boxes.filter((b) => b.page === s.page).length;
        if (addBox(E.defaultBox(s.page, frame.shownWidth, frame.shownHeight, onPage))) editor.focusBox(s.selected);
      },
    });
    const removeAll = button({
      label: t('redact_remove_all'),
      variant: 'text',
      onClick: async () => {
        const n = s.boxes.length;
        if (!n) return;
        const ok = await alertDialog({
          title: t('redact_remove_all_title'),
          message: tp('redact_remove_all_body', n, n),
          confirm: t('redact_remove_all'),
          dismiss: t('cancel'),
        });
        if (ok && !unmounted) {
          clearBoxes();
          addButton.focus({ preventScroll: true });
        }
      },
    });
    removeAll.classList.add('redact-remove-all', 'is-gone');
    const actions = h('div', { class: 'redact-actions' }, addButton, h('span', { class: 'redact-spacer' }), removeAll);

    // The page and what is said under it stay together: on wide screens they fill the right side,
    // and the buttons go to the left with the other options.
    const stage = h('div', { class: 'redact-stage' }, head, editor.el, hint, keys);
    const main = h('div', { class: 'redact-main' }, stage, controls.el, actions);

    const nameField = textField({
      label: t('file_name'),
      value: s.fileName,
      suffix: '.pdf',
      autocomplete: 'off',
      onInput: (v) => { s.fileName = v; },
    });
    const tail = h('div', { class: 'redact-tail' }, nameField);

    const el = h('div', { class: 'redact-layout' }, side, main, tail);
    ui = { el, card, editor, strip, findField, findButton, stopButton, findProgress, findBusy, controls, addButton, removeAll, nameField };
    renderBody();
    editor.setPdf(pdf);
    editor.showPage(s.page);
    updateFind();
    changed();
  }

  /**
   * Buttons that move, size and delete the chosen box a step at a time, for those who can't drag
   * (BoxControls). Each acts on the box as it is when pressed. While they go away they keep showing
   * the box they were for, as the app's.
   */
  function boxControls() {
    const steps = [];
    const stepButton = (iconName, label, step) => {
      const b = iconButton({ icon: iconName, label: t(label), onClick: () => {
        stepChosen(step);
        // A button that can't go further is off; the keyboard carries on from the box.
        if (b.disabled && document.activeElement !== b) ui?.editor.focusBox(s.selected);
      } });
      b.dataset.step = label;
      steps.push({ b, step });
      return b;
    };
    const STEP = E.STEP;
    const arrows = h('div', { class: 'redact-arrows' },
      stepButton('west', 'redact_move_left', (box) => E.moved(box, -STEP, 0)),
      stepButton('north', 'redact_move_up', (box) => E.moved(box, 0, -STEP)),
      stepButton('south', 'redact_move_down', (box) => E.moved(box, 0, STEP)),
      stepButton('east', 'redact_move_right', (box) => E.moved(box, STEP, 0)));
    // Width and height each stay together, one under the other on a narrow screen.
    const sizes = h('div', { class: 'redact-sizes' },
      h('div', { class: 'redact-size' },
        h('span', { class: 'redact-size-label', 'aria-hidden': 'true' }, t('redact_width')),
        stepButton('remove', 'redact_narrower', (box) => E.resized(box, -STEP, 0)),
        stepButton('add', 'redact_wider', (box) => E.resized(box, STEP, 0))),
      h('div', { class: 'redact-size' },
        h('span', { class: 'redact-size-label', 'aria-hidden': 'true' }, t('redact_height')),
        stepButton('remove', 'redact_shorter', (box) => E.resized(box, 0, -STEP)),
        stepButton('add', 'redact_taller', (box) => E.resized(box, 0, STEP))));
    const del = button({ label: t('redact_delete_box'), icon: 'delete', variant: 'text', tone: 'danger', onClick: () => deleteFocusingNext() });
    del.dataset.step = 'redact_delete_box';
    const inner = h('div', { class: 'redact-controls-inner' }, arrows, sizes, del);
    const el = h('div', { class: 'redact-controls is-gone', hidden: true }, inner);
    let shown = false;
    let hideTimer = 0;
    return {
      el,
      update(chosen) {
        // On a wide screen the buttons stay, off while no box is chosen: they sit beside the page,
        // which mustn't shift while they come and go.
        const wide = isWide();
        if (chosen) {
          // A button stays on while its step still changes the box.
          for (const { b, step } of steps) b.disabled = E.same(step(chosen), chosen);
        } else if (wide) {
          for (const { b } of steps) b.disabled = true;
        }
        del.disabled = wide && !chosen;
        el.classList.toggle('is-idle', wide && !chosen);
        if (chosen || wide) {
          if (!shown) {
            shown = true;
            clearTimeout(hideTimer);
            el.hidden = false;
            // Opens downwards while it fades in.
            if (wide) el.classList.remove('is-gone');
            else requestAnimationFrame(() => requestAnimationFrame(() => { if (shown) el.classList.remove('is-gone'); }));
          }
        } else if (shown) {
          shown = false;
          el.classList.add('is-gone');
          const ms = parseFloat(getComputedStyle(el).transitionDuration) * 1000 || 0;
          hideTimer = setTimeout(() => { if (!shown) el.hidden = true; }, ms + 20);
        }
      },
    };
  }

  /**
   * Deletes the chosen box and moves the focus on, where it was in the editor or its buttons. The
   * Delete key goes on to the next box of the page (each press deletes the box it is on). Delete
   * box leaves the page itself with the focus and no box chosen, as the app does, so a second quick
   * press finds none to delete. With no box left on the page, Add box takes the focus.
   */
  function deleteFocusingNext({ toNext = false } = {}) {
    const index = s.selected;
    const hadFocus = ui && (ui.editor.hasFocus() || ui.controls.el.contains(document.activeElement));
    const onPage = s.boxes.map((b, i) => (b.page === s.page ? i : -1)).filter((i) => i >= 0);
    const at = onPage.indexOf(index);
    if (!deleteChosen()) return;
    if (!hadFocus || !ui) return;
    const left = s.boxes.map((b, i) => (b.page === s.page ? i : -1)).filter((i) => i >= 0);
    if (!left.length) {
      ui.addButton.focus({ preventScroll: true });
      return;
    }
    if (toNext && ui.editor.focusBox(left[Math.min(Math.max(0, at), left.length - 1)])) return;
    ui.editor.focusFallback();
  }

  // ---- Keeping the screen up to date ----

  function changed({ page: pageChanged = false } = {}) {
    if (!ui || unmounted) {
      updateRun();
      return;
    }
    if (pageChanged) {
      ui.editor.showPage(s.page);
      ui.strip?.setSelected(s.page);
    }
    ui.editor.update();
    ui.strip?.setMarked(new Set(s.boxes.filter(inRange).map((b) => b.page)));
    const chosen = s.boxes[s.selected]?.page === s.page ? s.boxes[s.selected] : null;
    ui.controls.update(chosen);
    updateActions();
    updateRun();
  }

  function updateActions() {
    if (!ui) return;
    ui.addButton.disabled = !ui.editor.isReady() || s.processing;
    const any = s.boxes.length > 0;
    ui.removeAll.classList.toggle('is-gone', !any);
    ui.removeAll.disabled = !any;
    ui.removeAll.setAttribute('aria-hidden', String(!any));
    ui.removeAll.tabIndex = any ? 0 : -1;
  }

  function updateFind() {
    if (!ui) return;
    const stopHadFocus = document.activeElement === ui.stopButton;
    const findHadFocus = document.activeElement === ui.findButton;
    ui.findButton.disabled = !s.source || s.finding || !s.query.trim();
    ui.findButton.hidden = s.finding;
    ui.stopButton.hidden = !s.finding;
    ui.findBusy.hidden = !s.finding;
    ui.findField.setHelper(s.finding ? '' : t('redact_find_hint'));
    // The focus stays on the button that takes the other's place.
    if (findHadFocus && s.finding) ui.stopButton.focus({ preventScroll: true });
    else if (stopHadFocus && !s.finding) (ui.findButton.disabled ? ui.findField.input : ui.findButton).focus({ preventScroll: true });
  }

  function updateRun() {
    runButton.disabled = !(s.source && s.boxes.some(inRange) && !s.finding && !s.processing && !s.opening);
  }

  function hasUnsavedWork() {
    return s.boxes.length > 0 || (!!resultEl && !resultEl.isSaved());
  }

  renderBody();
  // The box buttons stay beside the page on wide screens, and come and go under it on phones.
  const stopWide = onWideChange(() => changed());
  // A PDF handed over (shared to the app, Choose a tool, dropped on Home) opens at once.
  const handed = ctx.files?.find((f) => f?.bytes) ?? null;
  // A reload on the result step: the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep();
  if (handed) open(handed);

  return {
    unmount() {
      unmounted = true;
      life.abort();
      stopWide();
      empty?.detachDrop?.();
      openToken++;
      findController?.abort();
      runController?.abort();
      putAwayResult();
      destroyLoaded();
      s.source?.close();
      s.source = null;
    },
    hasUnsavedWork,
    onStep(step) {
      if (step === 'result' && s.result) {
        if (showing !== 'result') showResultScreen();
        return;
      }
      // Back from the result goes back to editing; its PDF goes, as the app's.
      putAwayResult();
      showEditor();
      if (step === 'result') ctx.popStep();
    },
    /** What the screen holds, for tests and for checking from the console. */
    redact: {
      state: () => ({
        boxes: s.boxes.map((b) => ({ ...b })), page: s.page, selected: s.selected, searched: [...s.searched],
        finding: s.finding, processing: s.processing, fileName: s.fileName, pageCount: s.source?.pageCount ?? 0,
      }),
      addBox: (box) => addBox(box),
      showPage: (i) => showPage(i),
      selectBox: (i) => selectBox(i),
      clearBoxes: () => clearBoxes(),
      ready: () => !!ui?.editor.isReady(),
      result: () => s.result,
      zoom: () => ui?.editor.zoom() ?? 1,
      setZoom: (z) => ui?.editor.setZoom(z),
    },
  };
}
