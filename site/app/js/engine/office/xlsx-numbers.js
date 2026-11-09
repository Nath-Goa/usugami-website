// Numbers, dates and times in spreadsheet cells, shown as Excel shows them through the cell's number
// format code, such as "#,##0.00", "d-mmm-yy" or "[Red]0%;(0%)" (the app's SpreadsheetNumbers.kt,
// and the CellNumbers class of XlsxText.kt that writes them in the phone's language).
//
// A code has up to four sections: for positive numbers, negative numbers, zero and text. Conditions
// such as [>=100] can pick the section instead. Numbers keep Excel's 15 significant digits and round
// half away from zero. Dates are counts of days from 1900 (with the 29 February 1900 that Excel took
// over from Lotus 1-2-3) or from 1904, and times are fractions of a day. A code Excel wouldn't accept
// shows the number as General. Pure functions: no DOM, nothing thrown for any input.
import { Decimal, pow10 } from './xlsx-numbers-decimal.js';
import {
  trim, isBlank, lowercaseChar, toIntOrNull, toDoubleOrNull, intArg,
} from './xlsx-numbers-kt.js';

/**
 * American English, the language Excel's built-in formats are written for. A locale ({ decimal,
 * grouping, months, shortMonths, days, shortDays, am, pm }) holds the twelve months from January
 * and the seven days from Sunday; a name missing from it is taken from here.
 */
const ENGLISH = Object.freeze({
  decimal: '.',
  grouping: ',',
  months: Object.freeze([
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]),
  shortMonths: Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']),
  days: Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
  shortDays: Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
  am: 'AM',
  pm: 'PM',
});

/** Symbols and names for numbers and dates; see sheetLocale() for one from a language's own. */
export const SheetLocale = Object.freeze({ ENGLISH });

/** Excel keeps codes to 255 characters; a much longer one is treated as broken, so a crafted file can't slow every cell. */
const MAX_CODE = 1024;

/** The serials of 31 December 9999, the last day Excel shows, in the 1900 and 1904 systems. */
const LAST_DAY_1900 = 2958465;
const LAST_DAY_1904 = 2957003;

/** General never takes more characters than this, however wide the column. */
const GENERAL_WIDTH = 11;

/** A fraction's denominator has at most this many digits: nearer fractions than that are finer than a double. */
const MAX_DENOMINATOR_DIGITS = 7;

const PRECISION = 15;

