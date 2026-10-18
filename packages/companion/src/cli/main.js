// @ts-check
// The command line of the companion: `starpi-companion <command> [options]`.
import { codeOf, CompanionError } from '../lib/errors.js';
import { VERSION } from '../version.js';
import { parseArgs } from './args.js';
import { COMMON_BOOLEANS, COMMON_STRINGS, configFrom } from './context.js';
import { backupCommand } from './commands/backup.js';
import { egressSpliceCommand } from './commands/egress-splice.js';
import { kekInitCommand } from './commands/kek-init.js';
import { pairCommand } from './commands/pair.js';
import { secretCommand } from './commands/secret.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { tokenRevokeCommand } from './commands/token-revoke.js';
import { eraseCommand, exportCommand, importCommand } from './commands/vault.js';
import { verifyAuditCommand } from './commands/verify-audit.js';

/** @type {readonly import('./context.js').Command[]} */
export const COMMANDS = Object.freeze([startCommand, statusCommand, pairCommand, secretCommand, tokenRevokeCommand, verifyAuditCommand, backupCommand, exportCommand, importCommand, eraseCommand, kekInitCommand, egressSpliceCommand]);

function help() {
  const lines = [`starpi-companion ${VERSION}: Starpi Core, the local companion`, '', 'usage: starpi-companion <command> [options]', ''];
  for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(14)} ${c.summary}`);
  lines.push('', 'options for every command: --config <file> --data-dir <folder> --anchor-dir <folder> --json', 'starpi-companion <command> --help shows the usage of one command.');
  return lines.join('\n');
}

/**
 * Runs the command line; resolves with the exit code.
 * @param {string[]} argv  arguments after the program name
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (text: string) => void, stderr?: (text: string) => void, stdin?: NodeJS.ReadStream, onSignal?: (signal: 'SIGINT' | 'SIGTERM', fn: () => void) => void }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((t) => process.stdout.write(t));
  const stderr = io.stderr ?? ((t) => process.stderr.write(t));
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    stdout(`${help()}\n`);
    return name === undefined ? 2 : 0;
  }
  if (name === 'version' || name === '--version') {
    stdout(`${VERSION}\n`);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    stderr(`unknown command ${name}\n\n${help()}\n`);
    return 2;
  }
  try {
    const { positional, flags } = parseArgs(rest, { booleans: [...COMMON_BOOLEANS, ...(command.booleans ?? [])], strings: [...COMMON_STRINGS, ...(command.strings ?? [])] });
    if (flags.help) {
      stdout(`usage: starpi-companion ${command.usage}\n`);
      return 0;
    }
    /** @type {ReturnType<typeof configFrom> | null} */
    let cached = null;
    return await command.run({
      positional,
      flags,
      config: () => (cached ??= configFrom(flags, env)),
      out: (line = '') => stdout(`${line}\n`),
      json: (value) => stdout(`${JSON.stringify(value, null, 2)}\n`),
      err: (line) => stderr(`${line}\n`),
      env,
      stdin: io.stdin ?? process.stdin,
      onSignal: io.onSignal ?? ((signal, fn) => process.once(signal, fn)),
    });
  } catch (err) {
    const code = codeOf(err);
    const message = err instanceof Error ? err.message : String(err);
    stderr(`error: ${code}: ${message}\n`);
    if (err instanceof CompanionError && Array.isArray(err.details?.problems)) for (const p of err.details.problems) stderr(`  - ${p}\n`);
    return code === 'usage' ? 2 : 1;
  }
}
