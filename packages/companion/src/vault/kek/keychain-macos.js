// @ts-check
// KEK provider `keychain-macos`: the key is a generic password item in the login keychain, read
// with `/usr/bin/security find-generic-password -w`. The keychain is unlocked with the login, so a
// copy of the disk alone does not open the vault. `kek-init` stores a fresh key; `security` takes a
// password only as an argument or from a terminal, so it is passed as an argument once, at setup.
import { fail } from '../../lib/errors.js';
import { KEY_BYTES, newKey } from '../crypto.js';
import { runProgram } from './runner.js';

export const SECURITY = '/usr/bin/security';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const HEX_KEY = /^[0-9a-f]{64}$/;
/** Exit code of `security` when the item does not exist. */
const NOT_FOUND = 44;

/**
 * @param {{ service?: string, account?: string, run?: import('./runner.js').ProgramRunner }} options
 */
export function keychainKek({ service = 'starpi-companion-kek', account = 'starpi-companion', run = runProgram }) {
  if (!LABEL.test(service) || !LABEL.test(account)) throw fail('kek_config', 'vault.kek.service and account are short labels');
  return {
    name: 'keychain-macos',
    describe: () => `macOS keychain item ${service}/${account}`,
    exists: () => true,
    async load() {
      const out = await run(SECURITY, ['find-generic-password', '-s', service, '-a', account, '-w']);
      if (out.code === NOT_FOUND) throw fail('kek_missing', `the keychain has no item ${service}/${account}`);
      if (out.code !== 0) throw fail('kek_unavailable', `security find-generic-password failed (exit ${out.code})`);
      const text = out.stdout.toString('utf8').trim();
      if (!HEX_KEY.test(text)) throw fail('kek_invalid', `the keychain item does not hold ${KEY_BYTES} bytes as hex`);
      return Buffer.from(text, 'hex');
    },
    async init() {
      const key = newKey();
      const out = await run(SECURITY, ['add-generic-password', '-s', service, '-a', account, '-w', key.toString('hex')]);
      if (out.code !== 0) throw fail('kek_unavailable', `security add-generic-password failed (exit ${out.code}); an item may exist already`);
      return key;
    },
  };
}
