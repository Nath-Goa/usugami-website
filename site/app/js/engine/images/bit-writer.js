// Writes codes of up to 24 bits, most significant bit first, into a growing byte array
// (BitWriter in the app's CcittG4.kt), for CCITT G4 and JPEG's entropy-coded data.

export class BitWriter {
  constructor(initialSize = 4096) {
    this.buffer = new Uint8Array(Math.max(16, initialSize | 0));
    this.size = 0;
    this.bits = 0; // fewer than 8 bits are left here between writes
    this.count = 0;
  }

  write(code, length) {
    // At most 7 bits wait, so 7 + 24 fits in an unsigned 32-bit number.
    this.bits = ((this.bits << length) | (code & ((1 << length) - 1))) >>> 0;
    this.count += length;
    while (this.count >= 8) {
      this.count -= 8;
      this.put(this.bits >>> this.count);
    }
    this.bits &= (1 << this.count) - 1;
  }

  /** The bytes written, the last one padded with zero bits (or with one bits, as JPEG pads its data). */
  finish(padWithOnes = false) {
    if (this.count > 0) {
      this.put(((this.bits << (8 - this.count)) | (padWithOnes ? (1 << (8 - this.count)) - 1 : 0)) & 0xff);
    }
    this.count = 0;
    this.bits = 0;
    return this.buffer.slice(0, this.size);
  }

  put(byte) {
    if (this.size === this.buffer.length) {
      const bigger = new Uint8Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.size++] = byte & 0xff;
  }
}