const BUILT_IN = new Map([
  [0, 'General'],
  [1, '0'],
  [2, '0.00'],
  [3, '#,##0'],
  [4, '#,##0.00'],
  [5, '"$"#,##0_);\\("$"#,##0\\)'],
  [6, '"$"#,##0_);[Red]\\("$"#,##0\\)'],
  [7, '"$"#,##0.00_);\\("$"#,##0.00\\)'],
  [8, '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)'],
  [9, '0%'],
  [10, '0.00%'],
  [11, '0.00E+00'],
  [12, '# ?/?'],
  [13, '# ??/??'],
  [14, 'm/d/yyyy'],
  [15, 'd-mmm-yy'],
  [16, 'd-mmm'],
  [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'],
  [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'],
  [21, 'h:mm:ss'],
  [22, 'm/d/yyyy h:mm'],
  [37, '#,##0_);(#,##0)'],
  [38, '#,##0_);[Red](#,##0)'],
  [39, '#,##0.00_);(#,##0.00)'],
  [40, '#,##0.00_);[Red](#,##0.00)'],
  [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'],
  [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
  [44, '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'],
  [45, 'mm:ss'],
  [46, '[h]:mm:ss'],
  [47, 'mm:ss.0'],
  [48, '##0.0E+0'],
  [49, '@'],
]);

const NAMED_COLOURS = new Map([
  ['black', 0x000000],
  ['blue', 0x0000ff],
  ['cyan', 0x00ffff],
  ['green', 0x00ff00],
  ['magenta', 0xff00ff],
  ['red', 0xff0000],
  ['white', 0xffffff],
  ['yellow', 0xffff00],
]);

/** Excel's default palette, the colours of [Color1] to [Color56]. */
const PALETTE = [
  0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff,
  0x800000, 0x008000, 0x000080, 0x808000, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
  0x9999ff, 0x993366, 0xffffcc, 0xccffff, 0x660066, 0xff8080, 0x0066cc, 0xccccff,
  0x000080, 0xff00ff, 0xffff00, 0x00ffff, 0x800080, 0x800000, 0x008080, 0x0000ff,
  0x00ccff, 0xccffff, 0xccffcc, 0xffff99, 0x99ccff, 0xff99cc, 0xcc99ff, 0xffcc99,
  0x3366ff, 0x33cccc, 0x99cc00, 0xffcc00, 0xff9900, 0xff6600, 0x666699, 0x969696,
  0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399, 0x333333,
];

const argb = (rgb) => (rgb | 0xff000000) >>> 0;

// The pieces of a section. Those without a value are shared.
const POINT = Object.freeze({ type: 'point' });
const COMMA = Object.freeze({ type: 'comma' });
const SLASH = Object.freeze({ type: 'slash' });
const GENERAL_TOKEN = Object.freeze({ type: 'general' });
const AT = Object.freeze({ type: 'at' });
const literal = (text) => ({ type: 'literal', text });
// A digit placeholder: 0 shows a digit or 0, # a digit or nothing, and ? a digit or a space.
const DIGITS = { 0: Object.freeze({ type: 'digit', kind: '0' }), '#': Object.freeze({ type: 'digit', kind: '#' }), '?': Object.freeze({ type: 'digit', kind: '?' }) };

const Mode = { NUMBER: 0, DATE: 1, TEXT: 2 };

/** A section's condition, such as [>=100]: the section shows the numbers that meet it. */
class Condition {
  constructor(op, limit) {
    this.op = op;
    this.limit = limit;
  }

  holds(v) {
    switch (this.op) {
      case '<': return v < this.limit;
      case '<=': return v <= this.limit;
      case '>': return v > this.limit;
      case '>=': return v >= this.limit;
      case '=': return v === this.limit;
      default: return v !== this.limit;
    }
  }

  /** Whether only negative numbers (and zero) meet it, as with [<0]: those show without their minus. */
  get negativeOnly() {
    return this.limit === 0 && (this.op === '<' || this.op === '<=');
  }
}

/**
 * Where a number section puts its digits: the token indices of the placeholders of the whole part,
 * the decimals, the exponent, and a fraction's numerator and denominator, each left to right.
 */
class NumberLayout {
  constructor(tokens) {
    this.tokens = tokens;
    const size = tokens.length;
    const isDigit = (i) => tokens[i]?.type === 'digit';
    const run = (from) => {
      const out = [];
      for (let i = from; isDigit(i); i++) out.push(i);
      return out;
    };
    const digitsIn = (from, until) => {
      const out = [];
      for (let i = from; i < until; i++) if (isDigit(i)) out.push(i);
      return out;
    };

    this.general = tokens.findIndex((t) => t.type === 'general');
    let exponent = -1;
    for (let i = 0; i < size; i++) {
      if (tokens[i].type === 'exponent' && isDigit(i + 1)) {
        exponent = i;
        break;
      }
    }
    this.exponent = exponent;
    this.exponentAt = exponent >= 0 ? run(exponent + 1) : [];
    const mantissaEnd = exponent >= 0 ? exponent : size;
    let point = -1;
    for (let i = 0; i < mantissaEnd; i++) {
      if (tokens[i].type === 'point') {
        point = i;
        break;
      }
    }
    this.point = point;
    let slash = -1;
    if (exponent < 0 && point < 0) {
      for (let i = 1; i < size - 1; i++) {
        if (tokens[i].type === 'slash' && isDigit(i - 1) && (isDigit(i + 1) || tokens[i + 1].type === 'denominator')) {
          slash = i;
          break;
        }
      }
    }
    this.slash = slash;
    if (slash >= 0) {
      let start = slash - 1;
      while (isDigit(start - 1)) start--;
      this.numeratorAt = [];
      for (let i = start; i < slash; i++) this.numeratorAt.push(i);
      this.fixedDenominator = tokens[slash + 1].type === 'denominator' ? tokens[slash + 1].value : 0;
      this.denominatorAt = this.fixedDenominator > 0 ? [] : run(slash + 1);
      this.wholeAt = digitsIn(0, start);
      this.decimalsAt = [];
    } else {
      this.numeratorAt = [];
      this.denominatorAt = [];
      this.fixedDenominator = 0;
      this.wholeAt = digitsIn(0, point >= 0 ? point : mantissaEnd);
      this.decimalsAt = point >= 0 ? digitsIn(point + 1, mantissaEnd) : [];
    }

    // Commas that separate thousands or divide by 1000, and so show nothing themselves.
    this.hidden = new Array(size).fill(false);
    let group = false;
    let scale = 0;
    const wholeAt = this.wholeAt;
    const lastDigit = Math.max(wholeAt.length ? wholeAt[wholeAt.length - 1] : -1,
      this.decimalsAt.length ? this.decimalsAt[this.decimalsAt.length - 1] : -1, point);
    // A comma right after the last digit, or after another such comma, divides by 1000: #,##0, shows thousands.
    const trailing = (i) => {
      if (slash >= 0 || i < lastDigit + 1 || i >= mantissaEnd) return false;
      for (let k = lastDigit + 1; k < i; k++) if (tokens[k].type !== 'comma') return false;
      return true;
    };
    for (let i = 0; i < size; i++) {
      if (tokens[i].type !== 'comma') continue;
      if (wholeAt.length && wholeAt[0] < i && wholeAt[wholeAt.length - 1] > i) {
        group = true;
        this.hidden[i] = true;
      } else if (trailing(i)) {
        scale -= 3;
        this.hidden[i] = true;
      }
    }
    this.grouped = group;
    // The power of ten the number is multiplied by: 2 for each %, 3 for each ‰, -3 for each comma at the end.
    let shift = scale;
    for (const t of tokens) {
      if (t.type === 'percent') shift += t.sign === '%' ? 2 : 3;
    }
    this.shift = shift;
  }
}

/** One section of a code, read: its pieces, colour and condition. */
class Section {
  constructor(tokens, colour, condition, mode) {
    this.tokens = tokens;
    this.colour = colour;
    this.condition = condition;
    this.isDate = mode === Mode.DATE;
    this.layout = mode === Mode.NUMBER ? new NumberLayout(tokens) : null;
    let sub = 0;
    let twelve = false;
    for (const t of tokens) {
      if (t.type === 'subsecond' && t.digits > sub) sub = t.digits;
      if (t.type === 'ampm') twelve = true;
    }
    this.subSecondDigits = sub;
    this.twelveHour = twelve;
  }
}

/** A whole code: the sections for numbers, at most three, and the one for text, if any. No sections means General. */
const GENERAL = Object.freeze({ numeric: Object.freeze([]), text: null });

/** Codes already read, most recently used last: a sheet uses a handful of them across thousands of cells. */
const parsed = new Map();
const CACHE_SIZE = 256;

/** `code` read, from the codes already read when it is one of them. */
function formatOf(code) {
  const cached = parsed.get(code);
  if (cached) {
    parsed.delete(code);
    parsed.set(code, cached);
    return cached;
  }
  const format = parse(code);
  parsed.set(code, format);
  if (parsed.size > CACHE_SIZE) parsed.delete(parsed.keys().next().value);
  return format;
}

/** Reads a whole code; a broken one (an unclosed quote or bracket, five sections) reads as General. */
function parse(code) {
  if (code.length > MAX_CODE || isBlank(code) || trim(code).toLowerCase() === 'general') return GENERAL;
  const parts = split(code);
  if (!parts || parts.length > 4) return GENERAL;
  // The fourth section is for text; with fewer, a last section with @ in it is.
  const last = section(parts[parts.length - 1], Mode.TEXT);
  let textIndex = -1;
  if (parts.length === 4) textIndex = 3;
  else if (last && last.tokens.some((t) => t.type === 'at')) textIndex = parts.length - 1;
  const numeric = [];
  for (let i = 0; i < parts.length; i++) {
    if (i === textIndex) continue;
    const s = section(parts[i], showsDate(parts[i]) ? Mode.DATE : Mode.NUMBER);
    if (!s) return GENERAL;
    numeric.push(s);
  }
  if (textIndex >= 0 && !last) return GENERAL;
  return { numeric, text: textIndex >= 0 ? last : null };
}

/**
 * `code` cut at its semicolons, but not at those in quotes or brackets or after \, _ or *; null
 * when a quote or bracket is left open.
 */
function split(code) {
  const parts = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === '[') {
      const end = code.indexOf(c === '"' ? '"' : ']', i + 1);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === '\\' || c === '_' || c === '*') {
      i += 2;
    } else if (c === ';') {
      parts.push(code.slice(start, i));
      start = ++i;
    } else {
      i++;
    }
  }
  parts.push(code.slice(Math.min(start, code.length)));
  return parts;
}

/** Whether a section shows a date or time: it has y, m, d, h or s outside quotes and brackets, or [h], [m] or [s]. */
function showsDate(part) {
  let i = 0;
  while (i < part.length) {
    const c = part[i];
    if (c === '"') {
      const end = part.indexOf('"', i + 1);
      if (end < 0) return false;
      i = end + 1;
    } else if (c === '[') {
      const end = part.indexOf(']', i + 1);
      if (end < 0) return false;
      if (elapsedUnit(part.slice(i + 1, end)) !== null) return true;
      i = end + 1;
    } else if (c === '\\' || c === '_' || c === '*') {
      i += 2;
    } else {
      if ('ymdhs'.includes(lowercaseChar(c))) return true;
      i++;
    }
  }
  return false;
}

/** The unit of an elapsed-time bracket, h, m or s for [h], [mm] or [ss], or null for any other bracket. */
function elapsedUnit(inner) {
  if (!inner.length) return null;
  const unit = lowercaseChar(inner[0]);
  if (!'hms'.includes(unit)) return null;
  for (let k = 0; k < inner.length; k++) if (lowercaseChar(inner[k]) !== unit) return null;
  return unit;
}

/** How many UTF-16 units the character at `i` takes: 2 for one beyond the BMP. */
function charCount(s, i) {
  return s.codePointAt(i) > 0xffff ? 2 : 1;
}

/** Reads one section in `mode`; null when a quote or bracket in it isn't closed. */
function section(part, mode) {
  const tokens = [];
  let colour = null;
  let condition = null;
  let i = 0;
  while (i < part.length) {
    const c = part[i];
    if (c === '"') {
      const end = part.indexOf('"', i + 1);
      if (end < 0) return null;
      tokens.push(literal(part.slice(i + 1, end)));
      i = end + 1;
    } else if (c === '\\' || c === '_' || c === '*') {
      // The character after them, a whole one even beyond the BMP: shown for \, its width as a space
      // for _, and repeated to fill the cell for *, which a PDF's fixed text leaves out.
      const next = i + 1 < part.length ? charCount(part, i + 1) : 0;
      if (c === '\\') tokens.push(literal(part.slice(i + 1, i + 1 + next)));
      if (c === '_') tokens.push(literal(' '));
      i += 1 + next;
    } else if (c === '[') {
      const end = part.indexOf(']', i + 1);
      if (end < 0) return null;
      const inner = part.slice(i + 1, end);
      const name = inner.toLowerCase();
      const unit = elapsedUnit(inner);
      if (NAMED_COLOURS.has(name)) {
        colour = argb(NAMED_COLOURS.get(name));
      } else if (name.startsWith('color')) {
        const number = toIntOrNull(name.slice(5));
        if (number !== null && number >= 1 && number <= 56) colour = argb(PALETTE[number - 1]);
      } else if (inner.startsWith('<') || inner.startsWith('>') || inner.startsWith('=')) {
        condition = conditionOf(inner) ?? condition;
      } else if (inner.startsWith('$')) {
        // A currency, [$€-x-euro2] or [$₹-4009], shows its symbol; a bare locale, [$-409], shows nothing.
        const rest = inner.slice(1);
        const dash = rest.indexOf('-');
        const symbol = dash < 0 ? rest : rest.slice(0, dash);
        if (symbol) tokens.push(literal(symbol));
      } else if (mode === Mode.DATE && unit !== null) {
        tokens.push({ type: 'elapsed', kind: unit, count: inner.length });
      }
      i = end + 1;
    } else if (mode === Mode.TEXT) {
      tokens.push(c === '@' ? AT : literal(c));
      i++;
    } else if (mode === Mode.NUMBER) {
      i = numberToken(part, i, tokens);
    } else {
      i = dateToken(part, i, tokens);
    }
  }
  if (mode === Mode.DATE) markMinutes(tokens);
  return new Section(tokens, colour, condition, mode);
}

/** Whether `part` has `word` at `i`, in any case. */
function wordAt(part, i, word) {
  return part.slice(i, i + word.length).toLowerCase() === word;
}

/** Reads the number-section token at `i` into `tokens`; returns where the next one starts. */
function numberToken(part, i, tokens) {
  const c = part[i];
  const next = part[i + 1];
  if (c === '0' || c === '#' || c === '?') {
    tokens.push(DIGITS[c]);
  } else if (c === '.') {
    tokens.push(POINT);
  } else if (c === ',') {
    tokens.push(COMMA);
  } else if (c === '%' || c === '‰') {
    tokens.push({ type: 'percent', sign: c });
  } else if (c === '@') {
    tokens.push(AT);
  } else if ((c === 'E' || c === 'e') && (next === '+' || next === '-')) {
    // E+ or E- before the exponent's digits; with E- a positive exponent has no sign.
    tokens.push({ type: 'exponent', letter: c, plus: next === '+' });
    return i + 2;
  } else if ((c === 'G' || c === 'g') && wordAt(part, i, 'general')) {
    tokens.push(GENERAL_TOKEN);
    return i + 7;
  } else if (c === '/') {
    tokens.push(SLASH);
    // A fixed denominator, as in "# ?/8"; nine digits at most so it stays a 32-bit number.
    if (next !== undefined && next >= '1' && next <= '9') {
      let end = i + 1;
      while (end < part.length && end - i <= 9 && part[end] >= '0' && part[end] <= '9') end++;
      tokens.push({ type: 'denominator', value: Number(part.slice(i + 1, end)) });
      return end;
    }
  } else {
    tokens.push(literal(c));
  }
  return i + 1;
}

/** Whether `token` is a date part or elapsed time of `unit` (h or s). */
function isUnit(token, unit) {
  return token != null && (token.type === 'date' || token.type === 'elapsed') && token.kind === unit;
}

/** Reads the date-section token at `i` into `tokens`; returns where the next one starts. */
function dateToken(part, i, tokens) {
  const c = part[i];
  const letter = lowercaseChar(c);
  const last = tokens[tokens.length - 1];
  if ('ymdhse'.includes(letter) || letter === 'g') {
    let end = i + 1;
    while (end < part.length && lowercaseChar(part[end]) === letter) end++;
    // g is the era of Japanese dates, which the Gregorian calendar here doesn't have.
    // A date part: y (year), m (month), n (a minute, written m), d (day), h (hour), s (second) or e (year).
    if (letter !== 'g') tokens.push({ type: 'date', kind: letter, count: end - i });
    return end;
  }
  if (letter === 'a' && wordAt(part, i, 'am/pm')) {
    // As in Excel, AM/PM is always in capitals, and A/P is in small letters when written so.
    tokens.push({ type: 'ampm', short: false, lower: false });
    return i + 5;
  }
  if (letter === 'a' && wordAt(part, i, 'a/p')) {
    tokens.push({ type: 'ampm', short: true, lower: c === 'a' });
    return i + 3;
  }
  if (c === '.' && part[i + 1] === '0' && isUnit(last, 's')) {
    // Tenths, hundredths or thousandths of a second, after the seconds.
    let end = i + 1;
    while (end < part.length && end - i <= 3 && part[end] === '0') end++;
    tokens.push({ type: 'subsecond', digits: end - i - 1 });
    return end;
  }
  tokens.push(literal(c));
  return i + 1;
}

/** Turns each m or mm that means minutes into n: one right after an hour, or right before a second. */
function markMinutes(tokens) {
  const timed = (t) => t.type === 'date' || t.type === 'elapsed';
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i];
    if (m.type !== 'date' || m.kind !== 'm' || m.count > 2) continue;
    let before = null;
    for (let k = i - 1; k >= 0; k--) if (timed(tokens[k])) { before = tokens[k]; break; }
    let after = null;
    for (let k = i + 1; k < tokens.length; k++) if (timed(tokens[k])) { after = tokens[k]; break; }
    if (isUnit(before, 'h') || isUnit(after, 's')) tokens[i] = { type: 'date', kind: 'n', count: m.count };
  }
}

