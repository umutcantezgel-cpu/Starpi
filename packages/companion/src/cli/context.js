// @ts-check
// What every command gets: its parsed arguments, the resolved configuration, output helpers and the
// environment. Commands print plain lines, or one JSON document with --json.
import { loadConfig } from '../config.js';

/** Options every command accepts. */
export const COMMON_STRINGS = Object.freeze(['config', 'data-dir', 'anchor-dir']);
export const COMMON_BOOLEANS = Object.freeze(['json', 'help']);

/**
 * @typedef {object} CommandContext
 * @property {string[]} positional
 * @property {Record<string, string | boolean>} flags
 * @property {() => import('../config.js').CompanionConfig & { file: string | null }} config
 * @property {(line?: string) => void} out
 * @property {(value: unknown) => void} json
 * @property {(line: string) => void} err
 * @property {NodeJS.ProcessEnv} env
 * @property {NodeJS.ReadStream} stdin
 * @property {(signal: 'SIGINT' | 'SIGTERM', fn: () => void) => void} onSignal
 */

/**
 * @typedef {object} Command
 * @property {string} name
 * @property {string} summary
 * @property {string} usage
 * @property {readonly string[]} [booleans]
 * @property {readonly string[]} [strings]
 * @property {(ctx: CommandContext) => Promise<number>} run   resolves with the exit code
 */

/**
 * @param {Record<string, string | boolean>} flags
 * @param {NodeJS.ProcessEnv} env
 * @param {Partial<{ port: number, appDir: string }>} [extra]
 */
export function configFrom(flags, env, extra = {}) {
  return loadConfig({
    file: typeof flags.config === 'string' ? flags.config : undefined,
    overrides: {
      dataDir: typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined,
      anchorDir: typeof flags['anchor-dir'] === 'string' ? flags['anchor-dir'] : undefined,
      ...extra,
    },
    env,
  });
}
