// @ts-check
// The pairing between this browser and the local companion, and what the browser remembers of it.
//
// Pairing: the user starts `starpi-companion pair`, which prints an 8-character code, and enters
// it here. POST /v1/session/pair answers in one of two ways, decided by the companion from the
// page's origin:
//   cookie  (Mode A) the app was served by the companion: an HttpOnly cookie plus a CSRF value;
//   bearer  (Mode B) the app runs on an allowed origin: a 32-byte token bound to that origin.
// Either answer brings the companion's Ed25519 public key and its key id. The secret (token or
// CSRF value) is sealed with AES-GCM under a key made with `extractable: false`, so its bytes
// never leave WebCrypto, and kept with the rest of the link in the IndexedDB database
// `starpi-companion`; nothing about the companion is synced or sent anywhere else.
//
// The voice input reaches the companion's voice relay the same way: with the token (Mode B), or
// with the session cookie and the CSRF value (Mode A, where the page and the companion share an
// origin).
//
// No network at boot: restore() only reads what is stored. The app talks to the companion when the
// user opens its card or tab, asks a question that searches it, or pairs.
//
// Rollback detection: every answer carries the companion's signed audit head. Each one is checked
// against the public key from the pairing, and the highest verified head is stored per companion
// (by key id). A different hash at the stored number, a newer head whose chain no longer holds the
// stored record (GET /v1/audit/head?seq=), or a current head (GET /v1/audit/head) with a lower
// number than the stored one means the companion's data were put back or replaced: the state
// becomes `rollback` or `fork` and the app shows a red banner until the user accepts the
// companion's current state. A lower head alone is no proof: answers to requests made at the same
// time can arrive out of order. So the current head is asked for first, and the late head only has
// to be the chain's own record at its number.
import { setCompanionPaired } from '../providers.js';
import { setCompanionVoiceLink } from '../voice/sources/companion.js';
import { fromBase64url, toBase64url } from '../core/hash.js';
import { readLocal, removeLocal, writeLocal } from '../storage.js';
import { asHead, CompanionError, createCompanionClient, DEFAULT_COMPANION_ORIGIN, importIdentityKey, keyIdMatches, loopbackOrigin, verifyHead } from './client.js';

/** @typedef {import('./client.js').SignedHead} SignedHead */
/** @typedef {import('./client.js').CompanionClient} CompanionClient */
/** @typedef {import('./client.js').FetchLike} FetchLike */

/** The IndexedDB database of the companion link (never part of the synced store). */
export const LINK_DB = 'starpi-companion';
export const LINK_DB_VERSION = 1;
/** A flag in localStorage while a link is stored, so a browser that never paired opens no database. */
export const LINK_MARKER = 'starpi_companion_linked';
/** What a pairing code looks like once spaces and dashes are dropped. */
export const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * @typedef {object} SealedSecret
 * @property {string} iv    base64url, 12 bytes
 * @property {string} data  base64url ciphertext with its tag
 */

/**
 * The stored link to a paired companion.
 * @typedef {object} StoredLink
 * @property {'current'} id
 * @property {'cookie' | 'bearer'} mode
 * @property {string} origin
 * @property {string} session
 * @property {'owner' | 'member'} role
 * @property {string} expiresAt
 * @property {string} publicKey   raw Ed25519 key, base64url
 * @property {string} keyId       SHA-256 of the raw key, hex
 * @property {string} pairedAt
 * @property {SealedSecret} secret  the bearer token or the CSRF value
 */

/**
 * The highest verified head of one companion.
 * @typedef {{ keyId: string, seq: number, hash: string, sig: string, at: string }} StoredHead
 */

/**
 * Where the link lives (IndexedDB in the app, a map in tests).
 * @typedef {object} LinkStore
 * @property {() => Promise<StoredLink | null>} load
 * @property {(link: StoredLink) => Promise<void>} save
 * @property {() => Promise<void>} clear
 * @property {(keyId: string) => Promise<StoredHead | null>} head
 * @property {(head: StoredHead) => Promise<void>} saveHead
 * @property {() => Promise<CryptoKey>} sealKey  the non-extractable AES-GCM key (made on first use)
 */

/**
 * `unknown`: nothing checked yet; `ok`: the head verifies and is not older than the stored one;
 * `rollback`: older than the stored one; `fork`: another history at a number the browser knows;
 * `invalid`: the signature does not verify; `unsupported`: this browser cannot check Ed25519.
 * @typedef {'unknown' | 'ok' | 'rollback' | 'fork' | 'invalid' | 'unsupported'} AuditState
 */

