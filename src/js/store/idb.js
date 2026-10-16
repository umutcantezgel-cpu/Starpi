// @ts-check
// A small promise wrapper over IndexedDB, written without dependencies. One interface covers two
// backends: the browser's IndexedDB, and an in-memory stand-in used when IndexedDB is missing or
// refuses to open (private windows, blocked site data, a database another tab keeps at an older
// version). The stand-in follows the same key order, index and transaction rules, but its data
// ends with the page, so it reports `persistent: false` and the UI can say so.
//
// Rules that come from IndexedDB itself and hold for both backends:
// - Inside transaction(), await only the operations of that transaction. Awaiting anything else
//   (fetch, timers, WebCrypto) lets IndexedDB commit early, and later operations then fail.
// - A failed write (an existing key on add(), a unique index clash) aborts the whole
//   transaction, even when the caller catches the error. A bad argument (a missing store, an
//   invalid key) only rejects that one call.
// - Keys are numbers, strings, dates, binary data or arrays of those. Booleans, null and objects
//   are not keys, so a record that should be found by a flag stores it as 0 or 1.

/** @typedef {number | string | Date | ArrayBuffer | ArrayBufferView | Key[]} Key */
/** @typedef {Key | KeyRange} KeyQuery */
/** @typedef {'readonly' | 'readwrite'} TxMode */
/** @typedef {{ durability?: 'default' | 'strict' | 'relaxed' }} TxOptions */
/** @typedef {'unsupported' | 'unavailable' | 'blocked' | 'timeout' | 'version' | 'error'} FallbackReason */

/**
 * @typedef {'unavailable' | 'blocked' | 'timeout' | 'version' | 'quota' | 'constraint' | 'not_found' | 'read_only' | 'data' | 'inactive' | 'closed' | 'aborted' | 'unknown'} StoreErrorCode
 */

/**
 * @typedef {object} IterateOptions
 * @property {string} [index]       walk an index instead of the primary key
 * @property {KeyQuery | null} [query]
 * @property {'next' | 'prev'} [direction]  ascending (default) or descending key order
 * @property {number} [limit]       stop after this many records
 */

/**
 * Called once per record, in key order. Must be synchronous; returning false stops the walk.
 * @typedef {(value: any, key: Key, primaryKey: Key) => boolean | void} Visitor
 */

/**
 * Operations on object stores. A database runs each call in a transaction of its own; inside
 * transaction(), the same calls share one transaction.
 * @typedef {object} StoreOps
 * @property {(store: string, query: KeyQuery) => Promise<any>} get  the first matching record, or undefined
 * @property {(store: string, query?: KeyQuery | null, count?: number) => Promise<any[]>} getAll
 * @property {(store: string, query?: KeyQuery | null, count?: number) => Promise<Key[]>} getAllKeys
 * @property {(store: string, query?: KeyQuery | null) => Promise<number>} count
 * @property {(store: string, value: unknown) => Promise<Key>} put  inserts or replaces; resolves with the key
 * @property {(store: string, value: unknown) => Promise<Key>} add  inserts only; an existing key fails with 'constraint'
 * @property {(store: string, values: readonly unknown[]) => Promise<Key[]>} putMany  many puts in one transaction
 * @property {(store: string, query: KeyQuery) => Promise<void>} delete  one key or every key in a range
 * @property {(store: string) => Promise<void>} clear
 * @property {(store: string, index: string, query: KeyQuery) => Promise<any>} getFromIndex
 * @property {(store: string, index: string, query?: KeyQuery | null, count?: number) => Promise<any[]>} getAllFromIndex
 * @property {(store: string, index: string, query?: KeyQuery | null, count?: number) => Promise<Key[]>} getAllKeysFromIndex  primary keys, in index order
 * @property {(store: string, index: string, query?: KeyQuery | null) => Promise<number>} countFromIndex
 * @property {(store: string, options: IterateOptions, visit: Visitor) => Promise<number>} iterate  resolves with the number of records visited
 */

/**
 * @typedef {object} StoreDbInfo
 * @property {string} name
 * @property {number} version
 * @property {'indexeddb' | 'memory'} backend
 * @property {boolean} persistent  false when the data ends with the page (the memory stand-in)
 * @property {FallbackReason | null} fallbackReason  why IndexedDB was not used, when it was not
 * @property {() => string[]} storeNames
 * @property {() => boolean} isClosed  true after close() or after another tab upgraded the database
 * @property {<T>(stores: string | string[], mode: TxMode, fn: (tx: StoreOps) => T | Promise<T>, options?: TxOptions) => Promise<T>} transaction
 *   runs fn in one transaction over the stores; resolves with its result once committed, and
 *   rolls everything back when fn throws or a write fails
 * @property {() => void} close
 */

/** @typedef {StoreOps & StoreDbInfo} StoreDb */

