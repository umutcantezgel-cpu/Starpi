// @ts-check
// Data classes decide where content may travel. Every request to a language model carries the
// class of the most protected piece of content in it:
//   public     may go to any configured model, local or in the cloud;
//   personal   may go to any configured model; cloud models only when the owner enabled them for
//              personal content (on by default, because the owner configured that cloud model);
//   sensitive  only to models on this machine (loopback); never to a cloud model;
//   secret     never leaves the companion: no model sees it, the answer is a template.
// A request never moves silently to a weaker place: a failing local model is not replaced by a
// cloud model, and the class of a request can only be raised, never lowered, by the code that
// builds it.

/** @typedef {'public' | 'personal' | 'sensitive' | 'secret'} DataClass */
/** @typedef {'none' | 'local' | 'cloud'} Locality */

/** In order of protection, weakest first. @type {readonly DataClass[]} */
export const DATA_CLASSES = Object.freeze(['public', 'personal', 'sensitive', 'secret']);

/** @param {unknown} value @returns {value is DataClass} */
export const isDataClass = (value) => DATA_CLASSES.includes(/** @type {DataClass} */ (value));

/** @param {DataClass} dataClass */
export const classRank = (dataClass) => DATA_CLASSES.indexOf(dataClass);

/**
 * The more protected of two classes.
 * @param {DataClass} a
 * @param {DataClass} b
 * @returns {DataClass}
 */
export const strictest = (a, b) => (classRank(a) >= classRank(b) ? a : b);

/**
 * Whether content of a class may reach a model of the given locality.
 * @param {DataClass} dataClass
 * @param {Locality} locality
 * @param {{ personalToCloud?: boolean }} [policy]
 */
export function mayReach(dataClass, locality, { personalToCloud = true } = {}) {
  if (locality === 'none') return true;
  switch (dataClass) {
    case 'public':
      return true;
    case 'personal':
      return locality === 'local' || personalToCloud;
    case 'sensitive':
      return locality === 'local';
    default:
      return false;
  }
}
