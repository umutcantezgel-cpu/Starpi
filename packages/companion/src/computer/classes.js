// @ts-check
// The class decision: which of read, low, high or forbidden one proposed step belongs to. It looks
// at what the actor reported about the target just before the step, never at what the model claims,
// and it is pure, so the same report always gives the same class.
//
// Order of the checks:
//   1. the action, its arguments and its stated purpose (unknown, malformed or missing: forbidden);
//   2. the windows involved: blocked apps, the window showing Starpi itself, browser windows whose
//      address is unknown, apps outside a configured allow list (forbidden);
//   3. per action: the point lies on the screen and inside its window, the key is on the allow list,
//      the text field is a plain one and not a secret one (otherwise forbidden);
//   4. what raises the class to high: risky words on the control, in a dialog or in the stated
//      purpose, careful apps, unknown or vaguely labelled controls, text that is not literally part
//      of the task, keys and apps that carry the high class, opening an app after the screen was read.
// The stated purpose can only raise a class. Whatever cannot be determined counts against the step.
import { ACTIONS, CLASSES, KEY_REPEAT_LIMIT, PURPOSE_MAX, SCROLL_LINES_LIMIT, START_CLASS, TYPE_TEXT_MAX } from './limits.js';
import { APP_ID, SECRET_ROLE, TEXT_ROLES, VAGUE_LABELS, WEB_APP_SHELLS, hostOf } from './lists.js';

/** @typedef {import('./limits.js').ActionClass} ActionClass */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box */

/**
 * What the actor reported just before a step. Every member may be missing or null (unknown).
 * @typedef {object} Seen
 * @property {{ app?: string | null, title?: string | null, url?: string | null } | null} [front]  the frontmost window
 * @property {{ app?: string | null, title?: string | null, url?: string | null, box?: Box | null } | null} [window]
 *   the window under the point (click, scroll) or holding the focus (type, press)
 * @property {{ role?: string | null, label?: string | null } | null} [element]  under the point, or focused
 * @property {string | null} [dialog]  text of a dialog around the target
 * @property {{ width: number, height: number } | null} [screen]  in the actor's points
 */

/**
 * A step as the control hands it over.
 * @typedef {object} Step
 * @property {string} action
 * @property {Record<string, unknown>} args
 * @property {string} why     the purpose the model stated
 */

/**
 * The description of a target that an approval is bound to.
 * @typedef {{ app: string | null, title: string | null, role: string | null, label: string | null }} Target
 */

/**
 * @typedef {object} Ruling
 * @property {ActionClass} cls
 * @property {string[]} reasons   codes: what forbade the step, or what raised it above its start class
 * @property {Target} target
 */

/** @param {unknown} v @returns {string | null} */
const textOrNull = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Text prepared for matching: compatibility-normalised, lower case, typographic quotes made plain,
 * runs of white space folded to one space.
 * @param {unknown} value
 */
