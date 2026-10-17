// @ts-check
// Web Storage access that never throws (private mode, disabled storage, quota exceeded).

/**
 * @param {'localStorage' | 'sessionStorage'} area
 * @returns {Storage | null}
 */
function storageArea(area) {
  try {
    return globalThis[area] ?? null;
  } catch {
    return null;
  }
}

/** @param {string} key */
export function readLocal(key) {
  try {
    return storageArea('localStorage')?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {boolean} false when the value could not be stored (storage missing, blocked or full)
 */
export function writeLocal(key, value) {
  try {
    const area = storageArea('localStorage');
    if (!area) return false;
    area.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export function removeLocal(key) {
  try {
    storageArea('localStorage')?.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
export function readLocalJson(key, fallback) {
  const raw = readLocal(key);
  if (raw === null) return fallback;
  try {
    return /** @type {T} */ (JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function writeLocalJson(key, value) {
  return writeLocal(key, JSON.stringify(value));
}

// Credentials. Since 3.0 a key is kept for the tab only (sessionStorage); keeping it longer is the
// job of the key vault (ai/keys.js), which stores it encrypted. Plaintext keys in localStorage are
// a 2.x leftover: they are still read until the one-time move (moveSecretToSession) has run, and
// never written again.

/**
 * Reads a credential: this tab's copy, else a plaintext copy an earlier version left in local
 * storage (until it has been moved).
 * @param {string} key
 */
export function readSecret(key) {
  try {
    const session = storageArea('sessionStorage')?.getItem(key);
    if (session) return session;
  } catch {
    // ignore
  }
  return readLocal(key) ?? '';
}

/**
 * Stores a credential for this tab only and removes any plaintext copy in local storage.
 * @param {string} key
 * @param {string} value
 * @param {boolean} [_remember]  ignored: plaintext "remember keys" is gone (use the key vault)
 * @returns {boolean} false when a non-empty value could not be stored
 */
export function writeSecret(key, value, _remember) {
  removeSecret(key);
  if (!value) return true;
  try {
    const area = storageArea('sessionStorage');
    if (!area) return false;
    area.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export function removeSecret(key) {
  removeLocal(key);
  try {
    storageArea('sessionStorage')?.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Moves a plaintext credential from local storage into this tab's session storage. A copy the tab
 * already holds wins; the local copy is removed either way, also when session storage is missing
 * (the key is then gone rather than left in plaintext).
 * @param {string} key
 * @returns {boolean} true when a local copy existed
 */
export function moveSecretToSession(key) {
  const local = readLocal(key);
  if (local === null) return false;
  let session;
  try {
    session = storageArea('sessionStorage')?.getItem(key) ?? '';
  } catch {
    session = '';
  }
  if (!session && local) {
    try {
      storageArea('sessionStorage')?.setItem(key, local);
    } catch {
      // storage full or blocked: the key is dropped below rather than kept in plaintext
    }
  }
  removeLocal(key);
  return true;
}
