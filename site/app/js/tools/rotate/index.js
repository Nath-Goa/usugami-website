// Rotate PDF (PdfEditOptions.kt RotateOptions, PdfToolsViewModel.rotatePage/rotateAll/runRotate):
// every page at once, or each with its own buttons, each picture turning as it will be shown;
// Reset pages turns them all back. Only how each page is shown changes.
import { h, announce } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { iconButton, button, uid } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { mountPdfTool, collapsible } from '../split/frame.js';

/** The thumbnail's box, 55 × 72 dp as the app's, width over height. */
const BOX_W = 55;
const BOX_H = 72;
const BOX_ASPECT = BOX_W / BOX_H;
/** Pages this far outside the list's view are drawn ahead of being scrolled to, and let go further out. */
const AHEAD = '480px';

const floorMod = (a, b) => ((a % b) + b) % b;

/** What a page turned `rotation` degrees says under its number (turnedLabel). */
export function turnedKey(rotation) {
  switch (floorMod(rotation, 360)) {
    case 90: return 'rotated_right';
    case 180: return 'rotated_upside_down';
    case 270: return 'rotated_left';
    default: return null;
  }
}

/**
 * The running angle a page shown at `angle` degrees moves to for `rotation` (0, 90, 180 or 270):
 * the short way round, so turning from 270 to 0 goes a quarter turn on, not three back
 * (animatePdfPageRotationAsState).
 */
export function nextAngle(angle, rotation) {
  let delta = floorMod(rotation - angle, 360);
  if (delta > 180) delta -= 360;
  return angle + delta;
}

/**
 * How much a picture of `aspect` (width over height), fitted upright in the box, shrinks to fit
 * it lying on its side.
 */
export function sidewaysScale(aspect) {
  if (!(aspect > 0)) return 1;
  const w = aspect > BOX_ASPECT ? BOX_ASPECT : aspect;
  const hgt = aspect > BOX_ASPECT ? BOX_ASPECT / aspect : 1;
  return Math.min(BOX_ASPECT / hgt, 1 / w);
}

/** A turn icon drawn the same whichever way the text runs: a turn left is to the left (TurnIcon.kt). */
function unmirrored(btn) {
  for (const svg of btn.querySelectorAll('svg.icon-mirrored')) {
    svg.classList.remove('icon-mirrored');
    svg.style.transform = '';
  }
  return btn;
}

