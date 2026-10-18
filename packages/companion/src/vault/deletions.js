// @ts-check
// The deletion list: one append-only text file outside the data folder (next to the audit anchors)
// that names every vault item and every namespace that was deleted, with the time:
//   <namespace>/<item id> <ISO time>      one item
//   <namespace>/* <ISO time> <generation> a whole namespace: every key generation up to this one is
//                                         erased (0 when the namespace never had a key); a namespace
//                                         line without its generation is invalid
// It lives outside the data folder because an older copy of that folder does not know what was
// deleted after it was taken: when a backup is restored, the reconciliation deletes again what the
// list names, so a restore never brings back what the owner erased.
import { closeSync, constants, fdatasyncSync, fstatSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ISO_UTC } from '../contracts/check.js';
import { NAMESPACE } from '../contracts/module.js';
import { fail } from '../lib/errors.js';
import { ensurePrivateDir, pathsOverlap, readRegularFile } from '../lib/fsx.js';

/** Vault item ids: letters, digits and `._:-`, 1 to 128 characters. */
export const ITEM_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ITEM_LINE = /^([a-z][a-z0-9_]{1,31})\/([A-Za-z0-9._:-]{1,128}) (\S+)$/;
const NAMESPACE_LINE = /^([a-z][a-z0-9_]{1,31})\/\* (\S+) (\d{1,9})$/;

/**
 * One line: an item (`id` set, `gen` null) or a whole namespace (`id` null, `gen` set).
 * @typedef {{ ns: string, id: string | null, at: string, gen: number | null }} Deletion
 */

/**
 * Appends one line to a regular file (made 0600 when new) and returns once it is on disk.
 * @param {string} file
 * @param {string} line
 */
function appendLine(file, line) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const fd = openSync(file, flags, 0o600);
  let problem = null;
  try {
    if (fstatSync(fd).isFile()) {
      writeSync(fd, line);
      fdatasyncSync(fd);
    } else {
      problem = fail('deletions_path', 'the deletion list is not a regular file');
    }
  } catch (err) {
    problem = err;
  }
  closeSync(fd);
  if (problem !== null) throw problem;
}

/**
 * @param {{ file: string, dataDir: string }} options
 */
export function openDeletionList({ file, dataDir }) {
  if (pathsOverlap(file, dataDir)) throw fail('deletions_path', 'the deletion list must lie outside the data folder');
  return {
    file,
    /**
     * Appends one line and makes it durable before returning.
     * @param {string} ns
     * @param {string | null} id   null for the whole namespace
     * @param {string} at
     * @param {number | null} [gen]  required for a namespace line: the highest key generation erased
     */
    append(ns, id, at, gen = null) {
      if (!NAMESPACE.test(ns) || (id !== null && !ITEM_ID.test(id)) || !ISO_UTC.test(at)) throw fail('deletions_invalid', 'a deletion names a namespace, an item id and a UTC time');
      if (id === null && (!Number.isInteger(gen) || /** @type {number} */ (gen) < 0 || /** @type {number} */ (gen) > 999_999_999)) throw fail('deletions_invalid', 'a namespace deletion names the key generation it erased');
      ensurePrivateDir(dirname(file));
      appendLine(file, id === null ? `${ns}/* ${at} ${gen}\n` : `${ns}/${id} ${at}\n`);
    },
    /** Every valid line; lines that do not parse are ignored (and counted). */
    read() {
      const raw = readRegularFile(file, 64 * 1024 * 1024);
      /** @type {Deletion[]} */
      const entries = [];
      let invalid = 0;
      if (raw === null) return { entries, invalid };
      for (const line of raw.toString('utf8').split('\n')) {
        if (line === '') continue;
        const whole = NAMESPACE_LINE.exec(line);
        const item = whole ? null : ITEM_LINE.exec(line);
        const at = whole ? whole[2] : item?.[3];
        if ((!whole && !item) || !ISO_UTC.test(/** @type {string} */ (at))) {
          invalid += 1;
          continue;
        }
        if (whole) entries.push({ ns: whole[1], id: null, at: whole[2], gen: Number(whole[3]) });
        else entries.push({ ns: /** @type {RegExpExecArray} */ (item)[1], id: /** @type {RegExpExecArray} */ (item)[2], at: /** @type {string} */ (at), gen: null });
      }
      return { entries, invalid };
    },
  };
}

/** @typedef {ReturnType<typeof openDeletionList>} DeletionList */
