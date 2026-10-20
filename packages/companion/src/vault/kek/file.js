// @ts-check
// KEK provider `file`: 32 random bytes as 64 hex characters in a file of its own, outside the data
// folder (so a copy of the data folder alone stays sealed), mode 0600 and owned by the user who runs
// the companion. Good enough for a single-user machine with full-disk encryption; the systemd and
// keychain providers bind the key to the machine or the login instead.
import { statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fail } from '../../lib/errors.js';
import { ensurePrivateDir, readRegularFile, writeFileOnce } from '../../lib/fsx.js';
import { KEY_BYTES, newKey } from '../crypto.js';

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * @param {{ path: string }} options
 */
export function fileKek({ path }) {
  if (!isAbsolute(path)) throw fail('kek_config', 'vault.kek.path must be absolute');
  return {
    name: 'file',
    describe: () => `file ${path}`,
    exists: () => readRegularFile(path, 256) !== null,
    async load() {
      const raw = readRegularFile(path, 256);
      if (raw === null) throw fail('kek_missing', `the key file ${path} is missing`);
      if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) throw fail('kek_file_mode', `the key file ${path} is readable by others; chmod 600 it`);
      const text = raw.toString('utf8').trim();
      if (!HEX_KEY.test(text)) throw fail('kek_invalid', `the key file ${path} does not hold ${KEY_BYTES} bytes as hex`);
      return Buffer.from(text, 'hex');
    },
    async init() {
      ensurePrivateDir(dirname(path));
      const key = newKey();
      writeFileOnce(path, `${key.toString('hex')}\n`, { mode: 0o600 });
      return key;
    },
  };
}
