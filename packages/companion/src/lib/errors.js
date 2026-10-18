// @ts-check
// One error type for the whole companion: a stable machine code (snake_case) that the CLI, the
// HTTP answers and the browser app translate, a plain English message for logs, and an optional HTTP
// status for the server. Codes are part of the public contract; messages are not.

export class CompanionError extends Error {
  /**
   * @param {string} code     stable snake_case code, e.g. 'audit_rollback'
   * @param {string} message  English, for logs and the console
   * @param {{ status?: number, details?: Record<string, unknown>, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'CompanionError';
    this.code = code;
    this.status = extra.status ?? 500;
    this.details = extra.details ?? {};
  }
}

/**
 * Shorthand for `new CompanionError(...)`.
 * @param {string} code
 * @param {string} message
 * @param {{ status?: number, details?: Record<string, unknown>, cause?: unknown }} [extra]
 */
export const fail = (code, message, extra) => new CompanionError(code, message, extra);

/**
 * The code of any thrown value: a CompanionError's own, a Node system error's (lower-cased), else
 * 'internal_error'.
 * @param {unknown} err
 */
export function codeOf(err) {
  if (err instanceof CompanionError) return err.code;
  const code = /** @type {{ code?: unknown }} */ (err ?? {}).code;
  return typeof code === 'string' && code !== '' ? code.toLowerCase() : 'internal_error';
}
