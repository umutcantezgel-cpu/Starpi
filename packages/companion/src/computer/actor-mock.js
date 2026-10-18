// @ts-check
// The mock actor: a simulated screen held in memory. It answers `inspect` and `look` from a scene
// (windows, elements with role, label and box, a dialog, visible lines), performs steps by changing
// that scene (a click focuses a text field, typing fills it, opening an app brings it to the front)
// and records every step it performed. Scenes can make steps slow, stall until aborted, fail with a
// code, or lack the platform permissions. It never touches a real screen, keyboard or pointer and it
// starts no process. It is the actor of this release and the one the tests drive.

/**
 * @typedef {object} MockElement
 * @property {string | null} role
 * @property {string | null} [label]
 * @property {import('./classes.js').Box} box
 * @property {boolean} [focused]
 * @property {string} [value]      text a field holds
 */

/**
 * @typedef {object} MockScene
 * @property {{ width: number, height: number }} [screen]
 * @property {{ app: string | null, title?: string | null, url?: string | null }} [front]
 * @property {Array<{ app: string | null, title?: string | null, url?: string | null, box: import('./classes.js').Box }>} [windows]
 * @property {MockElement[]} [elements]
 * @property {string | null} [dialog]
 * @property {string[]} [lines]
 * @property {Record<string, string>} [failures]  action name → error code
 * @property {string[]} [stalls]                 actions that never finish unless aborted
 * @property {number} [workMs]                   wall-clock time each step (and each typed piece) takes
 * @property {boolean} [denied]                  the platform permissions are missing
 */

/** A neutral demo scene: a notes app with a search box, a note field and two buttons. @type {Readonly<MockScene>} */
export const DEMO_SCENE = Object.freeze({
  screen: { width: 1280, height: 800 },
  front: { app: 'org.example.notes', title: 'Notes', url: null },
  windows: [{ app: 'org.example.notes', title: 'Notes', url: null, box: { x: 0, y: 0, w: 1280, h: 800 } }],
  elements: [
    { role: 'searchbox', label: 'Search notes', box: { x: 24, y: 16, w: 320, h: 32 } },
    { role: 'button', label: 'New note', box: { x: 360, y: 16, w: 120, h: 32 } },
    { role: 'textbox', label: 'Note text', box: { x: 24, y: 72, w: 1232, h: 640 }, focused: true, value: '' },
    { role: 'button', label: 'Delete note', box: { x: 1136, y: 736, w: 120, h: 32 } },
  ],
  dialog: null,
  lines: ['Notes', 'Untitled note'],
});

/** @param {[number, number]} at @param {import('./classes.js').Box | undefined} box */
const within = (at, box) => !!box && at[0] >= box.x && at[1] >= box.y && at[0] < box.x + box.w && at[1] < box.y + box.h;
/** @param {import('./classes.js').Box} box @returns {[number, number]} */
const middleOf = (box) => [Math.floor(box.x + box.w / 2), Math.floor(box.y + box.h / 2)];
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * @param {{ scene?: MockScene }} [options]  the starting scene (copied); the demo scene by default
 */
