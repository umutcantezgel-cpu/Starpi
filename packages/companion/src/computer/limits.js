// @ts-check
// Fixed numbers and names of the experimental computer control. A configuration may shorten the
// durations and tighten the lists (lists.js); it can never stretch a limit set here.

export const COMPUTER_MODULE_ID = 'computer';
export const COMPUTER_MODULE_VERSION = '0.1.0';
/** The vault namespace holding consent, the stop flag and the record of the latest mandate. */
export const COMPUTER_NAMESPACE = 'computer';

/** A mandate lives at most this long; an extension never gives back more than this. */
export const MANDATE_LIMIT_S = 120;
/** The shortest mandate a configuration may ask for. */
export const MANDATE_FLOOR_S = 30;
/** With this little time left no further action starts until the mandate owner extends. */
export const HOLD_BEFORE_END_S = 15;
/**
 * Requests only a person should make (grant consent, start or extend a mandate, decide an approval)
 * are refused while the actor works and for this long after its last action, so the actor can never
 * press the button that lets it go on.
 */
export const QUIET_AFTER_ACTION_MS = 2_000;
/** One approval request lives at most this long. */
export const APPROVAL_LIMIT_S = 60;
/** The shortest approval window a configuration may ask for. */
export const APPROVAL_FLOOR_S = 10;
/** Text is typed in pieces of this many characters; stop, deadline and field are checked before each. */
export const TYPE_PIECE_CHARS = 16;
/** Longest text of one typing step. */
export const TYPE_TEXT_MAX = 1_000;
/** Longest task text of a mandate. */
export const TASK_TEXT_MAX = 2_000;
/** Longest stated purpose of one step. */
export const PURPOSE_MAX = 200;
/** One key step presses its key at most this often. */
export const KEY_REPEAT_LIMIT = 10;
/** One scroll step moves at most this many lines. */
export const SCROLL_LINES_LIMIT = 40;
/** Model turns of one mandate at most (the deadline usually ends it first). */
export const TURN_LIMIT = 30;
/** Steps one model turn may propose. */
export const STEPS_PER_TURN = 6;
/** A model turn that takes longer is cut off. */
export const MODEL_TIMEOUT_MS = 60_000;
/** Longest model text kept for the person (the final summary). */
export const SUMMARY_MAX = 2_000;
/** Entries the in-memory journal keeps. */
export const JOURNAL_LIMIT = 400;
/** After a stop, wait this long at most for the running action to settle before the end is written. */
export const SETTLE_LIMIT_MS = 1_000;

/** The actions the control offers. */
export const ACTIONS = Object.freeze({
  look: 'screen.look',
  click: 'pointer.click',
  scroll: 'pointer.scroll',
  type: 'keyboard.type',
  press: 'keyboard.press',
  open: 'app.open',
});
/** @type {readonly string[]} */
export const ACTION_NAMES = Object.freeze(Object.values(ACTIONS));

/**
 * Action classes, weakest first:
 *   read       looks at the screen only;
 *   low        local input the task asks for (a click on a named control, text from the task);
 *   high       runs only after the mandate owner approved this one step;
 *   forbidden  never runs (blocked app, secret field, key outside the allow list, ...).
 * @typedef {'read' | 'low' | 'high' | 'forbidden'} ActionClass
 */
/** @type {readonly ActionClass[]} */
export const CLASSES = Object.freeze(['read', 'low', 'high', 'forbidden']);

/** The class of each action before its target is looked at. @type {Readonly<Record<string, ActionClass>>} */
export const START_CLASS = Object.freeze({
  [ACTIONS.look]: 'read',
  [ACTIONS.click]: 'low',
  [ACTIONS.scroll]: 'low',
  [ACTIONS.type]: 'low',
  [ACTIONS.press]: 'low',
  [ACTIONS.open]: 'low',
});

/** Version of the consent statement; a grant names the version the person saw. */
export const CONSENT_VERSION = 1;
/**
 * The consent statement in its canonical English form (the app shows a translation of the same
 * version). Its SHA-256 is recorded with every grant.
 */
export const CONSENT_STATEMENT = [
  'Starpi Core may operate this computer for me while I watch.',
  'It acts only inside a mandate I start, for at most two minutes unless I extend it,',
  'only with the actions the mandate lists and never in blocked apps.',
  'Every step of the high class waits for my approval, every step is recorded,',
  'and I can stop it at any moment and withdraw this consent.',
].join(' ');

/**
 * Why a mandate ended.
 * @typedef {'stopped' | 'revoked' | 'expired' | 'finished' | 'failed' | 'restart' | 'shutdown'} EndReason
 */
/** @type {readonly EndReason[]} */
export const END_REASONS = Object.freeze(['stopped', 'revoked', 'expired', 'finished', 'failed', 'restart', 'shutdown']);
