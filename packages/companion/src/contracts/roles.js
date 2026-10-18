// @ts-check
// Who may do what. The companion knows two roles: the owner, who installed it and may change it,
// and a member, who may use it (ask, read, add notes) but not change its configuration, its secrets
// or who else is paired. A route names the least role it needs; 'public' needs no sign-in.

/** @typedef {'owner' | 'member'} Role */
/** @typedef {Role | 'public'} Access */

/** @type {readonly Role[]} */
export const ROLES = Object.freeze(['owner', 'member']);

/** @type {readonly Access[]} */
export const ACCESS_LEVELS = Object.freeze(['public', 'member', 'owner']);

/** @param {unknown} value @returns {value is Role} */
export const isRole = (value) => ROLES.includes(/** @type {Role} */ (value));

/**
 * True when a signed-in role (or nobody) satisfies what a route needs.
 * @param {Role | null} role
 * @param {Access} needed
 */
export function roleAllows(role, needed) {
  if (needed === 'public') return true;
  if (role === null) return false;
  return needed === 'member' ? isRole(role) : role === 'owner';
}
