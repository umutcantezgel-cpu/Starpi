// @ts-check
// The lists the action classes are decided with, and how a configuration may change them. App ids
// are the platform's application identifiers (bundle ids on macOS). The block list, the careful
// list, the browsers, the own apps and the risky words only grow from the configuration; the key
// allow list only shrinks; the allow list of apps, when it is set, narrows everything further.
import { checkRecord, isRecord } from '../contracts/check.js';

/** An application id: never a path, an address or an option. */
export const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,154}$/;

/**
 * Apps the control never acts in, nor opens. Grouped by why: they change the system or its
 * security settings, hold credentials, ask for a password, or run commands and scripts (which would
 * hand the actor a way around every other rule).
 */
export const BLOCKED_APPS_DEFAULT = Object.freeze([
  // system settings and system tools
  'com.apple.systempreferences', 'com.apple.Settings', 'com.apple.ActivityMonitor', 'com.apple.DiskUtility',
  'com.apple.installer', 'com.apple.MigrateAssistant', 'com.apple.BootCampAssistant',
  // credentials
  'com.apple.keychainaccess', 'com.apple.Passwords', 'com.1password.1password', 'com.agilebits.onepassword7',
  'com.bitwarden.desktop', 'org.keepassxc.keepassxc',
  // password and authorisation prompts of the system
  'com.apple.SecurityAgent', 'com.apple.loginwindow', 'com.apple.LocalAuthentication.UIAgent', 'com.apple.coreservices.uiagent',
  // command lines, scripting and automation
  'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'net.kovidgoyal.kitty', 'org.alacritty',
  'com.mitchellh.ghostty', 'com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts',
]);

/** Browsers: one of their windows may show the app itself, so its address must be known and foreign. */
export const BROWSERS_DEFAULT = Object.freeze([
  'com.apple.Safari', 'com.google.Chrome', 'org.chromium.Chromium', 'org.mozilla.firefox', 'com.microsoft.edgemac',
  'com.brave.Browser', 'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera',
]);

/** Installed web apps run in a browser shell under an id of their own; they count as browsers. */
export const WEB_APP_SHELLS = Object.freeze([
  /^com\.apple\.Safari\.WebApp\./,
  /^com\.google\.Chrome\.app\./,
  /^com\.microsoft\.edgemac\.app\./,
  /^com\.brave\.Browser\.app\./,
]);

/**
 * Apps where one click can reach other people or many files (mail, chat, calendar, contacts, the
 * file manager, browsers): every step with an effect there is of the high class.
 */
export const CAREFUL_APPS_DEFAULT = Object.freeze([
  'com.apple.mail', 'com.microsoft.Outlook', 'com.apple.MobileSMS', 'com.apple.FaceTime', 'com.tinyspeck.slackmacgap',
  'com.microsoft.teams2', 'com.apple.iCal', 'com.apple.AddressBook', 'com.apple.finder',
  ...BROWSERS_DEFAULT,
]);

/** Element roles of plain text inputs (neutral names; an actor maps its platform's roles onto them). */
export const TEXT_ROLES = Object.freeze(['textbox', 'searchbox', 'combobox']);
/** The role of a field whose content is hidden (a password): typing there is forbidden. */
export const SECRET_ROLE = 'password';

/**
 * Keys a step may press, with the class they carry. `mod` is the platform's primary modifier
 * (Command on macOS). Pasting and saving put content in places the task did not name, so they wait
 * for an approval.
 * @type {ReadonlyArray<[string, import('./limits.js').ActionClass]>}
 */
export const KEYS_DEFAULT = Object.freeze([
  ['enter', 'low'], ['tab', 'low'], ['escape', 'low'], ['backspace', 'low'], ['space', 'low'],
  ['up', 'low'], ['down', 'low'], ['left', 'low'], ['right', 'low'],
  ['pageup', 'low'], ['pagedown', 'low'], ['home', 'low'], ['end', 'low'],
  ['mod+a', 'low'], ['mod+c', 'low'], ['mod+f', 'low'], ['mod+z', 'low'],
  ['mod+v', 'high'], ['mod+s', 'high'],
]);

/**
 * Words that mark a control or a stated purpose as consequential. They match at the start of a word
 * of the normalised text, so a false hit only raises the class. Add the words of the interface
 * language through `riskyWords`.
 */
export const RISKY_WORDS_DEFAULT = Object.freeze([
  'delete', 'remove', 'erase', 'trash', 'discard', 'overwrite', 'replace', 'empty', 'wipe',
  'send', 'submit', 'post', 'publish', 'share', 'invite', 'forward', 'reply',
  'pay', 'buy', 'purchase', 'order', 'checkout', 'transfer', 'donate', 'subscribe',
  'sign out', 'log out', 'uninstall', 'install', 'format', 'reset', 'restart', 'shut down',
  'allow', 'grant', 'approve', 'accept', 'confirm', 'authorize', 'authorise', "don't save", 'do not save',
]);

