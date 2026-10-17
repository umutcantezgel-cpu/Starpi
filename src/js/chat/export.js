// @ts-check
// Chat export and import formats, pure, so they are pinned by unit tests.
//
// - `starpi.chat/v2` (current): the whole message tree of a conversation — every node with its
//   parent, role, content parts, model, provider and answer label — plus the active path. Attached
//   files appear as metadata (name, type, size); their bytes stay on the device. Internal fields
//   (which turns stay on the device, project and receipt references) and anything that looks like a
//   credential are never written.
// - `starpi.chat/v1` (2.x): the messages on screen as a flat list. Still written by chatToJson for
//   older callers and still readable.
// - Markdown: the active path, one heading per speaker.
//
// parseChatImport reads both JSON versions into records for ChatStore.importConversation.
import { activePath, indexNodes, nodeText } from './tree.js';

/** @typedef {import('../store/schema.js').ConversationRecord} ConversationRecord */
/** @typedef {import('../store/schema.js').NodeRecord} NodeRecord */
/** @typedef {import('../store/schema.js').StoredPart} StoredPart */
/** @typedef {import('./store.js').NodeInput} NodeInput */
/** @typedef {import('./store.js').ConversationInput} ConversationInput */

export const CHAT_EXPORT_V1 = 'starpi.chat/v1';
export const CHAT_EXPORT_V2 = 'starpi.chat/v2';

/** An import larger than this is refused before it is parsed. */
export const IMPORT_MAX_CHARS = 20 * 1024 * 1024;
/** At most this many messages per imported conversation. */
export const IMPORT_MAX_NODES = 5000;

/**
 * One message as exported in v1 and in Markdown. Internal fields of the conversation (such as which
 * turns stay on the device) are never part of an export.
 * @typedef {object} ExportTurn
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {string | null} createdAt  ISO time
 * @property {string | null} engine     engine id of an answer (cloud, client, wasm, local, synthesizer)
 * @property {string | null} model      model id, when one was recorded
 * @property {'free' | 'grounded' | null} chatMode
 */

/** @typedef {{ exportedAt: string, version: string, locale: string }} ExportMeta */

/**
 * The conversation as v1 JSON (2.x format).
 * @param {ExportTurn[]} turns
 * @param {{ sessionId: string, exportedAt: string, version: string, locale: string }} meta
 * @returns {string}
 */