const OPERATORS = ['<>', '<=', '>=', '<', '>', '='];

/** The condition in a bracket such as [>=100] or [<>0]; null when its number isn't one. */
function conditionOf(inner) {
  const op = OPERATORS.find((o) => inner.startsWith(o));
  const limit = toDoubleOrNull(trim(inner.slice(op.length)));
  if (limit === null || !Number.isFinite(limit)) return null;
  return new Condition(op, limit);
}

/**
 * The section that shows `v`, and whether it shows it without its minus, as the negative section
 * does; null when none does, and General shows it. Without conditions, two sections split at zero
 * and a third takes zero itself. With them, the first section whose condition holds is used, and a
 * section without one takes what is left.
 */
function choose(format, v) {
  const sections = format.numeric;
  if (!sections.length) return null;
  const c0 = sections[0].condition;
  const c1 = sections[1]?.condition ?? null;
  if (c0 === null && c1 === null && (sections[2]?.condition ?? null) === null) {
    if (sections.length === 1) return [sections[0], false];
    if (v < 0) return [sections[1], true];
    if (v === 0 && sections.length === 3) return [sections[2], false];
    return [sections[0], false];
  }
  if (c0 !== null ? c0.holds(v) : (sections.length === 3 ? v > 0 : v >= 0)) {
    return [sections[0], v < 0 && c0?.negativeOnly === true];
  }
  if (sections.length >= 2 && (c1 !== null ? c1.holds(v) : (sections.length === 2 || v < 0))) {
    const unsigned = c1 !== null
      ? c1.negativeOnly
      : (c0 === null || (c0.limit === 0 && (c0.op === '>=' || (c0.op === '>' && sections.length === 3))));
    return [sections[1], v < 0 && unsigned];
  }
  return sections.length === 3 ? [sections[2], false] : null;
}