/**
 * Schema changes and data access while a database is created or upgraded.
 * @typedef {object} UpgradeContext
 * @property {number} oldVersion  0 when the database is new
 * @property {number} newVersion
 * @property {(name: string, options: { keyPath: string | string[] }) => void} createStore
 * @property {(name: string) => void} deleteStore
 * @property {(name: string) => boolean} hasStore
 * @property {(store: string, name: string, keyPath: string | string[], options?: { unique?: boolean }) => void} createIndex
 * @property {(store: string, name: string) => void} deleteIndex
 * @property {(store: string, name: string) => boolean} hasIndex
 * @property {StoreOps} tx  reads and writes inside the upgrade (await only these)
 */

/** @typedef {(ctx: UpgradeContext) => void | Promise<void>} Upgrade */

/**
 * @typedef {object} OpenOptions
 * @property {IDBFactory | null} [factory]  defaults to globalThis.indexedDB; null forces the memory stand-in
 * @property {boolean} [fallback]  false: reject instead of falling back to memory (default true)
 * @property {number} [timeoutMs]  how long a silent or blocked open may take before falling back
 * @property {() => void} [onVersionChange]  another tab upgraded or deleted the database; this connection closed
 * @property {() => void} [onBlocked]  an older connection in another tab delays the upgrade
 */

const OPEN_TIMEOUT_MS = 8_000;
const KEY_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

