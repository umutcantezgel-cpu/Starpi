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
 * A chat session as `starpi.chat/v2` JSON: its stored conversation once the messages still being
 * stored are written, or the turns on screen as one thread when nothing is stored for it.
 * @param {string} sessionId
 * @param {ExportMeta} meta
 * @param {ExportTurn[]} shown  the turns the chat shows
 * @returns {Promise<string>}
 */
export async function exportSessionJson(sessionId, meta, shown) {
  // The chat view has loaded this module already; importing it here keeps the formats importable
  // on their own (tests, tools).
  const { chatData, waitForWrites } = await import('./chat-store.js');
  await waitForWrites(sessionId);
  try {
    const thread = await (await chatData()).loadThread(sessionId);
    if (thread && thread.nodes.length > 0) return chatToJsonV2(thread, meta);
  } catch (err) {
    console.warn('[starpi] the stored chat could not be read; the chat on screen is exported', err);
  }
  return chatToJsonV2(turnsToThread(sessionId, shown), meta);
}