/** `x` rounded to the 15 significant digits Excel keeps, from the shortest decimal that reads back as it. */
function excelValue(x) {
  return Decimal.fromNumber(x).round(PRECISION);
}

/** `value` in General: as many digits as fit in `maxChars` (at most 11), scientific when that shows more of them. */
function general(value, locale, maxChars) {
  if (value === 0) return '0';
  const digits = generalDigits(excelValue(Math.abs(value)), Math.min(Math.max(maxChars, 1), GENERAL_WIDTH));
  const text = locale.decimal === '.' ? digits : digits.replaceAll('.', locale.decimal);
  return value < 0 ? '-' + text : text;
}

/** `x` (not negative) in General's digits, in `width` characters where it can be. */
function generalDigits(x, width) {
  if (x.signum() === 0) return '0';
  const magnitude = x.magnitude();
  const scientific = scientificGeneral(x, magnitude, width);
  const plain = plainGeneral(x, magnitude, width);
  if (!plain) return scientific[0];
  // On a tie the plain form wins, so 0.0001 stays 0.0001 rather than 1E-04.
  return plain[1] >= scientific[1] ? plain[0] : scientific[0];
}

/** `x` written out in `width` characters, and how many significant digits that shows; null when it doesn't fit or rounds to 0. */
function plainGeneral(x, magnitude, width) {
  const wholeDigits = magnitude >= 0 ? magnitude + 1 : 1;
  if (wholeDigits > width) return null;
  const rounded = x.setScale(Math.max(width - wholeDigits - 1, 0)).stripTrailingZeros();
  const text = rounded.toPlainString();
  // Rounding can carry into one digit more: 99999999999.5 becomes 100000000000.
  if (rounded.signum() === 0 || text.length > width) return null;
  return [text, rounded.precision()];
}

