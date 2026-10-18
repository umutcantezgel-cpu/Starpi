// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// Fixed facts of the voice features, shared by the browser and the server routes (api/voice/*):
// audio formats, limits, the source ids, and the voices each speech service may speak with. Only
// fixed, listed voices are ever used: the prebuilt Gemini voices, ElevenLabs' premade voices, the
// OpenAI voices, and the Piper voices of api/_lib/voice-allowlist.json. Nothing here can clone,
// design or upload a voice. Pure: no DOM, no I/O.
import pipers from '../../../api/_lib/voice-allowlist.json' with { type: 'json' };

/** Sample rates: the microphone is sent at 16 kHz, cloud voices answer at 24 kHz (PCM16 mono). */
export const AUDIO = Object.freeze({ inputRate: 16_000, outputRate: 24_000 });

export const LIMITS = Object.freeze({
  /** Characters of one speech request (a sentence is split below this; tts.js). */
  speakChars: 600,
  /** Longest utterance a press records; the WAV then stays under maxWavBytes. */
  utteranceSec: 60,
  /** Header plus 60 s of 16 kHz PCM16. */
  maxWavBytes: 44 + 60 * 16_000 * 2,
  /** Characters a transcript may have. */
  transcriptChars: 4000,
  /** The user's glossary: characters and terms. */
  glossaryChars: 600,
  glossaryTerms: 60,
  /** Utterances shorter than this (a tap on the button) are not sent. */
  minUtteranceMs: 250,
  /** The microphone stays muted this long after the app stopped speaking (half duplex). */
  playbackMuteMs: 300,
  /** A Live session ends after this long, after this much silence, or when the tab is hidden. */
  liveSessionMin: 15,
  liveSilenceMin: 3,
  /** A Live token is valid this long and must open its session within the second limit. */
  tokenTtlMin: 30,
  tokenConnectSec: 60,
  /** Characters of excerpts a source Live turn passes to the model. */
  liveExcerptChars: 18_000,
});

/**
 * Default models of the speech services. A site sets its own for the server routes through
 * STARPI_GEMINI_TTS_MODEL, STARPI_GEMINI_STT_MODEL, STARPI_GEMINI_LIVE_MODEL and
 * STARPI_ELEVENLABS_MODEL; calls with the user's own key use these.
 */
export const SPEECH_MODELS = Object.freeze({
  geminiStt: 'gemini-2.5-flash',
  geminiTts: 'gemini-2.5-flash-preview-tts',
  geminiLive: 'gemini-live-2.5-flash-preview',
  openaiStt: 'gpt-4o-mini-transcribe',
  openaiTts: 'gpt-4o-mini-tts',
  groqStt: 'whisper-large-v3-turbo',
  elevenlabsTts: 'eleven_multilingual_v2',
  piper: 'piper',
});

/** Speech input sources, in the order the automatic choice tries them. */
export const STT_SOURCES = Object.freeze(/** @type {const} */ (['browser', 'gemini', 'openai', 'groq', 'local', 'companion']));
/** Speech output sources. */
export const TTS_SOURCES = Object.freeze(/** @type {const} */ (['browser', 'gemini', 'elevenlabs', 'openai', 'local']));

/** @typedef {(typeof STT_SOURCES)[number]} SttSourceId */
/** @typedef {(typeof TTS_SOURCES)[number]} TtsSourceId */

/**
 * @param {unknown} value
 * @returns {value is SttSourceId}
 */
export const isSttSource = (value) => typeof value === 'string' && /** @type {readonly string[]} */ (STT_SOURCES).includes(value);

/**
 * @param {unknown} value
 * @returns {value is TtsSourceId}
 */
export const isTtsSource = (value) => typeof value === 'string' && /** @type {readonly string[]} */ (TTS_SOURCES).includes(value);

/**
 * Sources whose audio or text stays on this device or on a machine of the user's own (a speech
 * server they run, the paired companion). The on-device mode allows only these.
 */
export const LOCAL_SOURCES = Object.freeze(new Set(['local', 'companion']));

/** @typedef {{ id: string, label: string, online?: boolean }} VoiceEntry  online: a browser voice that sends the text to its vendor */

/**
 * The prebuilt voices of Gemini speech generation (the names the API takes as voiceName).
 * @type {readonly string[]}
 */
