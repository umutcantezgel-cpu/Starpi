// @ts-check
/**
 * @file Conversations on this device: the conversation records and their message trees in the app
 * database (store/schema.js: `conversations`, `nodes`, `blobs`), with change events for the views.
 *
 * Model
 * - A conversation has a title, flags (pinned, archived), an optional project and assistant, the
 *   model and mode it was last used with, and `activeLeafId`: the leaf whose path is the thread.
 * - A node is one message with `parts` (the AI contract's content parts) and `opaque` provider state.
 *   Both are stored exactly as given and never change afterwards: nodes are append-only. Editing a
 *   question or regenerating an answer appends a sibling under the same parent (addSibling), so
 *   every branch only grows at its end and stays valid for replay to the provider that wrote it.
 *   Only metadata can be attached later (annotateNode: grounding, receipt, usage, sources, label).
 * - Attachments are blobs owned by a node (putBlob with ownerId); a part refers to one by `blobId`.
 *
 * Use (the thread is built on this):
 *   const store = await openChatStore();                       // shared instance, migrations done
 *   const c = await store.createConversation({ mode: 'free' });
 *   const q = await store.appendNode(c.id, { parentId: null, role: 'user', parts: [{ type: 'text', text: 'Hi' }] });
 *   const a = await store.appendNode(c.id, { parentId: q.id, role: 'assistant', parts, opaque, model, provider, usage });
 *   const r = await store.addSibling(a.id, { role: 'assistant', parts: other });  // regenerate: ‹ 2/2 ›
 *   const { conversation, tree, path } = await store.loadThread(c.id);        // path = active thread
 *   await store.setActiveLeaf(c.id, switchBranch(tree, a.id, -1));            // back to ‹ 1/2 › (tree.js)
 *   const off = store.onChange((e) => …);                     // { kind: 'conversation' | 'node' | 'all', … }
 *
 * appendNode makes the new node the active leaf (unless { activate: false }) and titles an untitled
 * conversation after its first question. Every call runs in order with the others, and each write is
 * one transaction. Changes reach the other tabs of this browser through a BroadcastChannel.
 */
import { StoreError } from '../store/idb.js';
import { appDb, storeProfileName } from '../store/schema.js';
import { activePath, indexNodes, nodeText } from './tree.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('../store/idb.js').StoreOps} StoreOps */
/** @typedef {import('../store/schema.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../store/schema.js').StoredPart} StoredPart */
/** @typedef {import('../store/schema.js').BlobRecord} BlobRecord */
/** @typedef {import('../store/schema.js').NodeUsage} NodeUsage */
/** @typedef {import('../store/schema.js').SourceRef} SourceRef */
/** @typedef {import('./tree.js').NodeTree} NodeTree */

/**
 * A new message. `parentId` is null for the first message of a conversation.
 * @typedef {object} NodeInput
 * @property {string | null} parentId
 * @property {NodeRecord['role']} role
 * @property {StoredPart[]} parts
 * @property {unknown[]} [opaque]
 * @property {string | null} [model]
 * @property {string | null} [provider]
 * @property {string | null} [label]
 * @property {unknown} [grounding]
 * @property {string} [receiptId]
 * @property {NodeUsage | null} [usage]
 * @property {SourceRef[]} [sources]
 * @property {boolean} [localOnly]  never sent to a cloud provider as history (default false)
 * @property {Record<string, unknown>} [meta]
 * @property {number} [createdAt]  defaults to now
 * @property {string} [id]  defaults to a random id
 */

/**
 * @typedef {object} ConversationInput
 * @property {string} [id]  defaults to `starpi_<uuid>` (it doubles as the chat session id)
 * @property {string} [title]
 * @property {string} [projectId]
 * @property {string} [assistantId]
 * @property {string | null} [model]
 * @property {ConversationRecord['mode']} [mode]  default 'auto'
 * @property {boolean} [pinned]
 * @property {boolean} [archived]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 */

/**
 * Fields a conversation update may change. `projectId: null` takes it out of its project.
 * @typedef {object} ConversationPatch
 * @property {string} [title]
 * @property {string | null} [projectId]
 * @property {string | null} [assistantId]
 * @property {boolean} [pinned]
 * @property {boolean} [archived]
 * @property {string | null} [model]
 * @property {ConversationRecord['mode']} [mode]
 */

