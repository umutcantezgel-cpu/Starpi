// @ts-check
// The UI dictionaries and how they load.
//
// Layout: every language has a root file `<lang>.json` and one file per namespace `<ns>/<lang>.json`.
// A namespace file's keys are reached as `<ns>.<key>` and are merged into the root dictionary, so a
// feature keeps its strings in its own file instead of editing the shared root files. A key may be
// defined only once (tests/unit/i18n.test.mjs).
//
// Loading: English is part of the app bundle. It is the default language and the fallback for every
// key another language lacks. Every other language is fetched as separate chunks when it is chosen.
//
// - New namespace: add `<ns>/en.json` and `<ns>/de.json`, list `<ns>` in NAMESPACES and import its
//   English file below. The unit tests fail until directory, list and imports agree.
// - New language: add `<lang>.json` (plus `<ns>/<lang>.json` where translated) and list it in
//   SHIPPED_LOCALES. Untranslated keys show the English text.
import aiEn from './ai/en.json' with { type: 'json' };
import aiOrchestrationEn from './ai-orchestration/en.json' with { type: 'json' };
import canvasEn from './canvas/en.json' with { type: 'json' };
import chatEn from './chat/en.json' with { type: 'json' };
import chatThreadEn from './chat-thread/en.json' with { type: 'json' };
import companionEn from './companion/en.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };
import liveEn from './live/en.json' with { type: 'json' };
import memoryEn from './memory/en.json' with { type: 'json' };
import providersEn from './providers/en.json' with { type: 'json' };
import researchEn from './research/en.json' with { type: 'json' };
import shellEn from './shell/en.json' with { type: 'json' };
import trustEn from './trust/en.json' with { type: 'json' };
import voiceEn from './voice/en.json' with { type: 'json' };
import workspaceEn from './workspace/en.json' with { type: 'json' };

/** @typedef {{ [key: string]: string | Dictionary }} Dictionary */
/** @typedef {{ root: Dictionary, namespaces: Record<string, Dictionary> }} LocaleFiles */

/** Namespaces, in merge order. */
export const NAMESPACES = Object.freeze(['shell', 'chat', 'chat-thread', 'ai', 'ai-orchestration', 'providers', 'research', 'voice', 'live', 'trust', 'memory', 'companion', 'workspace', 'canvas']);

/** Languages with a root dictionary; the language switch offers exactly these. */
export const SHIPPED_LOCALES = Object.freeze(['en', 'de']);

/** @type {Readonly<LocaleFiles>} */
export const ENGLISH = Object.freeze({
  root: en,
  namespaces: {
    shell: shellEn,
    chat: chatEn,
    'chat-thread': chatThreadEn,
    ai: aiEn,
    'ai-orchestration': aiOrchestrationEn,
    providers: providersEn,
    research: researchEn,
    voice: voiceEn,
    live: liveEn,
    trust: trustEn,
    memory: memoryEn,
    companion: companionEn,
    workspace: workspaceEn,
    canvas: canvasEn,
  },
});

/**
 * Fetches one language's files. The bundler turns both imports into one lazy chunk per file. A
 * namespace without a file for the language resolves to {} (its keys fall back to English); a
 * missing root file rejects.
 * @param {string} locale a language code the caller has validated
 * @returns {Promise<LocaleFiles>}
 */
export async function loadLocaleFiles(locale) {
  if (locale === 'en') return ENGLISH;
  const root = /** @type {Dictionary} */ ((await import(`./${locale}.json`, { with: { type: 'json' } })).default);
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => {
      try {
        return /** @type {const} */ ([ns, /** @type {Dictionary} */ ((await import(`./${ns}/${locale}.json`, { with: { type: 'json' } })).default)]);
      } catch {
        return /** @type {const} */ ([ns, /** @type {Dictionary} */ ({})]);
      }
    }),
  );
  return { root, namespaces: Object.fromEntries(entries) };
}