export class StoreError extends Error {
  /**
   * @param {StoreErrorCode} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StoreError';
    this.code = code;
  }
}

/** @type {Record<string, StoreErrorCode>} */
const DOM_ERROR_CODES = {
  QuotaExceededError: 'quota',
  ConstraintError: 'constraint',
  NotFoundError: 'not_found',
  ReadOnlyError: 'read_only',
  DataError: 'data',
  DataCloneError: 'data',
  VersionError: 'version',
  TransactionInactiveError: 'inactive',
  InvalidStateError: 'closed',
  AbortError: 'aborted',
  SecurityError: 'unavailable',
  InvalidAccessError: 'unavailable',
};

/**
 * Maps a DOMException (or anything thrown) onto a StoreError with a stable code for the UI.
 * @param {unknown} err
 * @returns {StoreError}
 */
export function toStoreError(err) {
  if (err instanceof StoreError) return err;
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
  const message = err instanceof Error || (err && typeof err === 'object' && 'message' in err) ? String(/** @type {{ message: unknown }} */ (err).message) : String(err);
  return new StoreError(DOM_ERROR_CODES[name] ?? 'unknown', message || name || 'Storage error', err);
}

// ---------------------------------------------------------------------------------------------
// Keys and ranges (shared by both backends)

/**
 * IndexedDB's key type order: number < date < string < binary < array; -1 for a non-key.
 * @param {unknown} key
 * @returns {number}
 */
function keyType(key) {
  if (typeof key === 'number') return Number.isNaN(key) ? -1 : 0;
  if (key instanceof Date) return Number.isNaN(key.getTime()) ? -1 : 1;
  if (typeof key === 'string') return 2;
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return 3;
  if (Array.isArray(key)) return key.every((part) => keyType(part) >= 0) ? 4 : -1;
  return -1;
}

/**
 * @param {unknown} key
 * @returns {key is Key}
 */
export function isValidKey(key) {
  return keyType(key) >= 0;
}

/** @param {ArrayBuffer | ArrayBufferView} data */
function bytesOf(data) {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Compares two keys the way IndexedDB orders them.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1}
 */
export function compareKeys(a, b) {
  const ta = keyType(a);
  const tb = keyType(b);
  if (ta < 0 || tb < 0) throw new StoreError('data', 'Not a valid key');
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 0 || ta === 2) {
    const x = /** @type {number | string} */ (a);
    const y = /** @type {number | string} */ (b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (ta === 1) return compareKeys(/** @type {Date} */ (a).getTime(), /** @type {Date} */ (b).getTime());
  if (ta === 3) {
    const x = bytesOf(/** @type {ArrayBuffer} */ (a));
    const y = bytesOf(/** @type {ArrayBuffer} */ (b));
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return compareKeys(x.length, y.length);
  }
  const x = /** @type {Key[]} */ (a);
  const y = /** @type {Key[]} */ (b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const order = compareKeys(x[i], y[i]);
    if (order !== 0) return order;
  }
  return compareKeys(x.length, y.length);
}

/** A key range that works with both backends; build one with `range`. */
export class KeyRange {
  /**
   * @param {Key | undefined} lower
   * @param {Key | undefined} upper
   * @param {boolean} [lowerOpen]
   * @param {boolean} [upperOpen]
   */
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    if (lower === undefined && upper === undefined) throw new StoreError('data', 'A key range needs a bound');
    if ((lower !== undefined && !isValidKey(lower)) || (upper !== undefined && !isValidKey(upper))) throw new StoreError('data', 'Not a valid key');
    if (lower !== undefined && upper !== undefined) {
      const order = compareKeys(lower, upper);
      if (order > 0 || (order === 0 && (lowerOpen || upperOpen))) throw new StoreError('data', 'The key range is empty');
    }
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lower !== undefined && lowerOpen;
    this.upperOpen = upper !== undefined && upperOpen;
    Object.freeze(this);
  }

  /** @param {unknown} key */
  includes(key) {
    if (!isValidKey(key)) return false;
    if (this.lower !== undefined) {
      const order = compareKeys(key, this.lower);
      if (order < 0 || (order === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const order = compareKeys(key, this.upper);
      if (order > 0 || (order === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

export const range = Object.freeze({
  /** @param {Key} key */
  only: (key) => new KeyRange(key, key),
  /** @param {Key} lower @param {Key} upper @param {boolean} [lowerOpen] @param {boolean} [upperOpen] */
  bound: (lower, upper, lowerOpen = false, upperOpen = false) => new KeyRange(lower, upper, lowerOpen, upperOpen),
  /** @param {Key} lower @param {boolean} [open] */
  lowerBound: (lower, open = false) => new KeyRange(lower, undefined, open, false),
  /** @param {Key} upper @param {boolean} [open] */
  upperBound: (upper, open = false) => new KeyRange(undefined, upper, false, open),
  /**
   * Every array key that starts with these parts, e.g. all `[docId, idx]` keys of one document.
   * An empty array sorts after every number, date, string and binary key, so it closes the range.
   * @param {Key[]} parts
   */
  prefix: (parts) => new KeyRange(parts, [...parts, []]),
  /** @param {string} text every string key that starts with text */
  startsWith: (text) => new KeyRange(text, `${text}￿`),
});

/**
 * @param {unknown} value
 * @param {string | string[]} keyPath
 * @returns {unknown} undefined when a part of the path is missing
 */
function extractKey(value, keyPath) {
  if (Array.isArray(keyPath)) {
    const parts = keyPath.map((path) => extractKey(value, path));
    return parts.some((part) => part === undefined) ? undefined : parts;
  }
  /** @type {unknown} */
  let node = value;
  for (const part of keyPath.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = /** @type {Record<string, unknown>} */ (node)[part];
  }
  return node;
}

/** @param {unknown} keyPath */
function assertKeyPath(keyPath) {
  const parts = Array.isArray(keyPath) ? keyPath : [keyPath];
  if (parts.length === 0 || !parts.every((part) => typeof part === 'string' && KEY_PATH.test(part))) {
    throw new StoreError('data', 'A key path is a dotted property name or a list of them');
  }
}

/**
 * @param {KeyQuery | null | undefined} query
 * @returns {(key: Key) => boolean}
 */
function matcher(query) {
  if (query === undefined || query === null) return () => true;
  if (query instanceof KeyRange) return (key) => query.includes(key);
  if (!isValidKey(query)) throw new StoreError('data', 'Not a valid key');
  return (key) => compareKeys(key, query) === 0;
}

/**
 * get(), getFromIndex() and delete() take a key or a range, never "everything".
 * @param {KeyQuery | null | undefined} query
 * @returns {KeyQuery}
 */
function required(query) {
  if (query === undefined || query === null) throw new StoreError('data', 'A key or a key range is required');
  return query;
}

/** @param {number | undefined} count */
function limitOf(count) {
  return typeof count === 'number' && count > 0 ? Math.floor(count) : Number.POSITIVE_INFINITY;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    throw new StoreError('data', 'The value cannot be stored', err);
  }
}

/** @returns {IDBFactory | null} */
function defaultFactory() {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    // Reading indexedDB throws in some sandboxed frames and with site data blocked.
    return null;
  }
}

/** @param {unknown} name */
function assertDbName(name) {
  if (typeof name !== 'string' || !name) throw new StoreError('data', 'A database needs a name');
}

/**
 * Builds the database-level calls on top of a transaction runner, one transaction per call.
 * @param {StoreDbInfo['transaction']} transaction
 * @returns {StoreOps}
 */
function opsOver(transaction) {
  return {
    get: (store, query) => transaction(store, 'readonly', (tx) => tx.get(store, query)),
    getAll: (store, query, count) => transaction(store, 'readonly', (tx) => tx.getAll(store, query, count)),
    getAllKeys: (store, query, count) => transaction(store, 'readonly', (tx) => tx.getAllKeys(store, query, count)),
    count: (store, query) => transaction(store, 'readonly', (tx) => tx.count(store, query)),
    put: (store, value) => transaction(store, 'readwrite', (tx) => tx.put(store, value)),
    add: (store, value) => transaction(store, 'readwrite', (tx) => tx.add(store, value)),
    putMany: (store, values) => transaction(store, 'readwrite', (tx) => tx.putMany(store, values)),
    delete: (store, query) => transaction(store, 'readwrite', (tx) => tx.delete(store, query)),
    clear: (store) => transaction(store, 'readwrite', (tx) => tx.clear(store)),
    getFromIndex: (store, index, query) => transaction(store, 'readonly', (tx) => tx.getFromIndex(store, index, query)),
    getAllFromIndex: (store, index, query, count) => transaction(store, 'readonly', (tx) => tx.getAllFromIndex(store, index, query, count)),
    getAllKeysFromIndex: (store, index, query, count) => transaction(store, 'readonly', (tx) => tx.getAllKeysFromIndex(store, index, query, count)),
    countFromIndex: (store, index, query) => transaction(store, 'readonly', (tx) => tx.countFromIndex(store, index, query)),
    iterate: (store, options, visit) => transaction(store, 'readonly', (tx) => tx.iterate(store, options, visit)),
  };
}

// ---------------------------------------------------------------------------------------------
// IndexedDB backend

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function settle(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toStoreError(req.error));
  });
}

/**
 * Runs a synchronous IndexedDB call that may throw (bad key, missing store) as a rejection.
 * @template T
 * @param {() => IDBRequest<T>} start
 * @returns {Promise<T>}
 */
function call(start) {
  try {
    return settle(start());
  } catch (err) {
    return Promise.reject(toStoreError(err));
  }
}

/**
 * @param {KeyQuery | null | undefined} query
 * @returns {IDBValidKey | IDBKeyRange | null | undefined}
 */
function toIdbQuery(query) {
  if (!(query instanceof KeyRange)) return /** @type {IDBValidKey | null | undefined} */ (query);
  const { lower, upper, lowerOpen, upperOpen } = query;
  if (lower === undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  if (upper === undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
}

/**
 * @param {IDBObjectStore | IDBIndex} source
 * @param {IterateOptions} options
 * @param {Visitor} visit
 * @returns {Promise<number>}
 */
function walkCursor(source, options, visit) {
  return new Promise((resolve, reject) => {
    const limit = limitOf(options.limit);
    let visited = 0;
    /** @type {IDBRequest<IDBCursorWithValue | null>} */
    let req;
    try {
      req = source.openCursor(toIdbQuery(options.query), options.direction === 'prev' ? 'prev' : 'next');
    } catch (err) {
      reject(toStoreError(err));
      return;
    }
    req.onerror = () => reject(toStoreError(req.error));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(visited);
        return;
      }
      visited += 1;
      let more;
      try {
        more = visit(cursor.value, /** @type {Key} */ (cursor.key), /** @type {Key} */ (cursor.primaryKey));
      } catch (err) {
        reject(err);
        return;
      }
      if (more === false || visited >= limit) resolve(visited);
      else cursor.continue();
    };
  });
}

/**
 * @param {IDBTransaction} tx
 * @returns {StoreOps}
 */
function idbOps(tx) {
  /** @param {string} name */
  const os = (name) => tx.objectStore(name);
  /** @param {string} store @param {string} index */
  const ix = (store, index) => tx.objectStore(store).index(index);
  /** @param {string} store @param {readonly unknown[]} values */
  const putMany = (store, values) => {
    try {
      const target = os(store);
      // All requests are queued before the first await, which is what makes a batch fast.
      return Promise.all(values.map((value) => settle(/** @type {IDBRequest<Key>} */ (target.put(value)))));
    } catch (err) {
      return Promise.reject(toStoreError(err));
    }
  };
  return {
    get: (store, query) => call(() => os(store).get(/** @type {IDBValidKey | IDBKeyRange} */ (toIdbQuery(query)))),
    getAll: (store, query, count) => call(() => os(store).getAll(toIdbQuery(query), count || undefined)),
    getAllKeys: (store, query, count) => call(() => /** @type {IDBRequest<Key[]>} */ (os(store).getAllKeys(toIdbQuery(query), count || undefined))),
    count: (store, query) => call(() => os(store).count(toIdbQuery(query) ?? undefined)),
    put: (store, value) => call(() => /** @type {IDBRequest<Key>} */ (os(store).put(value))),
    add: (store, value) => call(() => /** @type {IDBRequest<Key>} */ (os(store).add(value))),
    putMany,
    delete: (store, query) => call(() => os(store).delete(/** @type {IDBValidKey | IDBKeyRange} */ (toIdbQuery(query)))),
    clear: (store) => call(() => os(store).clear()),
    getFromIndex: (store, index, query) => call(() => ix(store, index).get(/** @type {IDBValidKey | IDBKeyRange} */ (toIdbQuery(query)))),
    getAllFromIndex: (store, index, query, count) => call(() => ix(store, index).getAll(toIdbQuery(query), count || undefined)),
    getAllKeysFromIndex: (store, index, query, count) => call(() => /** @type {IDBRequest<Key[]>} */ (ix(store, index).getAllKeys(toIdbQuery(query), count || undefined))),
    countFromIndex: (store, index, query) => call(() => ix(store, index).count(toIdbQuery(query) ?? undefined)),
    iterate: (store, options, visit) => {
      try {
        return walkCursor(options.index ? ix(store, options.index) : os(store), options, visit);
      } catch (err) {
        return Promise.reject(toStoreError(err));
      }
    },
  };
}

/**
 * @template T
 * @param {IDBDatabase} idb
 * @param {string[]} stores
 * @param {TxMode} mode
 * @param {(tx: StoreOps) => T | Promise<T>} fn
 * @param {TxOptions} [options]
 * @returns {Promise<T>}
 */
async function runIdbTransaction(idb, stores, mode, fn, options) {
  /** @type {IDBTransaction} */
  let tx;
  try {
    tx = options?.durability ? idb.transaction(stores, mode, { durability: options.durability }) : idb.transaction(stores, mode);
  } catch (err) {
    throw toStoreError(err);
  }
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onabort = () => reject(toStoreError(tx.error ?? new StoreError('aborted', 'The transaction was aborted')));
  });
  // The outcome is awaited below; this keeps an early abort from counting as unhandled meanwhile.
  done.catch(() => {});
  /** @type {T} */
  let result;
  try {
    result = await fn(idbOps(tx));
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborting.
    }
    await done.catch(() => {});
    throw err;
  }
  try {
    tx.commit?.();
  } catch {
    // Already finished or aborting; `done` reports which.
  }
  await done;
  return result;
}

