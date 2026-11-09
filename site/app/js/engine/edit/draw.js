// Drawing Edit PDF's items, the same way on a screen canvas (the preview) and on a PdfCanvas (the
// saved PDF), in points on the page as shown: strokes and shapes as paths with round ends and
// corners, a highlighter see-through and multiplied with the page, text from its layout, pictures
// in their boxes (PageEditing.kt and EditPreview.kt).
import { HIGHLIGHTER_ALPHA, isBox, outline } from './layout.js';
import { drawText } from './text.js';

/** Adds the path `ops` (layout.js outline()) to `target`'s current path. */
export function tracePath(target, ops) {
  for (const op of ops) {
    switch (op[0]) {
      case 'M': target.moveTo(op[1], op[2]); break;
      case 'L': target.lineTo(op[1], op[2]); break;
      case 'C': target.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6]); break;
      case 'Z': target.closePath(); break;
      default: break;
    }
  }
}

/** A stroke as the PDF draws it: round ends and corners; a highlighter's see-through and multiplied with the page. */
function strokeInk(target, item, color, width, highlighter) {
  if (highlighter) {
    target.globalAlpha = HIGHLIGHTER_ALPHA;
    // A marker's ink multiplies with the page, so black text under it stays black.
    target.globalCompositeOperation = 'multiply';
  }
  if (item.type === 'ink' && item.points.length === 2) {
    // One point is a dot, as the pen's round end draws a line of no length.
    target.fillStyle = color;
    target.beginPath();
    target.arc(item.points[0], item.points[1], width / 2, 0, Math.PI * 2);
    target.fill();
    return;
  }
  target.strokeStyle = color;
  target.lineWidth = width;
  target.lineCap = 'round';
  target.lineJoin = 'round';
  target.beginPath();
  tracePath(target, outline(item));
  target.stroke();
}

/**
 * Draws `item` on `target` (a PdfCanvas or a 2D canvas context, in points on the page as shown).
 * `look.text(item)` gives a text item's layout (text.js textLayoutSync), `look.picture(item)` a
 * picture item's image (an ImageBitmap or canvas on the screen, embedImage()'s result in a PDF);
 * either may give null, and the item is then left out.
 */
export function drawItem(target, item, look) {
  target.save();
  try {
    switch (item.type) {
      case 'text': {
        const layout = look.text?.(item);
        if (layout) drawText(target, item, layout);
        break;
      }
      case 'picture': {
        const image = look.picture?.(item);
        if (image) {
          if ('imageSmoothingQuality' in target) target.imageSmoothingQuality = 'high';
          target.drawImage(image, item.x, item.y, item.width, item.height);
        }
        break;
      }
      case 'ink':
        strokeInk(target, item, item.color, item.width, item.highlighter);
        break;
      case 'shape':
        if (isBox(item) && item.filled) {
          target.fillStyle = item.color;
          target.beginPath();
          tracePath(target, outline(item));
          target.fill();
        } else {
          strokeInk(target, item, item.color, item.width, false);
        }
        break;
      default:
        break;
    }
  } finally {
    target.restore();
  }
}

/** Draws a stroke still being drawn: `points` (x, y, …) with the pen's or highlighter's colour and width. */
export function drawLiveStroke(target, points, color, width, highlighter) {
  if (points.length < 2) return;
  target.save();
  try {
    strokeInk(target, { type: 'ink', points }, color, width, highlighter);
  } finally {
    target.restore();
  }
}
