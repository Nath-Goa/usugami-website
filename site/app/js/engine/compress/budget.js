// Long pixel work done in slices, so the page can paint and take input (the progress dialog's bar
// and its Cancel) while an image is read, checked and stored again.
import { checkCancelled } from '../../core/errors.js';
import { pause } from '../images/canvas.js';

/** Pixels done between looks at the clock: a few milliseconds of work even on a slow phone. */
const SLICE = 1 << 16;

/** Work runs about this long (ms) before the page gets its turn. */
const BUDGET_MS = 24;

/**
 * A clock for one piece of long work: `check()` lets the page paint once the budget is spent since
 * it last did, and stops with CancelledError once `signal` is aborted.
 */
export class WorkBudget {
  /** @param {AbortSignal} [signal] */
  constructor(signal, ms = BUDGET_MS) {
    this.signal = signal;
    this.ms = ms;
    this.started = performance.now();
  }

  /** Gives the page its turn when the budget is spent; throws CancelledError once cancelled. */
  async check() {
    checkCancelled(this.signal);
    if (performance.now() - this.started < this.ms) return;
    await pause();
    checkCancelled(this.signal);
    this.started = performance.now();
  }

  /**
   * Runs `step(from, to)` over 0 to `count` in slices of `slice`, giving the page its turn as the
   * budget runs out. `step` returning false stops early; resolves with whether it went to the end.
   * @param {number} count
   * @param {(from: number, to: number) => boolean | void} step
   */
  async each(count, step, slice = SLICE) {
    for (let from = 0; from < count; from += slice) {
      if (step(from, Math.min(count, from + slice)) === false) return false;
      if (from + slice < count) await this.check();
    }
    return true;
  }
}
