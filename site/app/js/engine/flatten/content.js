// A small reader of content streams: enough to read a field's default appearance (/DA), find the
// part of an appearance a field's text goes in (/Tx BMC ... EMC), and see which fonts it uses.
// It never throws on bad input: what it can't read it skips.

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

/** A name operand ('/Helv' gives { name: 'Helv' }). */
class Name {
  constructor(name) { this.name = name; }
}

/**
 * Calls onOp(operator, operands, start, end) for each operator of the content `s` (a Latin-1
 * string), where start and end are the operator's own position. Operands are numbers, Name
 * objects, strings (their bytes as Latin-1), arrays, and null for dictionaries and the rest.
 */
export function scan(s, onOp) {
  const n = s.length;
  let i = 0;
  let operands = [];
  const stack = [];
  const push = (v) => {
    if (stack.length) stack[stack.length - 1].push(v);
    else operands.push(v);
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (WHITE.has(c)) { i++; continue; }
    if (c === 0x25) { // % comment
      while (i < n && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) { // ( literal string
      let depth = 1;
      let out = '';
      i++;
      while (i < n && depth > 0) {
        const ch = s[i];
        if (ch === '\\') {
          const nx = s[i + 1];
          const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[nx];
          if (esc !== undefined) { out += esc; i += 2; continue; }
          if (nx >= '0' && nx <= '7') {
            let oct = '';
            let j = i + 1;
            while (j < n && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
            out += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i = j;
            continue;
          }
          if (nx === '\r' || nx === '\n') {
            i += 2;
            if (nx === '\r' && s[i] === '\n') i++;
            continue;
          }
          i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
        out += ch;
        i++;
      }
      push(out);
      continue;
    }
    if (c === 0x3c) { // < hex string or << dictionary
      if (s.charCodeAt(i + 1) === 0x3c) { stack.push([]); stack[stack.length - 1].dict = true; i += 2; continue; }
      const end = s.indexOf('>', i + 1);
      const hex = s.slice(i + 1, end < 0 ? n : end).replace(/[^0-9A-Fa-f]/g, '');
      let out = '';
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      push(out);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === 0x3e) { // >> end of dictionary
      i += s.charCodeAt(i + 1) === 0x3e ? 2 : 1;
      if (stack.length) { stack.pop(); push(null); }
      continue;
    }
    if (c === 0x5b) { stack.push([]); i++; continue; } // [
    if (c === 0x5d) { // ]
      i++;
      if (stack.length) {
        const arr = stack.pop();
        push(arr.dict ? null : arr);
      }
      continue;
    }
    if (c === 0x7b || c === 0x7d || c === 0x29) { i++; continue; } // { } ) stray
    if (c === 0x2f) { // /Name
      let j = i + 1;
      while (j < n && !WHITE.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
      const raw = s.slice(i + 1, j).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      push(new Name(raw));
      i = j;
      continue;
    }
    // A number or a keyword.
    let j = i;
    while (j < n && !WHITE.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
    const word = s.slice(i, j);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      push(Number(word));
    } else if (word === 'true' || word === 'false') {
      push(word === 'true');
    } else if (word === 'null') {
      push(null);
    } else if (stack.length) {
      push(null); // a stray keyword inside an array or dictionary
    } else {
      onOp(word, operands, i, j);
      operands = [];
      if (word === 'ID') {
        // Inline image data: binary, up to "EI" between white space.
        let k = j + 1;
        while (k < n) {
          if (s[k] === 'E' && s[k + 1] === 'I' && WHITE.has(s.charCodeAt(k - 1)) && (k + 2 >= n || WHITE.has(s.charCodeAt(k + 2)))) break;
          k++;
        }
        j = k;
      }
    }
    i = j === i ? i + 1 : j;
  }
}

/**
 * A field's default appearance string, read: { font, size, color } where font is the font
 * resource's name (or undefined), size the font size (0: as big as fits), and color the operator
 * that sets the text colour with its operands ({ op: 'rg', args: [1, 0, 0] }), or undefined.
 * As PDFBox reads it, the last Tf and the last colour win.
 */
export function parseDA(da) {
  const out = { font: undefined, size: 0, color: undefined };
  if (typeof da !== 'string') return out;
  scan(da, (op, args) => {
    if (op === 'Tf' && args.length >= 2 && args[args.length - 2] instanceof Name && typeof args[args.length - 1] === 'number') {
      out.font = args[args.length - 2].name;
      out.size = Math.max(0, args[args.length - 1]);
    } else if (op === 'g' && args.length >= 1 && typeof args[args.length - 1] === 'number') {
      out.color = { op: 'g', args: args.slice(-1) };
    } else if (op === 'rg' && args.length >= 3 && args.slice(-3).every((v) => typeof v === 'number')) {
      out.color = { op: 'rg', args: args.slice(-3) };
    } else if (op === 'k' && args.length >= 4 && args.slice(-4).every((v) => typeof v === 'number')) {
      out.color = { op: 'k', args: args.slice(-4) };
    }
  });
  return out;
}

/**
 * Where the first marked-content section (normally "/Tx BMC") of the content `s` starts and ends:
 * { afterBmc, emcStart } to keep s[0, afterBmc) and s[emcStart, end), or null when there is none.
 */
export function markedContent(s) {
  let afterBmc = -1;
  let emcStart = -1;
  let depth = 0;
  scan(s, (op, _args, start, end) => {
    if (emcStart >= 0) return;
    if (afterBmc < 0) {
      if (op === 'BMC') afterBmc = end;
      return;
    }
    if (op === 'BMC' || op === 'BDC') depth++;
    else if (op === 'EMC') {
      if (depth === 0) emcStart = start;
      else depth--;
    }
  });
  if (afterBmc < 0) return null;
  return { afterBmc, emcStart: emcStart < 0 ? s.length : emcStart };
}

/** The names of the font resources content `s` selects with Tf. */
export function fontsUsed(s) {
  const used = new Set();
  scan(s, (op, args) => {
    if (op === 'Tf' && args.length >= 2 && args[args.length - 2] instanceof Name) used.add(args[args.length - 2].name);
  });
  return used;
}

export { Name };