/** `x` as 1.23457E+11, as many digits as `width` has room for, and how many significant digits that shows. */
function scientificGeneral(x, magnitude, width) {
  let exponentDigits = Math.max(2, String(Math.abs(magnitude)).length);
  for (;;) {
    // The lead digit, its point, the decimals and E+ with the exponent's digits.
    const decimals = Math.max(width - 4 - exponentDigits, 0);
    const mantissa = x.round(decimals + 1);
    const exponent = mantissa.magnitude();
    const needed = Math.max(2, String(Math.abs(exponent)).length);
    if (needed > exponentDigits) {
      exponentDigits = needed;
      continue;
    }
    const lead = mantissa.movePoint(-exponent).stripTrailingZeros().toPlainString();
    const text = lead + 'E' + (exponent < 0 ? '-' : '+') + String(Math.abs(exponent)).padStart(2, '0');
    return [text, mantissa.stripTrailingZeros().precision()];
  }
}

/** The number `magnitude` (not negative) shown by a number section, after a minus when `negative`. */
function number(magnitude, negative, section, locale, maxChars) {
  const layout = section.layout;
  const tokens = section.tokens;
  const out = new Array(tokens.length).fill(null);
  if (layout.general >= 0) out[layout.general] = general(magnitude, locale, maxChars);
  else if (layout.slash >= 0) fraction(excelValue(magnitude).movePoint(layout.shift), layout, out);
  else if (layout.exponent >= 0) scientific(excelValue(magnitude).movePoint(layout.shift), layout, locale, out);
  else decimal(excelValue(magnitude).movePoint(layout.shift), layout, locale, out);
  let shown = negative ? '-' : '';
  for (let i = 0; i < tokens.length; i++) shown += out[i] ?? plain(tokens[i], layout.hidden[i]);
  return shown;
}

/** What a token shows when no digits were put in it. */
function plain(token, hidden) {
  switch (token.type) {
    case 'literal': return token.text;
    case 'percent': return token.sign;
    case 'exponent': return token.letter + (token.plus ? '+' : '-');
    case 'denominator': return String(token.value);
    case 'point': return '.';
    case 'slash': return '/';
    case 'comma': return hidden ? '' : ',';
    default: return '';
  }
}

/** `x` rounded to the decimal placeholders and put in them, its whole part before the point. */
function decimal(x, layout, locale, out) {
  const digits = x.setScale(layout.decimalsAt.length).toPlainString();
  const dot = digits.indexOf('.');
  const before = dot < 0 ? digits : digits.slice(0, dot);
  const whole = before === '0' ? '' : before;
  placeWhole(whole, layout, layout.wholeAt, layout.grouped ? locale.grouping : null, out);
  placeDecimals(dot < 0 ? '' : digits.slice(dot + 1), layout, out);
  if (layout.point >= 0) out[layout.point] = (layout.wholeAt.length ? '' : whole) + locale.decimal;
}

/**
 * `x` as a mantissa and exponent. With more than one whole-part placeholder, as in ##0.0E+0, the
 * exponent is a multiple of their number (engineering notation); otherwise the mantissa has one digit.
 */
function scientific(x, layout, locale, out) {
  const step = Math.max(1, layout.wholeAt.length);
  const decimals = layout.decimalsAt.length;
  let exponent = 0;
  let mantissa = x.setScale(decimals);
  if (x.signum() !== 0) {
    exponent = Math.floor(x.magnitude() / step) * step;
    mantissa = x.movePoint(-exponent).setScale(decimals);
    // Rounding carried over: 9.999 with two decimals is 1.00E+01, not 10.00E+00.
    if (mantissa.compareTo(new Decimal(pow10(step), 0)) >= 0) {
      exponent += step;
      mantissa = x.movePoint(-exponent).setScale(decimals);
    }
  }
  decimal(mantissa, layout, locale, out);
  const e = layout.tokens[layout.exponent];
  out[layout.exponent] = e.letter + (exponent < 0 ? '-' : e.plus ? '+' : '');
  placeWhole(String(Math.abs(exponent)), layout, layout.exponentAt, null, out);
}

/**
 * `x` as a fraction: the nearest one with a denominator that fits its placeholders (or the fixed one),
 * after a whole part when the format has one, as in "# ?/?", or improper without, as in "?/?".
 */