/**
 * Metadata that may be attached to a stored node. `meta` is merged into the node's meta.
 * @typedef {Pick<NodeRecord, 'grounding' | 'receiptId' | 'usage' | 'sources' | 'label' | 'meta'>} NodeAnnotation
 */

/**
 * @typedef {{ kind: 'conversation', op: 'put' | 'delete', id: string, remote?: boolean }
 *   | { kind: 'node', op: 'put', id: string, conversationId: string, remote?: boolean }
 *   | { kind: 'all', remote?: boolean }} ChatChange
 */

/**
 * @typedef {object} Thread
 * @property {ConversationRecord} conversation
 * @property {NodeRecord[]} nodes
 * @property {NodeTree} tree
 * @property {NodeRecord[]} path  root first, ending at the active leaf
 */

/**
 * @typedef {object} ChatStoreOptions
 * @property {() => Promise<StoreDb>} [open]  the database (default: the app database)
 * @property {() => number} [now]
 * @property {() => string} [uuid]
 * @property {string | null} [channel]  BroadcastChannel name for changes between tabs (none by default)
 */

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MODES = new Set(['grounded', 'free', 'auto']);
const ANNOTATIONS = new Set(['grounding', 'receiptId', 'usage', 'sources', 'label', 'meta']);
const PATCHABLE = new Set(['title', 'projectId', 'assistantId', 'pinned', 'archived', 'model', 'mode']);
/** Blob kinds that belong to chats (workspace originals, kind 'file', stay). */
const CHAT_BLOB_KINDS = new Set(['attachment', 'thumbnail']);
export const TITLE_CHARS = 60;
const MAX_TITLE_CHARS = 200;
const FIRST_TURN_CHARS = 500;

/**
 * A title from the first line of a text, at most TITLE_CHARS characters.
 * @param {string} text
 */
export function titleFromText(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((l) => l.trim()) ?? '';
  return Array.from(line.replace(/\s+/g, ' ').trim()).slice(0, TITLE_CHARS).join('');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} parts */
function checkParts(parts) {
  if (!Array.isArray(parts) || parts.some((p) => !isRecord(p) || typeof p.type !== 'string' || !p.type)) {
    throw new StoreError('data', 'A message needs a list of parts, each with a type');
  }
}

/** @param {NodeInput} input */
function checkNodeInput(input) {
  if (!isRecord(input)) throw new StoreError('data', 'A message is an object');
  if (!ROLES.has(input.role)) throw new StoreError('data', `Unknown message role "${String(input.role)}"`);
  if (input.parentId !== null && typeof input.parentId !== 'string') throw new StoreError('data', 'parentId is a node id or null');
  checkParts(input.parts);
  if (input.opaque !== undefined && !Array.isArray(input.opaque)) throw new StoreError('data', 'opaque is a list');
}

