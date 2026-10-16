// @ts-check
// A ZIP reader without dependencies, for the Office formats (DOCX, XLSX and PPTX are ZIP packages).
// It reads the central directory (ZIP64 included), copies stored entries, inflates deflated ones with
// the platform's DecompressionStream('deflate-raw') and checks every entry's CRC-32.
//
// Archives are untrusted input. Before anything is inflated it refuses what could exhaust memory:
// too many entries, an entry or a total that declares more bytes than the limits allow, an entry
// whose declared compression ratio is far beyond what real documents reach, and entries whose data
// overlap (one compressed stream counted many times). While inflating, an entry that produces more
// bytes than it declared is stopped at once. Entry names are sanitised: absolute paths, drive
// letters, ".." segments and control characters make an entry unreadable, never a path outside.
import { ParseError } from './errors.js';

const MiB = 1024 * 1024;

/**
 * @typedef {object} ZipLimits
 * @property {number} entries        most entries in the central directory
 * @property {number} entryBytes     largest uncompressed size of one entry
 * @property {number} totalBytes     most uncompressed bytes in all entries (declared, and inflated per archive)
 * @property {number} ratio          highest uncompressed/compressed ratio of an entry above ratioMinBytes
 * @property {number} ratioMinBytes  entries up to this size may compress better (small, harmless)
 */

/** @type {Readonly<ZipLimits>} */
export const ZIP_LIMITS = Object.freeze({ entries: 10_000, entryBytes: 64 * MiB, totalBytes: 160 * MiB, ratio: 200, ratioMinBytes: MiB });

/**
 * @typedef {object} ZipEntry
 * @property {string} name            sanitised path inside the archive ("word/document.xml")
 * @property {number} method          0 stored, 8 deflate
 * @property {number} flags           general purpose bit flags
 * @property {number} crc32
 * @property {number} compressedSize
 * @property {number} size            uncompressed size as declared
 * @property {number} offset          of the local file header
 * @property {number} dataStart       of the compressed data
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;

/** @param {string} message */
const invalid = (message) => new ParseError('invalid_document', message);
/** @param {string} message */
const bomb = (message) => new ParseError('zip_bomb', message);

/**
 * True for bytes that start like a ZIP archive (a local file header, or the end record of an empty one).
 * @param {Uint8Array} bytes
 */
export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

/**
 * A safe relative path for an entry name, or null when the name must not be used: control
 * characters, an absolute path or drive letter, or a ".." segment. Backslashes count as separators;
 * empty and "." segments are dropped.
 * @param {string} name
 */
export function sanitizeEntryName(name) {
  // eslint-disable-next-line no-control-regex -- control characters in a name are the point here
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  const path = name.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return null;
  /** @type {string[]} */
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** @type {Uint32Array | null} */
let crcTable = null;

/**
 * CRC-32 (ISO 3309, as used by ZIP).
 * @param {Uint8Array} bytes
 */
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Little-endian reads with bounds checks: a truncated archive is reported, never read as zeros.
 * @param {Uint8Array} b
 */
function reader(b) {
  /** @param {number} o @param {number} n */
  const need = (o, n) => {
    if (!Number.isSafeInteger(o) || o < 0 || o + n > b.length) throw invalid('The ZIP archive is truncated');
  };
  /** @param {number} o */
  const u16 = (o) => (need(o, 2), b[o] | (b[o + 1] << 8));
  /** @param {number} o */
  const u32 = (o) => (need(o, 4), (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000);
  /** @param {number} o */
  const u64 = (o) => {
    const lo = u32(o);
    const hi = u32(o + 4);
    if (hi >= 0x200000) throw invalid('A ZIP64 size is out of range');
    return hi * 0x100000000 + lo;
  };
  return { need, u16, u32, u64 };
}

/** @param {Uint8Array} b */
function findEndRecord(b) {
  const { u16, u32 } = reader(b);
  let loose = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || u32(i) !== SIG_EOCD) continue;
    const end = i + 22 + u16(i + 20);
    if (end === b.length) return i;
    if (end < b.length && loose === -1) loose = i;
  }
  return loose;
}

