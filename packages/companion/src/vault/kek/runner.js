// @ts-check
// The only way the kernel runs another program: the key-encryption-key tools (systemd-creds, the
// macOS keychain tool) and systemd's readiness tool. The reference to execFile is taken when this
// module loads, before the egress guard forbids spawning for everything else, and only absolute
// paths from a fixed list are accepted, with an argument list and no shell. Modules never get this.
// execFile ends in ChildProcess#spawn, which the guard refuses too; the guard asks
// kernelProgramStarting() and lets a program through only while this runner is starting it.
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

/** How many runner calls are inside execFile right now (it starts the program synchronously). */
let starting = 0;

/**
 * True only while runProgram is starting `file` and `file` is one of KERNEL_PROGRAMS. Read by the
 * egress guard; nothing outside this module can make it true.
 * @param {unknown} file
 */
export const kernelProgramStarting = (file) => starting > 0 && typeof file === 'string' && KERNEL_PROGRAMS.includes(file);

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
    const argv = [...args];
    /** @type {ReturnType<typeof execFile>} */
    let child;
    starting += 1;
    try {
      child = execFile(file, argv, { shell: false, env, timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : -1) : 0;
        resolve({ code, stdout: Buffer.from(stdout ?? []), stderr: Buffer.from(stderr ?? []).toString('utf8').slice(0, 500) });
      });
    } finally {
      starting -= 1;
    }
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
