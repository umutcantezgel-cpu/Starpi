// @ts-check
// Pins of connector tools. A tool of an MCP server is described by its name, title, description,
// input and output schema and annotations; the pin is the SHA-256 of that description as canonical
// JSON. The owner approves a tool together with its pin, and a tool is usable only while the server
// still describes it with exactly that pin. A server that changes a description afterwards (new
// wording that could steer a model, a wider schema) loses the tool until the owner looks at the new
// description and approves it again.
import { createHash } from 'node:crypto';
import { isRecord } from '../contracts/check.js';
import { canonicalJson } from '../lib/canonical.js';

export const PIN = /^sha256:[0-9a-f]{64}$/;
/** The tool names this companion accepts from a server. */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * @typedef {object} ToolDescription
 * @property {string} name             as the server names it
 * @property {string} title            '' when the server gives none
 * @property {string} description      cut to 4000 characters
 * @property {Record<string, unknown>} inputSchema
 * @property {Record<string, unknown> | null} outputSchema
 * @property {Record<string, unknown> | null} annotations
 */

/**
 * A listed tool as the companion keeps it, or null when it is malformed.
 * @param {unknown} raw
 * @returns {ToolDescription | null}
 */
export function readTool(raw) {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name) || !isRecord(raw.inputSchema)) return null;
  return {
    name: raw.name,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '',
    inputSchema: raw.inputSchema,
    outputSchema: isRecord(raw.outputSchema) ? raw.outputSchema : null,
    annotations: isRecord(raw.annotations) ? raw.annotations : null,
  };
}

/**
 * The pin of a tool description.
 * @param {ToolDescription} tool
 */
export function pinOf(tool) {
  const text = canonicalJson({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations });
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The state of a tool against its approval.
 * @param {string | null} current   the pin the server describes now, null when it no longer lists the tool
 * @param {string | null} approved  the pin the owner approved, null when never
 * @returns {'approved' | 'changed' | 'new' | 'missing'}
 */
export function pinState(current, approved) {
  if (current === null) return 'missing';
  if (approved === null) return 'new';
  return current === approved ? 'approved' : 'changed';
}
