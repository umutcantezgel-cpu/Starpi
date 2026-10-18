// @ts-check
// A small argument parser: positional words, `--name value`, `--name=value` and boolean flags.
import { fail } from '../lib/errors.js';

/**
 * @param {string[]} argv
 * @param {{ booleans?: readonly string[], strings?: readonly string[] }} spec
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
 */
export function parseArgs(argv, { booleans = [], strings = [] } = {}) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (booleans.includes(name)) {
      if (eq >= 0) throw fail('usage', `--${name} takes no value`);
      flags[name] = true;
    } else if (strings.includes(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') throw fail('usage', `--${name} needs a value`);
      flags[name] = value;
    } else {
      throw fail('usage', `unknown option --${name}`);
    }
  }
  return { positional, flags };
}

/**
 * Reads a secret from standard input: everything until EOF when piped, one hidden line on a
 * terminal. Never from an argument, where other users could see it in the process list.
 * @param {string} prompt
 * @param {NodeJS.ReadStream} [stdin]
 * @param {NodeJS.WriteStream} [stderr]
 * @returns {Promise<string>}
 */
export function readSecret(prompt, stdin = process.stdin, stderr = process.stderr) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      /** @type {Buffer[]} */
      const chunks = [];
      stdin.on('data', (c) => chunks.push(Buffer.from(c)));
      stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
      stdin.once('error', reject);
      return;
    }
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (/** @type {Buffer} */ buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          reject(fail('cancelled', 'cancelled'));
          return;
        }
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
