// @ts-check
// Every speech source, and the context they run in for this page: the user's keys, the voice
// settings, the mode (on-device or not), what the site offers with its own keys, the paired
// companion and the shared playback. ttsEngines() lists the engines of a reading: the chosen
// source, then the browser's own voices; a reading never falls back to a cloud service the user
// did not choose.
import { getKey } from '../../ai/keys.js';
import { getMode } from '../../state.js';
import { apiVoices } from '../client.js';
import { getPlayback } from '../playback.js';
import { getVoiceSettings } from '../settings.js';
import { browserStt, browserTts } from './browser.js';
import { companionStt, companionVoiceLink } from './companion.js';
import { elevenlabsTts } from './elevenlabs.js';
import { geminiStt, geminiTts } from './gemini.js';
import { groqStt } from './groq.js';
import { localStt, localTts } from './local.js';
import { openaiStt, openaiTts } from './openai.js';

/** @typedef {import('./shared.js').SourceContext} SourceContext */
/** @typedef {import('./shared.js').SiteVoice} SiteVoice */
/** @typedef {import('./shared.js').SttSource} SttSource */
/** @typedef {import('./shared.js').TtsSource} TtsSource */
/** @typedef {import('../catalog.js').SttSourceId} SttSourceId */
/** @typedef {import('../catalog.js').TtsSourceId} TtsSourceId */

/** @type {Readonly<Record<SttSourceId, SttSource>>} */
export const STT = Object.freeze({ browser: browserStt, gemini: geminiStt, openai: openaiStt, groq: groqStt, local: localStt, companion: companionStt });
/** @type {Readonly<Record<TtsSourceId, TtsSource>>} */
export const TTS = Object.freeze({ browser: browserTts, gemini: geminiTts, elevenlabs: elevenlabsTts, openai: openaiTts, local: localTts });

/** @type {SiteVoice | null} */
let siteOffer = null;
/** @type {Promise<SiteVoice | null> | null} */
let siteLoading = null;

/**
 * Asks the site once what it offers with its own keys (GET /api/voice/voices). Never rejects; a
 * site without the route offers nothing.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<SiteVoice | null>}
 */
export function loadSiteOffer(options = {}) {
  if (siteLoading && !options.force) return siteLoading;
  siteLoading = apiVoices()
    .then((v) => (siteOffer = { geminiTts: v.gemini.tts, geminiStt: v.gemini.stt, live: v.gemini.live, elevenlabsTts: v.elevenlabs.tts }))
    .catch(() => (siteOffer = { geminiTts: false, geminiStt: false, live: false, elevenlabsTts: false }));
  return siteLoading;
}

/** The context of this page's sources. @type {SourceContext} */
export const pageContext = {
  getKey,
  settings: getVoiceSettings,
  onDevice: () => getMode() === 'client',
  site: () => siteOffer,
  companion: companionVoiceLink,
  playback: getPlayback,
};

/**
 * The engines of a reading: the chosen source when it can speak now, then the browser's voices.
 * @param {SourceContext} ctx
 * @param {Readonly<Record<TtsSourceId, TtsSource>>} [sources]
 */
export function ttsEngines(ctx, sources = TTS) {
  const chosen = sources[ctx.settings().tts];
  const list = [];
  if (chosen && (!ctx.onDevice() || chosen.local) && safeAvailable(chosen, ctx)) list.push(chosen.engine(ctx));
  if (chosen?.id !== 'browser' && safeAvailable(sources.browser, ctx)) list.push(sources.browser.engine(ctx));
  return list;
}

/**
 * @param {TtsSource} source
 * @param {SourceContext} ctx
 */
function safeAvailable(source, ctx) {
  try {
    return source.available(ctx);
  } catch {
    return false;
  }
}
