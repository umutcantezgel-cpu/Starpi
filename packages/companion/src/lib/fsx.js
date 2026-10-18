// @ts-check
// File helpers with the guarantees the stores rely on: private modes (folders 0700, files 0600),
// atomic replacement (complete temporary file, fsync, rename, fsync of the folder), write-once
// files that never replace an existing one, and reads that refuse symbolic links and oversized
// files. Every descriptor is opened and closed through `withDescriptor`, so none leaks on an error.
import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from './errors.js';

const ON_WINDOWS = process.platform === 'win32';
const NO_FOLLOW = ON_WINDOWS ? 0 : constants.O_NOFOLLOW;

/**
 * Opens a path, hands the descriptor to `use` and always closes it.
 * @template T
 * @param {string} path
 * @param {number} flags
 * @param {(fd: number) => T} use
 * @param {number} [mode]
 * @returns {T}
 */
function withDescriptor(path, flags, use, mode) {
  const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  let value;
  let thrown = null;
  try {
    value = use(fd);
  } catch (err) {
    thrown = err;
  }
  closeSync(fd);
  if (thrown !== null) throw thrown;
  return /** @type {T} */ (value);
}

/**
 * Runs `fn` and answers `fallback` when the path it touched does not exist.
 * @template T
 * @param {() => T} fn
 * @param {T} fallback
 * @returns {T}
 */
function unlessMissing(fn, fallback) {
  let value = fallback;
  try {
    value = fn();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw err;
  }
  return value;
}

/**
 * Makes a folder (and its parents) with mode 0700; an existing folder keeps its mode unless
 * `tighten` is set.
 * @param {string} dir
 * @param {{ tighten?: boolean }} [options]
 */
export function ensurePrivateDir(dir, { tighten = false } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (tighten && !ON_WINDOWS) chmodSync(dir, 0o700);
}

/** Makes a rename or unlink inside a folder durable (no-op on Windows). @param {string} dir */
export function syncDir(dir) {
  if (!ON_WINDOWS) withDescriptor(dir, constants.O_RDONLY, (fd) => fsyncSync(fd));
}

/** @param {string | Uint8Array} data */
const bytesOf = (data) => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data);

/**
 * Writes every byte and makes them durable.
 * @param {number} fd
 * @param {Uint8Array} bytes
 */
function writeDurably(fd, bytes) {
  for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done, bytes.length - done);
  fsyncSync(fd);
}

/** A fresh hidden name next to a file. @param {string} file */
const scratchName = (file) => join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);

/**
 * Replaces a file atomically, mode 0600 unless another is given.
 * @param {string} file
 * @param {string | Uint8Array} data
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const scratch = scratchName(file);
  try {
    withDescriptor(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, (fd) => writeDurably(fd, bytesOf(data)), mode);
    renameSync(scratch, file);
  } catch (err) {
    rmSync(scratch, { force: true });
    throw err;
  }
  syncDir(dirname(file));
}

/**
 * Writes a file that must not exist yet: complete under a hidden name first, then hard-linked to
 * its name, so no reader ever sees half of it. A taken name throws `file_exists`.
 * @param {string} file
 * @param {string | Uint8Array} data
 * @param {{ mode?: number }} [options]
 */
export function writeFileOnce(file, data, { mode = 0o400 } = {}) {
  const scratch = scratchName(file);
  withDescriptor(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, (fd) => writeDurably(fd, bytesOf(data)), 0o600);
  let failure = null;
  try {
    if (!ON_WINDOWS) chmodSync(scratch, mode);
    linkSync(scratch, file);
  } catch (err) {
    failure = /** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST' ? fail('file_exists', `${basename(file)} exists already and is never replaced`) : err;
  }
  rmSync(scratch, { force: true });
  if (failure !== null) throw failure;
  syncDir(dirname(file));
}

/**
 * The content of a regular file, without following a link at its last step; null when it does not
 * exist. Anything but a regular file of at most `maxBytes` throws `file_invalid`.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Buffer | null}
 */
export function readRegularFile(file, maxBytes = 16 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'ENOENT') return null;
    throw code === 'ELOOP' ? fail('file_invalid', `${basename(file)} is a symbolic link`) : err;
  }
  return readOpened(fd, file, maxBytes);
}

/**
 * Reads an open regular file completely and closes it.
 * @param {number} fd
 * @param {string} file
 * @param {number} maxBytes
 */
function readOpened(fd, file, maxBytes) {
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw fail('file_invalid', `${basename(file)} is not a regular file`);
    if (info.size > maxBytes) throw fail('file_invalid', `${basename(file)} is larger than ${maxBytes} bytes`);
    const content = Buffer.allocUnsafe(info.size);
    let filled = 0;
    for (let got = -1; filled < content.length && got !== 0; filled += got) got = readSync(fd, content, filled, content.length - filled, filled);
    return content.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/**
 * Removes a file durably; false when it was not there.
 * @param {string} file
 */
export function removeFile(file) {
  const removed = unlessMissing(() => {
    unlinkSync(file);
    return true;
  }, false);
  if (removed) syncDir(dirname(file));
  return removed;
}

/**
 * The entries of a folder (none when it does not exist).
 * @param {string} dir
 * @returns {import('node:fs').Dirent[]}
 */
export const listDir = (dir) => unlessMissing(() => readdirSync(dir, { withFileTypes: true }), /** @type {import('node:fs').Dirent[]} */ ([]));

/** @param {string} path */
export const isDir = (path) => unlessMissing(() => lstatSync(path).isDirectory(), false);

/** @param {string} path */
export const exists = (path) => existsSync(path);

/**
 * The real path of a path that may not exist yet: its nearest existing ancestor resolved through
 * links, the missing rest appended as written.
 * @param {string} path
 * @returns {string}
 */
export function realPathLoose(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  try {
    return realpathSync.native(absolute);
  } catch {
    return parent === absolute ? absolute : join(realPathLoose(parent), basename(absolute));
  }
}

/**
 * Whether two folders are the same or one contains the other, compared as written and with links
 * resolved.
 * @param {string} first   a path
 * @param {string} second  another path
 */
export function pathsOverlap(first, second) {
  /** @param {string} inner @param {string} outer */
  const within = (inner, outer) => {
    const rel = relative(outer, inner);
    return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  };
  /** @param {string} x @param {string} y */
  const nested = (x, y) => within(x, y) || within(y, x);
  return nested(resolve(first), resolve(second)) || nested(realPathLoose(first), realPathLoose(second));
}
