// @ts-check
// What a synced conversation is, how two versions of one merge, and how a merged version is written
// into the conversation store (chat/store.js).
//
// A record is either a conversation or a deletion marker:
//   { v: 1, kind: 'conversation', id, conversation: { title, createdAt, pinned, archived, model,
//     mode, activeLeafId }, nodes: [ … ] }
//   { v: 1, kind: 'deleted', id, deletedAt }
//
// What never goes into a record
// - Turns marked localOnly (on-device answers, turns that used files on this device). A synced turn
//   whose parent is local-only hangs under its nearest synced ancestor instead, the active leaf moves
//   up the same way, and a title made from a local-only question is replaced by one made from the
//   first synced question.
// - Project and assistant links (those records stay on the device), attachments (blobs), receipts,
//   provider keys and signing keys: the record is built from a field allowlist of conversations and
//   messages, and nothing else is read.
//
// Merging (last writer wins per conversation, by revision)
// - Messages are append-only and never change, so two versions merge without loss: the union of
//   their messages; metadata attached later is filled in where one side lacks it.
// - Conversation fields (title, flags, model, mode, active leaf): a field this device changed since
//   the revision it last synced is kept (this device writes the merged version next, as the newest
//   revision); every other field comes from the newer remote revision.
import { indexNodes, nodeText, pathTo } from '../chat/tree.js';
import { titleFromText } from '../chat/store.js';

/** @typedef {import('../store/schema.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../chat/store.js').ChatStore} ChatStore */

/**
 * The synced fields of a conversation.
 * @typedef {object} SyncedConversation
 * @property {string} title
 * @property {number} createdAt
 * @property {0 | 1} pinned
 * @property {0 | 1} archived
 * @property {string | null} model
 * @property {'grounded' | 'free' | 'auto'} mode
 * @property {string | null} activeLeafId
 */

/**
 * A synced message: the node fields from the allowlist (never localOnly, never a blob).
 * @typedef {object} SyncedNode
 * @property {string} id
 * @property {string | null} parentId
 * @property {NodeRecord['role']} role
 * @property {NodeRecord['parts']} parts
 * @property {unknown[]} opaque
 * @property {string | null} model
 * @property {string | null} provider
 * @property {string | null} label
 * @property {NodeRecord['usage']} usage
 * @property {number} createdAt
 * @property {unknown} [grounding]
 * @property {string} [receiptId]
 * @property {NodeRecord['sources']} [sources]
 * @property {Record<string, unknown>} [meta]
 */

/** @typedef {{ v: 1, kind: 'conversation', id: string, conversation: SyncedConversation, nodes: SyncedNode[] }} ConversationPayload */
/** @typedef {{ v: 1, kind: 'deleted', id: string, deletedAt: number }} DeletedPayload */
/** @typedef {ConversationPayload | DeletedPayload} SyncRecord */

/** The conversation fields that merge one by one. */
export const META_FIELDS = /** @type {const} */ (['title', 'pinned', 'archived', 'model', 'mode', 'activeLeafId']);
/** @typedef {Pick<SyncedConversation, typeof META_FIELDS[number]>} SyncedMeta */