/**
 * Reads and checks the central directory.
 * @param {Uint8Array} b
 * @param {ZipLimits} limits
 * @returns {{ entries: ZipEntry[], skipped: number }}
 */
function readDirectory(b, limits) {
  const { need, u16, u32, u64 } = reader(b);
  const eocd = findEndRecord(b);
  if (eocd < 0) throw invalid('Not a ZIP archive (no end of central directory record)');
  let disk = u16(eocd + 4);
  let directoryDisk = u16(eocd + 6);
  let total = u16(eocd + 10);
  let directorySize = u32(eocd + 12);
  let directoryOffset = u32(eocd + 16);
  let directoryLimit = eocd;
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(locator) !== SIG_EOCD64_LOCATOR) throw invalid('The ZIP64 end record is missing');
    const record = u64(locator + 8);
    if (record + 56 > locator || u32(record) !== SIG_EOCD64) throw invalid('The ZIP64 end record is broken');
    disk = u32(record + 16);
    directoryDisk = u32(record + 20);
    total = u64(record + 32);
    directorySize = u64(record + 40);
    directoryOffset = u64(record + 48);
    directoryLimit = record;
  }
  if (disk !== 0 || directoryDisk !== 0) throw invalid('Multi-volume ZIP archives are not supported');
  if (total > limits.entries) throw bomb(`The archive has ${total} entries (at most ${limits.entries} allowed)`);
  if (directoryOffset + directorySize > directoryLimit) throw invalid('The central directory lies outside the archive');

  const names = new TextDecoder('utf-8');
  /** @type {ZipEntry[]} */
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  let p = directoryOffset;
  const end = directoryOffset + directorySize;
  for (let k = 0; k < total; k++) {
    if (p + 46 > end || u32(p) !== SIG_CENTRAL) throw invalid('The central directory is broken');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    let compressedSize = u32(p + 20);
    let size = u32(p + 24);
    const nameLength = u16(p + 28);
    const extraLength = u16(p + 30);
    const commentLength = u16(p + 32);
    let entryDisk = u16(p + 34);
    let offset = u32(p + 42);
    need(p + 46, nameLength + extraLength + commentLength);
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff || entryDisk === 0xffff) {
      // ZIP64 extended information: only the fields that overflowed are present, in this order.
      let q = p + 46 + nameLength;
      const extraEnd = q + extraLength;
      while (q + 4 <= extraEnd) {
        const id = u16(q);
        const length = u16(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          const fieldEnd = r + length;
          const next = (/** @type {number} */ bytes) => {
            if (r + bytes > fieldEnd) throw invalid('A ZIP64 extra field is too short');
            const value = bytes === 8 ? u64(r) : u32(r);
            r += bytes;
            return value;
          };
          if (size === 0xffffffff) size = next(8);
          if (compressedSize === 0xffffffff) compressedSize = next(8);
          if (offset === 0xffffffff) offset = next(8);
          if (entryDisk === 0xffff) entryDisk = next(4);
          break;
        }
        q += 4 + length;
      }
    }
    const raw = names.decode(b.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (entryDisk !== 0) throw invalid('Multi-volume ZIP archives are not supported');
    if (raw.endsWith('/') || raw.endsWith('\\')) continue; // a directory
    const name = sanitizeEntryName(raw);
    if (!name) {
      skipped += 1;
      continue;
    }
    // Two entries with one name are read differently by different programs; refuse the ambiguity.
    const key = name.toLowerCase();
    if (seen.has(key)) throw invalid(`The archive contains ${name} twice`);
    seen.add(key);
    entries.push({ name, method, flags, crc32: crc, compressedSize, size, offset, dataStart: 0 });
  }

  let declared = 0;
  for (const e of entries) {
    if (e.size > limits.entryBytes) throw bomb(`${e.name} would unpack to ${e.size} bytes (at most ${limits.entryBytes} allowed)`);
    if (e.size > limits.ratioMinBytes && e.size > Math.max(e.compressedSize, 1) * limits.ratio) {
      throw bomb(`${e.name} would unpack to ${Math.round(e.size / Math.max(e.compressedSize, 1))} times its compressed size`);
    }
    declared += e.size;
    if (u32(e.offset) !== SIG_LOCAL) throw invalid(`The local header of ${e.name} is missing`);
    e.dataStart = e.offset + 30 + u16(e.offset + 26) + u16(e.offset + 28);
    if (e.dataStart + e.compressedSize > directoryOffset) throw invalid(`The data of ${e.name} runs into the central directory`);
  }
  if (declared > limits.totalBytes) throw bomb(`The archive would unpack to ${declared} bytes (at most ${limits.totalBytes} allowed)`);
  const sorted = [...entries].sort((a, c) => a.offset - c.offset);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].offset < sorted[i - 1].dataStart + sorted[i - 1].compressedSize) throw bomb(`The entries ${sorted[i - 1].name} and ${sorted[i].name} overlap`);
  }
  return { entries, skipped };
}