/**
 * @param {IDBDatabase} idb
 * @param {IDBTransaction} tx
 * @param {number} oldVersion
 * @param {number} newVersion
 * @returns {UpgradeContext}
 */
function idbUpgradeContext(idb, tx, oldVersion, newVersion) {
  return {
    oldVersion,
    newVersion,
    createStore: (name, { keyPath }) => {
      assertKeyPath(keyPath);
      idb.createObjectStore(name, { keyPath });
    },
    deleteStore: (name) => idb.deleteObjectStore(name),
    hasStore: (name) => idb.objectStoreNames.contains(name),
    createIndex: (store, name, keyPath, opts) => {
      assertKeyPath(keyPath);
      tx.objectStore(store).createIndex(name, keyPath, { unique: Boolean(opts?.unique) });
    },
    deleteIndex: (store, name) => tx.objectStore(store).deleteIndex(name),
    hasIndex: (store, name) => tx.objectStore(store).indexNames.contains(name),
    tx: idbOps(tx),
  };
}

/**
 * @param {IDBDatabase} idb
 * @param {OpenOptions} options
 * @returns {StoreDb}
 */
function wrapIdb(idb, options) {
  let closed = false;
  idb.onversionchange = () => {
    closed = true;
    idb.close();
    options.onVersionChange?.();
  };
  // Fires when the browser closes the connection itself, e.g. after site data was cleared.
  idb.onclose = () => {
    closed = true;
  };
  /** @type {StoreDbInfo['transaction']} */
  const transaction = (stores, mode, fn, txOptions) => {
    if (closed) return Promise.reject(new StoreError('closed', 'The database connection is closed'));
    return runIdbTransaction(idb, Array.isArray(stores) ? stores : [stores], mode, fn, txOptions);
  };
  return {
    ...opsOver(transaction),
    name: idb.name,
    version: idb.version,
    backend: 'indexeddb',
    persistent: true,
    fallbackReason: null,
    storeNames: () => [...idb.objectStoreNames],
    isClosed: () => closed,
    transaction,
    close: () => {
      closed = true;
      idb.close();
    },
  };
}

