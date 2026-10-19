// @ts-check
// The macOS actor: preview, not verified on hardware.
//
// This release cannot run it. It would have to start the system's scripting tool for every step,
// and the companion forbids starting processes; it has also never been run on a real Mac. So
// `createMacosActor` always throws, and the configuration value `actor: "macos"` is refused when the
// module starts. What is kept here is the plan for a later release, small enough to review now:
//   - only fixed absolute programs, never a shell;
//   - values travel as arguments after `--` and are read by the script from `argv`; they are never
//     spliced into script text, so no value can become code;
//   - the platform's accessibility roles are mapped onto the neutral roles of the class decision;
//   - each call gets a short timeout and an environment holding PATH only.
// Inspecting targets, scrolling and the re-check right before a step are not part of the preview.
import { fail } from '../lib/errors.js';
import { APP_ID } from './lists.js';

/** @type {Readonly<{ kind: 'macos', state: 'preview', verifiedOnHardware: false, note: string }>} */
export const MACOS_ACTOR_STATUS = Object.freeze({ kind: 'macos', state: 'preview', verifiedOnHardware: false, note: 'preview, not verified on hardware' });

export const SCRIPT_RUNNER = '/usr/bin/osascript';
export const APP_LAUNCHER = '/usr/bin/open';
/** The only environment a call would get. */
export const CALL_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
export const CALL_TIMEOUT_MS = 8_000;

/** Virtual key codes of the keys on the allow list (US layout positions). */
export const MAC_KEY_CODES = Object.freeze({
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53,
  left: 123, right: 124, down: 125, up: 126, pageup: 116, pagedown: 121, home: 115, end: 119,
  a: 0, c: 8, f: 3, s: 1, v: 9, z: 6,
});

/** Accessibility roles and subroles mapped onto the neutral roles. */
export const MAC_ROLES = Object.freeze({
  AXTextField: 'textbox', AXTextArea: 'textbox', AXSearchField: 'searchbox', AXComboBox: 'combobox', AXSecureTextField: 'password',
  AXButton: 'button', AXLink: 'link', AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXMenuItem: 'menuitem', AXTab: 'tab',
  AXStaticText: 'text', AXImage: 'image', AXList: 'list', AXTable: 'table', AXWindow: 'window',
});

/**
 * Scripts (JavaScript for Automation) that read every value from argv.
 * @type {Readonly<Record<'press' | 'type' | 'click', string>>}
 */
const SCRIPTS = Object.freeze({
  press: 'function run(argv) { const mods = argv[1] === "mod" ? ["command down"] : []; Application("System Events").keyCode(Number(argv[0]), { using: mods }); }',
  type: 'function run(argv) { Application("System Events").keystroke(argv[0]); }',
  click: [
    'function run(argv) { ObjC.import("CoreGraphics"); const at = $.CGPointMake(Number(argv[0]), Number(argv[1]));',
    '[$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp].forEach((kind) => $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, kind, at, $.kCGMouseButtonLeft))); }',
  ].join(' '),
});

/**
 * The neutral role of an accessibility element.
 * @param {string | null | undefined} role
 * @param {string | null | undefined} [subrole]
 * @returns {string | null}
 */
export function neutralRole(role, subrole) {
  if (subrole === 'AXSecureTextField') return 'password';
  const key = /** @type {keyof typeof MAC_ROLES} */ (role ?? '');
  return Object.hasOwn(MAC_ROLES, key) ? MAC_ROLES[key] : null;
}

/**
 * The program and argument list one step would need, or null for a step outside the preview.
 * @param {{ action: string, key?: string, text?: string, at?: [number, number], app?: string }} step
 * @returns {{ file: string, args: string[] } | null}
 */
export function planMacosCall(step) {
  /** @param {keyof typeof SCRIPTS} name @param {Array<string | number>} values */
  const script = (name, values) => ({ file: SCRIPT_RUNNER, args: ['-l', 'JavaScript', '-e', SCRIPTS[name], '--', ...values.map(String)] });
  switch (step.action) {
    case 'keyboard.press': {
      const [mod, base] = (step.key ?? '').includes('+') ? /** @type {string} */ (step.key).split('+') : ['', step.key ?? ''];
      if (!Object.hasOwn(MAC_KEY_CODES, base) || (mod !== '' && mod !== 'mod')) return null;
      return script('press', [MAC_KEY_CODES[/** @type {keyof typeof MAC_KEY_CODES} */ (base)], mod]);
    }
    case 'keyboard.type':
      return typeof step.text === 'string' && step.text !== '' ? script('type', [step.text]) : null;
    case 'pointer.click':
      return Array.isArray(step.at) && step.at.every((v) => Number.isInteger(v) && v >= 0) ? script('click', step.at) : null;
    case 'app.open':
      return typeof step.app === 'string' && APP_ID.test(step.app) ? { file: APP_LAUNCHER, args: ['-b', step.app] } : null;
    default:
      return null;
  }
}

/**
 * Always refuses: the macOS actor is a preview in this release.
 * @returns {never}
 */
export function createMacosActor() {
  throw fail('computer_actor_preview', `the macOS actor is a ${MACOS_ACTOR_STATUS.note}; this release runs the mock actor only`, { status: 501 });
}
