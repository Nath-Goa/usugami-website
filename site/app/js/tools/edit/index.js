// Edit PDF (EditPdfOptions.kt, EditPreview.kt, EditHistory.kt and the edit parts of
// PdfToolScreen.kt and PdfToolsViewModel.kt): one page at a time, large, with what was added drawn
// on it. A row of tools adds text, shapes and pictures (each put in the middle of the page and
// chosen, ready to move) or turns on drawing with a pen or highlighter. The chosen item's controls
// sit under the page (beside it on wide screens). Everything but drawing itself also works with
// buttons and the keyboard, for those who can't drag.
import { h, ensureCss, isWide, onWideChange } from '../../core/dom.js';
import { t, tp, tWeb, loadStrings, formatSize } from '../../core/i18n.js';
import {
  topBar, button, iconButton, bottomBar, emptyState, fileCard, textField, linearProgress, progressDialog,
  snackbar, alertDialog, dropZone, menu,
} from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { pickFiles } from '../../core/files.js';
import { openPdf } from '../../core/pdfdoc.js';
import { showResult } from '../../core/output.js';
import { withSuffix, baseName } from '../../core/names.js';
import { UserError, CancelledError } from '../../core/errors.js';
import {
  EditHistory, DEFAULT_STYLE, inkItem, newShape, newText, newPicture, clearOf, onPage, moved, copy,
  isBox, unitSize, textLayout, importPicture, decodePicture, editPages, shownPageSizes,
  PREVIEW_SIDE, TEXT_MAX_LENGTH,
} from '../../engine/edit.js';
import { createStage, ZOOM_MAX } from './stage.js';
import { toolbar, properties, pageStrip, textDialog, SHAPES } from './controls.js';

/** The message a problem shows: a UserError's own, else `fallback`'s. */
function problemText(error, fallback) {
  if (error instanceof UserError) {
    // The app's "this phone" words, as the web says them.
    if (error.key === 'watermark_no_font') return tWeb('watermark_no_font');
    return t(error.key, ...(error.args ?? []));
  }
  return t(fallback);
}

/** The zoom steps the buttons go through. */
const ZOOMS = [1, 1.5, 2, 3, 4, ZOOM_MAX];

