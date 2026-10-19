// @ts-check
// The one database layout of the app: every object store with its key and indexes, the record
// shapes they hold, and the versioned steps that build the layout. All features share this
// database; its name comes from the build profile (default 'starpi'), so a product built on this
// code keeps its data apart by passing its own name to configureStore().
//
// A schema change is a new step at the end of SCHEMA_STEPS with the next version number. Steps are
// never edited after a release: a browser that already ran version n only runs the steps after n.
// Steps may only await the operations of `ctx.tx` (see idb.js).
import { openDb, StoreError } from './idb.js';

/** @typedef {import('./idb.js').StoreDb} StoreDb */
/** @typedef {import('./idb.js').OpenOptions} OpenOptions */
/** @typedef {import('./idb.js').UpgradeContext} UpgradeContext */

// ---------------------------------------------------------------------------------------------
// Record shapes. Times are epoch milliseconds. Flags that an index looks up are 0 or 1, because
// IndexedDB cannot index booleans.

/**
 * A content part of a message as the AI contract defines it (text, image, file, tool_call,
 * tool_result, opaque). The store keeps parts exactly as given.
 * @typedef {{ type: string } & Record<string, unknown>} StoredPart
 */

/**
 * @typedef {object} ConversationRecord
 * @property {string} id
 * @property {string} title
 * @property {string} [projectId]
 * @property {string} [assistantId]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {0 | 1} pinned
 * @property {0 | 1} archived
 * @property {string | null} activeLeafId  the node whose path from the root is shown
 * @property {string | null} model
 * @property {'grounded' | 'free' | 'auto'} mode
 */

/**
 * One message in the conversation tree. Editing or regenerating adds a sibling under the same
 * parent, so a branch only ever grows at its end and provider state stays valid for replay.
 * @typedef {object} NodeRecord
 * @property {string} id
 * @property {string} conversationId
 * @property {string | null} parentId  null for the first message of a conversation
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {StoredPart[]} parts
 * @property {unknown[]} opaque  provider state (signed thinking, encrypted reasoning) replayed unchanged
 * @property {string | null} model
 * @property {string | null} provider
 * @property {string | null} label  answer label: 'grounded', 'free', 'mixed', 'web', or the companion's ('companion', 'companion_free', 'companion_template')
 * @property {unknown} [grounding]  the source-check result of the answer
 * @property {string} [receiptId]
 * @property {NodeUsage | null} usage
 * @property {SourceRef[]} [sources]
 * @property {boolean} localOnly  never sent to a cloud provider as history
 * @property {Record<string, unknown>} [meta]  fields carried over from older formats
 * @property {number} createdAt
 */

/** @typedef {{ input: number, output: number, reasoning?: number, cacheRead?: number, costUsd?: number }} NodeUsage */
/** @typedef {{ title: string, rank?: number | null }} SourceRef */

/**
 * @typedef {object} BlobRecord
 * @property {string} id
 * @property {Blob} data
 * @property {string} type  MIME type
 * @property {number} size  bytes
 * @property {'attachment' | 'thumbnail' | 'file'} kind  'file': original bytes kept when OPFS is missing
 * @property {string} [name]
 * @property {string} [ownerId]  the node or document the blob belongs to
 * @property {number} createdAt
 */

/**
 * @typedef {object} ProjectRecord
 * @property {string} id
 * @property {string} name
 * @property {string} instructions  prepended to the system prompt of the project's conversations
 * @property {string | null} defaultModel
 * @property {string[]} docIds  workspace documents the project answers from
 * @property {'global' | 'project' | 'off'} memoryScope
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * A saved preset; exported as `starpi.assistant/v1`.
 * @typedef {object} AssistantRecord
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} instructions
 * @property {string | null} model
 * @property {string[]} tools
 * @property {string[]} starters
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * A fact the user chose to keep (memory is opt-in).
 * @typedef {object} MemoryRecord
 * @property {string} id
 * @property {string} text
 * @property {string} scope  'global' or a project id
 * @property {'explicit' | 'suggested'} source
 * @property {number} createdAt
 * @property {number | null} usedAt
 * @property {number} weight
 */

/**
 * @typedef {object} ArtifactRecord
 * @property {string} id
 * @property {string} conversationId
 * @property {string} nodeId
 * @property {string} type  e.g. 'code', 'html', 'svg', 'mermaid', 'markdown'
 * @property {string} title
 * @property {Array<{ content: string, at: number }>} versions
 */