/**
 * Inflates raw deflate data, stopping as soon as it produces more than `size` bytes.
 * @param {Uint8Array} data
 * @param {number} size
 * @param {string} name
 */
async function inflateRaw(data, size, name) {
  if (typeof DecompressionStream !== 'function') throw invalid('This runtime cannot decompress ZIP entries');
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer
    .write(/** @type {Uint8Array<ArrayBuffer>} */ (data))
    .then(() => writer.close())
    .catch(() => {});
  const read = stream.readable.getReader();
  const out = new Uint8Array(size);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await read.read();
      if (done) break;
      if (value.length > size - n) throw bomb(`${name} unpacks to more bytes than it declares`);
      out.set(value, n);
      n += value.length;
    }
  } catch (err) {
    read.cancel().catch(() => {});
    if (err instanceof ParseError) throw err;
    throw invalid(`${name} is not valid deflate data`);
  }
  if (n !== size) throw invalid(`${name} is shorter than it declares`);
  return out;
}

export class ZipArchive {
  /**
   * @param {Uint8Array} bytes
   * @param {Partial<ZipLimits>} [limits]
   */
  constructor(bytes, limits = {}) {
    this.bytes = bytes;
    /** @type {ZipLimits} */
    this.limits = { ...ZIP_LIMITS, ...limits };
    const { entries, skipped } = readDirectory(bytes, this.limits);
    /** @type {readonly ZipEntry[]} */
    this.entries = entries;
    /** Entries left out because their names were unsafe. */
    this.skipped = skipped;
    /** Bytes inflated so far; all reads together stay within limits.totalBytes. */
    this.inflated = 0;
    /** @type {Map<string, ZipEntry>} */
    this.byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  }

  /**
   * The entry with this path, compared without case (part names of Office packages are case-insensitive).
   * @param {string} name
   */
  get(name) {
    const key = sanitizeEntryName(name.replace(/^\/+/, ''));
    return key ? (this.byName.get(key.toLowerCase()) ?? null) : null;
  }

  /**
   * The uncompressed bytes of an entry, checked against its CRC-32.
   * @param {ZipEntry | string} entryOrName
   * @returns {Promise<Uint8Array>}
   */
  async read(entryOrName) {
    const entry = typeof entryOrName === 'string' ? this.get(entryOrName) : entryOrName;
    if (!entry) throw invalid(`The archive has no entry ${String(entryOrName)}`);
    if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ParseError('encrypted_document', `${entry.name} is encrypted`);
    if (this.inflated + entry.size > this.limits.totalBytes) throw bomb(`Reading ${entry.name} would unpack more than ${this.limits.totalBytes} bytes`);
    const data = this.bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let out;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) throw invalid(`The stored entry ${entry.name} has two sizes`);
      out = data;
    } else if (entry.method === 8) {
      out = await inflateRaw(data, entry.size, entry.name);
    } else {
      throw invalid(`${entry.name} uses compression method ${entry.method}, which is not supported`);
    }
    this.inflated += out.length;
    if (crc32(out) !== entry.crc32) throw invalid(`${entry.name} is damaged (CRC-32 mismatch)`);
    return out;
  }
}

/**
 * Opens a ZIP archive held in memory. Throws ParseError 'invalid_document' for a broken archive and
 * 'zip_bomb' when it exceeds the limits.
 * @param {Uint8Array} bytes
 * @param {Partial<ZipLimits>} [limits]
 */
export function openZip(bytes, limits) {
  return new ZipArchive(bytes, limits);
}
