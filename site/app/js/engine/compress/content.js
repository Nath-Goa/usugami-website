// What a content stream does that matters for the size an image is shown at: saving and restoring
// the graphics state (q, Q), changing the transform (cm) and drawing an XObject (Do). Everything
// else (text, paths, colours, inline images) is read past, the way a viewer's parser reads it, so
// strings, comments and inline image data that look like operators don't count as them.

/** Operator codes in the list `scanContent` makes. */
export const OP_SAVE = 1;
export const OP_RESTORE = 2;
export const OP_TRANSFORM = 3;
export const OP_DRAW = 4;

const WHITE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

/** A token that is an operand but not a number or a name (a string, array, dictionary, true...). */
const OTHER = Symbol('operand');

/**
 * Reads `bytes` (a decoded content stream) and returns the drawing operations that matter, as a
 * flat list: OP_SAVE, OP_RESTORE, OP_TRANSFORM followed by its six numbers, OP_DRAW followed by the
 * XObject's resource name. A generator: it yields now and then so long streams can be read without
 * holding up the page (run it with runAsync or runSync from images/canvas.js).
 * @param {Uint8Array} bytes
 * @returns {Generator<void, Array<number|string>>}
 */
export function* scanContent(bytes) {
  const ops = [];
  const n = bytes.length;
  // The last few operands, as they come: numbers, names (strings) or OTHER.
  const stack = [];
  let depth = 0; // inside [ ] or << >>: what is there belongs to one operand
  let i = 0;
  let nextYield = 1 << 18;
  while (i < n) {
    if (i > nextYield) {
      nextYield = i + (1 << 18);
      yield;
    }
    const c = bytes[i];
    if (WHITE[c]) {
      i++;
      continue;
    }
    if (c === 0x25) {
      // A comment runs to the end of the line.
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      i = skipLiteralString(bytes, i + 1);
      if (depth === 0) push(stack, OTHER);
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        if (depth === 0) push(stack, OTHER);
        depth++;
        i += 2;
        continue;
      }
      // A hex string.
      i++;
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      if (depth === 0) push(stack, OTHER);
      continue;
    }
    if (c === 0x3e) {
      if (bytes[i + 1] === 0x3e && depth > 0) depth--;
      i += bytes[i + 1] === 0x3e ? 2 : 1;
      continue;
    }
    if (c === 0x5b || c === 0x7b) {
      if (depth === 0) push(stack, OTHER);
      depth++;
      i++;
      continue;
    }
    if (c === 0x5d || c === 0x7d) {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (c === 0x2f) {
      // A name: up to white space or a delimiter, with #xx escapes.
      let j = i + 1;
      while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
      if (depth === 0) push(stack, nameText(bytes, i + 1, j));
      i = j;
      continue;
    }
    // A number or a keyword (an operator, or true, false, null).
    let j = i;
    while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
    if (j === i) {
      i++; // a stray ')' or '}' and the like
      continue;
    }
    const first = bytes[i];
    if ((first >= 0x30 && first <= 0x39) || first === 0x2b || first === 0x2d || first === 0x2e) {
      if (depth === 0) push(stack, numberAt(bytes, i, j));
      i = j;
      continue;
    }
    if (depth > 0) {
      // A keyword inside an array or dictionary is part of that operand (true, false, null).
      i = j;
      continue;
    }
    const len = j - i;
    if (len === 1 && first === 0x71) {
      ops.push(OP_SAVE);
    } else if (len === 1 && first === 0x51) {
      ops.push(OP_RESTORE);
    } else if (len === 2 && first === 0x63 && bytes[i + 1] === 0x6d) {
      const k = stack.length;
      if (k >= 6) {
        const m = stack.slice(k - 6);
        if (m.every((v) => typeof v === 'number' && Number.isFinite(v))) ops.push(OP_TRANSFORM, ...m);
      }
    } else if (len === 2 && first === 0x44 && bytes[i + 1] === 0x6f) {
      const name = stack[stack.length - 1];
      if (typeof name === 'string') ops.push(OP_DRAW, name);
    } else if (len === 2 && first === 0x42 && bytes[i + 1] === 0x49) {
      j = skipInlineImage(bytes, j);
    } else if (len === 4 && first === 0x74 && bytes[i + 1] === 0x72) {
      push(stack, OTHER); // true
      i = j;
      continue;
    } else if ((len === 5 && first === 0x66 && bytes[i + 1] === 0x61) || (len === 4 && first === 0x6e && bytes[i + 1] === 0x75)) {
      push(stack, OTHER); // false, null
      i = j;
      continue;
    }
    stack.length = 0;
    i = j;
  }
  return ops;
}