export const GEMINI_VOICES = Object.freeze([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);
export const DEFAULT_GEMINI_VOICE = 'Kore';

/**
 * ElevenLabs premade voices, as the public voice library lists them. Only these ids are spoken,
 * and only when the account's own list also calls them premade.
 * @type {readonly VoiceEntry[]}
 */
export const ELEVENLABS_VOICES = Object.freeze([
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', label: 'Laura' },
  { id: 'IKne3meq5aSn9XLyUdCD', label: 'Charlie' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda' },
  { id: 'bIHbv24MWmeRgasZH58o', label: 'Will' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica' },
  { id: 'cjVigY5qzO86Huf0OWal', label: 'Eric' },
  { id: 'iP95p4xoKVk53GoZ742B', label: 'Chris' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily' },
  { id: 'pqHfZKP75CvOlQylNhV4', label: 'Bill' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger' },
  { id: 'SAz9YHcvj6GT2YYXdXww', label: 'River' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni' },
]);
export const DEFAULT_ELEVENLABS_VOICE = 'EXAVITQu4vr4xnSDxMaL';

/** The voices of OpenAI speech generation. */
export const OPENAI_VOICES = Object.freeze(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
export const DEFAULT_OPENAI_VOICE = 'alloy';

/**
 * @typedef {object} PiperVoice
 * @property {string} id
 * @property {string} label
 * @property {string} lang      BCP 47 with region
 * @property {string} license   SPDX id of the training data's licence
 * @property {string} card
 * @property {string | null} base
 */

/** The Piper voices a local voice server may speak with. @type {readonly PiperVoice[]} */
export const PIPER_VOICES = Object.freeze(/** @type {PiperVoice[]} */ (pipers.voices).map((v) => Object.freeze({ ...v })));

/** @param {unknown} id */
export const isGeminiVoice = (id) => typeof id === 'string' && GEMINI_VOICES.includes(id);
/** @param {unknown} id */
export const isElevenLabsVoice = (id) => typeof id === 'string' && ELEVENLABS_VOICES.some((v) => v.id === id);
/** @param {unknown} id */
export const isOpenAiVoice = (id) => typeof id === 'string' && OPENAI_VOICES.includes(id);
/** @param {unknown} id */
export const isPiperVoice = (id) => typeof id === 'string' && PIPER_VOICES.some((v) => v.id === id);

/**
 * The allowlisted Piper voices of a language ("en", "de-AT"), the exact region first.
 * @param {string} locale
 * @returns {PiperVoice[]}
 */
export function piperVoicesFor(locale) {
  const lang = String(locale ?? '').toLowerCase().replace('_', '-');
  const base = lang.split('-')[0];
  return PIPER_VOICES.filter((v) => v.lang.toLowerCase().split('-')[0] === base).sort((a, b) => Number(b.lang.toLowerCase() === lang) - Number(a.lang.toLowerCase() === lang));
}

/** Origin of the Gemini Live socket. */
export const LIVE_WS_ORIGIN = 'wss://generativelanguage.googleapis.com';
/** Path of the Live endpoint that takes ephemeral tokens (?access_token=), per API version. */
const LIVE_PATH = /^\/ws\/google\.ai\.generativelanguage\.v1(?:alpha|beta)\.GenerativeService\.BidiGenerateContentConstrained$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * @param {unknown} url
 * @returns {URL | null}
 */
function parseUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The Live endpoint for ephemeral tokens of an API version below a socket origin (the real one, or
 * a loopback fake in tests).
 * @param {'v1alpha' | 'v1beta'} version
 * @param {string} [origin]
 */
export function liveEndpoint(version, origin = LIVE_WS_ORIGIN) {
  return `${origin}/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContentConstrained`;
}

/**
 * Whether a socket URL is a Gemini Live endpoint the browser may open: wss on Google's host, or a
 * loopback fake (only the test build's CSP lets a page reach one). Never a URL that carries a key.
 * @param {unknown} url
 */
export function isLiveSocketUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || parsed.username || parsed.password || parsed.hash || !LIVE_PATH.test(parsed.pathname)) return false;
  for (const name of parsed.searchParams.keys()) if (name !== 'access_token') return false;
  if (parsed.protocol === 'wss:' && parsed.origin === LIVE_WS_ORIGIN) return true;
  return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && LOOPBACK.has(parsed.hostname);
}