/**
 * A workspace document. Its text lives in `chunks`, its original bytes in the file store.
 * @typedef {object} DocRecord
 * @property {string} id
 * @property {string} name
 * @property {string} sha256  hex digest of the original bytes
 * @property {number} extractor  extractor version that produced the chunks
 * @property {number} bytes  size of the original file
 * @property {number} addedAt
 * @property {string} [mime]
 * @property {string} [fileId]  id in the file store (opfs.js)
 */

/** @typedef {{ docId: string, idx: number, start: number, end: number, text: string }} ChunkRecord */

/**
 * A quantised embedding of one chunk: value ≈ data[i] * scale.
 * @typedef {{ docId: string, idx: number, model: string, dim: number, data: Int8Array, scale: number }} VectorRecord
 */

/**
 * @typedef {object} ReceiptRecord
 * @property {string} id
 * @property {Record<string, unknown>} receipt  the receipt document as exported
 * @property {string} [conversationId]
 * @property {string} [nodeId]
 * @property {number} createdAt
 */

/**
 * A per-device signing key. The private key is a non-extractable CryptoKey: IndexedDB keeps the
 * handle, the key material never leaves WebCrypto.
 * @typedef {object} SigningKeyRecord
 * @property {string} id  key id derived from the public key
 * @property {'Ed25519' | 'ES256'} alg
 * @property {CryptoKey} privateKey
 * @property {CryptoKey} publicKey
 * @property {JsonWebKey} publicJwk
 * @property {number} createdAt
 * @property {number | null} retiredAt
 */

/**
 * @typedef {object} ResearchRecord
 * @property {string} id
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} question
 * @property {'chat' | 'library' | 'header'} origin
 * @property {'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'stale'} status
 * @property {number | null} heartbeatAt
 * @property {{ id: string, model: string }} provider
 * @property {{ sources?: Record<string, unknown>, web?: Record<string, unknown> }} parts
 * @property {string} [receiptId]
 */

/**
 * One measured model run.
 * @typedef {object} BenchRecord
 * @property {string} id
 * @property {string} modelId
 * @property {string} runtime
 * @property {string} deviceClass
 * @property {string} browser
 * @property {number} tokPerSec
 * @property {number} ttftMs
 * @property {number} loadMs
 * @property {number} failures
 * @property {number} at
 */

/**
 * The hash check of one downloaded model file.
 * @typedef {object} ModelIntegrityRecord
 * @property {string} url
 * @property {number} size
 * @property {string} sha256
 * @property {'verified' | 'mismatch' | 'override'} status
 * @property {number} checkedAt
 */

/** @typedef {{ key: string, value: unknown, updatedAt: number }} SettingsRecord */

/**
 * Provider keys encrypted with a key derived from the user's passphrase.
 * @typedef {object} KeyVaultRecord
 * @property {string} id
 * @property {1} v
 * @property {{ name: 'PBKDF2', hash: 'SHA-256', iterations: number }} kdf
 * @property {Uint8Array} salt
 * @property {Uint8Array} iv
 * @property {Uint8Array} ct  AES-GCM ciphertext
 * @property {number} updatedAt
 */

// ---------------------------------------------------------------------------------------------
// Layout

/**
 * @typedef {object} StoreSpec
 * @property {string | string[]} keyPath
 * @property {Record<string, { keyPath: string | string[], unique?: boolean }>} [indexes]
 */

/** @typedef {{ version: number, apply: (ctx: UpgradeContext) => void | Promise<void> }} SchemaStep */

export const DEFAULT_DB_NAME = 'starpi';

/** @param {string} keyPath */
const by = (keyPath) => ({ keyPath });

/** Version 1: every store the app uses. */
const V1_STORES = /** @type {Record<string, StoreSpec>} */ ({
  conversations: { keyPath: 'id', indexes: { updatedAt: by('updatedAt'), projectId: by('projectId'), pinned: by('pinned') } },
  nodes: { keyPath: 'id', indexes: { conversationId: by('conversationId'), parentId: by('parentId') } },
  blobs: { keyPath: 'id' },
  projects: { keyPath: 'id' },
  assistants: { keyPath: 'id' },
  memory: { keyPath: 'id', indexes: { scope: by('scope') } },
  artifacts: { keyPath: 'id', indexes: { conversationId: by('conversationId') } },
  docs: { keyPath: 'id', indexes: { sha256: by('sha256') } },
  chunks: { keyPath: ['docId', 'idx'], indexes: { docId: by('docId') } },
  vectors: { keyPath: ['docId', 'idx', 'model'], indexes: { docId: by('docId') } },
  receipts: { keyPath: 'id' },
  signingKeys: { keyPath: 'id' },
  research: { keyPath: 'id', indexes: { status: by('status'), updatedAt: by('updatedAt') } },
  bench: { keyPath: 'id', indexes: { modelId: by('modelId') } },
  modelIntegrity: { keyPath: 'url' },
  settings: { keyPath: 'key' },
  keyvault: { keyPath: 'id' },
});