/** @param {unknown} title */
function cleanTitle(title) {
  return Array.from(String(title ?? '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_TITLE_CHARS)
    .join('');
}

/**
 * @param {ChatStoreOptions} [options]
 */
export function createChatStore(options = {}) {
  const open = options.open ?? appDb;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  /** @type {Set<(change: ChatChange) => void>} */
  const listeners = new Set();
  /** @type {BroadcastChannel | null} */
  let channel = null;
  if (options.channel && typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(options.channel);
      channel.onmessage = (event) => {
        if (isRecord(event.data) && typeof event.data.kind === 'string') deliver({ .../** @type {ChatChange} */ (event.data), remote: true });
      };
    } catch {
      channel = null;
    }
  }

  // Times are strictly increasing within this store, so siblings created in the same millisecond
  // keep their creation order.
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Math.floor(now()), lastStamp + 1);
    return lastStamp;
  };

  let tail = Promise.resolve();
  /**
   * Runs store calls one after the other, so a read sees every write that was asked for before it.
   * @template T
   * @param {(db: StoreDb) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serial(fn) {
    const run = tail.then(() => open()).then(fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** @param {ChatChange} change */
  function deliver(change) {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (err) {
        console.error('[starpi] a chat change listener failed', err);
      }
    }
  }

  /** @param {ChatChange[]} changes */
  function emit(...changes) {
    for (const change of changes) {
      deliver(change);
      try {
        channel?.postMessage(change);
      } catch {
        // A closed channel only stops the other tabs from hearing about it.
      }
    }
  }

  /**
   * @param {ConversationInput} input
   * @returns {ConversationRecord}
   */
  function buildConversation(input) {
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : stamp();
    /** @type {ConversationRecord} */
    const record = {
      id: input.id ?? `starpi_${uuid()}`,
      title: cleanTitle(input.title),
      createdAt,
      updatedAt: Number.isFinite(input.updatedAt) ? Math.max(Number(input.updatedAt), createdAt) : createdAt,
      pinned: input.pinned ? 1 : 0,
      archived: input.archived ? 1 : 0,
      activeLeafId: null,
      model: typeof input.model === 'string' ? input.model : null,
      mode: input.mode && MODES.has(input.mode) ? input.mode : 'auto',
    };
    if (typeof input.projectId === 'string' && input.projectId) record.projectId = input.projectId;
    if (typeof input.assistantId === 'string' && input.assistantId) record.assistantId = input.assistantId;
    return record;
  }

  /**
   * @param {string} conversationId
   * @param {string | null} parentId
   * @param {NodeInput} input
   * @returns {NodeRecord}
   */
  function buildNode(conversationId, parentId, input) {
    /** @type {NodeRecord} */
    const node = {
      id: typeof input.id === 'string' && input.id ? input.id : uuid(),
      conversationId,
      parentId,
      role: input.role,
      parts: input.parts,
      opaque: input.opaque ?? [],
      model: typeof input.model === 'string' ? input.model : null,
      provider: typeof input.provider === 'string' ? input.provider : null,
      label: typeof input.label === 'string' ? input.label : null,
      usage: input.usage ?? null,
      localOnly: input.localOnly === true,
      createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : stamp(),
    };
    if (input.grounding !== undefined) node.grounding = input.grounding;
    if (typeof input.receiptId === 'string') node.receiptId = input.receiptId;
    if (Array.isArray(input.sources)) node.sources = input.sources;
    if (isRecord(input.meta) && Object.keys(input.meta).length > 0) node.meta = input.meta;
    return node;
  }

  /**
   * Adds a node inside a transaction over conversations and nodes. `add` (not `put`) refuses an id
   * that exists, so a stored message is never replaced.
   * @param {StoreOps} tx
   * @param {ConversationRecord} conversation
   * @param {NodeInput} input
   * @param {{ activate?: boolean, autoTitle?: boolean }} opts
   */
  async function addNode(tx, conversation, input, opts) {
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = /** @type {NodeRecord | undefined} */ (await tx.get('nodes', parentId));
      if (!parent || parent.conversationId !== conversation.id) throw new StoreError('data', 'The parent message is not part of this conversation');
    }
    const node = buildNode(conversation.id, parentId, input);
    await tx.add('nodes', node);
    /** @type {ConversationRecord} */
    const updated = { ...conversation, updatedAt: Math.max(conversation.updatedAt, node.createdAt) };
    if (opts.activate !== false) updated.activeLeafId = node.id;
    if (!updated.title && node.role === 'user' && opts.autoTitle !== false) updated.title = titleFromText(nodeText(node));
    await tx.put('conversations', updated);
    return { node, conversation: updated };
  }

  /** @param {NodeRecord} node @param {ConversationRecord} conversation */
  function emitAppend(node, conversation) {
    emit({ kind: 'node', op: 'put', id: node.id, conversationId: node.conversationId }, { kind: 'conversation', op: 'put', id: conversation.id });
  }

  /**
   * @param {StoreOps} tx
   * @param {string} id
   * @returns {Promise<ConversationRecord>}
   */
  async function mustGetConversation(tx, id) {
    const conversation = await tx.get('conversations', id);
    if (!conversation) throw new StoreError('not_found', 'No such conversation');
    return conversation;
  }

  const store = {
    /**
     * @param {ConversationInput} [input]
     * @returns {Promise<ConversationRecord>}
     */
    createConversation(input = {}) {
      return serial(async (db) => {
        const record = buildConversation(input);
        await db.add('conversations', record);
        emit({ kind: 'conversation', op: 'put', id: record.id });
        return record;
      });
    },

    /**
     * @param {string} id
     * @returns {Promise<ConversationRecord | undefined>}
     */
    getConversation(id) {
      return serial((db) => db.get('conversations', id));
    },

    /**
     * Conversations for the list: pinned first, then the most recently used.
     * @param {{ includeArchived?: boolean }} [opts]
     * @returns {Promise<ConversationRecord[]>}
     */
    listConversations(opts = {}) {
      return serial(async (db) => {
        /** @type {ConversationRecord[]} */
        const all = await db.getAll('conversations');
        return all.filter((c) => opts.includeArchived || !c.archived).sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      });
    },

    /**
     * Changes the title, flags, project, assistant, model or mode. Browsing and renaming do not
     * move a conversation in the list; only new messages do.
     * @param {string} id
     * @param {ConversationPatch} patch
     * @returns {Promise<ConversationRecord>}
     */
    updateConversation(id, patch) {
      const keys = Object.keys(patch ?? {});
      const bad = keys.find((k) => !PATCHABLE.has(k));
      if (bad) return Promise.reject(new StoreError('data', `"${bad}" cannot be changed this way`));
      if (patch.mode !== undefined && !MODES.has(patch.mode)) return Promise.reject(new StoreError('data', `Unknown mode "${patch.mode}"`));
      return serial(async (db) => {
        const updated = await db.transaction('conversations', 'readwrite', async (tx) => {
          const record = { ...(await mustGetConversation(tx, id)) };
          if (patch.title !== undefined) record.title = cleanTitle(patch.title);
          if (patch.pinned !== undefined) record.pinned = patch.pinned ? 1 : 0;
          if (patch.archived !== undefined) record.archived = patch.archived ? 1 : 0;
          if (patch.model !== undefined) record.model = typeof patch.model === 'string' ? patch.model : null;
          if (patch.mode !== undefined) record.mode = patch.mode;
          for (const key of /** @type {const} */ (['projectId', 'assistantId'])) {
            if (!(key in patch)) continue;
            const value = patch[key];
            if (typeof value === 'string' && value) record[key] = value;
            else delete record[key];
          }
          await tx.put('conversations', record);
          return record;
        });
        emit({ kind: 'conversation', op: 'put', id });
        return updated;
      });
    },

    /**
     * Deletes a conversation with its messages, their attachments and its artifacts.
     * @param {string} id
     * @returns {Promise<boolean>} false when there was no such conversation
     */
    deleteConversation(id) {
      return serial(async (db) => {
        const existed = await db.transaction(['conversations', 'nodes', 'blobs', 'artifacts'], 'readwrite', async (tx) => {
          const found = Boolean(await tx.get('conversations', id));
          const nodeIds = await tx.getAllKeysFromIndex('nodes', 'conversationId', id);
          const owners = new Set([id, ...nodeIds.map(String)]);
          /** @type {import('../store/idb.js').Key[]} */
          const blobIds = [];
          await tx.iterate('blobs', {}, (value, key) => {
            if (isRecord(value) && typeof value.ownerId === 'string' && owners.has(value.ownerId)) blobIds.push(key);
          });
          const artifactIds = await tx.getAllKeysFromIndex('artifacts', 'conversationId', id);
          await Promise.all([
            tx.delete('conversations', id),
            ...nodeIds.map((k) => tx.delete('nodes', k)),
            ...blobIds.map((k) => tx.delete('blobs', k)),
            ...artifactIds.map((k) => tx.delete('artifacts', k)),
          ]);
          return found || nodeIds.length > 0;
        });
        emit({ kind: 'conversation', op: 'delete', id });
        return existed;
      });
    },

    /**
     * Deletes every conversation, message, chat attachment and artifact on this device.
     * @returns {Promise<void>}
     */
    clearConversations() {
      return serial(async (db) => {
        await db.transaction(['conversations', 'nodes', 'blobs', 'artifacts'], 'readwrite', async (tx) => {
          /** @type {import('../store/idb.js').Key[]} */
          const blobIds = [];
          await tx.iterate('blobs', {}, (value, key) => {
            if (isRecord(value) && typeof value.kind === 'string' && CHAT_BLOB_KINDS.has(value.kind)) blobIds.push(key);
          });
          await Promise.all([tx.clear('conversations'), tx.clear('nodes'), tx.clear('artifacts'), ...blobIds.map((k) => tx.delete('blobs', k))]);
        });
        emit({ kind: 'all' });
      });
    },

    /**
     * Appends a message under `input.parentId` and, unless `opts.activate` is false, makes it the
     * active leaf.
     * @param {string} conversationId
     * @param {NodeInput} input
     * @param {{ activate?: boolean, autoTitle?: boolean }} [opts]
     * @returns {Promise<NodeRecord>}
     */
    appendNode(conversationId, input, opts = {}) {
      try {
        checkNodeInput(input);
      } catch (err) {
        return Promise.reject(err);
      }
      return serial(async (db) => {
        const { node, conversation } = await db.transaction(['conversations', 'nodes'], 'readwrite', async (tx) => addNode(tx, await mustGetConversation(tx, conversationId), input, opts));
        emitAppend(node, conversation);
        return node;
      });
    },

    /**
     * Continues the active thread: appends under the active leaf. With `opts.create`, a missing
     * conversation is created first (with that id), in the same transaction.
     * @param {string} conversationId
     * @param {Omit<NodeInput, 'parentId'>} input
     * @param {{ create?: Omit<ConversationInput, 'id'>, autoTitle?: boolean }} [opts]
     * @returns {Promise<NodeRecord>}
     */
    appendToActive(conversationId, input, opts = {}) {
      const full = /** @type {NodeInput} */ ({ ...input, parentId: null });
      try {
        checkNodeInput(full);
      } catch (err) {
        return Promise.reject(err);
      }
      return serial(async (db) => {
        const result = await db.transaction(['conversations', 'nodes'], 'readwrite', async (tx) => {
          /** @type {ConversationRecord | undefined} */
          let conversation = await tx.get('conversations', conversationId);
          if (!conversation) {
            if (!opts.create) throw new StoreError('not_found', 'No such conversation');
            conversation = buildConversation({ ...opts.create, id: conversationId });
            await tx.add('conversations', conversation);
          }
          const leaf = conversation.activeLeafId ? await tx.get('nodes', conversation.activeLeafId) : undefined;
          return addNode(tx, conversation, { ...full, parentId: leaf ? conversation.activeLeafId : null }, { autoTitle: opts.autoTitle });
        });
        emitAppend(result.node, result.conversation);
        return result.node;
      });
    },

    /**
     * Appends a sibling of a node (same parent): an edited question or a regenerated answer. It
     * becomes the active leaf.
     * @param {string} nodeId
     * @param {Omit<NodeInput, 'parentId'>} input
     * @returns {Promise<NodeRecord>}
     */
    addSibling(nodeId, input) {
      return serial((db) => db.get('nodes', nodeId)).then((/** @type {NodeRecord | undefined} */ node) => {
        if (!node) throw new StoreError('not_found', 'No such message');
        return store.appendNode(node.conversationId, { ...input, parentId: node.parentId });
      });
    },

    /**
     * Shows another branch: makes a node of the conversation its active leaf.
     * @param {string} conversationId
     * @param {string} nodeId
     * @returns {Promise<ConversationRecord>}
     */
    setActiveLeaf(conversationId, nodeId) {
      return serial(async (db) => {
        const updated = await db.transaction(['conversations', 'nodes'], 'readwrite', async (tx) => {
          const conversation = await mustGetConversation(tx, conversationId);
          const node = /** @type {NodeRecord | undefined} */ (await tx.get('nodes', nodeId));
          if (!node || node.conversationId !== conversationId) throw new StoreError('data', 'The message is not part of this conversation');
          const record = { ...conversation, activeLeafId: nodeId };
          await tx.put('conversations', record);
          return record;
        });
        emit({ kind: 'conversation', op: 'put', id: conversationId });
        return updated;
      });
    },

    /**
     * Attaches metadata to a stored message. Its parts, provider state, role and place in the tree
     * cannot change.
     * @param {string} nodeId
     * @param {Partial<NodeAnnotation>} patch
     * @returns {Promise<NodeRecord>}
     */
    annotateNode(nodeId, patch) {
      const bad = Object.keys(patch ?? {}).find((k) => !ANNOTATIONS.has(k));
      if (bad) return Promise.reject(new StoreError('data', `"${bad}" of a stored message cannot change`));
      return serial(async (db) => {
        const updated = await db.transaction('nodes', 'readwrite', async (tx) => {
          const node = /** @type {NodeRecord | undefined} */ (await tx.get('nodes', nodeId));
          if (!node) throw new StoreError('not_found', 'No such message');
          const { meta, ...rest } = patch;
          /** @type {NodeRecord} */
          const record = { ...node, ...rest };
          if (isRecord(meta)) record.meta = { ...node.meta, ...meta };
          await tx.put('nodes', record);
          return record;
        });
        emit({ kind: 'node', op: 'put', id: nodeId, conversationId: updated.conversationId });
        return updated;
      });
    },

    /**
     * @param {string} id
     * @returns {Promise<NodeRecord | undefined>}
     */
    getNode(id) {
      return serial((db) => db.get('nodes', id));
    },

    /**
     * Every message of a conversation, in no particular order (see tree.js).
     * @param {string} conversationId
     * @returns {Promise<NodeRecord[]>}
     */
    getNodes(conversationId) {
      return serial((db) => db.getAllFromIndex('nodes', 'conversationId', conversationId));
    },

    /**
     * A conversation with its tree and the active thread.
     * @param {string} conversationId
     * @returns {Promise<Thread | null>}
     */
    loadThread(conversationId) {
      return serial(async (db) => {
        const [conversation, nodes] = await db.transaction(['conversations', 'nodes'], 'readonly', (tx) =>
          Promise.all([tx.get('conversations', conversationId), tx.getAllFromIndex('nodes', 'conversationId', conversationId)]),
        );
        if (!conversation) return null;
        const tree = indexNodes(nodes);
        return { conversation, nodes, tree, path: activePath(tree, conversation.activeLeafId) };
      });
    },

    /**
     * The first question of every conversation (its earliest user message), for search.
     * @returns {Promise<Map<string, string>>}
     */
    firstUserTurns() {
      return serial(async (db) => {
        /** @type {Map<string, NodeRecord>} */
        const first = new Map();
        await db.iterate('nodes', {}, (value) => {
          const node = /** @type {NodeRecord} */ (value);
          if (node?.role !== 'user') return;
          const known = first.get(node.conversationId);
          if (!known || node.createdAt < known.createdAt) first.set(node.conversationId, node);
        });
        return new Map([...first].map(([id, node]) => [id, nodeText(node).slice(0, FIRST_TURN_CHARS)]));
      });
    },

    /**
     * The first question of one conversation.
     * @param {string} conversationId
     * @returns {Promise<string>}
     */
    async firstUserTurn(conversationId) {
      const nodes = await store.getNodes(conversationId);
      const first = nodes.filter((n) => n.role === 'user').sort((a, b) => a.createdAt - b.createdAt)[0];
      return first ? nodeText(first).slice(0, FIRST_TURN_CHARS) : '';
    },

    /**
     * Stores an imported conversation under fresh ids (an import never replaces what is here).
     * Parents that are not part of the import make their nodes roots.
     * @param {{ conversation: ConversationInput & { activeLeafId?: string | null }, nodes: NodeInput[] }} data
     * @returns {Promise<ConversationRecord>}
     */
    importConversation(data) {
      try {
        for (const node of data.nodes) checkNodeInput(node);
      } catch (err) {
        return Promise.reject(err);
      }
      const oldIds = data.nodes.map((n) => n.id ?? uuid());
      const ids = new Map(oldIds.map((id) => [id, uuid()]));
      if (ids.size !== oldIds.length) return Promise.reject(new StoreError('data', 'Two imported messages have the same id'));
      return serial(async (db) => {
        // The import never brings its own conversation id.
        const conversation = buildConversation({ ...data.conversation, id: undefined });
        const nodes = data.nodes.map((n, i) => {
          const parent = n.parentId !== null && ids.has(n.parentId) ? /** @type {string} */ (ids.get(n.parentId)) : null;
          return buildNode(conversation.id, parent, { ...n, id: ids.get(oldIds[i]), createdAt: Number.isFinite(n.createdAt) ? n.createdAt : conversation.createdAt });
        });
        const leaf = data.conversation.activeLeafId ? ids.get(data.conversation.activeLeafId) : undefined;
        conversation.activeLeafId = leaf ?? activePath(indexNodes(nodes), null).at(-1)?.id ?? null;
        if (!conversation.title) {
          const first = nodes.filter((n) => n.role === 'user').sort((a, b) => a.createdAt - b.createdAt)[0];
          if (first) conversation.title = titleFromText(nodeText(first));
        }
        await db.transaction(['conversations', 'nodes'], 'readwrite', async (tx) => {
          await tx.add('conversations', conversation);
          await Promise.all(nodes.map((n) => tx.add('nodes', n)));
        });
        emit({ kind: 'conversation', op: 'put', id: conversation.id });
        return conversation;
      });
    },

    /**
     * Projects to move a conversation into (empty until projects exist).
     * @returns {Promise<Array<{ id: string, name: string }>>}
     */
    listProjects() {
      return serial(async (db) => {
        if (!db.storeNames().includes('projects')) return [];
        /** @type {Array<Record<string, unknown>>} */
        const all = await db.getAll('projects');
        return all
          .filter((p) => typeof p.id === 'string' && typeof p.name === 'string')
          .map((p) => ({ id: String(p.id), name: String(p.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      });
    },

    /**
     * Stores an attachment (or its thumbnail) and returns its id, for a part's `blobId`.
     * @param {Blob} data
     * @param {{ kind?: 'attachment' | 'thumbnail', name?: string, ownerId?: string }} [opts]
     * @returns {Promise<string>}
     */
    putBlob(data, opts = {}) {
      return serial(async (db) => {
        /** @type {BlobRecord} */
        const record = { id: uuid(), data, type: data.type || 'application/octet-stream', size: data.size, kind: opts.kind ?? 'attachment', createdAt: stamp() };
        if (opts.name) record.name = opts.name;
        if (opts.ownerId) record.ownerId = opts.ownerId;
        await db.add('blobs', record);
        return record.id;
      });
    },

    /**
     * @param {string} id
     * @returns {Promise<BlobRecord | undefined>}
     */
    getBlob(id) {
      return serial((db) => db.get('blobs', id));
    },

    /**
     * Listens to changes made here and in other tabs.
     * @param {(change: ChatChange) => void} listener
     * @returns {() => void} stops listening
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Tells the listeners about a change made outside this store (e.g. a migration).
     * @param {ChatChange} change
     */
    notify(change) {
      emit(change);
    },

    /** Stops the change channel between tabs. */
    close() {
      channel?.close();
      channel = null;
    },
  };
  return store;
}

/** @typedef {ReturnType<typeof createChatStore>} ChatStore */

/** @type {ChatStore | null} */
let shared = null;
/** @type {Promise<ChatStore> | null} */
let ready = null;

/**
 * The page's chat store on the app database, without waiting for the migrations.
 * @returns {ChatStore}
 */
export function chatStore() {
  shared ??= createChatStore({ channel: `${storeProfileName()}-chat` });
  return shared;
}

/**
 * The page's chat store once the one-time data migrations ran (the 2.x chats are conversations by
 * then). The migrations load on demand; when they cannot run, the store still opens and they are
 * tried again on the next start.
 * @returns {Promise<ChatStore>}
 */
export function openChatStore() {
  ready ??= (async () => {
    const store = chatStore();
    try {
      const { runStartupMigrations } = await import('./migrate-v1.js');
      const { importedChats } = await runStartupMigrations();
      if (importedChats > 0) store.notify({ kind: 'all' });
    } catch (err) {
      console.warn('[starpi] the stored data could not be migrated now; it is tried again on the next start', err);
    }
    return store;
  })();
  return ready;
}
