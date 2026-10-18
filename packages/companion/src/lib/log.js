// @ts-check
// Structured log lines: one JSON object per line on stderr (journald and launchd keep them), with a
// time, a level, an event name and plain fields. Secrets never go in: the logger drops every field
// whose name looks like one, whatever the caller passes.

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */
/** @typedef {(level: Level, event: string, fields?: Record<string, unknown>) => void} Logger */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SECRET_FIELD = /(?:secret|token|password|passphrase|pairingcode|cookie|csrf|apikey|privatekey|kek|authorization)$/i;

/**
 * A logger that writes JSON lines.
 * @param {{ level?: Level, write?: (line: string) => void, now?: () => number }} [options]
 * @returns {Logger}
 */
export function createLogger({ level = 'info', write = (line) => process.stderr.write(line), now = Date.now } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  return (lvl, event, fields = {}) => {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    /** @type {Record<string, unknown>} */
    const line = { at: new Date(now()).toISOString(), level: lvl, event };
    for (const [name, value] of Object.entries(fields)) {
      if (SECRET_FIELD.test(name)) continue;
      line[name] = value instanceof Error ? { name: value.name, message: value.message } : value;
    }
    write(`${JSON.stringify(line)}\n`);
  };
}

/** A logger that writes nothing (tests, embedding). @type {Logger} */
export const silentLogger = () => {};

/**
 * A logger that keeps its lines in memory, for tests.
 * @returns {Logger & { lines: Array<{ level: Level, event: string, fields: Record<string, unknown> }> }}
 */
export function memoryLogger() {
  /** @type {Array<{ level: Level, event: string, fields: Record<string, unknown> }>} */
  const lines = [];
  /** @type {Logger} */
  const log = (level, event, fields = {}) => {
    lines.push({ level, event, fields });
  };
  return Object.assign(log, { lines });
}
