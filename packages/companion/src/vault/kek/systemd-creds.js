// @ts-check
// KEK provider `systemd-creds` (Linux with systemd 250 or newer): the key is an encrypted systemd
// credential, sealed to the host key and, where present, the TPM2, so a copy of the disk does not
// open it. Under the user unit (`LoadCredentialEncrypted=starpi-companion-kek`) systemd decrypts it
// into the service's private credentials folder, where the companion reads it without running
// anything. On the command line the credential file is opened with `systemd-creds decrypt`.
// `kek-init` makes the credential: the random key goes to `systemd-creds encrypt` on stdin, never as
// an argument.
import { isAbsolute, join } from 'node:path';
import { fail } from '../../lib/errors.js';
import { readRegularFile } from '../../lib/fsx.js';
import { KEY_BYTES, newKey } from '../crypto.js';
import { runProgram } from './runner.js';

export const SYSTEMD_CREDS = '/usr/bin/systemd-creds';
export const DEFAULT_CREDENTIAL = 'starpi-companion-kek';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX_KEY = /^[0-9a-f]{64}$/;

/** @param {Buffer} raw */
function parseKey(raw) {
  const text = raw.toString('utf8').trim();
  if (!HEX_KEY.test(text)) throw fail('kek_invalid', `the credential does not hold ${KEY_BYTES} bytes as hex`);
  return Buffer.from(text, 'hex');
}

/**
 * @param {{ name?: string, credential?: string, user?: boolean, env?: NodeJS.ProcessEnv, run?: import('./runner.js').ProgramRunner }} options
 */
export function systemdCredsKek({ name = DEFAULT_CREDENTIAL, credential, user = true, env = process.env, run = runProgram }) {
  if (!NAME.test(name)) throw fail('kek_config', 'vault.kek.name is not a valid credential name');
  if (credential !== undefined && !isAbsolute(credential)) throw fail('kek_config', 'vault.kek.credential must be absolute');
  const fromUnit = () => {
    const dir = env.CREDENTIALS_DIRECTORY;
    return dir && isAbsolute(dir) ? readRegularFile(join(dir, name), 256) : null;
  };
  return {
    name: 'systemd-creds',
    describe: () => `systemd credential ${name}${credential ? ` (${credential})` : ''}`,
    exists: () => fromUnit() !== null || (credential !== undefined && readRegularFile(credential, 64 * 1024) !== null),
    async load() {
      const loaded = fromUnit();
      if (loaded !== null) return parseKey(loaded);
      if (credential === undefined) throw fail('kek_missing', `the credential ${name} was not loaded by the unit and no credential file is configured`);
      const out = await run(SYSTEMD_CREDS, [...(user ? ['--user'] : []), `--name=${name}`, 'decrypt', credential, '-']);
      if (out.code !== 0) throw fail('kek_unavailable', `systemd-creds decrypt failed (exit ${out.code})`);
      return parseKey(out.stdout);
    },
    async init() {
      if (credential === undefined) throw fail('kek_config', 'vault.kek.credential is needed to create the credential');
      const key = newKey();
      const out = await run(SYSTEMD_CREDS, [...(user ? ['--user'] : []), `--name=${name}`, 'encrypt', '-', credential], { input: `${key.toString('hex')}\n` });
      if (out.code !== 0) throw fail('kek_unavailable', `systemd-creds encrypt failed (exit ${out.code})`);
      return key;
    },
  };
}