export function chatToJson(turns, meta) {
  const messages = turns.map(({ role, content, createdAt, engine, model, chatMode }) => ({ role, content, createdAt, engine, model, chatMode }));
  const doc = {
    schema: CHAT_EXPORT_V1,
    generator: { name: 'starpi', version: meta.version },
    sessionId: meta.sessionId,
    exportedAt: meta.exportedAt,
    locale: meta.locale,
    messages,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Closes a code fence that the text leaves open (an answer cut off mid-code), so the heading of the
 * next message is not swallowed by it.
 * @param {string} text
 */
function closeOpenFence(text) {
  const fences = text.match(/^ {0,3}```/gm) ?? [];
  return fences.length % 2 ? `${text}\n\`\`\`` : text;
}

/**
 * @param {ExportTurn[]} turns
 * @param {{ title: string, subtitle: string, user: string, assistant: (turn: ExportTurn) => string }} labels
 *   `assistant` names the speaker of an answer (e.g. "Starpi · Cloud assistant")
 * @returns {string}
 */
export function chatToMarkdown(turns, labels) {
  const body = turns.map((turn) => `## ${turn.role === 'user' ? labels.user : labels.assistant(turn)}\n\n${closeOpenFence(turn.content.trim())}\n`).join('\n');
  return `# ${labels.title}\n\n_${labels.subtitle}_\n\n${body}`;
}

/**
 * `starpi-chat-<date>-<session>.<ext>`: the export date and the start of the conversation id,
 * reduced to characters every file system accepts.
 * @param {string} sessionId
 * @param {string} exportedAt  ISO time
 * @param {'md' | 'json'} ext
 */
export function exportFileName(sessionId, exportedAt, ext) {
  const date = exportedAt.slice(0, 10).replace(/[^\d-]/g, '');
  const session = sessionId.replace(/^starpi_/, '').replace(/[^\w-]/g, '').slice(0, 8);
  return `starpi-chat-${[date, session].filter(Boolean).join('-')}.${ext}`;
}

// ---------------------------------------------------------------------------------------------
// v2 writer

/** Property names that never leave the device, wherever they appear. */
const SECRET_KEY = /^(api[-_]?key|x-api-key|x-goog-api-key|authorization|password|passphrase|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token)$/i;
/** Part types whose bytes stay on the device; the export keeps their metadata. */
const FILE_PARTS = new Set(['image', 'file']);
/** Fields of a file part that hold its bytes. */
const BYTE_FIELDS = new Set(['data', 'bytes', 'base64']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A deep copy without credential-like fields.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function scrub(value, depth = 0) {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!isRecord(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, v] of Object.entries(value)) if (!SECRET_KEY.test(key)) out[key] = scrub(v, depth + 1);
  return out;
}

/**
 * A part as exported: file and image parts lose their bytes and say so.
 * @param {StoredPart} part
 * @returns {Record<string, unknown>}
 */
function exportPart(part) {
  const clean = /** @type {Record<string, unknown>} */ (scrub(part));
  if (!FILE_PARTS.has(part.type)) return clean;
  let omitted = false;
  for (const field of BYTE_FIELDS) {
    if (field in clean) {
      delete clean[field];
      omitted = true;
    }
  }
  if (typeof clean.url === 'string' && /^(data|blob):/i.test(clean.url)) {
    delete clean.url;
    omitted = true;
  }
  return omitted ? { ...clean, omitted: true } : clean;
}

/**
 * Name, type and size of the files and images a message carries.
 * @param {StoredPart[]} parts
 * @returns {Array<{ type: string, name: string | null, mime: string | null, size: number | null }>}
 */
function attachmentsOf(parts) {
  return parts
    .filter((p) => FILE_PARTS.has(p.type))
    .map((p) => ({
      type: p.type,
      name: typeof p.name === 'string' ? p.name : null,
      mime: typeof p.mime === 'string' ? p.mime : null,
      size: typeof p.size === 'number' ? p.size : typeof p.data === 'string' ? Math.floor((p.data.length * 3) / 4) : null,
    }));
}

/** @param {number} ms */
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @param {NodeRecord} node
 * @returns {Record<string, unknown>}
 */
function exportNode(node) {
  const engine = typeof node.meta?.engine === 'string' ? node.meta.engine : null;
  const attachments = attachmentsOf(node.parts ?? []);
  return {
    id: node.id,
    parentId: node.parentId,
    role: node.role,
    createdAt: iso(node.createdAt),
    parts: (node.parts ?? []).map(exportPart),
    model: node.model ?? null,
    provider: node.provider ?? null,
    label: node.label ?? null,
    ...(engine ? { engine } : {}),
    ...(node.usage ? { usage: scrub(node.usage) } : {}),
    ...(node.sources?.length ? { sources: node.sources.map((s) => ({ title: s.title, ...(s.rank !== undefined ? { rank: s.rank } : {}) })) } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(node.opaque?.length ? { opaque: scrub(node.opaque) } : {}),
  };
}

/**
 * A conversation as a `starpi.chat/v2` document.
 * @param {{ conversation: ConversationRecord, nodes: readonly NodeRecord[] }} thread
 * @param {ExportMeta} meta
 */
export function conversationToV2(thread, meta) {
  const { conversation } = thread;
  const tree = indexNodes(thread.nodes);
  const path = activePath(tree, conversation.activeLeafId);
  const nodes = [...thread.nodes].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: CHAT_EXPORT_V2,
    generator: { name: 'starpi', version: meta.version },
    exportedAt: meta.exportedAt,
    locale: meta.locale,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: iso(conversation.createdAt),
      updatedAt: iso(conversation.updatedAt),
      pinned: Boolean(conversation.pinned),
      model: conversation.model ?? null,
      mode: conversation.mode,
      activeLeafId: path.at(-1)?.id ?? null,
    },
    activePath: path.map((n) => n.id),
    nodes: nodes.map(exportNode),
  };
}

/**
 * @param {{ conversation: ConversationRecord, nodes: readonly NodeRecord[] }} thread
 * @param {ExportMeta} meta
 * @returns {string}
 */
export function chatToJsonV2(thread, meta) {
  return `${JSON.stringify(conversationToV2(thread, meta), null, 2)}\n`;
}

/**
 * The questions and answers of a thread as export turns (for Markdown). An attached file shows as
 * its name in brackets, as the chat shows it.
 * @param {readonly NodeRecord[]} path
 * @returns {ExportTurn[]}
 */
export function pathToTurns(path) {
  /** @type {ExportTurn[]} */
  const turns = [];
  for (const node of path) {
    if (node.role !== 'user' && node.role !== 'assistant') continue;
    const files = attachmentsOf(node.parts ?? [])
      .map((a) => (a.name ? `[${a.name}]` : ''))
      .filter(Boolean);
    const text = [nodeText(node), ...files].filter(Boolean).join('\n\n');
    const mode = node.meta?.chat_mode ?? node.label;
    turns.push({
      role: node.role,
      content: text,
      createdAt: iso(node.createdAt),
      engine: typeof node.meta?.engine === 'string' ? node.meta.engine : null,
      model: node.model ?? null,
      chatMode: mode === 'free' || mode === 'grounded' ? mode : null,
    });
  }
  return turns;
}

/**
 * Turns shown in a chat as a linear thread (when no stored conversation exists).
 * @param {string} id
 * @param {ExportTurn[]} turns
 * @returns {{ conversation: ConversationRecord, nodes: NodeRecord[] }}
 */
export function turnsToThread(id, turns) {
  const at = (/** @type {string | null} */ t) => (t ? Date.parse(t) : Number.NaN);
  const known = turns.map((t) => at(t.createdAt)).find(Number.isFinite) ?? 0;
  /** @type {NodeRecord[]} */
  const nodes = turns.map((turn, i) => ({
    id: `m${i}`,
    conversationId: id,
    parentId: i ? `m${i - 1}` : null,
    role: turn.role,
    parts: [{ type: 'text', text: turn.content }],
    opaque: [],
    model: turn.model,
    provider: null,
    label: turn.role === 'assistant' ? turn.chatMode : null,
    usage: null,
    localOnly: false,
    ...(turn.engine || turn.chatMode ? { meta: { ...(turn.engine ? { engine: turn.engine } : {}), ...(turn.chatMode ? { chat_mode: turn.chatMode } : {}) } } : {}),
    createdAt: Number.isFinite(at(turn.createdAt)) ? at(turn.createdAt) : known + i,
  }));
  const first = turns.find((t) => t.role === 'user');
  const last = turns.findLast((t) => t.chatMode);
  return {
    conversation: {
      id,
      title: first ? first.content.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? '' : '',
      createdAt: nodes[0]?.createdAt ?? known,
      updatedAt: nodes.at(-1)?.createdAt ?? known,
      pinned: 0,
      archived: 0,
      activeLeafId: nodes.at(-1)?.id ?? null,
      model: turns.findLast((t) => t.model)?.model ?? null,
      mode: last?.chatMode ?? 'auto',
    },
    nodes,
  };
}

// ---------------------------------------------------------------------------------------------
// Import

/** Why an import was refused: not JSON, another format, no messages, or a message that is broken. */
export class ChatImportError extends Error {
  /**
   * @param {'too_large' | 'json' | 'schema' | 'empty' | 'invalid'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ChatImportError';
    this.code = code;
  }
}

/**
 * @typedef {object} ParsedImport
 * @property {typeof CHAT_EXPORT_V1 | typeof CHAT_EXPORT_V2} schema
 * @property {ConversationInput & { activeLeafId: string | null }} conversation
 * @property {Array<NodeInput & { id: string }>} nodes
 */

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** @param {unknown} value @returns {number | undefined} */
function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** @param {unknown} value @returns {string | null} */
function str(value) {
  return typeof value === 'string' && value ? value : null;
}

/** @param {unknown} value */
function sourcesOf(value) {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((s) => isRecord(s) && typeof s.title === 'string').map((s) => (typeof s.rank === 'number' || s.rank === null ? { title: String(s.title), rank: s.rank } : { title: String(s.title) }));
  return out.length ? out : undefined;
}

/** @param {unknown} value */
function usageOf(value) {
  if (!isRecord(value) || typeof value.input !== 'number' || typeof value.output !== 'number') return null;
  /** @type {import('../store/schema.js').NodeUsage} */
  const usage = { input: value.input, output: value.output };
  for (const key of /** @type {const} */ (['reasoning', 'cacheRead', 'costUsd'])) if (typeof value[key] === 'number') usage[key] = value[key];
  return usage;
}

/**
 * @param {unknown[]} messages
 * @returns {ParsedImport}
 */
function fromV1(messages) {
  /** @type {Array<NodeInput & { id: string }>} */
  const nodes = [];
  for (const m of messages) {
    if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) continue;
    const chatMode = m.chatMode === 'free' || m.chatMode === 'grounded' ? m.chatMode : null;
    const engine = str(m.engine);
    const meta = { ...(engine ? { engine } : {}), ...(chatMode ? { chat_mode: chatMode } : {}) };
    nodes.push({
      id: `m${nodes.length}`,
      parentId: nodes.length ? nodes[nodes.length - 1].id : null,
      role: m.role,
      parts: [{ type: 'text', text: m.content }],
      model: str(m.model),
      label: m.role === 'assistant' ? chatMode : null,
      localOnly: true,
      ...(Object.keys(meta).length ? { meta } : {}),
      createdAt: timeOf(m.createdAt) ?? timeOf(nodes[nodes.length - 1]?.createdAt),
    });
  }
  const modes = nodes.map((n) => n.meta?.chat_mode).filter((m) => m === 'free' || m === 'grounded');
  return {
    schema: CHAT_EXPORT_V1,
    conversation: { mode: /** @type {'free' | 'grounded' | undefined} */ (modes.at(-1)) ?? 'auto', activeLeafId: nodes.at(-1)?.id ?? null, model: nodes.findLast((n) => n.model)?.model ?? null },
    nodes,
  };
}

/**
 * Drops the parent of every node whose ancestry loops, so the tree has no cycles.
 * @param {Array<NodeInput & { id: string }>} nodes
 */
function breakCycles(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** @type {Map<string, boolean>} */
  const settled = new Map();
  for (const start of nodes) {
    /** @type {string[]} */
    const chain = [];
    const onChain = new Set();
    /** @type {(NodeInput & { id: string }) | undefined} */
    let node = start;
    while (node && !settled.has(node.id)) {
      if (onChain.has(node.id)) {
        node.parentId = null;
        break;
      }
      onChain.add(node.id);
      chain.push(node.id);
      node = node.parentId !== null ? byId.get(node.parentId) : undefined;
    }
    for (const id of chain) settled.set(id, true);
  }
}

/**
 * @param {Record<string, unknown>} doc
 * @returns {ParsedImport}
 */
function fromV2(doc) {
  if (!Array.isArray(doc.nodes)) throw new ChatImportError('schema', 'A v2 chat lists its messages in "nodes"');
  if (doc.nodes.length > IMPORT_MAX_NODES) throw new ChatImportError('too_large', `A chat may have at most ${IMPORT_MAX_NODES} messages`);
  /** @type {Array<NodeInput & { id: string }>} */
  const nodes = [];
  const seen = new Set();
  for (const n of doc.nodes) {
    if (!isRecord(n) || typeof n.id !== 'string' || !n.id || seen.has(n.id)) throw new ChatImportError('invalid', 'Every message needs its own id');
    if (typeof n.role !== 'string' || !ROLES.has(n.role)) throw new ChatImportError('invalid', `Message ${n.id} has an unknown role`);
    if (!Array.isArray(n.parts) || n.parts.some((p) => !isRecord(p) || typeof p.type !== 'string' || !p.type)) throw new ChatImportError('invalid', `Message ${n.id} has broken parts`);
    seen.add(n.id);
    const engine = str(n.engine);
    nodes.push({
      id: n.id,
      parentId: typeof n.parentId === 'string' ? n.parentId : null,
      role: /** @type {NodeRecord['role']} */ (n.role),
      parts: /** @type {StoredPart[]} */ (scrub(n.parts)),
      opaque: Array.isArray(n.opaque) ? /** @type {unknown[]} */ (scrub(n.opaque)) : [],
      model: str(n.model),
      provider: str(n.provider),
      label: str(n.label),
      usage: usageOf(n.usage),
      sources: sourcesOf(n.sources),
      // An imported chat is treated like an on-device one: nothing in it was meant to be resent.
      localOnly: true,
      ...(engine ? { meta: { engine } } : {}),
      createdAt: timeOf(n.createdAt),
    });
  }
  for (const node of nodes) if (node.parentId !== null && !seen.has(node.parentId)) node.parentId = null;
  breakCycles(nodes);
  const c = isRecord(doc.conversation) ? doc.conversation : {};
  const pathEnd = Array.isArray(doc.activePath) ? doc.activePath.at(-1) : null;
  const leaf = [c.activeLeafId, pathEnd].find((id) => typeof id === 'string' && seen.has(id));
  const mode = c.mode === 'free' || c.mode === 'grounded' || c.mode === 'auto' ? c.mode : 'auto';
  return {
    schema: CHAT_EXPORT_V2,
    conversation: {
      title: typeof c.title === 'string' ? c.title : '',
      model: str(c.model),
      mode,
      pinned: c.pinned === true,
      createdAt: timeOf(c.createdAt),
      updatedAt: timeOf(c.updatedAt),
      activeLeafId: typeof leaf === 'string' ? leaf : null,
    },
    nodes,
  };
}

/**
 * Reads an exported chat (v1 or v2). Ids in the file are kept for the tree's structure only; the
 * store gives the conversation fresh ids.
 * @param {string} text
 * @returns {ParsedImport}
 */
export function parseChatImport(text) {
  if (typeof text !== 'string') throw new ChatImportError('json', 'Not a chat export');
  if (text.length > IMPORT_MAX_CHARS) throw new ChatImportError('too_large', 'The file is too large to import');
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ChatImportError('json', 'The file is not JSON');
  }
  if (!isRecord(doc)) throw new ChatImportError('schema', 'Not a chat export');
  /** @type {ParsedImport} */
  let parsed;
  if (doc.schema === CHAT_EXPORT_V2) parsed = fromV2(doc);
  else if (doc.schema === CHAT_EXPORT_V1 && Array.isArray(doc.messages)) {
    if (doc.messages.length > IMPORT_MAX_NODES) throw new ChatImportError('too_large', `A chat may have at most ${IMPORT_MAX_NODES} messages`);
    parsed = fromV1(doc.messages);
  } else throw new ChatImportError('schema', 'Not a starpi.chat/v1 or starpi.chat/v2 export');
  if (parsed.nodes.length === 0) throw new ChatImportError('empty', 'The chat has no messages');
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Stored conversations

/**
 * The file for a stored conversation: v2 JSON, or Markdown of its active path.
 * @param {{ loadThread: (id: string) => Promise<{ conversation: ConversationRecord, nodes: NodeRecord[], path: NodeRecord[] } | null> }} store
 * @param {string} id
 * @param {{ format: 'md' | 'json', meta: ExportMeta, labels?: Parameters<typeof chatToMarkdown>[1] | ((turns: ExportTurn[]) => Parameters<typeof chatToMarkdown>[1]) }} opts
 * @returns {Promise<{ name: string, text: string, type: string } | null>} null when there is no such conversation
 */
export async function exportConversation(store, id, opts) {
  const thread = await store.loadThread(id);
  if (!thread) return null;
  const name = exportFileName(id, opts.meta.exportedAt, opts.format);
  if (opts.format === 'json') return { name, text: chatToJsonV2(thread, opts.meta), type: 'application/json' };
  const turns = pathToTurns(thread.path);
  const labels = typeof opts.labels === 'function' ? opts.labels(turns) : opts.labels;
  if (!labels) throw new TypeError('A Markdown export needs labels');
  return { name, text: chatToMarkdown(turns, labels), type: 'text/markdown;charset=utf-8' };
}
