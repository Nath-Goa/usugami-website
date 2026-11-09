// Tables of Word documents, PowerPoint slides and e-books, laid out and drawn on a PdfCanvas: a
// port of the app's OfficeTables.kt (with the Border of DocxStyles.kt). Rows grow with their
// tallest cell unless their height is exact; tables split between pages at a row, or inside a row
// too tall for a page of its own, with their header rows repeated on each page.
// Lengths are points (the app's tenths of a point aside); colours are ARGB numbers.

/** A table border: `width` in points (0 is a border explicitly turned off), `color` ARGB. */
export class Border {
  constructor(width, color) {
    this.width = width;
    this.color = color;
  }
}

/** No border: one explicitly turned off. */
Border.NONE = Object.freeze(new Border(0, 0));

/**
 * A table cell, laid out: `x` and `width` from the table's left edge, padding inside it. A null
 * `content` (a block, see blocks.js) is an empty cell, or the lower part of a merged one. `fill`
 * is an ARGB colour or null; `top`, `left`, `bottom`, `right` Borders or null; `verticalAlign`
 * 0 top, 1 middle, 2 bottom.
 */
export class CellBox {
  constructor({
    x = 0, width = 0, content = null, fill = null, top = null, left = null, bottom = null, right = null,
    verticalAlign = 0, padLeft = 0, padTop = 0, padRight = 0, padBottom = 0,
  } = {}) {
    this.x = x;
    this.width = width;
    this.content = content;
    this.fill = fill;
    this.top = top;
    this.left = left;
    this.bottom = bottom;
    this.right = right;
    this.verticalAlign = verticalAlign;
    this.padLeft = padLeft;
    this.padTop = padTop;
    this.padRight = padRight;
    this.padBottom = padBottom;
  }

  /** This cell with some of its fields changed (Kotlin's copy). */
  copy(changes = {}) {
    return new CellBox({ ...this, ...changes });
  }
}

function line(canvas, border, x1, y1, x2, y2) {
  if (border == null || !(border.width > 0)) return;
  canvas.strokeStyle = border.color >>> 0;
  canvas.lineWidth = border.width;
  canvas.lineCap = 'square';
  canvas.lineJoin = 'miter';
  canvas.setLineDash([]);
  canvas.beginPath();
  canvas.moveTo(x1, y1);
  canvas.lineTo(x2, y2);
  canvas.stroke();
}

/** A table row of CellBoxes. It grows with its tallest cell, unless its height is `exact`. */
export class RowBlock {
  constructor(cells, minHeight = 0, exact = false) {
    this.cells = cells;
    this.minHeight = minHeight;
    this.exact = exact;
    if (exact && minHeight > 0) {
      this.height = minHeight;
    } else {
      let tallest = 0;
      for (const c of cells) tallest = Math.max(tallest, (c.content?.height ?? 0) + c.padTop + c.padBottom);
      this.height = Math.max(minHeight, tallest);
    }
  }

  draw(canvas, x, y) {
    const height = this.height;
    for (const cell of this.cells) {
      const left = x + cell.x;
      if (cell.fill != null) {
        canvas.fillStyle = cell.fill >>> 0;
        canvas.fillRect(left, y, cell.width, height);
      }
      const content = cell.content;
      if (!content) continue;
      const free = height - cell.padTop - cell.padBottom - content.height;
      const top = y + cell.padTop + (free > 0 ? (free * cell.verticalAlign) / 2 : 0);
      if (this.exact) {
        canvas.save();
        canvas.beginPath();
        canvas.rect(left, y, cell.width, height);
        canvas.clip();
      }
      content.draw(canvas, left + cell.padLeft, top);
      if (this.exact) canvas.restore();
    }
    // Borders last, so no cell's fill covers its neighbour's border.
    for (const cell of this.cells) {
      const left = x + cell.x;
      const right = left + cell.width;
      line(canvas, cell.top, left, y, right, y);
      line(canvas, cell.bottom, left, y + height, right, y + height);
      line(canvas, cell.left, left, y, left, y + height);
      line(canvas, cell.right, right, y, right, y + height);
    }
  }

  split(space, force = false) {
    if (this.exact) return force ? [this, null] : null;
    const heads = [];
    const tails = [];
    let progress = false;
    for (const cell of this.cells) {
      const content = cell.content;
      const room = space - cell.padTop - cell.padBottom;
      if (content == null || content.height <= room) {
        heads.push(cell);
        tails.push(cell.copy({ content: null }));
        if (content != null) progress = true;
        continue;
      }
      const parts = room > 0 || force ? content.split(Math.max(0, room), force) : null;
      if (parts == null) {
        heads.push(cell.copy({ content: null }));
        tails.push(cell);
      } else {
        heads.push(cell.copy({ content: parts[0] }));
        tails.push(cell.copy({ content: parts[1] }));
        progress = true;
      }
    }
    if (!progress) return force ? [this, null] : null;
    const rest = tails.some((c) => c.content != null) ? new RowBlock(tails, 0, false) : null;
    return [new RowBlock(heads, 0, false), rest];
  }
}

/**
 * A table: RowBlocks one under another, `x` points from the left edge it's drawn at. Split between
 * pages at a row, or inside a row that won't fit on a page of its own; the first `headerRows` rows
 * repeat at the top of each page.
 */
export class TableBlock {
  constructor(rows, headerRows = 0, x = 0) {
    this.rows = rows;
    this.headerRows = headerRows;
    this.x = x;
    let h = 0;
    for (const r of rows) h += r.height;
    this.height = h;
  }

  draw(canvas, x, y) {
    let top = y;
    for (const row of this.rows) {
      row.draw(canvas, x + this.x, top);
      top += row.height;
    }
  }

  split(space, force = false) {
    let used = 0;
    const rows = this.rows;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (used + row.height <= space) {
        used += row.height;
        continue;
      }
      const room = space - used;
      const bodyFits = i > this.headerRows;
      let parts = row.split(room, false);
      if (parts == null && !bodyFits) {
        if (!force) return null;
        parts = row.split(Math.max(0, room), true);
      }
      const head = rows.slice(0, i);
      if (parts?.[0]) head.push(parts[0]);
      if (!head.length) return null;
      const repeat = i >= this.headerRows ? rows.slice(0, this.headerRows) : [];
      const carried = parts == null ? [row] : parts[1] ? [parts[1]] : [];
      const tail = [...carried, ...rows.slice(i + 1)];
      if (!tail.length) return [new TableBlock(head, this.headerRows, this.x), null];
      return [new TableBlock(head, this.headerRows, this.x), new TableBlock([...repeat, ...tail], repeat.length, this.x)];
    }
    return [this, null];
  }
}
