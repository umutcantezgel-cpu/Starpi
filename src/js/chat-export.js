// @ts-check
// Chat export, as the chat view imports it: the formats live in chat/export.js (starpi.chat/v2 for
// the message tree, v1 for 2.x files, Markdown for reading). This module keeps the names 2.x code
// used and adds the export of a stored conversation. The chat view loads it when the user exports.
import { chatToJsonV2, turnsToThread } from './chat/export.js';

export {
  CHAT_EXPORT_V1 as CHAT_EXPORT_SCHEMA,
  CHAT_EXPORT_V1,
  CHAT_EXPORT_V2,
  ChatImportError,
  chatToJson,
  chatToJsonV2,
  chatToMarkdown,
  conversationToV2,
  exportConversation,
  exportFileName,
  parseChatImport,
  pathToTurns,
} from './chat/export.js';

/** @typedef {import('./chat/export.js').ExportTurn} ExportTurn */
/** @typedef {import('./chat/export.js').ExportMeta} ExportMeta */

/**
 * A chat session as `starpi.chat/v2` JSON: its stored conversation (chat-store.js
 * loadSessionThread), or the turns on screen as one thread when nothing is stored for it.
 * @param {import('./chat/store.js').Thread | null} thread
 * @param {string} sessionId
 * @param {ExportMeta} meta
 * @param {ExportTurn[]} shown  the turns the chat shows
 * @returns {string}
 */
export function sessionToJson(thread, sessionId, meta, shown) {
  return chatToJsonV2(thread && thread.nodes.length > 0 ? thread : turnsToThread(sessionId, shown), meta);
}