/** Metadata a stored message may get later (chat/store.js annotateNode). */
const LATE_FIELDS = /** @type {const} */ (['grounding', 'receiptId', 'usage', 'sources', 'label', 'meta']);
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MODES = new Set(['grounded', 'free', 'auto']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * JSON with sorted object keys, so equal content always gives the same text (and hash).
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, v) => (isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

/**
 * The synced form of a stored message (allowlist).
 * @param {NodeRecord} node
 * @param {string | null} parentId
 * @returns {SyncedNode}
 */
function syncedNode(node, parentId) {
  /** @type {SyncedNode} */
  const out = {
    id: node.id,
    parentId,
    role: node.role,
    parts: node.parts,
    opaque: Array.isArray(node.opaque) ? node.opaque : [],
    model: node.model ?? null,
    provider: node.provider ?? null,
    label: node.label ?? null,
    usage: node.usage ?? null,
    createdAt: node.createdAt,
  };
  if (node.grounding !== undefined) out.grounding = node.grounding;
  if (typeof node.receiptId === 'string') out.receiptId = node.receiptId;
  if (Array.isArray(node.sources)) out.sources = node.sources;
  if (isRecord(node.meta) && Object.keys(node.meta).length > 0) out.meta = node.meta;
  return out;
}

/**
 * The record of a stored conversation, or null when it has nothing to sync (no message, or only
 * local-only ones).
 * @param {ConversationRecord} conversation
 * @param {NodeRecord[]} nodes
 * @returns {ConversationPayload | null}
 */
export function buildPayload(conversation, nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = nodes.filter((n) => n.localOnly !== true);
  if (kept.length === 0) return null;
  const keptIds = new Set(kept.map((n) => n.id));
  /**
   * The nearest synced node at or above `id` (null at the root).
   * @param {string | null | undefined} id
   */
  const syncedAncestor = (id) => {
    const seen = new Set();
    let at = id ?? null;
    while (at !== null && !keptIds.has(at)) {
      const node = byId.get(at);
      if (!node || seen.has(at)) return null;
      seen.add(at);
      at = node.parentId;
    }
    return at;
  };
  const out = kept.map((n) => syncedNode(n, syncedAncestor(n.parentId))).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // A title made from a local-only question would carry that question to the server.
  let title = conversation.title ?? '';
  const localQuestion = nodes.some((n) => n.localOnly === true && n.role === 'user' && title !== '' && titleFromText(nodeText(n)) === title);
  if (localQuestion) {
    const first = kept.filter((n) => n.role === 'user').sort((a, b) => a.createdAt - b.createdAt)[0];
    title = first ? titleFromText(nodeText(first)) : '';
  }
  return {
    v: 1,
    kind: 'conversation',
    id: conversation.id,
    conversation: {
      title,
      createdAt: conversation.createdAt,
      pinned: conversation.pinned ? 1 : 0,
      archived: conversation.archived ? 1 : 0,
      model: typeof conversation.model === 'string' ? conversation.model : null,
      mode: MODES.has(conversation.mode) ? conversation.mode : 'auto',
      activeLeafId: syncedAncestor(conversation.activeLeafId),
    },
    nodes: out,
  };
}

/**
 * @param {string} id
 * @param {number} at
 * @returns {DeletedPayload}
 */
export function deletedPayload(id, at) {
  return { v: 1, kind: 'deleted', id, deletedAt: at };
}

/**
 * @param {ConversationPayload} payload
 * @returns {SyncedMeta}
 */
export function metaOf(payload) {
  const c = payload.conversation;
  return { title: c.title, pinned: c.pinned, archived: c.archived, model: c.model, mode: c.mode, activeLeafId: c.activeLeafId };
}

/**
 * Checks a decrypted record. It was made by a browser holding the sync key, but may come from a
 * newer or broken version; the store refuses what it cannot keep, this refuses what would confuse
 * the merge.
 * @param {unknown} value
 * @returns {value is SyncRecord}
 */
export function isSyncRecord(value) {
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== 'string' || !value.id) return false;
  if (value.kind === 'deleted') return Number.isFinite(value.deletedAt);
  if (value.kind !== 'conversation' || !isRecord(value.conversation) || !Array.isArray(value.nodes)) return false;
  const c = value.conversation;
  if (typeof c.title !== 'string' || !Number.isFinite(c.createdAt) || !MODES.has(/** @type {string} */ (c.mode))) return false;
  if (c.activeLeafId !== null && typeof c.activeLeafId !== 'string') return false;
  const ids = new Set();
  for (const n of value.nodes) {
    if (!isRecord(n) || typeof n.id !== 'string' || !n.id || ids.has(n.id)) return false;
    if (!ROLES.has(/** @type {string} */ (n.role)) || !Array.isArray(n.parts) || !Number.isFinite(n.createdAt)) return false;
    if (n.parentId !== null && typeof n.parentId !== 'string') return false;
    ids.add(n.id);
  }
  return true;
}

/**
 * Merges a newer remote version into the local one (see the file comment). `base` is the metadata
 * of the revision this device last synced, or null when local fields have no claim (no local
 * change, or no common revision).
 * @param {ConversationPayload | null} local
 * @param {ConversationPayload} remote
 * @param {SyncedMeta | null} base
 * @returns {ConversationPayload}
 */