/** Keeps the last six operands only: no operator that matters here takes more. */
function push(stack, v) {
  if (stack.length >= 6) stack.shift();
  stack.push(v);
}

function nameText(bytes, start, end) {
  let s = '';
  for (let k = start; k < end; k++) {
    const c = bytes[k];
    if (c === 0x23 && k + 2 < end) {
      const hex = String.fromCharCode(bytes[k + 1] ?? 0, bytes[k + 2] ?? 0);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        s += String.fromCharCode(parseInt(hex, 16));
        k += 2;
        continue;
      }
    }
    s += String.fromCharCode(c);
  }
  return s;
}

/** The number in bytes[start..end), read leniently as viewers do ("--5", "5." and ".5" included). */
function numberAt(bytes, start, end) {
  let k = start;
  let negative = false;
  while (k < end && (bytes[k] === 0x2b || bytes[k] === 0x2d)) {
    if (bytes[k] === 0x2d) negative = !negative;
    k++;
  }
  let v = 0;
  let scale = 0;
  let digits = 0;
  for (; k < end; k++) {
    const c = bytes[k];
    if (c >= 0x30 && c <= 0x39) {
      v = v * 10 + (c - 0x30);
      if (scale) scale *= 10;
      digits++;
    } else if (c === 0x2e && !scale) {
      scale = 1;
    } else {
      break;
    }
  }
  if (!digits) return NaN;
  if (scale) v /= scale;
  return negative ? -v : v;
}

/** The index after a literal string whose '(' is just before `i`: nested parentheses and escapes count. */
function skipLiteralString(bytes, i) {
  let level = 1;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i++];
    if (c === 0x5c) i++;
    else if (c === 0x28) level++;
    else if (c === 0x29 && --level === 0) break;
  }
  return i;
}

/**
 * The index after an inline image's EI, `i` being just after its BI. The image dictionary is read
 * up to ID; its data is skipped by its /L (or /Length) when given, otherwise up to an EI that
 * stands alone and is followed by what looks like content again (binary data can hold "EI").
 */
function skipInlineImage(bytes, i) {
  const n = bytes.length;
  let length = -1;
  let lastName = null;
  // The dictionary: keys and values up to the ID keyword.
  while (i < n) {
    const c = bytes[i];
    if (WHITE[c]) {
      i++;
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
      lastName = nameText(bytes, i + 1, j);
      i = j;
      continue;
    }
    if (c === 0x28) {
      i = skipLiteralString(bytes, i + 1);
      continue;
    }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    let j = i;
    while (j < n && !WHITE[bytes[j]] && !DELIM[bytes[j]]) j++;
    if (j === i) {
      i++;
      continue;
    }
    if (j - i === 2 && bytes[i] === 0x49 && bytes[i + 1] === 0x44) {
      i = j;
      break;
    }
    if ((lastName === 'L' || lastName === 'Length') && bytes[i] >= 0x30 && bytes[i] <= 0x39) length = numberAt(bytes, i, j);
    i = j;
  }
  // One white-space byte separates ID from the data.
  if (i < n && WHITE[bytes[i]]) i++;
  if (length >= 0 && Number.isInteger(length)) {
    const end = i + length;
    let k = end;
    while (k < n && WHITE[bytes[k]]) k++;
    if (bytes[k] === 0x45 && bytes[k + 1] === 0x49 && (k + 2 >= n || WHITE[bytes[k + 2]] || DELIM[bytes[k + 2]])) return k + 2;
  }
  for (let k = i; k + 1 < n; k++) {
    if (bytes[k] !== 0x45 || bytes[k + 1] !== 0x49) continue;
    if (k > i && !WHITE[bytes[k - 1]]) continue;
    if (k + 2 < n && !WHITE[bytes[k + 2]] && !DELIM[bytes[k + 2]]) continue;
    if (looksLikeContent(bytes, k + 2)) return k + 2;
  }
  return n;
}

/** Whether the bytes from `i` look like content stream text (no control or high bytes) for a while. */
function looksLikeContent(bytes, i) {
  const end = Math.min(bytes.length, i + 48);
  for (let k = i; k < end; k++) {
    const c = bytes[k];
    if (c > 0x7e || (c < 0x20 && !WHITE[c])) return false;
  }
  return true;
}
