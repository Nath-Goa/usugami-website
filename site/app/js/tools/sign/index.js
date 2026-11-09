// Sign PDF (PdfToolScreen.kt with SignOptions.kt and SignaturePad.kt): choose a PDF, draw a
// signature, pick the page, drag the signature into place on a preview of it and choose its size,
// then Sign PDF. The signature stays for the whole visit, so another PDF can be signed without
// drawing it again; it lives only in this module's memory, never in any storage.
import { h, ensureCss } from '../../core/dom.js';
import { t, tp, loadStrings, formatSize } from '../../core/i18n.js';
import {
  topBar, button, bottomBar, emptyState, fileCard, textField, snackbar, progressDialog, dropZone, linearProgress,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { pickFiles } from '../../core/files.js';
import { openPdf, reportFileProblems } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { baseName, withSuffix } from '../../core/names.js';
import { UserError, CancelledError } from '../../core/errors.js';
import { signPdf } from '../../engine/sign.js';
import { openSignaturePad, closeSignaturePad } from './pad.js';
import { pageStrip, signaturePlacer, signatureSvg } from './placer.js';

/** The signature drawn this visit (a Signature), or null. Gone when the page is reloaded or closed. */
let sessionSignature = null;

/** The signature kept for this visit, as { strokes, ink } (for tests), or null. */
export function keptSignature() {
  return sessionSignature ? sessionSignature.toJSON() : null;
}

/** Renders Sign PDF into ctx.root. */
export async function mount(ctx) {
  await Promise.all([loadStrings('sign'), ensureCss(new URL('./sign.css', import.meta.url))]);

  const state = {
    src: null,
    // A signature usually goes at the end, so the last page is chosen first.
    page: 0,
    // null: not moved yet, so it sits where it starts out on whichever page is chosen.
    placement: null,
    fileName: '',
    opening: false,
    processing: false,
    view: 'edit',
    result: null,
    lastOutput: null,
  };
  let unmounted = false;
  /** Aborted when the screen goes: a password dialog still open closes with it. */
  const life = new AbortController();
  let runBtn = null;
  let detachDrop = null;
  let strip = null;
  let placer = null;
  let parts = null;

  const ready = () => !!state.src && !!sessionSignature && !state.opening && !state.processing;
  const updateButton = () => { if (runBtn) runBtn.disabled = !ready(); };

  function dropEditor() {
    detachDrop?.();
    detachDrop = null;
    strip?.destroy();
    strip = null;
    placer?.destroy();
    placer = null;
    parts = null;
  }

  // ---- Opening, removing and starting over

  async function openItem(item) {
    if (!item || state.opening) return;
    state.opening = true;
    render();
    let src = null;
    try {
      src = await openPdf(item, { password: item.password, signal: life.signal });
    } catch (e) {
      if (!(e instanceof CancelledError)) reportFileProblems([{ name: item.name, error: e }]);
    }
    state.opening = false;
    if (unmounted) {
      src?.close();
      return;
    }
    if (src) {
      state.src?.close();
      state.src = src;
      state.page = Math.max(0, src.pageCount - 1);
      state.placement = null;
      state.fileName = withSuffix(baseName(src.name), '_signed', 'Usugami');
    }
    render();
    // The card picked from has gone: the focus goes on to the signature, what comes next.
    const active = document.activeElement;
    if (src && (!active || active === document.body || !active.isConnected)) parts?.signatureCard.focus({ preventScroll: true });
  }

  async function pick() {
    const items = await pickFiles({ accept: 'pdf', multiple: false });
    if (items.length) openItem(items[0]);
  }

  function removePdf() {
    state.src?.close();
    state.src = null;
    state.placement = null;
    render();
    focusHeading();
  }

  function focusHeading() {
    const title = ctx.root.querySelector('h1');
    if (!title) return;
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }

  // ---- The signature

  async function drawSignature() {
    const signature = await openSignaturePad({ initial: sessionSignature });
    if (unmounted || !signature || signature.isEmpty) return;
    sessionSignature = signature;
    updateSignatureParts();
    updateButton();
    parts?.signatureCard.focus({ preventScroll: true });
  }

  function signatureCard() {
    if (!sessionSignature) {
      return h('button', { type: 'button', class: 'sign-card sign-card--draw', onClick: drawSignature },
        h('span', { class: 'sign-card-icon', 'aria-hidden': 'true' }, icon('draw', { size: 32 })),
        h('span', { class: 'sign-card-label' }, t('sign_draw')));
    }
    // On white, like the pad, so black ink shows in the dark theme too.
    return h('button', { type: 'button', class: 'sign-card sign-card--change', 'aria-label': t('sign_change'), onClick: drawSignature },
      h('span', { class: 'sign-card-ink' }, signatureSvg(sessionSignature, { fit: 'meet', cls: 'sign-card-svg' })),
      h('span', { class: 'sign-card-edit', 'aria-hidden': 'true' }, icon('edit', { size: 24 })));
  }

  /** The signature's card, and choosing the page and the place once there is a signature to place. */
  function updateSignatureParts() {
    if (!parts) return;
    const card = signatureCard();
    parts.signatureCard.replaceWith(card);
    parts.signatureCard = card;
    const src = state.src;
    const has = !!sessionSignature;
    parts.layout.classList.toggle('has-place', has);
    if (has && src.pageCount > 1 && !strip) {
      strip = pageStrip({
        src, selected: state.page, label: t('sign_page'),
        onSelect: (i) => {
          state.page = i;
          placer?.setPage(i);
        },
      });
      parts.pages.replaceChildren(h('h2', { class: 'sign-title' }, t('sign_page')), strip);
      parts.pages.hidden = false;
      parts.pages.classList.add('sign-enter');
    }
    if (has && !placer) {
      placer = signaturePlacer({
        src, signature: sessionSignature, page: state.page, placement: state.placement,
        onPlacement: (p) => { state.placement = p; },
      });
      parts.place.replaceChildren(placer.el);
      parts.controls.replaceChildren(placer.controls);
      for (const box of [parts.place, parts.controls]) {
        box.hidden = false;
        box.classList.add('sign-enter');
      }
    } else if (placer) {
      placer.setSignature(sessionSignature);
    }
  }

  // ---- Screens

  function render() {
    dropEditor();
    state.view = 'edit';
    const bar = topBar({ title: t('tool_sign'), onBack: () => ctx.back() });
    const page = h('div', { class: 'page sign-page' });
    runBtn = button({ label: t('pdf_sign_action'), onClick: run, cls: 'sign-run' });
    ctx.root.replaceChildren(bar, page, bottomBar(runBtn));
    updateButton();
    if (state.opening) page.append(linearProgress({ value: null, label: t('pdf_working') }));
    if (!state.src) {
      const empty = emptyState({
        icon: 'add', title: t('pick_pdf'), onClick: () => { if (!state.opening) pick(); },
        onFiles: (items) => openItem(items[0]), accept: 'pdf', multiple: false,
      });
      if (state.opening) empty.disabled = true;
      page.append(h('div', { class: 'sign-empty' }, empty));
      return;
    }
    const src = state.src;
    const pdfCard = fileCard({
      name: src.name,
      detail: t('result_details', tp('page_count', src.pageCount), formatSize(src.size)),
      thumbnail: src.thumbnail(0, 58).catch(() => null),
      onRemove: removePdf,
    });
    const nameField = textField({
      label: t('file_name'), value: state.fileName, suffix: '.pdf',
      onInput: (v) => { state.fileName = v; },
    });
    const signatureCardEl = signatureCard();
    const signatureSection = h('section', { class: 'sign-signature' },
      h('h2', { class: 'sign-title' }, t('sign_signature')),
      signatureCardEl,
      h('p', { class: 'sign-note' }, t('sign_note')));
    const pages = h('section', { class: 'sign-pages', hidden: true });
    const place = h('div', { class: 'sign-place-box', hidden: true });
    const controls = h('div', { class: 'sign-controls-box', hidden: true });
    const layout = h('div', { class: 'sign-layout' },
      h('div', { class: 'sign-file' }, pdfCard),
      signatureSection,
      pages,
      place,
      controls,
      h('div', { class: 'sign-name' }, nameField));
    page.append(layout);
    parts = { layout, signatureCard: signatureCardEl, pages, place, controls };
    updateSignatureParts();
    // Pages and the place don't animate in when the editor is drawn again.
    for (const box of [pages, place, controls]) box.classList.remove('sign-enter');
    // On a computer, another PDF dropped (or pasted) here takes this one's place.
    detachDrop = dropZone(page, { accept: 'pdf', multiple: false, onFiles: (items) => openItem(items[0]) });
  }

  async function run() {
    if (!ready()) return;
    const src = state.src;
    state.processing = true;
    updateButton();
    const controller = new AbortController();
    const dialog = progressDialog({ title: t('pdf_working'), onCancel: () => controller.abort() });
    let out = null;
    try {
      out = await signPdf(
        { name: src.name, bytes: src.bytes, password: src.password },
        { signature: sessionSignature, page: state.page, placement: state.placement, name: state.fileName },
        { signal: controller.signal },
      );
    } catch (e) {
      if (!(e instanceof CancelledError) && !unmounted) snackbar(e instanceof UserError ? t(e.key, ...e.args) : t('pdf_process_failed'));
    } finally {
      await dialog.close();
      state.processing = false;
    }
    if (unmounted) return;
    if (out) {
      showResultView(out);
      ctx.pushStep?.('result');
    } else {
      updateButton();
    }
  }

  function showResultView(out) {
    dropEditor();
    runBtn = null;
    state.view = 'result';
    state.lastOutput = out;
    state.result = showResult(ctx.root, {
      files: [out],
      passwordRemoved: !!state.src?.password,
      onBack: () => {
        backToEditing();
        ctx.popStep?.();
      },
      onStartOver: () => {
        startOver();
        ctx.popStep?.();
      },
    });
  }

  function putAwayResult() {
    state.result?.destroy();
    state.result = null;
  }

  function backToEditing() {
    if (state.view !== 'result') return;
    putAwayResult();
    render();
    focusHeading();
  }

  function startOver() {
    putAwayResult();
    state.lastOutput = null;
    state.src?.close();
    state.src = null;
    state.placement = null;
    render();
    focusHeading();
  }

  render();
  // A reload on the result step: the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();
  if (ctx.files?.length) openItem(ctx.files[0]);

  return {
    unmount() {
      unmounted = true;
      life.abort();
      closeSignaturePad();
      dropEditor();
      putAwayResult();
      state.src?.close();
      state.src = null;
    },
    hasUnsavedWork() {
      return state.processing || (state.view === 'result' && !!state.result && !state.result.isSaved());
    },
    onStep(step) {
      if (step == null) backToEditing();
      else if (step === 'result' && state.view === 'edit' && state.lastOutput && state.src) showResultView(state.lastOutput);
    },
  };
}

