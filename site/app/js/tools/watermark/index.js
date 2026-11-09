// Add watermark (PdfToolScreen.kt and PdfEditOptions.kt's WatermarkOptions and WatermarkPreview,
// PdfToolsViewModel's runWatermark and runWatermarkAll): the text, its colour and opacity, and the
// first page with the watermark drawn on it as the PDF will have it, for one PDF or several.
import { h, ensureCss, isWide, onWideChange } from '../../core/dom.js';
import { t, tWeb, loadStrings } from '../../core/i18n.js';
import { segmented, textField, snackbar, uid } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { UserError, CancelledError } from '../../core/errors.js';
import {
  addWatermark, watermarkStamp, paintWatermark, canDrawWatermark, WATERMARK_COLORS, WATERMARK_OPACITIES,
  WATERMARK_MAX_LENGTH, DEFAULT_COLOR, DEFAULT_OPACITY,
} from '../../engine/stamps.js';
import { mountStampTool, optionHeading } from '../page-numbers/stamp-screen.js';

const COLOR_LABELS = { gray: 'color_gray', black: 'color_black', red: 'color_red', blue: 'color_blue', green: 'color_green' };

/** Renders Add watermark into ctx.root. */
export async function mount(ctx) {
  await Promise.all([loadStrings('watermark'), ensureCss(new URL('./watermark.css', import.meta.url))]);
  // Kept while the tool is open, as the app keeps them through rotation.
  const state = { text: '', color: DEFAULT_COLOR, opacity: DEFAULT_OPACITY };

  return mountStampTool(ctx, {
    id: 'watermark',
    action: 'pdf_watermark_action',
    actionMany: 'pdf_watermark_action_many',
    forAllHint: 'watermark_for_all_hint',
    options: ({ changed }) => watermarkOptions(state, changed),
    async prepare() {
      if (!/\S/.test(state.text)) return null;
      // Checked here, so the message comes at once rather than after the progress dialog.
      if (!canDrawWatermark(state.text)) {
        snackbar(tWeb('watermark_no_font'));
        return null;
      }
      let stamp;
      try {
        // Drawn once for them all, as the app renders its stamp once.
        stamp = await watermarkStamp(state.text, state.color);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        snackbar(tWeb(e.key, ...e.args));
        return null;
      }
      const { opacity } = state;
      return async (src, index, name, hooks) => {
        try {
          return await addWatermark({ name: src.name, bytes: src.bytes, password: src.password }, { stamp, opacity, fileName: name }, hooks);
        } catch (e) {
          // Said for any device, not "this phone".
          if (e instanceof UserError && e.key === 'watermark_no_font') throw new UserError('web_watermark_no_font');
          throw e;
        }
      };
    },
  });
}

/** The choices: the text, Color, Opacity and the Preview. */
function watermarkOptions(state, changed) {
  const colorId = uid('wm-color');
  const opacityId = uid('wm-opacity');
  const preview = watermarkPreview(state);
  const text = textField({
    label: t('watermark_text'),
    helper: t('watermark_text_hint'),
    value: state.text,
    maxLength: WATERMARK_MAX_LENGTH,
    autocomplete: 'off',
    onInput: (v) => {
      state.text = v.slice(0, WATERMARK_MAX_LENGTH);
      preview.update();
      changed();
    },
  });
  text.input.setAttribute('autocapitalize', 'sentences');
  const swatches = colorSwatches({
    labelledBy: colorId,
    value: state.color,
    onChange: (v) => {
      state.color = v;
      preview.update();
    },
  });
  const opacity = segmented({
    labelledBy: opacityId,
    value: state.opacity,
    options: [
      { value: 'translucent', label: t('opacity_translucent') },
      { value: 'semi', label: t('opacity_semi') },
      { value: 'opaque', label: t('opacity_opaque') },
    ],
    onChange: (v) => {
      state.opacity = v;
      preview.update();
    },
  });
  const el = h('div', { class: 'stamps-options watermark-options' },
    text,
    optionHeading(t('watermark_color'), colorId), swatches,
    optionHeading(t('watermark_opacity'), opacityId), opacity,
    optionHeading(t('watermark_preview')), preview.el);
  return {
    el,
    ready: () => /\S/.test(state.text),
    setSource: (src) => preview.setSource(src),
    destroy: () => preview.destroy(),
  };
}

/**
 * One round swatch per colour (ColorSwatches), each a radio button named after its colour, with a
 * ring and a check mark on the chosen one. They wrap onto another row on a narrow screen.
 */
