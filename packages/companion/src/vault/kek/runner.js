// @ts-check
// The only way the kernel runs another program: the key-encryption-key tools (systemd-creds, the
// macOS keychain tool) and systemd's readiness tool. The reference to execFile is taken when this
// module loads, before the egress guard forbids spawning for everything else, and only absolute
// paths from a fixed list are accepted, with an argument list and no shell. Modules never get this.
import childProcess from 'node:child_process';
import { fail } from '../../lib/errors.js';

const execFile = childProcess.execFile;

/** Programs the kernel may run. */
export const KERNEL_PROGRAMS = Object.freeze([
  '/usr/bin/systemd-creds',
  '/usr/bin/systemd-notify',
  '/bin/systemd-notify',
  '/usr/bin/security',
]);

/**
 * @typedef {(file: string, args: readonly string[], options?: { input?: Uint8Array | string, timeoutMs?: number, env?: Record<string, string> }) => Promise<{ code: number, stdout: Buffer, stderr: string }>} ProgramRunner
 */

/** @type {ProgramRunner} */
export const runProgram = (file, args, { input, timeoutMs = 10_000, env = { PATH: '/usr/bin:/bin', LANG: 'C' } } = {}) =>
  new Promise((resolve, reject) => {
    if (!KERNEL_PROGRAMS.includes(file)) {
      reject(fail('program_not_allowed', `the kernel does not run ${file}`));
      return;
    }
    const child = execFile(file, [...args], { shell: false, env, timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : -1) : 0;
      resolve({ code, stdout: Buffer.from(stdout ?? []), stderr: Buffer.from(stderr ?? []).toString('utf8').slice(0, 500) });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