export function mount(ctx) {
  const build = (src, { engine, refresh }) => {
    const count = src.pageCount;
    /** Each page's turn, clockwise: 0, 90, 180 or 270. */
    const rotations = new Array(count).fill(0);
    const turned = () => rotations.some((r) => r !== 0);

    const list = h('ul', { class: 'rotate-list' });
    const cards = [];

    class Card {
      constructor(index) {
        this.index = index;
        this.angle = 0;
        this.aspect = null;
        this.canvas = null;
        this.controller = null;
        // Near the list's view: only those animate, so turning a long PDF's pages all at once stays quick.
        this.near = false;
        const number = index + 1;
        this.turn = h('div', { class: 'rotate-turn' }, h('span', { class: 'rotate-placeholder', 'aria-hidden': 'true' }, icon('picture_as_pdf', { size: 20 })));
        this.thumb = h('div', { class: 'rotate-thumb', 'aria-hidden': 'true' }, this.turn);
        this.stateText = h('span', { class: 'rotate-turned' });
        this.state = collapsible(this.stateText, { shown: false });
        this.left = unmirrored(iconButton({ icon: 'rotate_left', label: t('rotate_page_left', number), onClick: () => turnPage(index, -90) }));
        this.right = unmirrored(iconButton({ icon: 'rotate_right', label: t('rotate_page_right', number), onClick: () => turnPage(index, 90) }));
        this.el = h('li', { class: 'rotate-card' },
          this.thumb,
          h('div', { class: 'rotate-text' }, h('span', { class: 'rotate-page' }, t('pdf_page_number', number)), this.state),
          this.left, this.right);
        this.el.card = this;
      }

      /** Shows the page turned as it is now, animated (none with reduced motion, by the CSS). */
      update() {
        const rotation = rotations[this.index];
        this.angle = nextAngle(this.angle, rotation);
        this.applyTurn();
        const key = turnedKey(rotation);
        // Closing, it keeps saying how it was turned rather than going blank first.
        if (key) this.stateText.textContent = t(key);
        this.state.setShown(!!key, { animate: this.near });
      }

      applyTurn() {
        const sideways = floorMod(this.angle, 180) === 90;
        const scale = sideways ? sidewaysScale(this.aspect ?? BOX_ASPECT) : 1;
        this.turn.style.transform = `rotate(${this.angle}deg)` + (scale !== 1 ? ` scale(${scale.toFixed(4)})` : '');
        // Far from view it turns at once.
        this.turn.classList.toggle('is-far', !this.near);
      }

      load() {
        if (this.canvas || this.controller) return;
        const controller = new AbortController();
        this.controller = controller;
        src.thumbnail(this.index, BOX_W, { maxCssHeight: BOX_H, signal: controller.signal }).then((canvas) => {
          if (this.controller !== controller || controller.signal.aborted) return;
          this.controller = null;
          this.canvas = canvas;
          const w = canvas.width;
          const hgt = canvas.height;
          this.aspect = w && hgt ? w / hgt : null;
          canvas.classList.add('ui-fade-in');
          this.turn.replaceChildren(canvas);
          this.thumb.classList.add('has-picture');
          // Its new shape fitted at once, without turning it again.
          const transition = this.turn.style.transition;
          this.turn.style.transition = 'none';
          this.applyTurn();
          void this.turn.offsetWidth;
          this.turn.style.transition = transition;
        }, () => {
          if (this.controller === controller) this.controller = null;
        });
      }

      unload() {
        this.controller?.abort();
        this.controller = null;
        if (this.canvas) {
          this.canvas = null;
          this.turn.replaceChildren(h('span', { class: 'rotate-placeholder', 'aria-hidden': 'true' }, icon('picture_as_pdf', { size: 20 })));
          this.thumb.classList.remove('has-picture');
        }
      }
    }

    for (let i = 0; i < count; i++) {
      const card = new Card(i);
      cards.push(card);
      list.append(card.el);
    }

    // Pictures are drawn as their pages come near the list's view, and let go when far.
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = e.target.card;
        if (!card) continue;
        card.near = e.isIntersecting;
        card.turn.classList.toggle('is-far', !card.near);
        if (e.isIntersecting) card.load(); else card.unload();
      }
    }, { root: list, rootMargin: `${AHEAD} 0px` });
    for (const card of cards) observer.observe(card.el);

    const reset = button({
      label: t('pdf_reset_pages'),
      variant: 'text',
      cls: 'rotate-reset',
      disabled: true,
      onClick: () => {
        rotations.fill(0);
        changed();
      },
    });

    function changed(only) {
      if (only != null) cards[only].update();
      else for (const card of cards) card.update();
      reset.disabled = !turned();
      refresh();
    }

    function turnPage(index, degrees) {
      rotations[index] = floorMod(rotations[index] + degrees, 360);
      changed(index);
      // Said for a screen reader as much as shown for the eye.
      const key = turnedKey(rotations[index]);
      if (key) announce(`${t('pdf_page_number', index + 1)}, ${t(key)}`);
    }

    const rotateAll = (degrees) => {
      for (let i = 0; i < count; i++) rotations[i] = floorMod(rotations[i] + degrees, 360);
      changed();
    };

    const allHeadingId = uid('rotate-all');
    const all = h('div', { class: 'rotate-all-row', role: 'group', 'aria-labelledby': allHeadingId },
      h('h2', { class: 'onepdf-heading rotate-all-title', id: allHeadingId }, t('rotate_all')),
      unmirrored(iconButton({ icon: 'rotate_left', label: t('rotate_all_left'), onClick: () => rotateAll(-90) })),
      unmirrored(iconButton({ icon: 'rotate_right', label: t('rotate_all_right'), onClick: () => rotateAll(90) })));
    const head = h('div', { class: 'rotate-all' }, all, h('p', { class: 'onepdf-hint' }, t('rotate_hint')));

    return {
      nodes: [head, list, h('div', { class: 'rotate-reset-row' }, reset)],
      ready: turned,
      unsaved: turned,
      prepare: () => {
        const map = {};
        rotations.forEach((r, i) => { if (r) map[i] = r; });
        return map;
      },
      run: (input, map, fileName, hooks) => engine.rotatePdf(input, { rotations: map, fileName }, hooks),
      destroy: () => {
        observer.disconnect();
        for (const card of cards) card.unload();
      },
    };
  };

  return mountPdfTool(ctx, {
    id: 'rotate',
    namespace: 'rotate',
    action: 'pdf_rotate_action',
    css: new URL('./rotate.css', import.meta.url),
    build,
  });
}