/**
 * Creates the stores and indexes that do not exist yet, so a step also completes a layout that a
 * development build left half done.
 * @param {UpgradeContext} ctx
 * @param {Record<string, StoreSpec>} stores
 */
export function createStores(ctx, stores) {
  for (const [name, spec] of Object.entries(stores)) {
    if (!ctx.hasStore(name)) ctx.createStore(name, { keyPath: spec.keyPath });
    for (const [index, def] of Object.entries(spec.indexes ?? {})) {
      if (!ctx.hasIndex(name, index)) ctx.createIndex(name, index, def.keyPath, { unique: def.unique });
    }
  }
}

/** @type {readonly SchemaStep[]} */
export const SCHEMA_STEPS = Object.freeze([{ version: 1, apply: (/** @type {UpgradeContext} */ ctx) => createStores(ctx, V1_STORES) }]);

/** The layout after the last step, for checks and for "forget everything". */
export const STORES = Object.freeze(V1_STORES);
export const STORE_NAMES = Object.freeze(Object.keys(STORES));
export const SCHEMA_VERSION = SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version;

/**
 * The upgrade function for a list of steps: runs, in order, every step newer than the stored
 * version and not newer than the requested one.
 * @param {readonly SchemaStep[]} steps
 * @returns {(ctx: UpgradeContext) => Promise<void>}
 */
export function upgradeThrough(steps) {
  assertSteps(steps);
  return async (ctx) => {
    for (const step of steps) {
      if (step.version > ctx.oldVersion && step.version <= ctx.newVersion) await step.apply(ctx);
    }
  };
}

/** @param {readonly SchemaStep[]} steps */
function assertSteps(steps) {
  if (steps.length === 0) throw new StoreError('data', 'A schema needs at least one step');
  steps.forEach((step, i) => {
    if (!Number.isInteger(step.version) || step.version !== i + 1) throw new StoreError('data', `Schema step ${i + 1} has version ${step.version}`);
  });
}

/** @param {unknown} name */
function assertDbName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new StoreError('data', 'A database name is lowercase letters, digits and dashes');
}

/**
 * Opens the app database at the version of its last step.
 * @param {OpenOptions & { name?: string, steps?: readonly SchemaStep[] }} [options]
 * @returns {Promise<StoreDb>}
 */
export async function openAppDb(options = {}) {
  const { name = profile.name, steps = SCHEMA_STEPS, ...openOptions } = options;
  assertDbName(name);
  const upgrade = upgradeThrough(steps);
  return openDb(name, steps[steps.length - 1].version, upgrade, { onVersionChange: profile.onVersionChange, onBlocked: profile.onBlocked, ...openOptions });
}

/** @type {{ name: string, onVersionChange?: () => void, onBlocked?: () => void }} */
const profile = { name: DEFAULT_DB_NAME };
/** @type {Promise<StoreDb> | null} */
let shared = null;

/**
 * Sets the database name of this build and the callbacks for another tab upgrading it. Call it
 * before the first appDb(); a later call closes the shared connection.
 * @param {{ name?: string, onVersionChange?: () => void, onBlocked?: () => void }} options
 */
export function configureStore(options) {
  if (options.name !== undefined) assertDbName(options.name);
  if (options.name !== undefined) profile.name = options.name;
  if ('onVersionChange' in options) profile.onVersionChange = options.onVersionChange;
  if ('onBlocked' in options) profile.onBlocked = options.onBlocked;
  const previous = shared;
  shared = null;
  void previous?.then((db) => db.close(), () => {});
}

/** @returns {string} the database name of this build */
export function storeProfileName() {
  return profile.name;
}

/**
 * The shared connection of the page, opened on first use and reopened after another tab closed
 * it with an upgrade.
 * @returns {Promise<StoreDb>}
 */
export async function appDb() {
  if (shared) {
    const pending = shared;
    try {
      const db = await pending;
      if (!db.isClosed()) return db;
    } catch {
      // Reopen below.
    }
    if (shared === pending) shared = null;
  }
  shared ??= openAppDb();
  return shared;
}

/**
 * Empties stores in one transaction ("forget everything on this device" clears them all).
 * @param {StoreDb} db
 * @param {readonly string[]} [names]
 * @returns {Promise<void>}
 */
export function clearStores(db, names = STORE_NAMES) {
  const present = names.filter((name) => db.storeNames().includes(name));
  if (present.length === 0) return Promise.resolve();
  return db.transaction(present, 'readwrite', async (tx) => {
    await Promise.all(present.map((name) => tx.clear(name)));
  });
}
