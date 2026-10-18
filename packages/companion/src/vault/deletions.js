// @ts-check
// The deletion list: one append-only text file outside the data folder (next to the audit anchors)
// that names every vault item and every namespace that was deleted, with the time:
//   <namespace>/<item id> <ISO time>      one item
//   <namespace>/* <ISO time> <generation> a whole namespace (crypto-erase of that key generation)
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
const LINE = /^([a-z][a-z0-9_]{1,31})\/(\*|[A-Za-z0-9._:-]{1,128}) (\S+)(?: (\d{1,9}))?$/;

/** @typedef {{ ns: string, id: string | null, at: string, gen: number | null }} Deletion */

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
     * @param {number | null} [gen]  the key generation a namespace line erased
     */
    append(ns, id, at, gen = null) {
      if (!NAMESPACE.test(ns) || (id !== null && !ITEM_ID.test(id)) || !ISO_UTC.test(at)) throw fail('deletions_invalid', 'a deletion names a namespace, an item id and a UTC time');
      if (gen !== null && (!Number.isInteger(gen) || gen < 0)) throw fail('deletions_invalid', 'a key generation is a whole number');
      ensurePrivateDir(dirname(file));
      appendLine(file, `${ns}/${id ?? '*'} ${at}${id === null && gen !== null ? ` ${gen}` : ''}\n`);
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
        const m = LINE.exec(line);
        if (!m || !ISO_UTC.test(m[3])) {
          invalid += 1;
          continue;
        }
        entries.push({ ns: m[1], id: m[2] === '*' ? null : m[2], at: m[3], gen: m[4] === undefined ? null : Number(m[4]) });
      }
      return { entries, invalid };
    },
  };
}

/** @typedef {ReturnType<typeof openDeletionList>} DeletionList */
