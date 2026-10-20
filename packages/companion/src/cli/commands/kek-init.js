// @ts-check
// `starpi-companion kek-init`: creates the key-encryption key with the configured provider before
// the first start (systemd credential, keychain item or key file). It never replaces a key.
import { kekProvider } from '../../vault/kek/index.js';
import { isFresh } from '../../installation.js';
import { fail } from '../../lib/errors.js';

/** @type {import('../context.js').Command} */
export const kekInitCommand = {
  name: 'kek-init',
  summary: 'create the key-encryption key with the configured provider',
  usage: 'kek-init',
  async run(ctx) {
    const config = ctx.config();
    if (!isFresh(config.dataDir, config.anchorDir)) throw fail('kek_exists', 'this installation has a vault already; its key cannot be replaced');
    const provider = kekProvider({ config: config.vault.kek, configDir: config.configDir, dataDir: config.dataDir, env: ctx.env });
    await provider.init();
    ctx.out(`created the key-encryption key: ${provider.describe()}`);
    return 0;
  },
};