export function createMockActor({ scene = DEMO_SCENE } = {}) {
  /** @type {MockScene} */
  let now = structuredClone(scene);
  /** @type {Array<Record<string, unknown>>} */
  const performed = [];
  let busy = 0;

  /**
   * Waits for the scene's work time, or until aborted for a stalling action.
   * @param {string} action @param {AbortSignal | undefined} signal
   * @returns {Promise<boolean>} false when aborted
   */
  function spend(action, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    const stalls = (now.stalls ?? []).includes(action);
    const ms = now.workMs ?? 0;
    if (!stalls && ms <= 0) return Promise.resolve(true);
    busy += 1;
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const finish = (/** @type {boolean} */ ok) => {
        busy -= 1;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onAbort = () => finish(false);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!stalls) timer = setTimeout(() => finish(true), ms);
    });
  }

  /**
   * The common path of every step: permissions, configured failures, the work time, the record.
   * @param {string} action @param {AbortSignal | undefined} signal @param {Record<string, unknown>} detail
   * @param {() => void} [effect]
   * @returns {Promise<import('./actor.js').ActorResult>}
   */
  async function perform(action, signal, detail, effect) {
    if (now.denied) return { ok: false, code: 'permission_missing' };
    const failure = now.failures?.[action];
    if (typeof failure === 'string') return { ok: false, code: failure };
    if (!(await spend(action, signal))) return { ok: false, code: 'aborted' };
    effect?.();
    performed.push({ action, ...detail });
    return { ok: true };
  }

  const front = () => ({ app: now.front?.app ?? null, title: now.front?.title ?? null, url: now.front?.url ?? null });
  /** @param {[number, number]} at */
  const windowAt = (at) => (now.windows ?? []).find((w) => within(at, w.box)) ?? null;
  /** @param {[number, number]} at */
  const elementAt = (at) => (now.elements ?? []).find((e) => within(at, e.box)) ?? null;
  const focused = () => (now.elements ?? []).find((e) => e.focused) ?? null;
  const frontWindow = () => (now.windows ?? []).find((w) => w.app === now.front?.app) ?? null;

  /**
   * Re-checks the target right before a pointer step.
   * @param {[number, number]} at @param {import('./actor.js').Expect} expect
   */
  function pointerTargetHolds(at, expect) {
    const win = windowAt(at);
    if (expect.front === null || expect.app === null || win === null) return false;
    if (front().app !== expect.front || win.app !== expect.app) return false;
    return expect.title === null || (win.title ?? null) === expect.title;
  }

  /**
   * Re-checks the focus right before a keyboard step.
   * @param {import('./actor.js').Expect} expect
   */
  function focusHolds(expect) {
    if (expect.front === null || front().app !== expect.front || expect.app !== expect.front) return false;
    if (expect.role === undefined) return true;
    const el = focused();
    return el !== null && (el.role ?? null) === expect.role && (el.label ?? null) === (expect.label ?? null);
  }

  return {
    kind: 'mock',
    preview: false,
    /** Steps performed, in order (tests and the demo). */
    performed,
    /** @param {MockScene} next  replaces the scene (copied) */
    setScene(next) {
      now = structuredClone(next);
    },
    /** @returns {MockScene} a copy of the current scene */
    scene: () => structuredClone(now),
    /** Steps waiting right now. */
    busy: () => busy,

    /** @param {{ action: string, at?: [number, number] | null }} q @returns {Promise<import('./classes.js').Seen>} */
    async inspect({ action, at = null }) {
      const byPoint = action === 'pointer.click' || action === 'pointer.scroll';
      const win = byPoint ? (at ? windowAt(at) : null) : frontWindow();
      const el = byPoint ? (at ? elementAt(at) : null) : focused();
      return {
        front: now.front ? front() : null,
        window: win ? { app: win.app ?? null, title: win.title ?? null, url: win.url ?? null, box: { ...win.box } } : null,
        element: el ? { role: el.role ?? null, label: el.label ?? null } : null,
        dialog: now.dialog ?? null,
        screen: now.screen ? { ...now.screen } : null,
      };
    },

    /** @param {{ signal?: AbortSignal }} o */
    async look({ signal }) {
      const r = await perform('screen.look', signal, {});
      if (!r.ok) return r;
      return {
        ok: /** @type {const} */ (true),
        screen: {
          front: { app: front().app, title: front().title },
          windows: (now.windows ?? []).map((w) => ({ app: w.app ?? null, title: w.title ?? null, box: { ...w.box } })),
          elements: (now.elements ?? []).map((e) => ({ role: e.role ?? null, label: e.label ?? null, at: middleOf(e.box), focused: e.focused === true })),
          lines: [...(now.lines ?? [])],
          dialog: now.dialog ?? null,
          screen: now.screen ? { ...now.screen } : null,
        },
      };
    },

    /** @param {{ at: [number, number], expect: import('./actor.js').Expect, signal?: AbortSignal }} o */
    async click({ at, expect, signal }) {
      if (!pointerTargetHolds(at, expect)) return { ok: false, code: 'target_moved' };
      return perform('pointer.click', signal, { at: [...at] }, () => {
        const hit = elementAt(at);
        if (hit && TEXT_ROLES.has(hit.role ?? '')) for (const e of now.elements ?? []) e.focused = e === hit;
      });
    },

    /** @param {{ at: [number, number], direction: string, lines: number, expect: import('./actor.js').Expect, signal?: AbortSignal }} o */
    async scroll({ at, direction, lines, expect, signal }) {
      if (!pointerTargetHolds(at, expect)) return { ok: false, code: 'target_moved' };
      return perform('pointer.scroll', signal, { at: [...at], direction, lines });
    },

    /** @param {{ key: string, expect: import('./actor.js').Expect, signal?: AbortSignal }} o */
    async press({ key, expect, signal }) {
      if (!focusHolds(expect)) return { ok: false, code: 'target_moved' };
      return perform('keyboard.press', signal, { key });
    },

    /** @param {{ text: string, expect: import('./actor.js').Expect, signal?: AbortSignal }} o */
    async typePiece({ text, expect, signal }) {
      if (!focusHolds(expect)) return { ok: false, code: 'target_moved' };
      const field = focused();
      if (field === null || !TEXT_ROLES.has(field.role ?? '')) return { ok: false, code: 'field_unknown' };
      return perform('keyboard.type', signal, { text }, () => {
        field.value = `${field.value ?? ''}${text}`;
      });
    },

    /** @param {{ app: string, signal?: AbortSignal }} o */
    async open({ app, signal }) {
      return perform('app.open', signal, { app }, () => {
        now.front = { app, title: null, url: null };
      });
    },
  };
}

/** @typedef {ReturnType<typeof createMockActor>} MockActor */