/**
 * @typedef {object} PairingState
 * @property {'unpaired' | 'paired'} phase
 * @property {'cookie' | 'bearer' | null} mode
 * @property {string} origin          the companion's origin (the default when unpaired)
 * @property {'owner' | 'member' | null} role
 * @property {string | null} session
 * @property {string | null} expiresAt
 * @property {string | null} keyId
 * @property {boolean} lost           the companion no longer knows this browser's session
 * @property {{ state: AuditState, stored: StoredHead | null, reported: SignedHead | null }} audit
 */

/**
 * The IndexedDB store of the link. A browser without IndexedDB keeps it for the page only.
 * @returns {LinkStore}
 */
export function idbLinkStore() {
  /** @type {Promise<import('../store/idb.js').StoreDb> | null} */
  let opening = null;
  const db = () => {
    opening ??= import('../store/idb.js').then(({ openDb }) =>
      openDb(LINK_DB, LINK_DB_VERSION, ({ oldVersion, createStore }) => {
        if (oldVersion < 1) {
          createStore('link', { keyPath: 'id' });
          createStore('heads', { keyPath: 'keyId' });
          createStore('keys', { keyPath: 'id' });
        }
      }),
    );
    return opening;
  };
  return {
    load: async () => (await (await db()).get('link', 'current')) ?? null,
    save: async (link) => {
      await (await db()).put('link', link);
    },
    clear: async () => {
      await (await db()).delete('link', 'current');
    },
    head: async (keyId) => (await (await db()).get('heads', keyId)) ?? null,
    saveHead: async (head) => {
      await (await db()).put('heads', head);
    },
    async sealKey() {
      const d = await db();
      const stored = await d.get('keys', 'seal');
      if (stored?.key) return stored.key;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await d.put('keys', { id: 'seal', key });
      return key;
    },
  };
}

/** @param {{ origin: string, session: string, mode: string }} link */
const additionalData = (link) => new TextEncoder().encode(`starpi-companion-link\n${link.mode}\n${link.origin}\n${link.session}`);

/**
 * Seals a secret of a link.
 * @param {CryptoKey} key
 * @param {string} secret
 * @param {{ origin: string, session: string, mode: string }} link
 * @returns {Promise<SealedSecret>}
 */
export async function sealSecret(key, secret, link) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(link) }, key, new TextEncoder().encode(secret)));
  return { iv: toBase64url(iv), data: toBase64url(data) };
}

/**
 * Opens a sealed secret; null when it does not open (another key, a changed link).
 * @param {CryptoKey} key
 * @param {SealedSecret} sealed
 * @param {{ origin: string, session: string, mode: string }} link
 */
export async function openSecret(key, sealed, link) {
  const iv = fromBase64url(sealed?.iv ?? '');
  const data = fromBase64url(sealed?.data ?? '');
  if (!iv || iv.length !== 12 || !data) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(link) }, key, data));
  } catch {
    return null;
  }
}

/** What a person typed, reduced to the code alphabet. @param {unknown} input */
export const normalizeCode = (input) => (typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '') : '');

/**
 * Compares a verified head with the stored highest one.
 * @param {SignedHead} head
 * @param {StoredHead | null} stored
 * @returns {'first' | 'same' | 'newer' | 'rollback' | 'fork'}
 */
export function compareHeads(head, stored) {
  if (!stored) return 'first';
  if (head.seq < stored.seq) return 'rollback';
  if (head.seq === stored.seq) return head.hash === stored.hash ? 'same' : 'fork';
  return 'newer';
}

/**
 * @param {object} [options]
 * @param {LinkStore} [options.store]
 * @param {FetchLike} [options.fetch]
 * @param {string | null} [options.selfOrigin]  the page's own origin when the companion serves the app (Mode A)
 * @param {() => number} [options.now]
 * @param {(link: import('../voice/sources/shared.js').CompanionLink | null) => unknown} [options.voiceLink]
 * @param {{ get(): boolean, set(on: boolean): void }} [options.marker]  whether a link is stored
 */
