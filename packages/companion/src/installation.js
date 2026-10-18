// @ts-check
// Opening an installation: the key-encryption key, the keyring, the store, the vault, the identity
// and the audit chain, in that order. The service does this at start, and so do the command-line
// tools that work on the data without the server (pair, secret, verify-audit, backup).
import { join } from 'node:path';
import { createEventTypes } from './contracts/event.js';
import { createAuditChain } from './audit/chain.js';
import { loadIdentity } from './audit/identity.js';
import { fail } from './lib/errors.js';
import { systemClock } from './lib/clock.js';
import { ensurePrivateDir, exists } from './lib/fsx.js';
import { loadProfile } from './profiles/index.js';
import { openStore } from './store/sqlite.js';
import { openDeletionList } from './vault/deletions.js';
import { kekProvider } from './vault/kek/index.js';
import { openKeyring } from './vault/keyring.js';
import { createVault, namespaceCodec } from './vault/vault.js';
import { DB_FILE } from './vault/backup.js';

/** Where the files of an installation live. @param {string} dataDir @param {string} anchorDir */
export const installationFiles = (dataDir, anchorDir) => ({
  db: join(dataDir, DB_FILE),
  keyring: join(dataDir, 'vault', 'keyring.json'),
  blobs: join(dataDir, 'vault', 'blobs'),
  deletions: join(anchorDir, 'deletions.log'),
});

/** True when a data folder holds no installation yet. @param {string} dataDir @param {string} anchorDir */
export function isFresh(dataDir, anchorDir) {
  const files = installationFiles(dataDir, anchorDir);
  return !exists(files.keyring) && !exists(files.db);
}

/**
 * @param {object} options
 * @param {import('./config.js').CompanionConfig} options.config
 * @param {boolean} [options.create]     make a new installation when the data folder is empty
 * @param {import('./contracts/module.js').CompanionModule[]} [options.modules]
 * @param {import('./lib/clock.js').Clock} [options.clock]
 * @param {import('./vault/kek/runner.js').ProgramRunner} [options.run]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function openInstallation({ config, create = false, modules = [], clock = systemClock, run, env = process.env }) {
  const files = installationFiles(config.dataDir, config.anchorDir);
  const fresh = isFresh(config.dataDir, config.anchorDir);
  if (fresh && !create) throw fail('not_installed', `no installation in ${config.dataDir}; run "starpi-companion start" once`);
  ensurePrivateDir(config.dataDir, { tighten: true });

  const provider = kekProvider({ config: config.vault.kek, configDir: config.configDir, dataDir: config.dataDir, env, run });
  let kek;
  if (fresh && provider.name === 'file' && !provider.exists()) kek = await provider.init();
  else kek = await provider.load();
  const keyring = openKeyring({ file: files.keyring, kek, provider: provider.name, clock });

  const profile = loadProfile(config.profile);
  const types = createEventTypes();
  for (const t of profile.eventTypes) types.register(t);
  for (const m of modules) for (const t of m.eventTypes ?? []) types.register(t);
  const projections = [...profile.projections, ...modules.flatMap((m) => m.projections ?? [])];

  const store = openStore({ path: files.db, clock, types, projections, codec: namespaceCodec(keyring, 'events') });
  const deletions = openDeletionList({ file: files.deletions, dataDir: config.dataDir });
  const vault = createVault({ store, keyring, deletions, blobDir: files.blobs, clock });
  // The kernel's namespaces get their keys at once, so tools running next to the service never
  // race it to create them.
  if (fresh) for (const ns of ['events', 'secrets']) keyring.dataKey(ns);
  const identity = loadIdentity(vault, { create: fresh || create });
  const chain = createAuditChain({ store, identity, clock });
  return {
    config,
    files,
    fresh,
    kek,
    kekProvider: provider,
    keyring,
    store,
    vault,
    deletions,
    identity,
    chain,
    profile,
    close: () => store.close(),
  };
}

/** @typedef {Awaited<ReturnType<typeof openInstallation>>} Installation */