export function mergePayloads(local, remote, base) {
  if (!local) return remote;
  /** @type {Map<string, SyncedNode>} */
  const nodes = new Map(remote.nodes.map((n) => [n.id, n]));
  for (const mine of local.nodes) {
    const theirs = nodes.get(mine.id);
    if (!theirs) {
      nodes.set(mine.id, mine);
      continue;
    }
    // The message itself is the same on both sides; metadata attached later is filled in.
    /** @type {SyncedNode} */
    const merged = { ...mine };
    for (const field of LATE_FIELDS) {
      const have = mine[field];
      if ((have === undefined || have === null) && theirs[field] !== undefined && theirs[field] !== null) /** @type {Record<string, unknown>} */ (merged)[field] = theirs[field];
    }
    nodes.set(mine.id, merged);
  }
  /** @type {SyncedConversation} */
  const conversation = { ...remote.conversation, createdAt: Math.min(local.conversation.createdAt, remote.conversation.createdAt) };
  if (base) {
    for (const field of META_FIELDS) {
      if (local.conversation[field] !== base[field]) /** @type {Record<string, unknown>} */ (conversation)[field] = local.conversation[field];
    }
  }
  if (conversation.activeLeafId !== null && !nodes.has(conversation.activeLeafId)) conversation.activeLeafId = remote.conversation.activeLeafId;
  return { v: 1, kind: 'conversation', id: remote.id, conversation, nodes: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

/**
 * Messages in an order where every parent comes before its children; a parent that is not part of
 * the list makes its children roots.
 * @param {SyncedNode[]} nodes
 * @param {Set<string>} present  ids already stored
 */
function parentsFirst(nodes, present) {
  const ids = new Set(nodes.map((n) => n.id));
  /** @type {Array<SyncedNode & { parentId: string | null }>} */
  const order = [];
  const placed = new Set(present);
  let pending = nodes.filter((n) => !present.has(n.id));
  while (pending.length > 0) {
    const next = [];
    for (const n of pending) {
      const parent = n.parentId !== null && (ids.has(n.parentId) || present.has(n.parentId)) ? n.parentId : null;
      if (parent === null || placed.has(parent)) {
        order.push({ ...n, parentId: parent });
        placed.add(n.id);
      } else {
        next.push(n);
      }
    }
    // A cycle cannot be placed; its messages become roots.
    if (next.length === pending.length) {
      for (const n of next) {
        order.push({ ...n, parentId: null });
        placed.add(n.id);
      }
      break;
    }
    pending = next;
  }
  return order;
}

/**
 * Writes a merged version into the store, so that the local record (buildPayload) equals it:
 * creates the conversation or adds the messages it lacks, fills metadata in, and sets the changed
 * conversation fields. Local-only messages stay as they are; a local active leaf below the synced
 * leaf (a local-only turn) is kept.
 * @param {ChatStore} store
 * @param {ConversationPayload} target
 * @param {ConversationPayload | null} local  buildPayload of the stored conversation, if any
 */
export async function applyPayload(store, target, local) {
  const c = target.conversation;
  let conversation = await store.getConversation(target.id);
  if (!conversation) {
    conversation = await store.createConversation({ id: target.id, title: c.title, createdAt: c.createdAt, pinned: c.pinned === 1, archived: c.archived === 1, model: c.model, mode: c.mode });
  }
  const stored = await store.getNodes(target.id);
  const present = new Set(stored.map((n) => n.id));
  for (const n of parentsFirst(target.nodes, present)) {
    const { id, parentId, role, parts, opaque, model, provider, label, usage, createdAt, grounding, receiptId, sources, meta } = n;
    /** @type {import('../chat/store.js').NodeInput} */
    const input = { id, parentId, role, parts, opaque, model, provider, label, usage, createdAt, localOnly: false };
    if (grounding !== undefined) input.grounding = grounding;
    if (typeof receiptId === 'string') input.receiptId = receiptId;
    if (Array.isArray(sources)) input.sources = sources;
    if (isRecord(meta)) input.meta = meta;
    await store.appendNode(target.id, input, { activate: false, autoTitle: false });
  }
  const mine = new Map((local?.nodes ?? []).map((n) => [n.id, n]));
  for (const n of target.nodes) {
    const have = mine.get(n.id);
    if (!have) continue;
    /** @type {Record<string, unknown>} */
    const patch = {};
    for (const field of LATE_FIELDS) {
      if ((have[field] === undefined || have[field] === null) && n[field] !== undefined && n[field] !== null) patch[field] = n[field];
    }
    if (Object.keys(patch).length > 0) await store.annotateNode(n.id, /** @type {Partial<import('../chat/store.js').NodeAnnotation>} */ (patch));
  }
  // Compared with the synced view of the conversation (its title may differ from the stored one
  // when that came from a local-only question), or with the stored record when nothing synced yet.
  /** @type {Pick<SyncedConversation, 'title' | 'pinned' | 'archived' | 'model' | 'mode'>} */
  const was = local?.conversation ?? { title: conversation.title, pinned: conversation.pinned, archived: conversation.archived, model: conversation.model, mode: conversation.mode };
  /** @type {import('../chat/store.js').ConversationPatch} */
  const patch = {};
  if (was.title !== c.title) patch.title = c.title;
  if (was.pinned !== c.pinned) patch.pinned = c.pinned === 1;
  if (was.archived !== c.archived) patch.archived = c.archived === 1;
  if (was.model !== c.model) patch.model = c.model;
  if (was.mode !== c.mode) patch.mode = c.mode;
  if (Object.keys(patch).length > 0) await store.updateConversation(target.id, patch);
  if (c.activeLeafId && local?.conversation.activeLeafId !== c.activeLeafId) {
    const current = await store.getConversation(target.id);
    const all = await store.getNodes(target.id);
    const leaf = all.find((n) => n.id === current?.activeLeafId);
    // A local-only turn shown below the synced leaf stays shown.
    const keep = leaf?.localOnly === true && pathTo(indexNodes(all), leaf.id).some((n) => n.id === c.activeLeafId);
    if (!keep) await store.setActiveLeaf(target.id, c.activeLeafId);
  }
}