/**
 * @param {IDBFactory} factory
 * @param {string} name
 * @param {number} version
 * @param {Upgrade | undefined} upgrade
 * @param {OpenOptions} options
 * @returns {Promise<StoreDb>}
 */
function openIndexedDb(factory, name, version, upgrade, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let blocked = false;
    /** @type {unknown} */
    let upgradeError = null;
    /** @param {StoreError} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new StoreError(blocked ? 'blocked' : 'timeout', blocked ? 'Another tab keeps an older version of the database open' : 'The database did not open in time')),
      options.timeoutMs ?? OPEN_TIMEOUT_MS,
    );
    /** @type {IDBOpenDBRequest} */
    let req;
    try {
      req = factory.open(name, version);
    } catch (err) {
      fail(toStoreError(err));
      return;
    }
    req.onblocked = () => {
      blocked = true;
      options.onBlocked?.();
    };
    req.onupgradeneeded = (event) => {
      // Once the upgrade runs, the open finishes on its own; a large migration may take a while.
      clearTimeout(timer);
      const tx = /** @type {IDBTransaction} */ (req.transaction);
      /** @param {unknown} err */
      const abort = (err) => {
        upgradeError ??= err;
        try {
          tx.abort();
        } catch {
          // Already finished.
        }
      };
      try {
        const pending = upgrade?.(idbUpgradeContext(req.result, tx, event.oldVersion, event.newVersion ?? version));
        if (pending && typeof pending.then === 'function') pending.then(undefined, abort);
      } catch (err) {
        abort(err);
      }
    };
    req.onsuccess = () => {
      const idb = req.result;
      if (settled) {
        // The caller already moved on to the memory stand-in after a timeout.
        idb.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(wrapIdb(idb, options));
    };
    req.onerror = (event) => {
      event.preventDefault();
      fail(toStoreError(upgradeError ?? req.error));
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Memory backend

/** @typedef {{ key: Key, value: unknown }} MemoryEntry */
/** @typedef {{ keyPath: string | string[], unique: boolean }} MemoryIndex */
/** @typedef {{ keyPath: string | string[], indexes: Map<string, MemoryIndex>, entries: MemoryEntry[] }} MemoryTable */
/** @typedef {{ closed: boolean, onVersionChange?: () => void }} MemoryConnection */
/** @typedef {{ version: number, tables: Map<string, MemoryTable>, connections: Set<MemoryConnection> }} MemoryDatabase */
/**
 * One undo step: the entry a key had before a write, or the whole entry list before a bulk delete.
 * @typedef {{ table: MemoryTable, key: Key, before: MemoryEntry | null } | { table: MemoryTable, entries: MemoryEntry[] }} JournalEntry
 */

/** Memory databases live as long as the page, so closing and reopening keeps their data. */
/** @type {Map<string, MemoryDatabase>} */
const memoryDatabases = new Map();

/**
 * Binary search over the sorted entries of a table.
 * @param {MemoryEntry[]} entries
 * @param {Key} key
 * @returns {{ found: boolean, at: number }}
 */
function locate(entries, key) {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const order = compareKeys(entries[mid].key, key);
    if (order === 0) return { found: true, at: mid };
    if (order < 0) lo = mid + 1;
    else hi = mid;
  }
  return { found: false, at: lo };
}

/**
 * Sets or removes one entry; entries are replaced, never changed in place, so a shallow copy of
 * the entry list is a full snapshot.
 * @param {MemoryTable} table
 * @param {Key} key
 * @param {MemoryEntry | null} entry
 */
function writeEntry(table, key, entry) {
  const { found, at } = locate(table.entries, key);
  if (entry) table.entries.splice(at, found ? 1 : 0, entry);
  else if (found) table.entries.splice(at, 1);
}

/**
 * Records of an index in index order (ties by primary key). Records without a valid index key
 * are not part of the index, as in IndexedDB.
 * @param {MemoryTable} table
 * @param {string} name
 * @returns {Array<{ indexKey: Key, entry: MemoryEntry }>}
 */
function indexRows(table, name) {
  const index = table.indexes.get(name);
  if (!index) throw new StoreError('not_found', `No index "${name}"`);
  /** @type {Array<{ indexKey: Key, entry: MemoryEntry }>} */
  const rows = [];
  for (const entry of table.entries) {
    const indexKey = extractKey(entry.value, index.keyPath);
    if (isValidKey(indexKey)) rows.push({ indexKey, entry });
  }
  // The entries are already in primary-key order and the sort is stable.
  return rows.sort((a, b) => compareKeys(a.indexKey, b.indexKey));
}

/**
 * @param {MemoryTable} table
 * @param {unknown} value
 * @param {Key} key
 */
function checkUnique(table, value, key) {
  for (const [name, index] of table.indexes) {
    if (!index.unique) continue;
    const indexKey = extractKey(value, index.keyPath);
    if (!isValidKey(indexKey)) continue;
    const clash = table.entries.some((entry) => compareKeys(entry.key, key) !== 0 && isValidKey(extractKey(entry.value, index.keyPath)) && compareKeys(extractKey(entry.value, index.keyPath), indexKey) === 0);
    if (clash) throw new StoreError('constraint', `Index "${name}" already has this key`);
  }
}

/**
 * @param {Map<string, MemoryTable>} tables
 * @returns {Map<string, MemoryTable>}
 */
function snapshotTables(tables) {
  return new Map([...tables].map(([name, t]) => [name, { keyPath: t.keyPath, indexes: new Map(t.indexes), entries: t.entries.slice() }]));
}

/**
 * One memory transaction: a guard for scope and mode, an undo journal, and the first failed
 * write, which dooms the transaction like an aborting request in IndexedDB.
 * @param {MemoryDatabase} database
 * @param {string[] | null} scope  null: every table (upgrades)
 * @param {TxMode | 'versionchange'} mode
 */
function memoryTransaction(database, scope, mode) {
  /** @type {JournalEntry[]} */
  const journal = [];
  /** @type {StoreError | null} */
  let failure = null;
  let finished = false;

  /** @param {string} store @param {boolean} write */
  const table = (store, write) => {
    if (finished) throw new StoreError('inactive', 'The transaction has finished');
    if (scope && !scope.includes(store)) throw new StoreError('not_found', `Store "${store}" is not part of this transaction`);
    const found = database.tables.get(store);
    if (!found) throw new StoreError('not_found', `No store "${store}"`);
    if (write && mode === 'readonly') throw new StoreError('read_only', 'The transaction is read-only');
    return found;
  };

  /**
   * @template T
   * @param {() => T} fn
   * @returns {Promise<T>}
   */
  const run = (fn) => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  };

  /** @param {MemoryTable} t @param {Key} key @param {MemoryEntry | null} entry */
  const write = (t, key, entry) => {
    const { found, at } = locate(t.entries, key);
    journal.push({ table: t, key, before: found ? t.entries[at] : null });
    writeEntry(t, key, entry);
  };

  /** @param {string} store @param {unknown} value @param {boolean} overwrite */
  const store1 = (store, value, overwrite) => {
    const t = table(store, true);
    if (failure) throw new StoreError('inactive', 'The transaction is aborting');
    const copy = clone(value);
    const key = extractKey(copy, t.keyPath);
    if (!isValidKey(key)) throw new StoreError('data', `The record has no valid key at "${String(t.keyPath)}"`);
    try {
      if (!overwrite && locate(t.entries, key).found) throw new StoreError('constraint', 'A record with this key exists');
      checkUnique(t, copy, key);
    } catch (err) {
      failure ??= toStoreError(err);
      throw err;
    }
    write(t, key, { key, value: copy });
    return clone(key);
  };

  /** @param {string} store @param {KeyQuery | null | undefined} query @param {number} [count] */
  const entriesOf = (store, query, count) => {
    const match = matcher(query);
    const limit = limitOf(count);
    /** @type {MemoryEntry[]} */
    const out = [];
    for (const entry of table(store, false).entries) {
      if (out.length >= limit) break;
      if (match(entry.key)) out.push(entry);
    }
    return out;
  };

  /** @param {string} store @param {string} index @param {KeyQuery | null | undefined} query @param {number} [count] */
  const rowsOf = (store, index, query, count) => {
    const match = matcher(query);
    return indexRows(table(store, false), index)
      .filter((row) => match(row.indexKey))
      .slice(0, limitOf(count));
  };

  /** @type {StoreOps} */
  const ops = {
    get: (store, query) => run(() => clone(entriesOf(store, required(query), 1)[0]?.value)),
    getAll: (store, query, count) => run(() => entriesOf(store, query, count).map((e) => clone(e.value))),
    getAllKeys: (store, query, count) => run(() => entriesOf(store, query, count).map((e) => clone(e.key))),
    count: (store, query) => run(() => entriesOf(store, query).length),
    put: (store, value) => run(() => store1(store, value, true)),
    add: (store, value) => run(() => store1(store, value, false)),
    putMany: (store, values) => run(() => values.map((value) => store1(store, value, true))),
    delete: (store, query) =>
      run(() => {
        const t = table(store, true);
        const match = matcher(required(query));
        journal.push({ table: t, entries: t.entries });
        t.entries = t.entries.filter((entry) => !match(entry.key));
      }),
    clear: (store) =>
      run(() => {
        const t = table(store, true);
        journal.push({ table: t, entries: t.entries });
        t.entries = [];
      }),
    getFromIndex: (store, index, query) => run(() => clone(rowsOf(store, index, required(query), 1)[0]?.entry.value)),
    getAllFromIndex: (store, index, query, count) => run(() => rowsOf(store, index, query, count).map((r) => clone(r.entry.value))),
    getAllKeysFromIndex: (store, index, query, count) => run(() => rowsOf(store, index, query, count).map((r) => clone(r.entry.key))),
    countFromIndex: (store, index, query) => run(() => rowsOf(store, index, query).length),
    iterate: (store, options, visit) =>
      run(() => {
        const rows = options.index
          ? rowsOf(store, options.index, options.query).map((r) => ({ key: r.indexKey, entry: r.entry }))
          : entriesOf(store, options.query).map((entry) => ({ key: entry.key, entry }));
        if (options.direction === 'prev') rows.reverse();
        const limit = limitOf(options.limit);
        let visited = 0;
        for (const row of rows) {
          visited += 1;
          if (visit(clone(row.entry.value), clone(row.key), clone(row.entry.key)) === false || visited >= limit) break;
        }
        return visited;
      }),
  };

  return {
    ops,
    failure: () => failure,
    rollback() {
      finished = true;
      for (let i = journal.length - 1; i >= 0; i -= 1) {
        const step = journal[i];
        if ('entries' in step) step.table.entries = step.entries;
        else writeEntry(step.table, step.key, step.before);
      }
      journal.length = 0;
    },
    commit() {
      finished = true;
      journal.length = 0;
    },
  };
}

/**
 * @param {MemoryDatabase} database
 * @param {number} oldVersion
 * @param {number} newVersion
 * @param {StoreOps} tx
 * @returns {UpgradeContext}
 */
function memoryUpgradeContext(database, oldVersion, newVersion, tx) {
  /** @param {string} name */
  const tableOf = (name) => {
    const t = database.tables.get(name);
    if (!t) throw new StoreError('not_found', `No store "${name}"`);
    return t;
  };
  return {
    oldVersion,
    newVersion,
    createStore: (name, { keyPath }) => {
      assertKeyPath(keyPath);
      if (database.tables.has(name)) throw new StoreError('constraint', `Store "${name}" exists`);
      database.tables.set(name, { keyPath: clone(keyPath), indexes: new Map(), entries: [] });
    },
    deleteStore: (name) => {
      tableOf(name);
      database.tables.delete(name);
    },
    hasStore: (name) => database.tables.has(name),
    createIndex: (store, name, keyPath, opts) => {
      assertKeyPath(keyPath);
      const t = tableOf(store);
      if (t.indexes.has(name)) throw new StoreError('constraint', `Index "${name}" exists`);
      const index = { keyPath: clone(keyPath), unique: Boolean(opts?.unique) };
      t.indexes.set(name, index);
      if (index.unique) {
        const rows = indexRows(t, name);
        if (rows.some((row, i) => i > 0 && compareKeys(rows[i - 1].indexKey, row.indexKey) === 0)) throw new StoreError('constraint', `Index "${name}" would not be unique`);
      }
    },
    deleteIndex: (store, name) => {
      if (!tableOf(store).indexes.delete(name)) throw new StoreError('not_found', `No index "${name}"`);
    },
    hasIndex: (store, name) => tableOf(store).indexes.has(name),
    tx,
  };
}

/**
 * @param {string} name
 * @param {number} version
 * @param {Upgrade | undefined} upgrade
 * @param {OpenOptions} options
 * @param {FallbackReason} reason
 * @returns {Promise<StoreDb>}
 */
async function openMemory(name, version, upgrade, options, reason) {
  let database = memoryDatabases.get(name);
  if (!database) {
    database = { version: 0, tables: new Map(), connections: new Set() };
    memoryDatabases.set(name, database);
  }
  if (version < database.version) throw new StoreError('version', `The database is at version ${database.version}, newer than ${version}`);
  if (version > database.version) {
    for (const other of database.connections) {
      other.closed = true;
      other.onVersionChange?.();
    }
    database.connections.clear();
    const before = snapshotTables(database.tables);
    const tx = memoryTransaction(database, null, 'versionchange');
    try {
      await upgrade?.(memoryUpgradeContext(database, database.version, version, tx.ops));
      const failure = tx.failure();
      if (failure) throw failure;
      tx.commit();
    } catch (err) {
      tx.rollback();
      database.tables = before;
      throw toStoreError(err);
    }
    database.version = version;
  }
  const db = database;
  /** @type {MemoryConnection} */
  const connection = { closed: false, onVersionChange: options.onVersionChange };
  db.connections.add(connection);

  /** @type {StoreDbInfo['transaction']} */
  const transaction = async (stores, mode, fn) => {
    if (connection.closed) throw new StoreError('closed', 'The database connection is closed');
    const scope = Array.isArray(stores) ? stores : [stores];
    const missing = scope.find((store) => !db.tables.has(store));
    if (missing) throw new StoreError('not_found', `No store "${missing}"`);
    const tx = memoryTransaction(db, scope, mode);
    /** @type {Awaited<ReturnType<typeof fn>>} */
    let result;
    try {
      result = await fn(tx.ops);
    } catch (err) {
      tx.rollback();
      throw err;
    }
    const failure = tx.failure();
    if (failure) {
      tx.rollback();
      throw failure;
    }
    tx.commit();
    return result;
  };

  return {
    ...opsOver(transaction),
    name,
    version,
    backend: 'memory',
    persistent: false,
    fallbackReason: reason,
    storeNames: () => [...db.tables.keys()].sort(),
    isClosed: () => connection.closed,
    transaction,
    close: () => {
      connection.closed = true;
      db.connections.delete(connection);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Public entry points

/**
 * @param {StoreError} err
 * @returns {FallbackReason}
 */
function fallbackReasonOf(err) {
  if (err.code === 'blocked' || err.code === 'timeout' || err.code === 'version' || err.code === 'unavailable') return err.code;
  return 'error';
}

/**
 * Opens (and creates or upgrades) a database. When IndexedDB is missing or fails to open, the
 * result is the memory stand-in with `persistent: false` and the reason, unless
 * `options.fallback` is false.
 * @param {string} name
 * @param {number} version  a positive integer
 * @param {Upgrade} [upgrade]  runs when the stored version is lower than `version`
 * @param {OpenOptions} [options]
 * @returns {Promise<StoreDb>}
 */
export async function openDb(name, version, upgrade, options = {}) {
  assertDbName(name);
  if (!Number.isInteger(version) || version < 1) throw new StoreError('data', 'A database version is a positive integer');
  const factory = options.factory === undefined ? defaultFactory() : options.factory;
  if (!factory) {
    if (options.fallback === false) throw new StoreError('unavailable', 'IndexedDB is not available');
    return openMemory(name, version, upgrade, options, 'unsupported');
  }
  try {
    return await openIndexedDb(factory, name, version, upgrade, options);
  } catch (err) {
    const storeError = toStoreError(err);
    if (options.fallback === false) throw storeError;
    const reason = fallbackReasonOf(storeError);
    console.warn(`[store] IndexedDB could not open "${name}" (${reason}: ${storeError.message}); data is kept in memory for this page only`);
    return openMemory(name, version, upgrade, options, reason);
  }
}

/**
 * Deletes a database (and its memory stand-in). Open connections of this page close first.
 * @param {string} name
 * @param {{ factory?: IDBFactory | null }} [options]
 * @returns {Promise<void>}
 */
export async function deleteDb(name, options = {}) {
  assertDbName(name);
  const database = memoryDatabases.get(name);
  if (database) {
    for (const connection of database.connections) {
      connection.closed = true;
      connection.onVersionChange?.();
    }
    memoryDatabases.delete(name);
  }
  const factory = options.factory === undefined ? defaultFactory() : options.factory;
  if (!factory) return;
  await call(() => factory.deleteDatabase(name));
}