export function fold(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * The strongest of some classes; anything unknown counts as forbidden.
 * @param {...unknown} classes
 * @returns {ActionClass}
 */
export function strongest(...classes) {
  let rank = 0;
  for (const c of classes) {
    const i = CLASSES.indexOf(/** @type {ActionClass} */ (c));
    rank = Math.max(rank, i === -1 ? CLASSES.length - 1 : i);
  }
  return CLASSES[rank];
}

const LETTER_OR_DIGIT = '[\\p{L}\\p{N}]';
/** @param {string} text */
const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * True when a word of the list starts a word of the text.
 * @param {unknown} text
 * @param {readonly string[]} words
 */
export function mentionsRiskyWord(text, words) {
  const folded = fold(text);
  if (folded === '') return false;
  return words.some((word) => new RegExp(`(?<!${LETTER_OR_DIGIT})${escapeForRegExp(fold(word))}`, 'u').test(folded));
}

/** Code point ranges of the controls a typed text must not hold (the line feed, 0x0a, is left out). */
const CONTROL_RANGES = Object.freeze([[0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029]]);

/**
 * True when the text holds a control character other than the line feed: tab, carriage return and
 * the rest act like keys outside the allow list. Line and paragraph separators count as controls.
 * @param {string} text
 */
export const hasControlCharacter = (text) => [...text].some((ch) => {
  const n = ch.codePointAt(0) ?? 0;
  return CONTROL_RANGES.some(([low, high]) => n >= low && n <= high);
});

/**
 * True when the text stands in the task as it is, and as whole words wherever it begins or ends
 * with a letter or digit. A model can then not assemble foreign text out of letters or word pieces
 * of the task, one typing step at a time.
 * @param {unknown} text
 * @param {unknown} task
 */
export function isFromTask(text, task) {
  if (typeof text !== 'string' || text === '' || typeof task !== 'string') return false;
  const wordAt = (/** @type {string | undefined} */ ch) => ch !== undefined && new RegExp(LETTER_OR_DIGIT, 'u').test(ch);
  const chars = [...text];
  const before = wordAt(chars[0]) ? `(?<!${LETTER_OR_DIGIT})` : '';
  const after = wordAt(chars[chars.length - 1]) ? `(?!${LETTER_OR_DIGIT})` : '';
  return new RegExp(`${before}${escapeForRegExp(text)}${after}`, 'u').test(task);
}

/**
 * True when typed text names this machine or a host that serves Starpi itself.
 * @param {string} text
 * @param {import('./lists.js').Policy} policy
 */
export function namesOwnHost(text, policy) {
  const squeezed = fold(text).replace(/\s/g, '');
  if (/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)/.test(squeezed)) return true;
  for (const host of policy.ownHosts) if (host.includes('.') && squeezed.includes(host)) return true;
  return false;
}

const MODIFIER_NAMES = Object.freeze({ mod: 'mod', cmd: 'mod', command: 'mod', meta: 'mod', super: 'mod', ctrl: 'mod', control: 'mod', '⌘': 'mod', shift: 'shift', '⇧': 'shift', alt: 'alt', option: 'alt', opt: 'alt', '⌥': 'alt' });
const KEY_NAMES = Object.freeze({
  enter: 'enter', return: 'enter', tab: 'tab', escape: 'escape', esc: 'escape', backspace: 'backspace', space: 'space', spacebar: 'space',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down', left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
  pageup: 'pageup', pagedown: 'pagedown', home: 'home', end: 'end',
});

/**
 * A key as a model may write it ('Enter', 'cmd+z', 'Ctrl+C', 'ArrowDown', '⌘V') in the form of the
 * allow list ('enter', 'mod+z'); null when it does not parse. Command and Control both mean the
 * platform's primary modifier.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function keyName(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) return null;
  if (raw === ' ') return 'space';
  const spaced = raw.trim().toLowerCase().replace(/^([⌘⇧⌥]+)(?=[^+])/u, (symbols) => `${[...symbols].join('+')}+`);
  const parts = spaced.split('+').map((p) => p.trim().replace(/[\s_-]/g, ''));
  if (parts.some((p) => p === '')) return null;
  const last = /** @type {string} */ (parts.pop());
  const base = Object.hasOwn(KEY_NAMES, last) ? KEY_NAMES[/** @type {keyof typeof KEY_NAMES} */ (last)] : /^[a-z0-9]$/.test(last) ? last : null;
  if (base === null) return null;
  /** @type {Set<string>} */
  const mods = new Set();
  for (const part of parts) {
    if (!Object.hasOwn(MODIFIER_NAMES, part)) return null;
    mods.add(MODIFIER_NAMES[/** @type {keyof typeof MODIFIER_NAMES} */ (part)]);
  }
  return [...[...mods].sort(), base].join('+');
}