function fraction(x, layout, out) {
  const mixed = layout.wholeAt.length > 0;
  let whole = x.setScale(0, 'floor').toBigInt();
  const part = x.subtract(new Decimal(whole, 0));
  let numerator;
  let denominator;
  if (layout.fixedDenominator > 0) {
    denominator = BigInt(layout.fixedDenominator);
    numerator = (mixed ? part : x).times(denominator).setScale(0).toBigInt();
  } else {
    const digits = Math.min(layout.denominatorAt.length, MAX_DENOMINATOR_DIGITS);
    const nearest = nearestFraction(part.toNumber(), 10 ** digits - 1);
    denominator = BigInt(nearest[1]);
    numerator = BigInt(nearest[0]);
    if (!mixed) numerator += whole * denominator;
  }
  if (mixed && numerator === denominator) {
    whole += 1n;
    numerator = 0n;
  }
  if (mixed) {
    const wholeText = whole > 0n ? whole.toString() : numerator === 0n ? '0' : '';
    placeWhole(wholeText, layout, layout.wholeAt, null, out);
    if (numerator === 0n) {
      // A whole number: the fraction's place is left blank, so whole numbers line up with the rest.
      for (const i of layout.numeratorAt) out[i] = ' ';
      for (const i of layout.denominatorAt) out[i] = ' ';
      out[layout.slash] = ' ';
      if (layout.fixedDenominator > 0) out[layout.slash + 1] = ' '.repeat(String(layout.fixedDenominator).length);
      return;
    }
  }
  placeWhole(numerator.toString(), layout, layout.numeratorAt, null, out);
  const denominatorText = denominator.toString();
  // Never longer than its placeholders: the denominator was chosen to fit them.
  layout.denominatorAt.forEach((i, j) => {
    if (j < denominatorText.length) out[i] = denominatorText[j];
    else out[i] = layout.tokens[i].kind === '?' ? ' ' : '';
  });
}

/**
 * The fraction nearest `f` (0 to 1) whose denominator is at most `maxDenominator`, as numerator and
 * denominator: the best of the continued fraction's convergents and the step short of the next one.
 */
function nearestFraction(f, maxDenominator) {
  let p0 = 0;
  let q0 = 1;
  let p1 = 1;
  let q1 = 0;
  let x = f;
  let steps = 0;
  while (steps++ < 64) {
    const a = Math.floor(x);
    if (a > maxDenominator) break;
    const q2 = q0 + a * q1;
    if (q2 > maxDenominator) break;
    const p2 = p0 + a * p1;
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    if (x === a) break;
    x = 1 / (x - a);
  }
  const k = Math.floor((maxDenominator - q0) / q1);
  const p = p0 + k * p1;
  const q = q0 + k * q1;
  return Math.abs(p1 / q1 - f) <= Math.abs(p / q - f) ? [p1, q1] : [p, q];
}

/**
 * `digits` put right to left in the placeholders at `at`; the leftmost one also takes any digits left
 * over. Empty places show 0, a space or nothing as their placeholder asks, and `separator`, when
 * given, goes between thousands.
 */
function placeWhole(digits, layout, at, separator, out) {
  const n = at.length;
  const len = digits.length;
  for (let j = 0; j < n; j++) {
    const place = n - 1 - j;
    let shown = '';
    if (j === 0) {
      for (let p = len - 1; p >= n; p--) {
        shown += digits[len - 1 - p];
        if (separator !== null && p % 3 === 0) shown += separator;
      }
    }
    const kind = layout.tokens[at[j]].kind;
    const digit = place < len ? digits[len - 1 - place] : kind === '0' ? '0' : null;
    if (digit !== null) {
      shown += digit;
      if (separator !== null && place > 0 && place % 3 === 0) shown += separator;
    } else if (kind === '?') {
      shown += ' ';
    }
    out[at[j]] = shown;
  }
}

/** `digits` put left to right in the decimal placeholders; zeros at the end go where # asks and become spaces where ? does. */
function placeDecimals(digits, layout, out) {
  const at = layout.decimalsAt;
  const kinds = at.map((i) => layout.tokens[i].kind);
  let end = at.length;
  while (end > 0 && digits[end - 1] === '0' && kinds[end - 1] !== '0') end--;
  for (let j = 0; j < at.length; j++) out[at[j]] = j < end ? digits[j] : kinds[j] === '?' ? ' ' : '';
}

/** The date and time `serial` stands for, shown by a date section; one Excel can't show fills the room with #. */
function dateTime(serial, section, locale, date1904, maxChars) {
  const lastDay = date1904 ? LAST_DAY_1904 : LAST_DAY_1900;
  const hashes = '#'.repeat(Math.min(Math.max(maxChars, 1), 255));
  if (serial < 0 || serial >= lastDay + 1) return hashes;
  // Rounded to the second, or to the fraction of one shown, as Excel does; the minutes then aren't rounded.
  const perSecond = pow10(section.subSecondDigits);
  const perDay = 86400n * perSecond;
  const units = excelValue(serial).times(perDay).setScale(0).toBigInt();
  const day = Number(units / perDay);
  if (day > lastDay) return hashes;
  const seconds = Number(units / perSecond);
  const hour = Math.floor(seconds / 3600) % 24;
  const [year, month, dayOfMonth] = calendarDate(day, date1904);
  // Excel counts 1 January 1900 as a Sunday, so its weekdays before March 1900 run on from the false 29 February.
  const weekday = (day + (date1904 ? 5 : 6)) % 7;
  let shown = '';
  for (const token of section.tokens) {
    switch (token.type) {
      case 'literal':
        shown += token.text;
        break;
      case 'date':
        shown += datePart(token, { year, month, dayOfMonth, weekday, hour, seconds }, section, locale);
        break;
      case 'elapsed': {
        const total = token.kind === 'h' ? Math.floor(seconds / 3600) : token.kind === 'm' ? Math.floor(seconds / 60) : seconds;
        shown += String(total).padStart(token.count, '0');
        break;
      }
      case 'ampm': {
        const word = hour < 12 ? locale.am : locale.pm;
        const written = token.short ? firstLetter(word) : word;
        shown += token.lower ? written.toLowerCase() : written;
        break;
      }
      case 'subsecond': {
        const fractionText = (units % perSecond).toString().padStart(section.subSecondDigits, '0');
        shown += locale.decimal + fractionText.slice(0, token.digits);
        break;
      }
      default:
        break;
    }
  }
  return shown;
}

