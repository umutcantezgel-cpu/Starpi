// @ts-check
// The actor contract: what the control asks of whatever moves the pointer and the keyboard. An actor
// reports targets (`inspect`, `look`) and performs single steps; it never decides whether a step is
// allowed. Every acting method takes an `expect` description and re-checks it immediately before it
// acts, so a window that moved in between makes the step fail with `target_moved` instead of landing
// somewhere else. Every method honours its abort signal.
//
// In this release the only actor that can run is the mock actor (actor-mock.js). The macOS actor
// (actor-macos.js) is a preview that has not been verified on hardware and cannot be constructed.

/** @typedef {{ ok: true } | { ok: false, code: string }} ActorResult */

/**
 * What an acting method re-checks right before it acts.
 * @typedef {object} Expect
 * @property {string | null} front   app of the frontmost window
 * @property {string | null} app     app of the target window
 * @property {string | null} title   title of the target window (null: not checked)
 * @property {string | null} [role]  role of the focused element (typing)
 * @property {string | null} [label] label of the focused element (typing)
 */

/**
 * A description of the screen for the model: no image, only structure and visible text.
 * @typedef {object} ScreenReport
 * @property {{ app: string | null, title: string | null }} front
 * @property {Array<{ app: string | null, title: string | null, box: import('./classes.js').Box }>} windows
 * @property {Array<{ role: string | null, label: string | null, at: [number, number], focused: boolean }>} elements
 * @property {string[]} lines
 * @property {string | null} dialog
 * @property {{ width: number, height: number } | null} screen
 */

/**
 * @typedef {object} Actor
 * @property {string} kind
 * @property {boolean} preview   true for an actor that was not verified on real hardware
 * @property {(q: { action: string, at?: [number, number] | null, signal?: AbortSignal }) => Promise<import('./classes.js').Seen>} inspect
 * @property {(o: { signal?: AbortSignal }) => Promise<{ ok: true, screen: ScreenReport } | { ok: false, code: string }>} look
 * @property {(o: { at: [number, number], expect: Expect, signal?: AbortSignal }) => Promise<ActorResult>} click
 * @property {(o: { at: [number, number], direction: string, lines: number, expect: Expect, signal?: AbortSignal }) => Promise<ActorResult>} scroll
 * @property {(o: { key: string, expect: Expect, signal?: AbortSignal }) => Promise<ActorResult>} press
 * @property {(o: { text: string, expect: Expect, signal?: AbortSignal }) => Promise<ActorResult>} typePiece
 * @property {(o: { app: string, signal?: AbortSignal }) => Promise<ActorResult>} open
 */

/** The methods every actor brings. */
export const ACTOR_METHODS = Object.freeze(['inspect', 'look', 'click', 'scroll', 'press', 'typePiece', 'open']);

/**
 * Throws unless the value has the shape of an actor that may run.
 * @param {unknown} actor
 * @returns {Actor}
 */
export function assertActor(actor) {
  const a = /** @type {Record<string, unknown>} */ (actor ?? {});
  const missing = ACTOR_METHODS.filter((name) => typeof a[name] !== 'function');
  if (typeof a.kind !== 'string' || missing.length > 0) throw new TypeError(`computer: not an actor (missing ${missing.join(', ') || 'kind'})`);
  if (a.preview === true) throw new TypeError(`computer: the ${a.kind} actor is a preview and cannot run in this release`);
  return /** @type {Actor} */ (actor);
}
