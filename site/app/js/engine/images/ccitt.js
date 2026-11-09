// CCITT Group 4 (ITU-T T.6) compression of a black-and-white picture, as a PDF's CCITTFaxDecode
// filter reads it with /K -1 (and its other parameters left as they are): each row is coded by how
// the places where it changes between white and black differ from the row above's, so print takes
// a few bits a letter and blank paper almost nothing. Ends with the end-of-facsimile-block code.
// A port of the app's CcittG4.kt.
import { BitWriter } from './bit-writer.js';

/**
 * Encodes a black-and-white picture with CCITT Group 4.
 * @param {Uint8Array} bits rows of ceil(width / 8) bytes, the leftmost pixel in the high bit,
 *   1 for black and 0 for white (bits past a row's end are ignored)
 * @param {number} width
 * @param {number} height
 * @param {{ blackIs1?: boolean }} [options] blackIs1 false reads 1 as white instead (a PDF's
 *   DeviceGray order, as the page looks make them)
 * @returns {Uint8Array} the data for /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns width
 *   /Rows height >> (BlackIs1 false: black decodes to 0, as DeviceGray and image masks expect)
 */
export function encodeCcittG4(bits, width, height, { blackIs1 = true } = {}) {
  if (!(width > 0 && height > 0)) throw new RangeError(`A ${width} x ${height} picture`);
  const rowBytes = (width + 7) >> 3;
  if (!bits || bits.length < rowBytes * height) throw new RangeError(`A ${width} x ${height} picture needs ${rowBytes * height} bytes`);
  return encode(bits, width, height, rowBytes, blackIs1 ? 0xff : 0);
}

/** A page look's black-and-white picture ({ width, height, rowBytes, data }, 1 for white) as G4. */
export function encodeBitImage(image) {
  return encode(image.data, image.width, image.height, image.rowBytes, 0);
}

function encode(data, width, height, rowBytes, xor) {
  const out = new BitWriter(Math.max(1024, (rowBytes * height) >> 3));
  // Changing elements of the row being coded and of the row above (the first row's is white),
  // each followed by the row's width, which stands for "none further".
  let reference = new Int32Array(width + 4).fill(width);
  let coding = new Int32Array(width + 4);
  for (let y = 0; y < height; y++) {
    changes(data, y * rowBytes, width, xor, coding);
    codeRow(coding, reference, width, out);
    const swap = reference;
    reference = coding;
    coding = swap;
  }
  // EOFB: two EOL codes.
  out.write(1, 12);
  out.write(1, 12);
  return out.finish();
}

/**
 * The changing elements of the row starting at byte `start` into `out`: where a pixel differs from
 * the one before it (the row starts on an imaginary white pixel), then the width three times.
 * `xor` turns a byte into 1-for-white order. Returns how many there are.
 */
export function changes(data, start, width, xor, out) {
  let count = 0;
  let white = true;
  let x = 0;
  while (x < width) {
    const byte = (data[start + (x >>> 3)] ^ xor) & 0xff;
    // Whole bytes of the colour the row is in are skipped.
    if ((x & 7) === 0 && x + 8 <= width && byte === (white ? 0xff : 0x00)) {
      x += 8;
      continue;
    }
    const isWhite = ((byte >> (7 - (x & 7))) & 1) === 1;
    if (isWhite !== white) {
      out[count++] = x;
      white = isWhite;
    }
    x++;
  }
  out[count] = width;
  out[count + 1] = width;
  out[count + 2] = width;
  return count;
}

/** One row in two-dimensional coding, against `reference`, the row above's changing elements. */
function codeRow(coding, reference, width, out) {
  let a0 = -1;
  let white = true;
  let ia = 0;
  let ib = 0;
  while (a0 < width) {
    while (coding[ia] <= a0) ia++;
    const a1 = coding[ia];
    while (reference[ib] <= a0) ib++;
    // b1 is the first change above, right of a0, to the colour a0 isn't. The row above turns
    // black at its even changes (it starts white).
    let j = ib;
    if ((j % 2 === 0) !== white) j++;
    const b1 = reference[j];
    const b2 = reference[j + 1];
    if (b2 < a1) {
      out.write(PASS, 4);
      a0 = b2;
    } else if (a1 - b1 >= -3 && a1 - b1 <= 3) {
      const d = a1 - b1 + 3;
      out.write(VERTICAL_CODES[d], VERTICAL_LENGTHS[d]);
      a0 = a1;
      white = !white;
    } else {
      const a2 = coding[ia + 1];
      out.write(HORIZONTAL, 3);
      run(a1 - Math.max(a0, 0), white, out);
      run(a2 - a1, !white, out);
      a0 = a2;
    }
  }
}

/** A run of `length` pixels of one colour: make-up codes for each 64 (2560 at most each), then a terminating code. */
function run(length, white, out) {
  let left = length;
  const last = EXTENDED[EXTENDED.length - 1];
  while (left >= 2560) {
    out.write(last.code, last.length);
    left -= 2560;
  }
  if (left >= 64) {
    const makeUp = Math.floor(left / 64);
    const code = makeUp <= 27 ? (white ? WHITE_MAKE_UP : BLACK_MAKE_UP)[makeUp - 1] : EXTENDED[makeUp - 28];
    out.write(code.code, code.length);
    left -= makeUp * 64;
  }
  const code = (white ? WHITE_TERMINATING : BLACK_TERMINATING)[left];
  out.write(code.code, code.length);
}

const codes = (...bits) => bits.map((b) => Object.freeze({ code: parseInt(b, 2), length: b.length }));

const PASS = 0b0001;
const HORIZONTAL = 0b001;

/** V_L3, V_L2, V_L1, V0, V_R1, V_R2, V_R3: a1 that many pixels left of b1, under it, or right. */
const VERTICAL_CODES = [0b0000010, 0b000010, 0b010, 0b1, 0b011, 0b000011, 0b0000011];
const VERTICAL_LENGTHS = [7, 6, 3, 1, 3, 6, 7];

/** White runs of 0 to 63 (ITU-T T.4, table 2). */
export const WHITE_TERMINATING = codes(
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
);

/** Black runs of 0 to 63 (ITU-T T.4, table 2). */
export const BLACK_TERMINATING = codes(
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
);

/** White runs of 64, 128, … 1728 (ITU-T T.4, table 3). */
export const WHITE_MAKE_UP = codes(
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101',
  '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001',
  '010011010', '011000', '010011011',
);

/** Black runs of 64, 128, … 1728 (ITU-T T.4, table 3). */
export const BLACK_MAKE_UP = codes(
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100',
  '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010',
  '0000001011011', '0000001100100', '0000001100101',
);

/** Runs of 1792, 1856, … 2560 of either colour (ITU-T T.4, table 3a). */
export const EXTENDED = codes(
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101',
  '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111',
);
