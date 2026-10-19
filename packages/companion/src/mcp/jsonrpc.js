// @ts-check
// The JSON-RPC 2.0 side of the MCP server: reading one message, the error codes, and the protocol
// versions the server speaks. Version 2025-06-18 is answered by default; a client that asks for an
// older version the server knows gets that one (the version negotiation of `initialize`). Batches
// were dropped by the 2025-06-18 revision and are refused.
import { isRecord } from '../contracts/check.js';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

/** The error codes JSON-RPC 2.0 reserves, by what they mean. */
export const RPC = Object.freeze({ parseError: -32700, invalidRequest: -32600, unknownMethod: -32601, badParams: -32602, internal: -32603 });

/**
 * @typedef {{ kind: 'request', id: string | number, method: string, params: Record<string, unknown> }
 *   | { kind: 'notification', method: string, params: Record<string, unknown> }
 *   | { kind: 'response' }
 *   | { kind: 'invalid', id: string | number | null, code: number, message: string }} Message
 */

/**
 * Classifies a parsed body.
 * @param {unknown} value
 * @returns {Message}
 */
export function readMessage(value) {
  if (Array.isArray(value)) return { kind: 'invalid', id: null, code: RPC.invalidRequest, message: 'batches are not supported' };
  if (!isRecord(value) || value.jsonrpc !== '2.0') return { kind: 'invalid', id: null, code: RPC.invalidRequest, message: 'not a JSON-RPC 2.0 message' };
  const id = typeof value.id === 'string' || (typeof value.id === 'number' && Number.isInteger(value.id)) ? value.id : null;
  if (value.id !== undefined && id === null) return { kind: 'invalid', id: null, code: RPC.invalidRequest, message: 'an id is a string or an integer' };
  if (typeof value.method !== 'string') {
    if (id !== null && ('result' in value || 'error' in value)) return { kind: 'response' };
    return { kind: 'invalid', id, code: RPC.invalidRequest, message: 'a method is required' };
  }
  if (value.params !== undefined && !isRecord(value.params)) return { kind: 'invalid', id, code: RPC.badParams, message: 'params must be an object' };
  const params = /** @type {Record<string, unknown>} */ (value.params ?? {});
  return id === null ? { kind: 'notification', method: value.method, params } : { kind: 'request', id, method: value.method, params };
}

/** @param {string | number} id @param {unknown} result */
export const resultOf = (id, result) => ({ jsonrpc: '2.0', id, result });

/** @param {string | number | null} id @param {number} code @param {string} message @param {unknown} [data] */
export const errorOf = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

/**
 * The version the server answers to a requested one.
 * @param {unknown} requested
 */
export const negotiate = (requested) => (typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL);

/**
 * Checks arguments against a closed schema of the kind the tools declare: an object of strings,
 * integers and booleans with lengths and ranges, required members and no others.
 * @param {unknown} args
 * @param {{ properties: Record<string, any>, required?: string[] }} schema
 * @returns {string[]}
 */
export function argumentProblems(args, schema) {
  if (!isRecord(args)) return ['arguments must be an object'];
  /** @type {string[]} */
  const problems = [];
  for (const name of schema.required ?? []) if (args[name] === undefined) problems.push(`${name} is required`);
  for (const [name, value] of Object.entries(args)) {
    const rule = schema.properties[name];
    if (!rule) {
      problems.push(`${name} is not an argument of this tool`);
      continue;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') problems.push(`${name} must be a string`);
      else if ((rule.minLength !== undefined && value.length < rule.minLength) || (rule.maxLength !== undefined && value.length > rule.maxLength)) problems.push(`${name} must have ${rule.minLength ?? 0} to ${rule.maxLength} characters`);
      else if (rule.pattern && !new RegExp(rule.pattern).test(value)) problems.push(`${name} has the wrong form`);
    } else if (rule.type === 'integer') {
      if (!Number.isInteger(value)) problems.push(`${name} must be a whole number`);
      else if ((rule.minimum !== undefined && /** @type {number} */ (value) < rule.minimum) || (rule.maximum !== undefined && /** @type {number} */ (value) > rule.maximum)) problems.push(`${name} must be ${rule.minimum} to ${rule.maximum}`);
    } else if (rule.type === 'boolean' && typeof value !== 'boolean') problems.push(`${name} must be true or false`);
  }
  return problems;
}