function colorSwatches({ value, onChange, labelledBy }) {
  let current = value;
  const group = h('div', { class: 'watermark-swatches', role: 'radiogroup', 'aria-labelledby': labelledBy });
  const names = Object.keys(WATERMARK_COLORS);
  const buttons = names.map((name) => {
    const b = h('button', {
      type: 'button',
      role: 'radio',
      class: 'watermark-swatch',
      'aria-label': t(COLOR_LABELS[name]),
      title: t(COLOR_LABELS[name]),
      dataset: { color: name },
      style: { '--watermark-swatch': WATERMARK_COLORS[name] },
    }, h('span', { class: 'watermark-swatch-fill', 'aria-hidden': 'true' }, icon('check', { size: 24 })));
    // The check mark is dark on light colours, so it shows on every one.
    if (luminance(WATERMARK_COLORS[name]) > 0.5) b.classList.add('is-light');
    b.addEventListener('click', () => choose(name, false));
    b.addEventListener('keydown', (e) => {
      const at = names.indexOf(name);
      const rtl = getComputedStyle(group).direction === 'rtl';
      let next = null;
      if (e.key === 'ArrowRight') next = at + (rtl ? -1 : 1);
      else if (e.key === 'ArrowLeft') next = at + (rtl ? 1 : -1);
      else if (e.key === 'ArrowDown') next = at + 1;
      else if (e.key === 'ArrowUp') next = at - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = names.length - 1;
      else return;
      e.preventDefault();
      choose(names[(next + names.length) % names.length], true);
    });
    return b;
  });
  group.append(...buttons);
  const render = () => buttons.forEach((b, i) => {
    const on = names[i] === current;
    b.setAttribute('aria-checked', String(on));
    b.classList.toggle('is-selected', on);
    b.tabIndex = on ? 0 : -1;
  });
  const choose = (name, focus) => {
    const changed = name !== current;
    current = name;
    render();
    if (focus) buttons[names.indexOf(name)].focus();
    if (changed) onChange?.(name);
  };
  render();
  group.setValue = (v) => { current = v; render(); };
  return group;
}

/** Relative luminance of a #rrggbb colour, as Compose's Color.luminance(). */
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/**
 * The first page with the watermark drawn on it as the PDF will have it (WatermarkPreview): with
 * the same glyphs, at the same place and angle, and as big compared with the page. A tall page is
 * 220 px high and a wide one 280 px wide, as the app's (larger on wide screens); until page 1 has
 * been drawn, an A4-shaped blank stands in for it. The watermark is a layer of its own faded as a
 * whole, as the PDF's transparency group fades it.
 */
function watermarkPreview(state) {
  const pageCanvas = h('canvas', { class: 'watermark-preview-page' });
  const markCanvas = h('canvas', { class: 'watermark-preview-mark' });
  const frame = h('div', { class: 'watermark-preview', role: 'img', 'aria-label': t('watermark_preview_description') }, pageCanvas, markCanvas);
  const el = h('div', { class: 'watermark-preview-wrap' }, frame);
  let source = null;
  let aspect = 210 / 297;
  let pageBitmap = null;
  let renderAbort = null;
  let stamp = null;
  let token = 0;
  let destroyed = false;

  const box = () => (isWide() ? { w: 420, h: 330 } : { w: 280, h: 220 });
  const size = () => {
    const b = box();
    const width = Math.min(b.w, b.h * aspect);
    return { width, height: width / aspect };
  };
  const dpr = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));

  const layout = () => {
    const { width, height } = size();
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    const d = dpr();
    for (const c of [pageCanvas, markCanvas]) {
      c.width = Math.max(1, Math.round(width * d));
      c.height = Math.max(1, Math.round(height * d));
    }
    const ctx = pageCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    if (pageBitmap) ctx.drawImage(pageBitmap, 0, 0, pageCanvas.width, pageCanvas.height);
    drawMark();
  };

  const drawMark = () => {
    const ctx = markCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, markCanvas.width, markCanvas.height);
    if (!stamp) return;
    const { width, height } = size();
    const d = dpr();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    paintWatermark(ctx, stamp, width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  /** Lays the text out again (as typed, in the colour chosen) and draws it; the newest wins. */
  const update = async () => {
    markCanvas.style.opacity = String(WATERMARK_OPACITIES[state.opacity] ?? 1);
    const mine = ++token;
    const text = state.text.trim();
    let next = null;
    if (text) {
      try {
        next = await watermarkStamp(text, state.color);
      } catch {
        // Text no font can draw, or fonts that can't be fetched now: the page alone, as the app's
        // preview shows nothing it can't draw.
        next = null;
      }
    }
    if (mine !== token || destroyed) return;
    stamp = next;
    drawMark();
  };

  const setSource = (src) => {
    if (src === source) return;
    source = src;
    drawPage(true);
  };

  /**
   * Draws page 1 of the source for the box there is now (larger on wide screens). A new source
   * starts from the blank page; the same one keeps its picture until the sharper one is drawn.
   */
  const drawPage = async (fresh) => {
    const src = source;
    renderAbort?.abort();
    renderAbort = null;
    if (fresh) {
      pageBitmap = null;
      aspect = 210 / 297;
    }
    layout();
    if (!src) return;
    const controller = new AbortController();
    renderAbort = controller;
    try {
      const b = box();
      const canvas = await src.render(0, { cssWidth: b.w, maxCssHeight: b.h, signal: controller.signal });
      if (controller.signal.aborted || source !== src || destroyed) return;
      pageBitmap = canvas;
      aspect = canvas.width / canvas.height;
      layout();
    } catch (e) {
      // A first page that can't be drawn leaves the blank page.
      if (!(e instanceof CancelledError) && source === src) layout();
    }
  };

  const unwide = onWideChange(() => drawPage(false));
  layout();
  update();
  return {
    el,
    update,
    setSource,
    destroy() {
      destroyed = true;
      renderAbort?.abort();
      unwide();
    },
  };
}
