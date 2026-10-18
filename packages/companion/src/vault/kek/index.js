// @ts-check
// Choosing the key-encryption key (KEK) that wraps every namespace key of the vault. Configuration
// `vault.kek`: { provider: 'file' | 'systemd-creds' | 'keychain-macos', ...members of that provider }.
// Without a section the provider is `file` with the key next to the configuration file, outside the
// data folder. The KEK is loaded once at start; a wrong KEK is recognised by its id in the keyring
// and stops the start instead of failing on every item.
import { isAbsolute, join } from 'node:path';
import { checkRecord, isRecord, oneOf } from '../../contracts/check.js';
import { fail } from '../../lib/errors.js';
import { pathsOverlap } from '../../lib/fsx.js';
import { fileKek } from './file.js';
import { keychainKek } from './keychain-macos.js';
import { systemdCredsKek } from './systemd-creds.js';

export const KEK_PROVIDERS = Object.freeze(['file', 'systemd-creds', 'keychain-macos']);

/**
 * @typedef {object} KekProvider
 * @property {string} name
 * @property {() => string} describe
 * @property {() => boolean} exists     whether a key seems to be there (no secret is read)
 * @property {() => Promise<Buffer>} load
 * @property {() => Promise<Buffer>} init  creates a key; never replaces one
 */

/**
 * @param {unknown} raw  the `vault.kek` section
 * @returns {string[]}
 */
export function checkKekConfig(raw) {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['vault.kek: an object'];
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v.length > 0 ? null : 'a string');
  return checkRecord(raw, 'vault.kek', { provider: oneOf(KEK_PROVIDERS), path: str, name: str, credential: str, user: (v) => (typeof v === 'boolean' ? null : 'true or false'), service: str, account: str }, { required: ['provider'] });
}

/**
 * Builds the configured provider.
 * @param {object} options
 * @param {any} [options.config]          the `vault.kek` section
 * @param {string} options.configDir      folder of the configuration file (default key place)
 * @param {string} options.dataDir
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {import('./runner.js').ProgramRunner} [options.run]
 * @returns {KekProvider}
 */
export function kekProvider({ config, configDir, dataDir, env = process.env, run }) {
  const problems = checkKekConfig(config);
  if (problems.length > 0) throw fail('kek_config', problems.join('; '));
  const section = config ?? { provider: 'file' };
  switch (section.provider) {
    case 'systemd-creds':
      return systemdCredsKek({ name: section.name, credential: section.credential, user: section.user ?? true, env, run });
    case 'keychain-macos':
      return keychainKek({ service: section.service, account: section.account, run });
    default: {
      const path = section.path ?? join(configDir, 'kek.key');
      if (!isAbsolute(path)) throw fail('kek_config', 'vault.kek.path must be absolute');
      if (pathsOverlap(path, dataDir)) throw fail('kek_config', 'the key file must lie outside the data folder');
      return fileKek({ path });
    }
  }
}
