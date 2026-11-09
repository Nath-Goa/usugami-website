// Errors the app explains to the user. Engines throw these; screens show t(error.key, ...error.args).

/** A problem the user can understand and act on, worded by the string `key` (with `args`). */
export class UserError extends Error {
  constructor(key, ...args) {
    super(key);
    this.name = 'UserError';
    this.key = key;
    this.args = args;
  }
}

/** The PDF needs a password, and none (or a wrong one) was given. */
export class PasswordError extends Error {
  constructor(wrong = false) {
    super(wrong ? 'Wrong password' : 'Password needed');
    this.name = 'PasswordError';
    this.wrong = wrong;
  }
}

/** The user cancelled (AbortSignal). Screens ignore it quietly. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** Throws CancelledError if `signal` has been aborted. Call it between pages in long work. */
export function checkCancelled(signal) {
  if (signal?.aborted) throw new CancelledError();
}
