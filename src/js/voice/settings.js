// @ts-check
// The voice settings of this browser (localStorage starpi_voice_v1): which source turns speech
// into text (or the automatic order), which source speaks, the voice per source and language, the
// speaking rate, whether answers are read aloud on their own, the user's glossary, the address of
// a local voice server, the Live voice and whether Live may take a camera picture. Reading always
// normalizes, so a hand-edited or older entry can never select a voice outside the lists.
import { readLocalJson, writeLocalJson } from '../storage.js';
import { DEFAULT_ELEVENLABS_VOICE, DEFAULT_GEMINI_VOICE, DEFAULT_OPENAI_VOICE, isElevenLabsVoice, isGeminiVoice, isOpenAiVoice, isPiperVoice, isSttSource, isTtsSource, LIMITS } from './catalog.js';

export const VOICE_SETTINGS_KEY = 'starpi_voice_v1';
export const RATE_MIN = 0.5;
export const RATE_MAX = 2;

/** @typedef {import('./catalog.js').SttSourceId} SttSourceId */
/** @typedef {import('./catalog.js').TtsSourceId} TtsSourceId */

/**
 * @typedef {object} VoiceSettings
 * @property {'auto' | SttSourceId} stt          the source tried first; 'auto' follows STT_SOURCES
 * @property {TtsSourceId} tts
 * @property {Partial<Record<TtsSourceId, Record<string, string>>>} voices  voice id per source and language ("en", "de")
 * @property {number} rate                         0.5 to 2
 * @property {boolean} autoRead                    read answers aloud when they are complete
 * @property {string} glossary                     names and terms for speech input, as typed
 * @property {string} localUrl                     the local voice server ('' for none)
 * @property {string} liveVoice                    a prebuilt Gemini voice for Live
 * @property {boolean} camera                      Live may offer the camera picture
 */

/** @type {Readonly<VoiceSettings>} */
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stt: 'auto',
  tts: 'browser',
  voices: {},
  rate: 1,
  autoRead: false,
  glossary: '',
  localUrl: '',
  liveVoice: DEFAULT_GEMINI_VOICE,
  camera: false,
});

/** Whether a voice id may be stored for a source (browser voices are named by the platform). */
const VOICE_CHECKS = /** @type {Record<TtsSourceId, (id: string) => boolean>} */ ({
  browser: (id) => id.length > 0 && id.length <= 200,
  gemini: isGeminiVoice,
  elevenlabs: isElevenLabsVoice,
  openai: isOpenAiVoice,
  local: isPiperVoice,
});

/** The voice a source uses when the user picked none. */
export const DEFAULT_VOICES = Object.freeze(/** @type {Record<TtsSourceId, string | null>} */ ({ browser: null, gemini: DEFAULT_GEMINI_VOICE, elevenlabs: DEFAULT_ELEVENLABS_VOICE, openai: DEFAULT_OPENAI_VOICE, local: null }));

/**
 * A local voice server address: http(s) on any host, without credentials, query or fragment, as
 * an origin plus path without a trailing slash; '' for anything else.
 * @param {unknown} value
 */
export function normalizeServerUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return '';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) return '';
  return url.href.replace(/\/+$/, '');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Settings from anything stored: unknown fields are dropped, wrong values fall back to the default.
 * @param {unknown} raw
 * @returns {VoiceSettings}
 */
export function normalizeVoiceSettings(raw) {
  const r = isRecord(raw) ? raw : {};
  /** @type {VoiceSettings['voices']} */
  const voices = {};
  if (isRecord(r.voices)) {
    for (const [source, perLang] of Object.entries(r.voices)) {
      if (!isTtsSource(source) || !isRecord(perLang)) continue;
      /** @type {Record<string, string>} */
      const kept = {};
      for (const [lang, id] of Object.entries(perLang)) if (/^[a-z]{2}$/.test(lang) && typeof id === 'string' && VOICE_CHECKS[source](id)) kept[lang] = id;
      if (Object.keys(kept).length) voices[source] = kept;
    }
  }
  const rate = typeof r.rate === 'number' && Number.isFinite(r.rate) ? Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(r.rate * 20) / 20)) : DEFAULT_VOICE_SETTINGS.rate;
  return {
    stt: r.stt === 'auto' || isSttSource(r.stt) ? /** @type {VoiceSettings['stt']} */ (r.stt) : DEFAULT_VOICE_SETTINGS.stt,
    tts: isTtsSource(r.tts) ? r.tts : DEFAULT_VOICE_SETTINGS.tts,
    voices,
    rate,
    autoRead: r.autoRead === true,
    glossary: typeof r.glossary === 'string' ? r.glossary.slice(0, LIMITS.glossaryChars * 2) : '',
    localUrl: normalizeServerUrl(r.localUrl),
    liveVoice: isGeminiVoice(r.liveVoice) ? /** @type {string} */ (r.liveVoice) : DEFAULT_VOICE_SETTINGS.liveVoice,
    camera: r.camera === true,
  };
}

/**
 * The voice of a source for a language: the user's choice, else the source's default (null: the
 * source picks, as browser voices and local voices do).
 * @param {VoiceSettings} settings
 * @param {TtsSourceId} source
 * @param {string} locale
 * @returns {string | null}
 */
export function voiceFor(settings, source, locale) {
  const lang = String(locale ?? '').slice(0, 2).toLowerCase();
  return settings.voices[source]?.[lang] ?? DEFAULT_VOICES[source];
}

/** @type {Set<(settings: VoiceSettings) => void>} */
const listeners = new Set();
/** @type {VoiceSettings | null} */
let cached = null;

/** @returns {VoiceSettings} */
export function getVoiceSettings() {
  if (!cached) cached = normalizeVoiceSettings(readLocalJson(VOICE_SETTINGS_KEY, null));
  return cached;
}

/**
 * Changes some settings and stores them (in memory only when the browser refuses storage).
 * @param {Partial<VoiceSettings>} patch
 * @returns {VoiceSettings}
 */
export function setVoiceSettings(patch) {
  const current = getVoiceSettings();
  const next = normalizeVoiceSettings({ ...current, ...patch, voices: patch.voices ? { ...current.voices, ...patch.voices } : current.voices });
  cached = next;
  writeLocalJson(VOICE_SETTINGS_KEY, next);
  for (const fn of listeners) {
    try {
      fn(next);
    } catch (err) {
      console.error('[starpi] voice settings listener failed', err);
    }
  }
  return next;
}

/**
 * @param {(settings: VoiceSettings) => void} fn
 * @returns {() => void}
 */
export function onVoiceSettingsChange(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Forgets the cached copy (tests; another tab changed the entry). */
export function reloadVoiceSettings() {
  cached = null;
  return getVoiceSettings();
}
