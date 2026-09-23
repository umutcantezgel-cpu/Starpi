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

/**
 * Reads a credential from session storage first, then from local storage (remembered keys).
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
 * Stores a credential either for this tab only (sessionStorage) or persistently (localStorage).
 * @param {string} key
 * @param {string} value
 * @param {boolean} remember
 * @returns {boolean} false when a non-empty value could not be stored
 */
export function writeSecret(key, value, remember) {
  removeSecret(key);
  if (!value) return true;
  if (remember) return writeLocal(key, value);
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
