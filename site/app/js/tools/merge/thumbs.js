// Page pictures for Merge PDF's page list and Reorganize PDF's blank pages: a thumbnail turned as
// the page will be (TurnedThumbnail, turnedBy: sideways it shrinks to fit the space of an upright
// one, and turns the short way round), and a blank page's own picture (BlankPage).
import { h } from '../../core/dom.js';
import { icon } from '../../core/icons.js';

/**
 * A box `width` × `height` CSS px for a page's picture, drawn by `load(draw)` where
 * draw({ signal }) resolves with a canvas. el, setRotation(degrees), load(draw), unload().
 */
export function turnedThumb({ width, height }) {
  const turnEl = h('div', { class: 'merge-thumb-turn' });
  const placeholder = h('span', { class: 'merge-thumb-placeholder', 'aria-hidden': 'true' }, icon('picture_as_pdf', { size: 20 }));
  const el = h('div', { class: 'merge-thumb', style: { width: width + 'px', height: height + 'px' }, 'aria-hidden': 'true' }, placeholder, turnEl);
  const box = width / height;
  let angle = 0;
  let aspect = null;
  let node = null;
  let controller = null;

  const apply = () => {
    let scale = 1;
    if (aspect && Math.abs(angle) % 180 === 90) {
      // Fitted upright in the box (its height 1, its width `box`), the picture is w × hgt; turned,
      // it must fit across the other way.
      const w = aspect > box ? box : aspect;
      const hgt = aspect > box ? box / aspect : 1;
      scale = Math.min(box / hgt, 1 / w);
    }
    turnEl.style.transform = `rotate(${angle}deg)` + (scale !== 1 ? ` scale(${scale.toFixed(4)})` : '');
  };

  return {
    el,
    /** Turns the picture to `degrees`, the short way round from where it is. */
    setRotation(degrees) {
      const target = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
      const now = ((angle % 360) + 360) % 360;
      let delta = target - now;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      angle += delta;
      apply();
    },
    load(draw) {
      if (node || controller) return;
      const mine = new AbortController();
      controller = mine;
      Promise.resolve().then(() => draw({ signal: mine.signal })).then((canvas) => {
        if (controller !== mine || mine.signal.aborted || !canvas) return;
        controller = null;
        node = canvas;
        aspect = canvas.width && canvas.height ? canvas.width / canvas.height : null;
        canvas.classList.add('ui-fade-in');
        turnEl.replaceChildren(canvas);
        el.classList.add('has-picture');
        apply();
      }, () => {
        if (controller === mine) controller = null;
      });
    },
    unload() {
      controller?.abort();
      controller = null;
      if (node) {
        node = null;
        turnEl.replaceChildren();
        el.classList.remove('has-picture');
      }
    },
  };
}

/**
 * A blank page's picture: white, its own shape (`width` × `height` points), saying `label`
 * ("Blank") in gray, drawn to fit `cssWidth` × `cssHeight` CSS px at the screen's density.
 * @returns {HTMLCanvasElement}
 */
export function blankPicture(width, height, label, cssWidth, cssHeight = cssWidth * 4 / 3) {
  const density = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const aspect = width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : 0.75;
  let w = cssWidth;
  let hgt = w / aspect;
  if (hgt > cssHeight) {
    hgt = cssHeight;
    w = hgt * aspect;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * density));
  canvas.height = Math.max(1, Math.round(hgt * density));
  canvas.className = 'ui-page-canvas';
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  // labelMedium: 12 px, medium weight, smaller on a narrow page.
  const size = Math.max(8, Math.min(12, w / 6)) * density;
  g.font = `500 ${size}px ${family}`;
  g.fillStyle = '#888888';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 4 * density);
  return canvas;
}
