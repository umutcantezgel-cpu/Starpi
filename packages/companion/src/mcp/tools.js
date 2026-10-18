// @ts-check
// The tools the companion's MCP server offers to desktop MCP clients. All four only read, and only
// what the class ceiling of the server allows (`personal` by default; `sensitive` at most, since a
// desktop client may hand what it reads to a model in the cloud; secret content never):
//   search_documents  passages of the user's documents for a query
//   read_excerpt      one passage of a document (and the ones after it), as the search cited it
//   recall_notes      the user's notes that answer a query
//   list_agenda       the reminders of the coming days
// A result is text for the client's model plus the same data as structured content.
import { classRank } from '../contracts/data-classes.js';
import { fail } from '../lib/errors.js';

/**
 * @typedef {object} ToolContext
 * @property {import('../setup/hub.js').Hub} hub
 * @property {import('../contracts/data-classes.js').DataClass} maxClass
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} ServerTool
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {{ type: 'object', properties: Record<string, any>, required?: string[], additionalProperties: false }} inputSchema
 * @property {(args: Record<string, any>, ctx: ToolContext) => Promise<{ text: string, data: Record<string, unknown>, items: number }>} run
 */

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

/** @param {string} name */
const unavailable = (name) => fail('tool_unavailable', `${name} is not running on this companion`, { status: 503 });

/** @type {readonly ServerTool[]} */
export const SERVER_TOOLS = Object.freeze([
  {
    name: 'search_documents',
    title: 'Search documents',
    description: 'Finds passages in the documents the user stored in Starpi Core. Returns each passage with its document id and passage number, which read_excerpt accepts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500, description: 'What to look for, in words.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many passages to return (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, { hub, maxClass, signal }) {
      const index = hub.get('retrieval');
      if (!index) throw unavailable('the search index');
      const { passages } = await index.search(args.query, { k: args.limit ?? 5, collections: ['documents'], maxClass, signal });
      const found = passages.map((p) => ({ document: p.id, title: p.title, passage: p.chunk, text: p.text }));
      const text = found.length === 0 ? 'No passage matches.' : found.map((p) => `[${p.title}, passage ${p.passage}, document ${p.document}]\n${p.text}`).join('\n\n');
      return { text, data: { passages: found }, items: found.length };
    },
  },
  {
    name: 'read_excerpt',
    title: 'Read a passage',
    description: 'Reads a passage of a stored document by its document id and passage number (from search_documents), optionally with the passages that follow it.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', pattern: '^doc-[0-9a-f-]{36}$', maxLength: 40, description: 'The document id.' },
        passage: { type: 'integer', minimum: 0, maximum: 1000000, description: 'The passage number, starting at 0.' },
        count: { type: 'integer', minimum: 1, maximum: 3, description: 'How many passages to read from there (default 1).' },
      },
      required: ['document', 'passage'],
      additionalProperties: false,
    },
    async run(args, { hub, maxClass }) {
      const docs = hub.get('documents');
      if (!docs) throw unavailable('the document store');
      const record = docs.get(args.document);
      // A document above the ceiling is reported exactly like a missing one.
      if (!record || classRank(record.dataClass) > classRank(maxClass)) return { text: 'No such passage.', data: { passages: [] }, items: 0 };
      const found = [];
      for (let i = 0; i < (args.count ?? 1); i += 1) {
        const p = docs.passage(record.id, args.passage + i);
        if (!p) break;
        found.push({ document: record.id, title: record.name, passage: p.chunk, text: p.text });
      }
      const text = found.length === 0 ? 'No such passage.' : found.map((p) => `[${p.title}, passage ${p.passage}]\n${p.text}`).join('\n\n');
      return { text, data: { passages: found }, items: found.length };
    },
  },
  {
    name: 'recall_notes',
    title: 'Recall notes',
    description: 'Finds the notes the user keeps in Starpi Core that answer a query, best first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500, description: 'What the notes should be about.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many notes to return (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, { hub, maxClass, signal }) {
      const memory = hub.get('memory');
      if (!memory) throw unavailable('the memory');
      const notes = await memory.recall(args.query, { k: args.limit ?? 5, maxClass, record: false, signal });
      const found = notes.map((n) => {
        const full = memory.get(n.id);
        return { note: n.id, title: n.title, text: full?.text ?? n.text };
      });
      const text = found.length === 0 ? 'No note matches.' : found.map((n) => `[${n.title}]\n${n.text}`).join('\n\n');
      return { text, data: { notes: found }, items: found.length };
    },
  },
  {
    name: 'list_agenda',
    title: 'List the agenda',
    description: 'Lists the reminders of the coming days with their times, in the time zone each one is planned in.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 31, description: 'How many days ahead (default 7).' } },
      additionalProperties: false,
    },
    async run(args, { hub, maxClass }) {
      const agenda = hub.get('agenda');
      if (!agenda) throw unavailable('the agenda');
      const found = agenda.upcoming({ days: args.days ?? 7, max: 100, maxClass }).map((o) => ({ title: o.title, at: o.at, local: o.local, timeZone: o.timeZone }));
      const text = found.length === 0 ? 'Nothing is planned.' : found.map((o) => `${o.local} (${o.timeZone}): ${o.title}`).join('\n');
      return { text, data: { occurrences: found }, items: found.length };
    },
  },
]);

export const SERVER_TOOL_NAMES = Object.freeze(SERVER_TOOLS.map((t) => t.name));

/** The description of a tool for tools/list. @param {ServerTool} tool */
export const describeTool = (tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { title: tool.title, ...READ_ONLY } });
