// @ts-check
// Random identifiers and secrets.
import { randomBytes, randomUUID } from 'node:crypto';

/** A random UUID v4. */
export const newId = () => randomUUID();

/** A random secret of `bytes` bytes as base64url (43 characters for 32 bytes). @param {number} [bytes] */
export const newSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** UUID shape (any version, lower case). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
