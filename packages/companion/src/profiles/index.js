// @ts-check
// Profiles: what kind of data an installation deals with (its event types and projections). The
// kernel knows no domain; `minimal` (neutral feeds) is the default and the only built-in profile.
import { fail } from '../lib/errors.js';
import { minimalProfile } from './minimal/index.js';

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} title
 * @property {readonly import('../contracts/event.js').EventType[]} eventTypes
 * @property {readonly import('../store/sqlite.js').Projection[]} projections
 */

/** @type {Readonly<Record<string, Profile>>} */
export const PROFILES = Object.freeze({ minimal: minimalProfile });

export const DEFAULT_PROFILE = 'minimal';

/**
 * @param {string} [name]
 * @returns {Profile}
 */
export function loadProfile(name = DEFAULT_PROFILE) {
  const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : null;
  if (!profile) throw fail('profile_unknown', `unknown profile ${JSON.stringify(name)} (known: ${Object.keys(PROFILES).join(', ')})`);
  return profile;
}