function datePart(token, d, section, locale) {
  switch (token.kind) {
    case 'y': return token.count <= 2 ? String(d.year % 100).padStart(2, '0') : String(d.year);
    case 'e': return String(d.year);
    case 'm':
      switch (token.count) {
        case 1: return String(d.month);
        case 2: return String(d.month).padStart(2, '0');
        case 3: return nameOf(locale.shortMonths, ENGLISH.shortMonths, d.month - 1);
        case 5: return firstLetter(nameOf(locale.months, ENGLISH.months, d.month - 1));
        default: return nameOf(locale.months, ENGLISH.months, d.month - 1);
      }
    case 'd':
      switch (token.count) {
        case 1: return String(d.dayOfMonth);
        case 2: return String(d.dayOfMonth).padStart(2, '0');
        case 3: return nameOf(locale.shortDays, ENGLISH.shortDays, d.weekday);
        default: return nameOf(locale.days, ENGLISH.days, d.weekday);
      }
    case 'h': return twoDigits(section.twelveHour ? (d.hour + 11) % 12 + 1 : d.hour, token.count);
    case 'n': return twoDigits(Math.floor(d.seconds / 60) % 60, token.count);
    default: return twoDigits(d.seconds % 60, token.count);
  }
}

/** Days from 1 January 1970 to the date given, in the calendar used today. */
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.trunc((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The year, month and day `days` after 1 January 1970. */
function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

const DAYS_1904 = daysFromCivil(1904, 1, 1);
const DAYS_1899_12_31 = daysFromCivil(1899, 12, 31);
const DAYS_1899_12_30 = daysFromCivil(1899, 12, 30);

/** Year, month and day of day `day`: in the 1900 system day 0 is 0 January 1900 and day 60 is 29 February 1900, as in Excel. */
function calendarDate(day, date1904) {
  if (date1904) return civilFromDays(DAYS_1904 + day);
  if (day === 0) return [1900, 1, 0];
  if (day === 60) return [1900, 2, 29];
  return civilFromDays((day < 60 ? DAYS_1899_12_31 : DAYS_1899_12_30) + day);
}

function twoDigits(value, count) {
  return count >= 2 ? String(value).padStart(2, '0') : String(value);
}

function nameOf(names, english, index) {
  const name = Array.isArray(names) ? names[index] : undefined;
  return typeof name === 'string' ? name : english[index];
}

function firstLetter(word) {
  if (!word) return word;
  return word.slice(0, charCount(word, 0));
}

/**
 * The format code of built-in number format `id` (0..49, the ids Excel doesn't store in styles.xml),
 * or null. Ids 5 to 8 are Excel's dollar formats; 23 to 26 have no format of their own and are
 * General. Ids 27 to 36 are East Asian dates and times, which come out here as the short date, or
 * as times for 32 and 33.
 */
function builtInFormat(id) {
  if (id >= 23 && id <= 26) return 'General';
  if ((id >= 27 && id <= 31) || (id >= 34 && id <= 36)) return 'm/d/yyyy';
  if (id === 32) return 'h:mm';
  if (id === 33) return 'h:mm:ss';
  return BUILT_IN.get(id) ?? null;
}

/** Whether `formatCode` shows a date or time (so the cell's number is a date serial). */
function isDateFormat(formatCode) {
  return formatOf(codeArg(formatCode)).numeric.some((s) => s.isDate);
}

/**
 * `value` shown with `formatCode` as Excel shows it; General uses at most `maxChars` characters
 * (not counting a minus) like Excel's General in a narrow column. A date out of Excel's range, such
 * as a negative one, fills `maxChars` characters with #, as Excel fills the cell.
 * Returns { text, colour }: colour is the ARGB number the format asks for ([Red] is 0xFFFF0000), or null.
 */
function format(value, formatCode, { locale = ENGLISH, date1904 = false, maxChars = 11 } = {}) {
  const v = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(v)) return { text: '#NUM!', colour: null };
  const chars = intArg(maxChars, 11);
  const loc = localeOf(locale);
  const chosen = choose(formatOf(codeArg(formatCode)), v);
  if (!chosen) return { text: general(v, loc, chars), colour: null };
  const [section, unsigned] = chosen;
  const text = section.isDate
    ? dateTime(unsigned ? Math.abs(v) : v, section, loc, !!date1904, chars)
    : number(Math.abs(v), v < 0 && !unsigned, section, loc, chars);
  return { text, colour: section.colour };
}

/** A text cell shown with the text section of `formatCode` (the 4th section with @), or as itself. Returns { text, colour }. */
function formatText(text, formatCode) {
  const t = String(text ?? '');
  const section = formatOf(codeArg(formatCode)).text;
  if (!section) return { text: t, colour: null };
  let shown = '';
  for (const token of section.tokens) {
    if (token.type === 'at') shown += t;
    else if (token.type === 'literal') shown += token.text;
  }
  return { text: shown, colour: section.colour };
}

const filled = new WeakMap();

/** `locale` with whatever it leaves out taken from English, so a partial one still writes every part. */
function localeOf(locale) {
  if (locale === ENGLISH || locale == null || typeof locale !== 'object') return ENGLISH;
  let full = filled.get(locale);
  if (!full) {
    const text = (v, fallback) => (typeof v === 'string' ? v : fallback);
    full = {
      decimal: text(locale.decimal, ENGLISH.decimal),
      grouping: text(locale.grouping, ENGLISH.grouping),
      months: locale.months,
      shortMonths: locale.shortMonths,
      days: locale.days,
      shortDays: locale.shortDays,
      am: text(locale.am, ENGLISH.am),
      pm: text(locale.pm, ENGLISH.pm),
    };
    filled.set(locale, full);
  }
  return full;
}

function codeArg(code) {
  return typeof code === 'string' ? code : code == null ? '' : String(code);
}

/** Number formats as Excel shows them (SpreadsheetNumbers.kt). */
export const SpreadsheetNumbers = Object.freeze({ builtInFormat, isDateFormat, format, formatText });

// The phone's language in the app; the browser's here.

const US_DATE = 'm/d/yyyy';

function intlParts(lang, options, date) {
  return new Intl.DateTimeFormat(lang, { timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn', ...options }).formatToParts(date);
}

/**
 * The symbols and names `lang` (a BCP 47 tag such as 'fr' or 'en-GB', or undefined for the
 * browser's) writes numbers and dates with, for format(): its decimal point, digit grouping, month
 * and day names, and AM/PM. English for a language the browser doesn't know.
 */
export function sheetLocale(lang) {
  try {
    const numberParts = new Intl.NumberFormat(lang, { useGrouping: true, numberingSystem: 'latn' }).formatToParts(1234567.5);
    const decimal = numberParts.find((p) => p.type === 'decimal')?.value || ENGLISH.decimal;
    const grouping = numberParts.find((p) => p.type === 'group')?.value || ENGLISH.grouping;
    const part = (parts, type) => parts.find((p) => p.type === type)?.value;
    // Names as they read in a date (the genitive in some languages), as Java's DateFormatSymbols
    // gives them; alone where a date writes the month as a number (1月 in Japanese).
    const name = (options, date, type, fallback) => {
      const inDate = part(intlParts(lang, { day: 'numeric', ...options }, date), type);
      if (inDate && !/^\d+$/.test(inDate)) return inDate;
      return intlParts(lang, options, date).map((p) => p.value).join('') || fallback;
    };
    const months = [];
    const shortMonths = [];
    for (let m = 0; m < 12; m++) {
      const date = Date.UTC(2023, m, 15);
      months.push(name({ month: 'long' }, date, 'month', ENGLISH.months[m]));
      shortMonths.push(name({ month: 'short' }, date, 'month', ENGLISH.shortMonths[m]));
    }
    const days = [];
    const shortDays = [];
    for (let d = 0; d < 7; d++) {
      // 1 January 2023 was a Sunday.
      const date = Date.UTC(2023, 0, 1 + d);
      days.push(part(intlParts(lang, { weekday: 'long', day: 'numeric', month: 'long' }, date), 'weekday') || ENGLISH.days[d]);
      shortDays.push(part(intlParts(lang, { weekday: 'short', day: 'numeric', month: 'short' }, date), 'weekday') || ENGLISH.shortDays[d]);
    }
    const am = part(intlParts(lang, { hour: 'numeric', hour12: true }, Date.UTC(2023, 0, 1, 9)), 'dayPeriod') || ENGLISH.am;
    const pm = part(intlParts(lang, { hour: 'numeric', hour12: true }, Date.UTC(2023, 0, 1, 21)), 'dayPeriod') || ENGLISH.pm;
    return Object.freeze({ decimal, grouping, months, shortMonths, days, shortDays, am, pm });
  } catch {
    return ENGLISH;
  }
}

/**
 * `lang`'s short date as an Excel format code, with the year in full, as Windows writes it:
 * "m/d/yyyy" in the United States, "dd/mm/yyyy" in Britain, "dd.mm.yyyy" in Germany.
 */
export function shortDateCode(lang) {
  let parts;
  try {
    // 2 January, so a day or month written with two digits shows its leading zero.
    parts = intlParts(lang, { dateStyle: 'short' }, Date.UTC(2026, 0, 2));
  } catch {
    return US_DATE;
  }
  let code = '';
  for (const p of parts) {
    if (p.type === 'day') code += p.value.length >= 2 ? 'dd' : 'd';
    // A month written as a word comes out in digits, as the app turns Java's MMM into mm.
    else if (p.type === 'month') code += /^\d$/.test(p.value) ? 'm' : 'mm';
    else if (p.type === 'year') code += 'yyyy';
    else if (p.type === 'literal') {
      // Separators as they are; anything else (letters such as 年, marks) in quotes.
      let quoted = '';
      for (const c of p.value) {
        if ('/-. ,:'.includes(c)) {
          if (quoted) code += '"' + quoted + '"';
          quoted = '';
          code += c;
        } else if (c !== '"') {
          quoted += c;
        }
      }
      if (quoted) code += '"' + quoted + '"';
    }
  }
  const text = trim(code);
  return text.includes('d') && text.includes('m') && text.includes('y') ? text : US_DATE;
}

/**
 * Numbers as their cells' formats show them, written the way `lang` writes them, as Excel writes
 * them in the language of the computer it runs on: its decimal point, digit grouping, and month and
 * day names. The short date (built-in format 14) is `lang`'s too.
 */
export class CellNumbers {
  constructor(lang) {
    this.locale = sheetLocale(lang);
    this.shortDate = shortDateCode(lang);
  }

  /** The format code of built-in number format `id`: General for one that doesn't exist. */
  builtIn(id) {
    if (id === 14) return this.shortDate;
    if (id === 22) return `${this.shortDate} h:mm`;
    return builtInFormat(id) ?? 'General';
  }

  /** `value` in format `code`, General in at most `maxChars` characters, with the colour the format asks for. */
  format(value, code, date1904 = false, maxChars = 11) {
    return format(value, code, { locale: this.locale, date1904, maxChars });
  }

  /** `text` in the text section of format `code`, with the colour it asks for. */
  formatText(text, code) {
    return formatText(text, code);
  }
}
