// Long loops over a workbook's rows and cells check for cancelling and now and then let the page
// paint and handle input, without paying for an await on every row.
import { checkCancelled } from '../../core/errors.js';
import { pause } from './pause.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Pace {
  /** `signal` stops the work; `budget` is how many milliseconds go by between breaths. */
  constructor(signal, budget = 30) {
    this.signal = signal;
    this.budget = budget;
    this.last = now();
  }

  /** Throws CancelledError when cancelled; true when it is time to breathe(). */
  check() {
    checkCancelled(this.signal);
    return now() - this.last >= this.budget;
  }

  /** Lets the page breathe (in a new task, not after a timer: see pause.js), then checks for cancelling again. */
  async breathe() {
    await pause();
    this.last = now();
    checkCancelled(this.signal);
  }
}