/** Labels that say nothing about what a control does. */
export const VAGUE_LABELS = Object.freeze(['ok', 'okay', 'yes', 'continue', 'next', 'done', 'go', 'apply', 'proceed', 'got it', '>', '→']);

/** Host names that always mean this machine. */
export const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * @typedef {object} Policy  the lists after the configuration, ready for the class decision
 * @property {ReadonlySet<string>} blocked
 * @property {ReadonlySet<string>} allowed    empty: every app that is not blocked
 * @property {ReadonlySet<string>} openable   apps `app.open` may start; empty: the action is not offered
 * @property {ReadonlySet<string>} careful
 * @property {ReadonlySet<string>} browsers
 * @property {ReadonlySet<string>} ownApps    installed apps that show Starpi itself
 * @property {ReadonlySet<string>} ownHosts   host names that serve Starpi itself (loopback always)
 * @property {ReadonlyMap<string, import('./limits.js').ActionClass>} keys
 * @property {readonly string[]} riskyWords
 */

/** @param {unknown} v */
const appList = (v) => (Array.isArray(v) && v.length <= 200 && v.every((a) => typeof a === 'string' && APP_ID.test(a)) ? null : 'a list of app ids');
/** @param {unknown} v */
const wordList = (v) => (Array.isArray(v) && v.length <= 200 && v.every((w) => typeof w === 'string' && w.trim().length >= 2 && w.length <= 40) ? null : 'a list of words (2 to 40 characters)');
/** @param {unknown} v */
const keyList = (v) => {
  if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) return 'a list of key names';
  const known = new Set(KEYS_DEFAULT.map(([name]) => name));
  const unknown = v.filter((k) => !known.has(k));
  return unknown.length === 0 ? null : `only keys of the allow list (${unknown.join(', ')} is not)`;
};

/** Members of the module configuration that shape the lists. */
export const LIST_OPTIONS = Object.freeze({
  blockApps: appList,
  allowApps: appList,
  openApps: appList,
  carefulApps: appList,
  browsers: appList,
  ownApps: appList,
  keys: keyList,
  riskyWords: wordList,
});

/**
 * Problems of the list members of a module configuration (other members are checked elsewhere).
 * @param {Record<string, unknown>} raw
 * @returns {string[]}
 */
export function checkListOptions(raw) {
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const name of Object.keys(LIST_OPTIONS)) if (raw[name] !== undefined) picked[name] = raw[name];
  const problems = checkRecord(picked, 'modules.computer', LIST_OPTIONS);
  if (problems.length > 0) return problems;
  const blocked = new Set([...BLOCKED_APPS_DEFAULT, .../** @type {string[]} */ (picked.blockApps ?? [])]);
  for (const id of /** @type {string[]} */ (picked.openApps ?? [])) if (blocked.has(id)) problems.push(`modules.computer.openApps: ${id} is blocked`);
  for (const id of /** @type {string[]} */ (picked.allowApps ?? [])) if (blocked.has(id)) problems.push(`modules.computer.allowApps: ${id} is blocked`);
  return problems;
}

/**
 * The host name of an origin or address, lower case without brackets; null when it does not parse.
 * @param {unknown} address
 */
export function hostOf(address) {
  if (typeof address !== 'string' || address === '') return null;
  try {
    return new URL(address).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  } catch {
    return null;
  }
}

/**
 * Builds the policy. Call checkListOptions first: this function trusts its input.
 * @param {Record<string, unknown>} [raw]  the module configuration
 * @param {{ ownOrigins?: readonly string[] }} [extra]  origins the Starpi app is served from
 * @returns {Policy}
 */
export function buildPolicy(raw = {}, { ownOrigins = [] } = {}) {
  const r = isRecord(raw) ? raw : {};
  const list = (/** @type {string} */ name) => /** @type {string[]} */ (Array.isArray(r[name]) ? r[name] : []);
  const blocked = new Set([...BLOCKED_APPS_DEFAULT, ...list('blockApps')]);
  const keep = (/** @type {string[]} */ ids) => new Set(ids.filter((id) => !blocked.has(id)));
  const wantedKeys = Array.isArray(r.keys) ? new Set(list('keys')) : null;
  const ownHosts = new Set(LOOPBACK_HOSTS.map((h) => h.replace(/^\[(.*)\]$/, '$1')));
  for (const origin of ownOrigins) {
    const host = hostOf(origin);
    if (host) ownHosts.add(host);
  }
  return Object.freeze({
    blocked,
    allowed: keep(list('allowApps')),
    openable: keep(list('openApps')),
    careful: new Set([...CAREFUL_APPS_DEFAULT, ...list('carefulApps')]),
    browsers: new Set([...BROWSERS_DEFAULT, ...list('browsers')]),
    ownApps: new Set(list('ownApps')),
    ownHosts,
    keys: new Map(KEYS_DEFAULT.filter(([name]) => wantedKeys === null || wantedKeys.has(name))),
    riskyWords: Object.freeze([...new Set([...RISKY_WORDS_DEFAULT, ...list('riskyWords').map((w) => w.trim().toLowerCase())])]),
  });
}