/**
 * Why a window may not be used, or null when it may: an unknown app, a blocked app, an installed app
 * of Starpi, a browser (or installed web app) showing Starpi, the companion or any loopback page, or
 * one whose address the actor could not read.
 * @param {{ app?: string | null, url?: string | null } | null | undefined} win
 * @param {import('./lists.js').Policy} policy
 * @returns {string | null}
 */
export function windowProblem(win, policy) {
  const app = textOrNull(win?.app);
  if (app === null || !APP_ID.test(app)) return 'app_unknown';
  if (policy.blocked.has(app)) return 'app_blocked';
  if (policy.ownApps.has(app)) return 'own_window';
  if (policy.browsers.has(app) || WEB_APP_SHELLS.some((shell) => shell.test(app))) {
    const host = hostOf(win?.url);
    if (host === null) return 'window_unverified';
    if (policy.ownHosts.has(host)) return 'own_window';
  }
  if (policy.allowed.size > 0 && !policy.allowed.has(app)) return 'app_not_listed';
  return null;
}

/** @param {unknown} at @returns {at is [number, number]} */
const isPoint = (at) => Array.isArray(at) && at.length === 2 && at.every((v) => Number.isInteger(v) && v >= 0 && v <= 100_000);

/**
 * True when the arguments of a step have exactly the members and shapes its action takes.
 * @param {string} action
 * @param {Record<string, unknown>} args
 */
export function argumentsFit(action, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const names = Object.keys(args).sort().join(',');
  switch (action) {
    case ACTIONS.look:
      return names === '';
    case ACTIONS.click:
      return names === 'at' && isPoint(args.at);
    case ACTIONS.scroll:
      return names === 'at,direction,lines' && isPoint(args.at) && ['up', 'down', 'left', 'right'].includes(/** @type {string} */ (args.direction))
        && Number.isInteger(args.lines) && /** @type {number} */ (args.lines) >= 1 && /** @type {number} */ (args.lines) <= SCROLL_LINES_LIMIT;
    case ACTIONS.type:
      return names === 'text' && typeof args.text === 'string' && args.text.length > 0 && [...args.text].length <= TYPE_TEXT_MAX;
    case ACTIONS.press:
      return (names === 'key' || names === 'key,times') && typeof args.key === 'string'
        && (args.times === undefined || (Number.isInteger(args.times) && /** @type {number} */ (args.times) >= 1 && /** @type {number} */ (args.times) <= KEY_REPEAT_LIMIT));
    case ACTIONS.open:
      return names === 'app' && typeof args.app === 'string' && APP_ID.test(args.app);
    default:
      return false;
  }
}

/**
 * The window a step acts on: for a click or a scroll the one under the point (never assumed to be
 * the frontmost one), for typing and keys the one holding the focus.
 * @param {string} action
 * @param {Seen} seen
 */
function windowOfStep(action, seen) {
  if (seen.window) return seen.window;
  if (action === ACTIONS.click || action === ACTIONS.scroll) return null;
  return seen.front ?? null;
}

/**
 * The target description of a step from what the actor reported.
 * @param {string} action
 * @param {Seen} seen
 * @returns {Target}
 */
export function describeTarget(action, seen) {
  const win = windowOfStep(action, seen ?? {});
  const app = textOrNull(win?.app);
  return {
    app: app !== null && APP_ID.test(app) ? app : null,
    title: textOrNull(win?.title),
    role: textOrNull(seen?.element?.role),
    label: textOrNull(seen?.element?.label),
  };
}

/** @param {string | null} label */
const saysNothing = (label) => {
  const folded = fold(label);
  return folded === '' || VAGUE_LABELS.includes(folded);
};

/**
 * Decides the class of one step.
 * @param {Step} step
 * @param {Seen} seen        reported by the actor just before (empty for `app.open`)
 * @param {import('./lists.js').Policy} policy
 * @param {{ task: string, screenRead: boolean }} context  the task text; whether the screen was read in this mandate
 * @returns {Ruling}
 */
