// @ts-check
// Chat export: the conversation on screen as JSON (schema starpi.chat/v1) or as Markdown, with a
// file name that is safe on every platform. Pure, so the formats are pinned by unit tests.

export const CHAT_EXPORT_SCHEMA = 'starpi.chat/v1';

/**
 * One message as exported. Internal fields of the conversation (such as which turns stay on the
 * device) are never part of an export.
 * @typedef {object} ExportTurn
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {string | null} createdAt  ISO time
 * @property {string | null} engine     engine id of an answer (cloud, client, wasm, local, synthesizer)
 * @property {string | null} model      model id, when one was recorded
 * @property {'free' | 'grounded' | null} chatMode
 */

/**
 * @param {ExportTurn[]} turns
 * @param {{ sessionId: string, exportedAt: string, version: string, locale: string }} meta
 * @returns {string}
 */
export function chatToJson(turns, meta) {
  const messages = turns.map(({ role, content, createdAt, engine, model, chatMode }) => ({ role, content, createdAt, engine, model, chatMode }));
  const doc = {
    schema: CHAT_EXPORT_SCHEMA,
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
 * `starpi-chat-<date>-<session>.<ext>`: the export date and the start of the session id, reduced
 * to characters every file system accepts.
 * @param {string} sessionId
 * @param {string} exportedAt  ISO time
 * @param {'md' | 'json'} ext
 */
export function exportFileName(sessionId, exportedAt, ext) {
  const date = exportedAt.slice(0, 10).replace(/[^\d-]/g, '');
  const session = sessionId.replace(/^starpi_/, '').replace(/[^\w-]/g, '').slice(0, 8);
  return `starpi-chat-${[date, session].filter(Boolean).join('-')}.${ext}`;
}