export function createPairing(options = {}) {
  const store = options.store ?? idbLinkStore();
  const marker = options.marker ?? {
    get: () => readLocal(LINK_MARKER) === '1',
    set: (/** @type {boolean} */ on) => (on ? writeLocal(LINK_MARKER, '1') : removeLocal(LINK_MARKER)),
  };
  const now = options.now ?? (() => Date.now());
  const voiceLink = options.voiceLink ?? setCompanionVoiceLink;
  const selfOrigin = options.selfOrigin ? loopbackOrigin(options.selfOrigin) : null;

  /** @type {StoredLink | null} */
  let link = null;
  /** @type {CompanionClient | null} */
  let client = null;
  /** @type {{ key: CryptoKey, keyId: string } | null} */
  let identity = null;
  /** @type {PairingState} */
  let state = blank(selfOrigin ?? DEFAULT_COMPANION_ORIGIN);
  /** @type {Set<(s: PairingState) => void>} */
  const listeners = new Set();
  /** @type {SignedHead | null} */
  let nextHead = null;
  /** @type {Promise<void> | null} */
  let checking = null;
  /** The head checked last, whatever the verdict: the check's own requests carry it again. */
  /** @type {SignedHead | null} */
  let lastChecked = null;
  /** @type {Promise<PairingState> | null} */
  let restoring = null;

  /** @param {string} origin @returns {PairingState} */
  function blank(origin) {
    return { phase: 'unpaired', mode: null, origin, role: null, session: null, expiresAt: null, keyId: null, lost: false, audit: { state: 'unknown', stored: null, reported: null } };
  }

  /** @param {Partial<PairingState>} patch */
  function update(patch) {
    state = { ...state, ...patch };
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        console.warn('[starpi] a companion listener failed', err);
      }
    }
  }

  /** @param {Partial<PairingState['audit']>} patch */
  const setAudit = (patch) => update({ audit: { ...state.audit, ...patch } });

  /** @param {SignedHead} head */
  function observe(head) {
    if (!identity) return;
    nextHead = head;
    checking ??= drain().finally(() => {
      checking = null;
    });
  }

  async function drain() {
    while (nextHead) {
      const head = nextHead;
      nextHead = null;
      try {
        await check(head);
      } catch (err) {
        // A failed fork check (the companion went away) decides nothing; the next answer tries again.
        if (!(err instanceof CompanionError)) console.warn('[starpi] the companion audit check failed', err);
      }
    }
  }

  /**
   * The companion's verified head of record `seq` now; null when its chain has no such record or the
   * answer does not verify.
   * @param {{ key: CryptoKey, keyId: string }} own
   * @param {number} seq
   */
  async function headAt(own, seq) {
    const at = await /** @type {CompanionClient} */ (client).request('GET', '/v1/audit/head', { query: { seq } }).catch((err) => {
      if (err instanceof CompanionError && err.code === 'audit_seq_unknown') return { head: null };
      throw err;
    });
    const head = asHead(at?.head);
    return head && head.seq === seq && (await verifyHead(head, own)) ? head : null;
  }

  /** @param {SignedHead} head */
  async function check(head) {
    const own = identity;
    if (!own || !link) return;
    if (lastChecked && lastChecked.seq === head.seq && lastChecked.hash === head.hash) return;
    lastChecked = head;
    if (!(await verifyHead(head, own))) {
      setAudit({ state: 'invalid', reported: head });
      return;
    }
    const stored = await store.head(own.keyId);
    /** The head the verdict is about: the one reported, or the companion's current one. */
    let judged = head;
    let verdict = compareHeads(head, stored);
    if (verdict === 'rollback' && stored) {
      // Answers can arrive out of order, so an older head may be honest and only late. Ask where the
      // chain stands now: it is a rollback only when the current head is older than the stored one,
      // and the late head must be the chain's own record at its number (otherwise: another history).
      const answer = await /** @type {CompanionClient} */ (client).request('GET', '/v1/audit/head');
      const current = asHead(answer?.head);
      if (!current) throw new CompanionError('bad_response');
      if (!(await verifyHead(current, own))) {
        setAudit({ state: 'invalid', reported: current });
        return;
      }
      lastChecked = current;
      if (current.seq >= stored.seq) {
        const earlier = await headAt(own, head.seq);
        if (!earlier || earlier.hash !== head.hash) {
          // Reported is the current head: accepting takes the companion's state, not the stray head.
          setAudit({ state: 'fork', stored, reported: current });
          return;
        }
      }
      judged = current;
      verdict = compareHeads(current, stored);
    }
    if (verdict === 'rollback' || verdict === 'fork') {
      setAudit({ state: verdict, stored, reported: judged });
      return;
    }
    if (verdict === 'newer' && stored) {
      // The stored record must still be part of the companion's chain.
      const earlier = await headAt(own, stored.seq);
      if (!earlier || earlier.hash !== stored.hash) {
        setAudit({ state: 'fork', stored, reported: judged });
        return;
      }
    }
    if (identity !== own) return;
    // A rollback or fork stays until the user accepts the companion's state: a later head that fits
    // the stored one does not make the banner go away.
    if (state.audit.state === 'rollback' || state.audit.state === 'fork') return;
    /** @type {StoredHead} */
    const next = verdict === 'same' && stored ? stored : { keyId: own.keyId, seq: judged.seq, hash: judged.hash, sig: judged.sig, at: new Date(now()).toISOString() };
    if (verdict !== 'same') await store.saveHead(next);
    setAudit({ state: 'ok', stored: next, reported: judged });
  }

  /**
   * Makes the client of a link (with its secret opened) and the identity key.
   * @param {StoredLink} stored
   * @param {string} secret
   */
  async function connect(stored, secret) {
    link = stored;
    lastChecked = null;
    client = createCompanionClient({
      origin: stored.origin,
      auth: stored.mode === 'bearer' ? { kind: 'bearer', token: secret } : { kind: 'cookie', csrf: secret },
      fetch: options.fetch,
      onHead: observe,
    });
    try {
      identity = { key: await importIdentityKey(stored.publicKey), keyId: stored.keyId };
    } catch {
      identity = null;
    }
    voiceLink(stored.mode === 'bearer' ? { origin: stored.origin, token: secret } : { origin: stored.origin, csrf: secret });
    const storedHead = await store.head(stored.keyId).catch(() => null);
    update({
      phase: 'paired',
      mode: stored.mode,
      origin: stored.origin,
      role: stored.role,
      session: stored.session,
      expiresAt: stored.expiresAt,
      keyId: stored.keyId,
      lost: false,
      audit: { state: identity ? 'unknown' : 'unsupported', stored: storedHead, reported: null },
    });
  }

  function disconnect() {
    link = null;
    client = null;
    identity = null;
    nextHead = null;
    lastChecked = null;
    voiceLink(null);
  }

  /** @param {unknown} err */
  async function noticeLost(err) {
    if (err instanceof CompanionError && err.code === 'unauthenticated' && link) {
      const origin = link.origin;
      disconnect();
      marker.set(false);
      await store.clear().catch(() => {});
      update({ ...blank(origin), lost: true });
    }
  }

  /**
   * A JSON call to the paired companion; a session the companion no longer knows unpairs.
   * @param {'GET' | 'POST' | 'PUT' | 'DELETE'} method
   * @param {string} path
   * @param {import('./client.js').RequestOptions} [opts]
   * @returns {Promise<any>}
   */
  async function call(method, path, opts) {
    if (!client) throw new CompanionError('not_paired');
    try {
      return await client.request(method, path, opts);
    } catch (err) {
      await noticeLost(err);
      throw err;
    }
  }

  return {
    /** @returns {PairingState} */
    state: () => state,
    /**
     * @param {(s: PairingState) => void} fn
     * @returns {() => void}
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Whether the app is served by the companion (Mode A). */
    selfServed: () => selfOrigin !== null,
    /**
     * Loads the stored link (no network). A link that is gone, has expired or whose secret does not
     * open is dropped, flag and all. Whenever the flag said "linked" and no pairing came of it, the
     * listeners hear the unpaired state, so the pickers (which offered the companion on the flag
     * alone) stop offering it; a link that only could not be read keeps its flag for the next page.
     * @returns {Promise<PairingState>}
     */
    restore() {
      restoring ??= (async () => {
        if (!marker.get()) return state;
        /** @param {boolean} forget */
        const unusable = async (forget) => {
          if (forget) {
            marker.set(false);
            await store.clear().catch(() => {});
          }
          update({});
          return state;
        };
        /** @type {StoredLink | null} */
        let stored;
        try {
          stored = await store.load();
        } catch (err) {
          console.warn('[starpi] the companion link could not be read', err);
          return unusable(false);
        }
        if (!stored) return unusable(true);
        if (selfOrigin && stored.origin !== selfOrigin) return unusable(false);
        const secret = await openSecret(await store.sealKey(), stored.secret, stored).catch(() => null);
        if (!secret || !(Date.parse(stored.expiresAt) > now())) return unusable(true);
        await connect(stored, secret);
        return state;
      })();
      return restoring;
    },
    /** The client of the paired companion, or null. */
    client: () => client,
    /**
     * Asks a companion whether it is there (GET /v1/hello, no credentials).
     * @param {string} [origin]
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async probe(origin, opts = {}) {
      const target = loopbackOrigin(selfOrigin ?? origin ?? state.origin);
      if (!target) throw new CompanionError('origin_invalid');
      return createCompanionClient({ origin: target, fetch: options.fetch }).hello(opts);
    },
    /**
     * Pairs with the code the companion printed.
     * @param {{ code: string, origin?: string, label?: string, signal?: AbortSignal }} input
     * @returns {Promise<PairingState>}
     */
    async pair({ code, origin, label, signal }) {
      const typed = normalizeCode(code);
      if (!CODE_PATTERN.test(typed)) throw new CompanionError('code_format');
      const target = loopbackOrigin(selfOrigin ?? origin ?? state.origin);
      if (!target) throw new CompanionError('origin_invalid');
      const probe = createCompanionClient({ origin: target, fetch: options.fetch });
      const answer = await probe.request('POST', '/v1/session/pair', { body: { code: typed, ...(label ? { label: label.slice(0, 40) } : {}) }, signal });
      const mode = answer?.mode;
      const secret = mode === 'bearer' ? answer?.token : mode === 'cookie' ? answer?.csrf : null;
      if ((mode !== 'bearer' && mode !== 'cookie') || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(secret) || typeof answer.session !== 'string') throw new CompanionError('bad_response');
      if (!(await keyIdMatches(answer.publicKey, answer.keyId))) throw new CompanionError('identity_invalid');
      const base = { mode, origin: target, session: String(answer.session).slice(0, 64) };
      /** @type {StoredLink} */
      const stored = {
        id: 'current',
        ...base,
        role: answer.role === 'owner' ? 'owner' : 'member',
        expiresAt: typeof answer.expiresAt === 'string' ? answer.expiresAt : new Date(now() + 30 * 86_400_000).toISOString(),
        publicKey: answer.publicKey,
        keyId: answer.keyId,
        pairedAt: new Date(now()).toISOString(),
        secret: await sealSecret(await store.sealKey(), secret, base),
      };
      await store.save(stored);
      marker.set(true);
      await connect(stored, secret);
      const head = asHead(answer.auditHead);
      if (head) observe(head);
      return state;
    },
    /**
     * Ends the pairing: the session is ended on the companion (when it answers) and the link is
     * forgotten here. The stored audit head stays, so a re-paired companion is still compared.
     */
    async unpair() {
      const ending = client;
      const origin = state.origin;
      if (ending) await ending.request('POST', '/v1/session/logout', { timeoutMs: 4000 }).catch(() => null);
      disconnect();
      marker.set(false);
      await store.clear().catch(() => {});
      update(blank(selfOrigin ?? origin));
    },
    call,
    /**
     * A streamed call to the paired companion.
     * @param {'GET' | 'POST'} method
     * @param {string} path
     * @param {Parameters<CompanionClient['stream']>[2]} opts
     */
    async stream(method, path, opts) {
      if (!client) throw new CompanionError('not_paired');
      try {
        return await client.stream(method, path, opts);
      } catch (err) {
        await noticeLost(err);
        throw err;
      }
    },
    /** Checks the companion's current head now (GET /v1/audit/head) and waits for the verdict. */
    async checkAudit() {
      if (!client) return state.audit;
      // Asked for: the current head is checked again even when it was checked before.
      lastChecked = null;
      const answer = await call('GET', '/v1/audit/head');
      const head = asHead(answer?.head);
      if (head) observe(head);
      while (checking) await checking;
      return state.audit;
    },
    /**
     * Takes the companion's current, verified head as the new reference: after a restore the user
     * knows about (a backup put back on purpose). Only a head that verifies is taken.
     */
    async acceptCurrent() {
      const own = identity;
      const head = state.audit.reported;
      if (!own || !head || !(await verifyHead(head, own))) return false;
      /** @type {StoredHead} */
      const next = { keyId: own.keyId, seq: head.seq, hash: head.hash, sig: head.sig, at: new Date(now()).toISOString() };
      await store.saveHead(next);
      setAudit({ state: 'ok', stored: next, reported: head });
      return true;
    },
  };
}

/** @typedef {ReturnType<typeof createPairing>} Pairing */

/** @type {Pairing | null} */
let shared = null;

/** The page's origin when the companion serves this build (profile `companion`, Mode A), else null. */
export function selfServedOrigin() {
  return typeof __STARPI_PROFILE__ === 'string' && __STARPI_PROFILE__ === 'companion' && typeof location !== 'undefined' ? location.origin : null;
}

/**
 * The app's pairing (one per page), whoever asks for it first: the Companion tab, the retrieval
 * source or the chat's companion adapter. Its phase reaches the model pickers (providers.js).
 * @param {{ selfOrigin?: string | null }} [opts]
 */
export function companionPairing(opts = {}) {
  if (!shared) {
    shared = createPairing({ selfOrigin: opts.selfOrigin ?? selfServedOrigin() });
    // The model pickers offer the companion while it is paired.
    shared.subscribe((s) => setCompanionPaired(s.phase === 'paired'));
  }
  return shared;
}