export async function mount(ctx) {
  await Promise.all([loadStrings('edit'), ensureCss(new URL('./edit.css', import.meta.url))]);

  let src = null;           // the PdfSource being edited
  let sizes = null;         // each page's size as shown, from the PDF itself (engine shownPageSizes)
  let fallback = [];        // pdf.js's sizes, while those aren't known (or can't be)
  let pageIndex = 0;
  let mode = 'select';      // what a touch on the page does: 'select', 'pen' or 'highlighter'
  let style = { ...DEFAULT_STYLE };
  let fileName = '';
  let opening = 0;          // the latest PDF being opened; an older one is let go
  let importing = false;    // a PDF being opened
  let adding = false;       // a picture being taken in
  let processing = false;   // the PDF being made
  let result = null;
  let stepPushed = false;
  let gone = false;
  /** Aborted when the screen goes: a password dialog still open closes. */
  const life = new AbortController();
  let run = null;
  let dialog = null;        // the text dialog, while open
  let editor = null;        // the editor's parts, while a PDF is open
  let empty = null;

  const history = new EditHistory([], () => refresh());
  const previews = new Map();   // picture id → ImageBitmap, or 'pending' / 'failed'
  const layouts = new Map();    // colour and text → text layout, or 'pending'

  const saveBtn = button({ label: t('pdf_edit_action'), onClick: () => save() });
  const bar = topBar({ title: t(ctx.tool.title), onBack: () => ctx.back() });
  const loading = linearProgress({ value: null, label: t('web_edit_opening') });
  loading.classList.add('edit-loading');
  loading.hidden = true;
  const body = h('div', { class: 'edit-body' });
  const content = h('main', { class: 'page edit-main' }, loading, body);
  const screen = h('div', { class: 'edit-screen' }, bar, content, bottomBar(saveBtn));
  ctx.root.append(screen);

  // ---- Looking up what to draw ----

  const look = {
    text(item) {
      const text = item.text.slice(0, TEXT_MAX_LENGTH);
      const key = `${item.color}\n${text}`;
      const got = layouts.get(key);
      if (got && got !== 'pending') return got;
      if (!got) {
        layouts.set(key, 'pending');
        textLayout(text, item.color).then((layout) => {
          layouts.set(key, layout);
          editor?.stage.redraw();
        }, () => layouts.delete(key));
      }
      return null;
    },
    picture(item) {
      const got = previews.get(item.picture.id);
      if (got && typeof got !== 'string') return got;
      if (!got) {
        previews.set(item.picture.id, 'pending');
        decodePicture(item.picture, PREVIEW_SIDE).then((bitmap) => {
          if (gone) { bitmap.close?.(); return; }
          previews.set(item.picture.id, bitmap);
          editor?.stage.redraw();
        }, () => previews.set(item.picture.id, 'failed'));
      }
      return null;
    },
  };

  // ---- State ----

  const sizeOf = (i) => sizes?.[i] ?? fallback[i] ?? null;
  const shownSize = () => sizeOf(pageIndex) ?? { width: 595, height: 842 };
  const known = () => !!sizeOf(pageIndex);
  const itemsOnPage = () => history.items.filter((it) => it.page === pageIndex);
  const chosen = () => history.items.find((it) => it.id === history.selected && it.page === pageIndex) ?? null;
  const validItems = () => (src ? history.items.filter((it) => it.page < src.pageCount) : []);
  const ready = () => !!src && validItems().length > 0 && !importing && !adding && !processing;

  const hint = () => {
    if (mode !== 'select') return tWeb('edit_hint_draw');
    if (chosen()) return isWide() ? t('web_edit_hint_selected_wide') : t('edit_hint_selected');
    if (itemsOnPage().length) return t('edit_hint_select');
    return t('edit_hint_start');
  };

  /** Puts everything on the screen in step with the items, the page and the mode. */
  function refresh() {
    saveBtn.disabled = !ready();
    if (empty) empty.disabled = importing;
    if (!editor || gone) return;
    const e = editor;
    const size = shownSize();
    const item = chosen();
    // The chosen item is let go once it isn't on the page showing (Undo brought back another page's).
    if (history.selected != null && !item) {
      history.select(null);
      return;
    }
    e.tools.update({ mode, enabled: known() && !processing, importing: adding });
    e.hint.textContent = hint();
    e.undo.disabled = !history.canUndo || processing;
    e.redo.disabled = !history.canRedo || processing;
    e.stage.setMode(known() ? mode : 'select', style);
    e.stage.setItems(itemsOnPage(), item?.id ?? null);
    e.props.update({ item, mode, style, pageWidth: size.width, pageHeight: size.height });
    // Covering text with a filled box hides it only on the page as drawn: say so, and what really removes it.
    e.cover.hidden = !itemsOnPage().some((it) => isBox(it) && it.filled);
    e.strip?.update(pageIndex, new Set(history.items.map((it) => it.page)));
    if (e.pageLabel) e.pageLabel.textContent = t('web_edit_page_of', pageIndex + 1, src.pageCount);
    if (e.prev) e.prev.disabled = pageIndex <= 0;
    if (e.next) e.next.disabled = pageIndex >= src.pageCount - 1;
    const z = e.stage.zoom;
    e.zoomLabel.textContent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(z);
    e.zoomOut.disabled = z <= 1.001 || !known();
    e.zoomIn.disabled = z >= ZOOM_MAX - 0.001 || !known();
    e.zoomGroup.setAttribute('aria-label', t('web_edit_zoom_level', e.zoomLabel.textContent));
    e.addingBar.hidden = !adding;
  }

  const showPage = (i) => {
    if (!src || i < 0 || i >= src.pageCount) return;
    pageIndex = i;
    const selected = history.items.find((it) => it.id === history.selected);
    if (selected && selected.page !== i) history.select(null);
    editor?.stage.setPage(src, i, sizeOf(i));
    refresh();
    editor?.strip?.reveal(i);
  };

  const setMode = (wanted) => {
    mode = mode === wanted ? 'select' : wanted;
    history.select(null);
    refresh();
  };

  const full = () => snackbar(t('edit_full'));

  /** Adds `item` (chosen, unless it is a stroke), or says the PDF can take no more. */
  const add = (item) => {
    if (processing || gone) return false;
    if (!history.add(item)) {
      full();
      return false;
    }
    // The new item has the focus, so the keys (arrows, Delete) work on it and a screen reader names it.
    if (item.type !== 'ink' && item.page === pageIndex) editor?.stage.nodeOf(item.id)?.focus({ preventScroll: true });
    return true;
  };

  const undo = () => {
    if (processing) return;
    const page = history.undo();
    if (page != null) showPage(page);
  };

  const redo = () => {
    if (processing) return;
    const page = history.redo();
    if (page != null) showPage(page);
  };

  // ---- Adding ----

  const addText = async () => {
    if (!known() || processing) return;
    mode = 'select';
    refresh();
    const page = pageIndex;
    const { width, height } = shownSize();
    dialog = textDialog({ title: t('edit_text_add') });
    const text = await dialog;
    dialog = null;
    if (!text || gone || processing || !src) return;
    let unit;
    try {
      unit = await unitSize(text);
    } catch (e) {
      snackbar(problemText(e, 'pdf_process_failed'));
      return;
    }
    if (gone || processing || !src) return;
    const onThatPage = history.items.filter((it) => it.page === page);
    add(clearOf(newText(history.newId(), page, text, style.textSize, style.textColor, unit[0], unit[1], width, height), onThatPage, width, height));
  };

  const editText = async (item) => {
    if (!item || item.type !== 'text' || processing) return;
    dialog = textDialog({ title: t('edit_text_change'), initial: item.text });
    const text = await dialog;
    dialog = null;
    if (!text || gone || processing) return;
    let unit;
    try {
      unit = await unitSize(text);
    } catch (e) {
      snackbar(problemText(e, 'pdf_process_failed'));
      return;
    }
    // The text went (undone, say) while the dialog was open.
    const now = history.items.find((it) => it.id === item.id);
    if (!now || gone || processing) return;
    const size = sizeOf(now.page) ?? shownSize();
    history.replace(onPage(copy(now, { text, unitWidth: unit[0], unitHeight: unit[1] }), size.width, size.height));
  };

  const addShape = (shape) => {
    if (!known() || processing) return;
    mode = 'select';
    const { width, height } = shownSize();
    const item = newShape(history.newId(), pageIndex, shape.kind, shape.filled, style.shapeWidth, style.shapeColor, width, height);
    add(clearOf(item, itemsOnPage(), width, height));
  };

  const openShapes = (anchor) => {
    if (!known() || processing) return;
    menu(anchor, SHAPES.map((s) => ({ label: t(s.label), icon: s.icon, onClick: () => addShape(s) })));
  };

  /** Takes in the picture `file` and puts it in the middle of page `page`. */
  const addPicture = async (file, page = pageIndex) => {
    if (!src || adding || processing || gone) return;
    if (history.full) {
      full();
      return;
    }
    adding = true;
    refresh();
    const source = src;
    try {
      const picture = await importPicture(file);
      if (gone || src !== source) return;
      if (!picture) {
        snackbar(t('edit_picture_failed'));
        return;
      }
      const size = sizeOf(page) ?? shownSize();
      const item = newPicture(history.newId(), page, picture, picture.width / picture.height, size.width, size.height);
      mode = 'select';
      add(clearOf(item, history.items, size.width, size.height));
    } catch (e) {
      if (!(e instanceof CancelledError) && !gone) snackbar(t('edit_picture_failed'));
    } finally {
      adding = false;
      if (!gone) refresh();
    }
  };

  const pickPicture = async () => {
    if (!known() || adding || processing) return;
    if (history.full) {
      full();
      return;
    }
    mode = 'select';
    refresh();
    const page = pageIndex;
    const files = await pickFiles({ accept: 'image', multiple: false });
    if (files.length && !gone) await addPicture(files[0], page);
  };

  const onStroke = (points, page) => {
    const highlighter = mode === 'highlighter';
    add(inkItem({
      id: history.newId(), page, points,
      width: highlighter ? style.highlighterWidth : style.penWidth,
      color: highlighter ? style.highlighterColor : style.penColor,
      highlighter,
    }));
  };

  // ---- The editor ----

  const buildEditor = () => {
    const count = src.pageCount;
    let navEl = null;
    const card = fileCard({
      name: src.name,
      detail: t('result_details', tp('page_count', count), formatSize(src.size)),
      thumbnail: src.thumbnail(0, 58, { maxCssHeight: 78 }).catch(() => null),
      onRemove: () => remove(),
    });
    card.classList.add('edit-card');
    card.tabIndex = -1;
    const strip = count > 1 ? pageStrip({
      count,
      thumbnail: (i, w, o) => src.thumbnail(i, w, o),
      onSelect: (i) => showPage(i),
    }) : null;
    const tools = toolbar({
      onText: () => addText(),
      onMode: (m) => setMode(m),
      onShape: (anchor) => openShapes(anchor),
      onPicture: () => pickPicture(),
    });
    const hintEl = h('p', { class: 'edit-hint' });
    const undoBtn = iconButton({ icon: 'undo', label: t('undo'), onClick: undo });
    const redoBtn = iconButton({ icon: 'redo', label: t('redo'), onClick: redo });
    const hintRow = h('div', { class: 'edit-hintrow' }, hintEl, undoBtn, redoBtn);
    const stage = createStage({
      look,
      onSelect: (id) => {
        if (processing) return;
        history.select(id);
        if (id != null) stage.reveal(id);
      },
      onBegin: () => { if (!processing) history.begin(); },
      onDrag: (was, next) => !processing && history.drag(was, next),
      onEnd: () => history.end(),
      onStroke: (points, page) => onStroke(points, page),
      inkRoom: () => history.inkRoom(),
      onFull: () => full(),
      busy: () => processing,
      onZoom: () => refresh(),
      // On wide screens the page ends above the row under it and the Save PDF bar.
      below: () => (navEl?.offsetHeight || 52) + (screen.querySelector('.ui-bottombar')?.offsetHeight || 64) + 20,
    });
    // A picture dropped or pasted on the page goes on it.
    const detachPictures = dropZone(stage.el, {
      accept: 'image',
      multiple: false,
      onFiles: (items) => { if (known() && !result) addPicture(items[0]); },
    });
    const addingBar = linearProgress({ value: null, label: t('web_edit_picture_adding') });
    addingBar.classList.add('edit-adding');
    addingBar.hidden = true;

    let prev = null;
    let next = null;
    let pageLabel = null;
    const navItems = [];
    if (count > 1) {
      prev = iconButton({ icon: 'chevron_left', label: t('web_edit_previous_page'), onClick: () => showPage(pageIndex - 1) });
      next = iconButton({ icon: 'chevron_right', label: t('web_edit_next_page'), onClick: () => showPage(pageIndex + 1) });
      prev.classList.add('edit-turn');
      next.classList.add('edit-turn');
      pageLabel = h('span', { class: 'edit-nav-label', 'aria-live': 'polite' });
      navItems.push(h('div', { class: 'edit-pagenav' }, prev, pageLabel, next));
    }
    const zoomStep = (dir) => {
      const z = stage.zoom;
      const target = dir > 0 ? ZOOMS.find((v) => v > z + 0.01) ?? ZOOM_MAX : [...ZOOMS].reverse().find((v) => v < z - 0.01) ?? 1;
      stage.setZoom(target);
    };
    const zoomOut = iconButton({ icon: 'zoom_out', label: t('web_edit_zoom_out'), onClick: () => zoomStep(-1) });
    const zoomIn = iconButton({ icon: 'zoom_in', label: t('web_edit_zoom_in'), onClick: () => zoomStep(1) });
    const zoomLabel = h('span', { class: 'edit-nav-label edit-zoom-label', 'aria-hidden': 'true' });
    const zoomGroup = h('div', { class: 'edit-zoom', role: 'group' }, zoomOut, zoomLabel, zoomIn);
    const nav = h('div', { class: 'edit-nav' }, ...navItems, zoomGroup);
    navEl = nav;
    const group = h('div', { class: 'edit-canvas-group' }, hintRow, addingBar, stage.el, nav);
    const cover = h('div', { class: 'edit-cover' },
      h('span', { class: 'edit-cover-icon', 'aria-hidden': 'true' }, icon('info', { size: 18 })),
      h('p', {}, t('edit_cover_hint')));
    cover.hidden = true;
    const props = properties({
      onChange: (item) => { if (!processing) history.replace(item); },
      onMove: (dx, dy) => {
        const item = chosen();
        if (!item || processing) return;
        const size = shownSize();
        history.replace(moved(item, dx, dy, size.width, size.height));
      },
      onBegin: () => { if (!processing) history.begin(); },
      onStep: (item) => { if (!processing && history.items.some((it) => it.id === item.id)) history.stepItem(item); },
      onEnd: () => history.end(),
      onDelete: () => {
        const item = chosen();
        if (item && !processing) {
          history.remove(item.id);
          editor?.stage.frame.focus?.();
        }
      },
      onEditText: () => editText(chosen()),
      onStyle: (s) => {
        style = s;
        refresh();
      },
    });
    const nameField = textField({
      label: t('file_name'),
      value: fileName,
      suffix: '.pdf',
      autocomplete: 'off',
      spellcheck: false,
      onInput: (v) => { fileName = v; },
    });
    nameField.classList.add('edit-name');
    const work = h('div', { class: 'edit-work' }, tools, group);
    const side = h('div', { class: 'edit-side' }, cover, props, nameField);
    const stripBox = h('div', { class: 'edit-strip-box' }, strip);
    stripBox.hidden = !strip;
    const layout = h('div', { class: ['edit-layout', strip ? 'has-strip' : null] }, card, stripBox, work, side);
    stage.frame.tabIndex = -1;
    return {
      layout, card, strip, tools, hint: hintEl, undo: undoBtn, redo: redoBtn, stage, cover, props, nameField,
      prev, next, pageLabel, zoomIn, zoomOut, zoomLabel, zoomGroup, addingBar, detachPictures,
      destroy() {
        stage.destroy();
        strip?.destroy();
        tools.destroy();
        detachPictures();
      },
    };
  };

  // ---- Choosing the PDF ----

  const setImporting = (b) => {
    importing = b;
    loading.hidden = !b;
    content.toggleAttribute('aria-busy', b);
    refresh();
  };

  const confirmDiscard = () => alertDialog({ title: t('tool_discard_title'), confirm: t('discard'), dismiss: t('keep'), destructive: true });

  const forgetPictures = () => {
    for (const v of previews.values()) if (v && typeof v !== 'string') v.close?.();
    previews.clear();
    layouts.clear();
  };

  const closeSource = () => {
    dialog?.close();
    editor?.destroy();
    editor = null;
    src?.close();
    src = null;
    sizes = null;
    fallback = [];
    history.clear();
    forgetPictures();
    mode = 'select';
    pageIndex = 0;
  };

  const showEmpty = () => {
    empty?.detachDrop?.();
    empty = emptyState({
      icon: 'add',
      title: t('pick_pdf'),
      onClick: () => pick(),
      onFiles: (items) => choose(items[0]),
      accept: 'pdf',
      multiple: false,
    });
    body.replaceChildren(empty);
    refresh();
  };

  const choose = async (item) => {
    if (gone || !item || processing || importing || result) return;
    const mine = ++opening;
    setImporting(true);
    let opened = null;
    try {
      opened = await openPdf(item, { ...(item.password != null ? { password: item.password } : {}), signal: life.signal });
    } catch (e) {
      if (mine === opening && !gone && !(e instanceof CancelledError)) snackbar(problemText(e, 'pdf_import_failed'));
    }
    if (!opened || mine !== opening || gone) {
      opened?.close();
      if (mine === opening && !gone) setImporting(false);
      return;
    }
    if (!(opened.pageCount >= 1)) {
      opened.close();
      setImporting(false);
      snackbar(t('pdf_import_failed'));
      return;
    }
    closeSource();
    src = opened;
    fileName = withSuffix(baseName(src.name), '_edited', 'Usugami');
    // Every page's size as shown, exactly, from the PDF itself: items are placed in points on it.
    try {
      sizes = await shownPageSizes({ bytes: src.bytes, password: src.password });
      if (sizes.length !== src.pageCount) sizes = null;
    } catch {
      sizes = null;
    }
    if (!sizes && mine === opening && !gone) {
      // pdf-lib can't read it: pdf.js's sizes stand in, and saving says what is wrong.
      fallback = await Promise.all(Array.from({ length: opened.pageCount }, (_, i) => opened.pageSize(i)
        .then((s) => ({ width: s.width, height: s.height, rotation: s.rotation, box: null })).catch(() => null)));
    }
    if (mine !== opening || gone || src !== opened) return;
    setImporting(false);
    empty?.detachDrop?.();
    empty = null;
    editor = buildEditor();
    body.replaceChildren(editor.layout);
    showPage(0);
    editor.card.focus({ preventScroll: true });
  };

  const pick = async () => {
    if (importing || processing || gone) return;
    const items = await pickFiles({ accept: 'pdf', multiple: false });
    if (items.length && !gone) await choose(items[0]);
  };

  const startOver = () => {
    closeSource();
    fileName = '';
    showEmpty();
  };

  const remove = async () => {
    if (processing || importing) return;
    if (history.items.length && !(await confirmDiscard())) return;
    if (gone) return;
    startOver();
    empty?.focus?.({ preventScroll: true });
  };

  // ---- Saving ----

  const save = async () => {
    if (!ready() || result) return;
    const source = src;
    // Once Save is tapped, nothing more goes on the pages: the PDF is made from them as they were.
    processing = true;
    dialog?.close();
    history.end();
    refresh();
    const items = validItems();
    const controller = new AbortController();
    run = controller;
    const progress = progressDialog({ title: t('pdf_working'), onCancel: () => controller.abort() });
    let out = null;
    try {
      out = await editPages(
        { name: source.name, bytes: source.bytes, ...(source.password ? { password: source.password } : {}) },
        { items, name: fileName },
        { signal: controller.signal, onProgress: (done, total) => progress.update(total > 0 ? done / total : null) },
      );
    } catch (e) {
      if (!(e instanceof CancelledError) && !controller.signal.aborted && !gone) snackbar(problemText(e, 'pdf_process_failed'));
    } finally {
      await progress.close();
      processing = false;
      if (run === controller) run = null;
    }
    if (gone || !out || src !== source) {
      refresh();
      return;
    }
    result = showResult(ctx.root, {
      files: [out],
      zipName: baseName(out.name),
      passwordRemoved: !!source.password,
      onBack: () => backToEditing(),
      onStartOver: () => {
        leaveResult();
        startOver();
        if (stepPushed) {
          stepPushed = false;
          ctx.popStep?.();
        }
        empty?.focus?.({ preventScroll: true });
      },
    });
    ctx.pushStep?.('result');
    stepPushed = true;
  };

  const leaveResult = () => {
    if (!result) return false;
    result.destroy();
    result = null;
    ctx.root.replaceChildren(screen);
    editor?.stage.layout();
    refresh();
    return true;
  };

  const backToEditing = () => {
    if (leaveResult()) saveBtn.focus({ preventScroll: true });
    if (stepPushed) {
      stepPushed = false;
      ctx.popStep?.();
    }
  };

  // ---- Keys (on computers) ----

  const onKey = (e) => {
    if (!editor || result || processing || gone || e.defaultPrevented) return;
    if (document.documentElement.classList.contains('ui-modal-open') || document.querySelector('.ui-menu')) return;
    if (!screen.isConnected) return;
    const target = e.target instanceof Element ? e.target : null;
    const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (ctrl && !e.altKey && (key === 'z' || key === 'y')) {
      // In a text field, its own Undo.
      if (typing) return;
      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo(); else undo();
      return;
    }
    if (typing || ctrl || e.altKey) return;
    const item = chosen();
    if (e.key === 'Escape') {
      if (editor.stage.drawing) return;
      if (mode !== 'select') { setMode(mode); e.preventDefault(); return; }
      if (item) { history.select(null); e.preventDefault(); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && item) {
      e.preventDefault();
      const node = editor.stage.nodeOf(item.id);
      const hadFocus = node && document.activeElement === node;
      history.remove(item.id);
      if (hadFocus) editor.stage.frame.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      if (src.pageCount < 2) return;
      e.preventDefault();
      showPage(pageIndex + (e.key === 'PageDown' ? 1 : -1));
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (item && arrows[e.key]) {
      if (target?.closest('[role="radiogroup"], [role="toolbar"], [role="menu"], [role="slider"]')) return;
      e.preventDefault();
      const size = shownSize();
      // A step of the move buttons, or with Shift one point, for a precise place.
      const step = e.shiftKey ? 1 : 0.02 * Math.min(size.width, size.height);
      const [dx, dy] = arrows[e.key];
      history.replace(moved(item, dx * step, dy * step, size.width, size.height));
      editor.stage.reveal(item.id);
    }
  };
  document.addEventListener('keydown', onKey);
  const stopWide = onWideChange(() => refresh());

  showEmpty();
  // A reload on the result step: the result is gone, so its history step goes too.
  if (ctx.step) ctx.popStep?.();
  if (ctx.files?.length) choose(ctx.files[0]);

  return {
    unmount() {
      gone = true;
      opening++;
      life.abort();
      run?.abort();
      document.removeEventListener('keydown', onKey);
      stopWide();
      empty?.detachDrop?.();
      result?.destroy();
      result = null;
      closeSource();
    },
    hasUnsavedWork() {
      if (processing) return true;
      if (result) return !result.isSaved();
      return !!src && history.items.length > 0;
    },
    onStep(step) {
      if (step == null) {
        stepPushed = false;
        if (leaveResult()) saveBtn.focus({ preventScroll: true });
      } else if (!result) {
        ctx.popStep?.();
      } else {
        stepPushed = true;
      }
    },
    /** What is being edited, for tests: the items (pictures by their size), the page showing and its size. */
    inspect() {
      return {
        page: pageIndex,
        size: { ...shownSize() },
        mode,
        zoom: editor?.stage.zoom ?? 1,
        selected: history.selected,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        style: { ...style },
        items: history.items.map((it) => (it.type === 'picture'
          ? { ...it, picture: { width: it.picture.width, height: it.picture.height, jpeg: it.picture.jpeg } }
          : { ...it })),
      };
    },
  };
}