export function decideClass(step, seen, policy, context) {
  const { action, args, why } = step;
  const report = seen ?? {};
  const target = describeTarget(action, report);
  /** @param {string} reason @returns {Ruling} */
  const forbid = (reason) => ({ cls: 'forbidden', reasons: [reason], target });

  if (!Object.hasOwn(START_CLASS, action)) return forbid('unknown_action');
  if (!argumentsFit(action, args)) return forbid('bad_arguments');
  if (typeof why !== 'string' || why.trim() === '') return forbid('purpose_missing');
  if (why.length > PURPOSE_MAX) return forbid('bad_arguments');

  /** @type {ActionClass} */
  let cls = START_CLASS[action];
  /** @type {string[]} */
  const reasons = [];
  /** @param {string} reason */
  const raise = (reason) => {
    cls = strongest(cls, 'high');
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (action === ACTIONS.open) {
    const app = /** @type {string} */ (args.app);
    const openTarget = { app, title: null, role: 'app', label: null };
    if (policy.blocked.has(app)) return { cls: 'forbidden', reasons: ['app_blocked'], target: openTarget };
    if (policy.ownApps.has(app)) return { cls: 'forbidden', reasons: ['own_window'], target: openTarget };
    if (!policy.openable.has(app)) return { cls: 'forbidden', reasons: ['app_not_listed'], target: openTarget };
    if (context.screenRead) raise('opened_after_screen_read');
    if (mentionsRiskyWord(why, policy.riskyWords)) raise('risky_purpose');
    return { cls, reasons, target: openTarget };
  }

  // Every other action works on the screen: the frontmost window must be usable as well.
  const frontProblem = windowProblem(report.front, policy);
  if (frontProblem !== null) return forbid(frontProblem);
  if (action === ACTIONS.look) return { cls, reasons, target };
  const ownProblem = windowProblem(windowOfStep(action, report), policy);
  if (ownProblem !== null) return forbid(ownProblem);

  if (action === ACTIONS.click || action === ACTIONS.scroll) {
    const [x, y] = /** @type {[number, number]} */ (args.at);
    const screen = report.screen;
    if (!screen || !(x < screen.width && y < screen.height)) return forbid('off_screen');
    const box = report.window?.box;
    if (box && !(x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h)) return forbid('off_window');
    if (action === ACTIONS.scroll) return { cls, reasons, target };
  }

  const careful = policy.careful.has(/** @type {string} */ (target.app)) || policy.careful.has(/** @type {string} */ (textOrNull(report.front?.app)));

  if (action === ACTIONS.press) {
    const key = keyName(args.key);
    const keyClass = key === null ? undefined : policy.keys.get(key);
    if (keyClass === undefined) return forbid('key_not_listed');
    if (keyClass === 'high') raise('key_needs_approval');
    if (key === 'enter' && careful) raise('enter_in_careful_app');
  }

  if (action === ACTIONS.type) {
    const text = /** @type {string} */ (args.text);
    if (hasControlCharacter(text)) return forbid('control_character');
    const role = target.role;
    if (role === SECRET_ROLE) return forbid('field_secret');
    if (role === null || !TEXT_ROLES.includes(role)) return forbid('field_unknown');
    if (namesOwnHost(text, policy)) return forbid('own_address');
    if (text.includes('\n') && careful) raise('enter_in_careful_app');
    if (!isFromTask(text, context.task)) raise('text_not_from_task');
  }

  // click, press, type: what the control and the purpose say about the effect.
  if (mentionsRiskyWord(target.label, policy.riskyWords) || mentionsRiskyWord(report.dialog, policy.riskyWords)) raise('risky_target');
  if (mentionsRiskyWord(why, policy.riskyWords)) raise('risky_purpose');
  if (target.role === null) raise('target_unknown');
  else if (action === ACTIONS.click && !TEXT_ROLES.includes(target.role) && saysNothing(target.label)) raise('target_vague');
  if (careful) raise('careful_app');
  return { cls, reasons, target };
}
