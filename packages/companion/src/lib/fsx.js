// @ts-check
// File helpers with the guarantees the stores rely on: private modes (folders 0700, files 0600),
// atomic replacement (write a temporary file, fsync, rename, fsync the folder), write-once files
// that never replace an existing one, and reads that refuse symbolic links and oversized files.
import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from './errors.js';

const IS_WINDOWS = process.platform === 'win32';
const NOFOLLOW = IS_WINDOWS ? 0 : constants.O_NOFOLLOW;

/**
 * Creates a folder (and its parents) with mode 0700; an existing folder keeps its mode unless
 * `tighten` is set.
 * @param {string} dir
 * @param {{ tighten?: boolean }} [options]
 */
export function ensurePrivateDir(dir, { tighten = false } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (tighten && !IS_WINDOWS) chmodSync(dir, 0o700);
}

/** fsync of a folder, so a rename or unlink inside it is durable (a no-op on Windows). @param {string} dir */
export function syncDir(dir) {
  if (IS_WINDOWS) return;
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {number} fd
 * @param {Uint8Array} bytes
 */
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/** @param {string | Uint8Array} data */
const asBytes = (data) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data);

/**
 * Replaces a file atomically with mode 0600 (or the given one).
 * @param {string} file
 * @param {string | Uint8Array} data
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    writeAll(fd, asBytes(data));
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  syncDir(dir);
}

/**
 * Writes a file that must not exist yet (complete under a temporary name first, then hard-linked to
 * its name, so a reader never sees half of it). Throws `file_exists` when the name is taken.
 * @param {string} file
 * @param {string | Uint8Array} data
 * @param {{ mode?: number }} [options]
 */
export function writeFileOnce(file, data, { mode = 0o400 } = {}) {
  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeAll(fd, asBytes(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (!IS_WINDOWS) chmodSync(temp, mode);
    linkSync(temp, file);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'EEXIST') throw fail('file_exists', `${basename(file)} exists already and is never replaced`);
    throw err;
  } finally {
    rmSync(temp, { force: true });
  }
  syncDir(dir);
}

/**
 * Reads a regular file without following a symbolic link at its last step; null when it is not
 * there. Throws `file_invalid` for anything else than a regular file of at most `maxBytes`.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Buffer | null}
 */
export function readRegularFile(file, maxBytes = 16 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw fail('file_invalid', `${basename(file)} is a symbolic link`);
    throw err;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw fail('file_invalid', `${basename(file)} is not a regular file`);
    if (info.size > maxBytes) throw fail('file_invalid', `${basename(file)} is larger than ${maxBytes} bytes`);
    const out = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const n = readSync(fd, out, offset, info.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return out.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * Removes a file and makes the removal durable; false when it was not there.
 * @param {string} file
 */
export function removeFile(file) {
  try {
    unlinkSync(file);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
  syncDir(dirname(file));
  return true;
}

/**
 * Names in a folder (empty when it does not exist).
 * @param {string} dir
 * @returns {import('node:fs').Dirent[]}
 */
export function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

/** @param {string} path */
export const isDir = (path) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** @param {string} path */
export const exists = (path) => existsSync(path);

/**
 * The real path of a path that may not exist yet: the nearest existing parent resolved, the rest
 * appended as written.
 * @param {string} path
 */
export function realPathLoose(path) {
  const absolute = resolve(path);
  /** @type {string[]} */
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * True when one path is the other or lies inside it, as written or with links resolved.
 * @param {string} a
 * @param {string} b
 */
export function pathsOverlap(a, b) {
  /** @param {string} inner @param {string} outer */
  const inside = (inner, outer) => {
    const rel = relative(outer, inner);
    return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  };
  /** @param {string} x @param {string} y */
  const either = (x, y) => inside(x, y) || inside(y, x);
  return either(resolve(a), resolve(b)) || either(realPathLoose(a), realPathLoose(b));
}
