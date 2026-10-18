// @ts-check
// The full-screen Live sheet (#liveSheet): the mode (free conversation, or from your sources), the
// state of the conversation in words, the transcript with its labels, and the controls (start, press
// to talk, camera picture, a typed turn, stop). It wires the Live controller (controller.js) to the
// app: tokens from the site's live-token route (the user's Gemini key travels in a header, never in
// a URL), the microphone, the playback and speech queue, the speech input chain, and the chat's own
// model and retrieval when the chat registered them (voice/hooks.js), else live/ask.js.
import { getKey } from '../ai/keys.js';
import { setHtml } from '../dom.js';
import { getIntlLocale, getLocale, t } from '../i18n/index.js';
import { getMode } from '../state.js';
import { html, icon, label, segmented, setSegmentedValue } from '../ui/kit.js';
import { createCapture } from '../voice/capture.js';
import { apiLiveToken } from '../voice/client.js';
import { voiceUi } from '../voice/hooks.js';
import { getPlayback } from '../voice/playback.js';
import { getVoiceSettings } from '../voice/settings.js';
import { loadSiteOffer, pageContext, STT } from '../voice/sources/index.js';
import { speechQueue } from '../voice/speech.js';
import { sttChain, transcribeWithFallback } from '../voice/stt.js';
import { defaultAsk, defaultRetrieve } from './ask.js';
import { captureStill } from './camera.js';
import { createLiveController } from './controller.js';
import { renderTranscript } from './transcript.js';

/** @typedef {import('../features/registry.js').FeatureContext} FeatureContext */
/** @typedef {import('./controller.js').LiveState} LiveState */
/** @typedef {import('./controller.js').LiveMode} LiveMode */

/** The words of each state. */
const STATE_KEYS = Object.freeze(
  /** @type {Record<LiveState, string>} */ ({
    idle: 'live.state.idle',
    connecting: 'live.state.connecting',
    ready: 'live.state.ready',
    listening: 'live.state.listening',
    thinking: 'live.state.thinking',
    speaking: 'live.state.speaking',
    ended: 'live.state.ended',
  }),
);

/** Speech input sources that can transcribe a recording (browser recognition cannot, it listens itself). */
const transcribers = () => sttChain(STT, pageContext).filter((s) => s.transcribe);

/** @type {ReturnType<typeof createLiveController> | null} */
let controller = null;
let wired = false;
/** @type {LiveMode} */
let chosenMode = 'free';

/** The controller with the app's parts. */
function liveController() {
  if (controller) return controller;
  const queue = speechQueue();
  const playback = getPlayback();
  const queueActivity = { isPlaying: () => queue.speaking(), onStateChange: (/** @type {(on: boolean) => void} */ fn) => queue.onState(fn) };
  controller = createLiveController({
    liveToken: (input) => apiLiveToken({ ...input, locale: getLocale(), camera: getVoiceSettings().camera }, { userKey: getKey('gemini').trim() || null }),
    canUseLive: () => !pageContext.onDevice() && (getKey('gemini').trim() !== '' || pageContext.site()?.live === true),
    capture: () => createCapture({ context: () => playback.context(), activity: [playback, queueActivity] }),
    playback,
    queue,
    transcribe: (wav, signal) => transcribeWithFallback(wav, { chain: transcribers(), ctx: pageContext, locale: getIntlLocale(), signal }),
    canTranscribe: () => transcribers().length > 0,
    ask: (turn) => (voiceUi().ask ?? defaultAsk)(turn),
    retrieve: (query, options) => (voiceUi().retrieve ?? defaultRetrieve)(query, options),
    camera: () => captureStill(),
    locale: getIntlLocale,
    voice: () => getVoiceSettings().liveVoice,
  });
  return controller;
}

/**
 * The sheet's markup (rendered once; the parts update in place).
 */
function sheetMarkup() {
  return html`<div class="flex flex-col h-full max-w-3xl w-full mx-auto">
    <header class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200">
      <h2 class="flex items-center gap-2 text-base font-semibold text-slate-900">${icon('audio-lines', 'w-5 h-5 text-amber-600')}${label('live.title')}</h2>
      <button type="button" class="btn btn-ghost btn-icon" data-action="live-close" data-i18n-aria="live.close" aria-label="${t('live.close')}">${icon('x', 'w-5 h-5')}</button>
    </header>
    <div class="px-4 pt-3 space-y-2">
      ${segmented({ action: 'live-mode', label: 'live.mode.label', value: chosenMode, id: 'liveMode', options: [{ value: 'free', label: 'live.mode.free', icon: 'message-square' }, { value: 'sources', label: 'live.mode.sources', icon: 'shield-check' }] })}
      <p class="text-xs text-slate-600 leading-relaxed" data-live="mode-hint">${label(chosenMode === 'free' ? 'live.mode.free_hint' : 'live.mode.sources_hint')}</p>
    </div>
    <p class="mx-4 mt-2 flex items-center gap-2 text-sm font-medium text-slate-800" role="status" aria-live="polite" data-live="state">${icon('circle-dashed', 'w-4 h-4')}${label(STATE_KEYS.idle)}</p>
    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3" aria-live="polite" data-live="transcript">${renderTranscript([])}</div>
    <footer class="border-t border-slate-200 px-4 py-3 space-y-3 pb-[max(0.75rem,env(safe-area-inset-bottom,12px))]">
      <div class="flex flex-wrap items-center justify-center gap-2">
        <button type="button" class="btn btn-primary" data-action="live-start" data-live="start">${icon('audio-lines', 'w-4 h-4')}${label('live.start')}</button>
        <button type="button" class="hidden btn btn-primary touch-target-min" data-action="live-talk" data-live="talk" aria-pressed="false">${icon('mic', 'w-4 h-4')}<span data-live="talk-text">${t('live.talk')}</span></button>
        <button type="button" class="hidden btn btn-secondary" data-action="live-camera" data-live="camera">${icon('camera', 'w-4 h-4')}${label('live.camera')}</button>
        <button type="button" class="hidden btn btn-secondary" data-action="live-stop" data-live="stop">${icon('square', 'w-4 h-4')}${label('live.stop')}</button>
      </div>
      <form class="hidden flex gap-2" data-live="say-form">
        <label class="sr-only" for="liveSayInput">${label('live.say_label')}</label>
        <input id="liveSayInput" class="field flex-1" autocomplete="off" data-i18n-placeholder="live.say_placeholder" placeholder="${t('live.say_placeholder')}">
        <button type="button" class="btn btn-secondary" data-action="live-say">${label('live.say')}</button>
      </form>
      <p class="text-[11px] text-slate-500 text-center leading-snug" data-live="limits">${label('live.limits')}</p>
    </footer>
  </div>`;
}

/**
 * Updates the parts of the sheet for a state.
 * @param {HTMLElement} el
 */
function showState(el) {
  const c = liveController();
  const state = c.state();
  const part = (/** @type {string} */ name) => /** @type {HTMLElement | null} */ (el.querySelector(`[data-live="${name}"]`));
  const running = state !== 'idle' && state !== 'ended';
  const ended = state === 'ended' && c.reason() && c.reason() !== 'stopped';
  // Why the last press to talk led to no turn, while the conversation waits for the next one.
  const hint = running && state === 'ready' ? c.hint() : null;
  const status = part('state');
  if (status) {
    const iconName = hint ? 'info' : { idle: 'circle-dashed', connecting: 'loader-2', ready: 'mic', listening: 'mic', thinking: 'loader-2', speaking: 'volume-2', ended: 'circle-dashed' }[state];
    const engine = c.engine();
    const words = ended ? `live.ended.${c.reason()}` : hint ? `live.hint.${hint}` : STATE_KEYS[state];
    setHtml(
      status,
      html`${icon(iconName, 'w-4 h-4 shrink-0')}${label(words)}${running && engine ? html`<span class="chip chip-neutral text-[11px]">${label(engine === 'live' ? 'live.engine.live' : 'live.engine.turns')}</span>` : ''}`.value,
    );
  }
  part('start')?.classList.toggle('hidden', running);
  part('stop')?.classList.toggle('hidden', !running);
  const turns = running && c.engine() === 'turns';
  const talk = part('talk');
  if (talk) {
    talk.classList.toggle('hidden', !turns);
    talk.setAttribute('aria-pressed', String(state === 'listening'));
    const text = part('talk-text');
    if (text) text.textContent = t(state === 'listening' ? 'live.talk_send' : state === 'thinking' || state === 'speaking' ? 'live.talk_interrupt' : 'live.talk');
  }
  part('camera')?.classList.toggle('hidden', !running || !getVoiceSettings().camera);
  part('say-form')?.classList.toggle('hidden', !running);
  for (const btn of el.querySelectorAll('#liveMode button')) /** @type {HTMLButtonElement} */ (btn).disabled = running;
}

/**
 * Opens the sheet (first time: renders it and wires its actions).
 * @param {HTMLElement} el the #liveSheet mount
 * @param {FeatureContext} ctx
 */
export function openLiveSheet(el, ctx) {
  const c = liveController();
  if (!wired) {
    wired = true;
    setHtml(el, sheetMarkup().value);
    c.onState(() => showState(el));
    c.transcript.onChange((entries) => {
      const box = /** @type {HTMLElement | null} */ (el.querySelector('[data-live="transcript"]'));
      if (!box) return;
      setHtml(box, renderTranscript(entries).value);
      box.scrollTop = box.scrollHeight;
    });
    ctx.onAction('live-close', () => ctx.closeDialog(el));
    ctx.onAction('live-mode', (btn) => {
      if (c.state() !== 'idle' && c.state() !== 'ended') return;
      chosenMode = btn.dataset.arg === 'sources' ? 'sources' : 'free';
      setSegmentedValue(el.querySelector('#liveMode'), chosenMode);
      const hint = /** @type {HTMLElement | null} */ (el.querySelector('[data-live="mode-hint"]'));
      if (hint) setHtml(hint, label(chosenMode === 'free' ? 'live.mode.free_hint' : 'live.mode.sources_hint').value);
    });
    ctx.onAction('live-start', async () => {
      if (getMode() === 'client' && !voiceUi().ask) {
        ctx.toast('live.on_device', { tone: 'warn' });
        return;
      }
      await getPlayback().unlock();
      await Promise.race([loadSiteOffer(), new Promise((resolve) => setTimeout(resolve, 1500))]);
      await c.start(chosenMode);
      showState(el);
    });
    ctx.onAction('live-talk', () => void c.talk());
    ctx.onAction('live-stop', () => c.stop('stopped'));
    ctx.onAction('live-camera', async () => {
      if (!(await c.snapshot())) ctx.toast('live.camera_failed', { tone: 'warn' });
      else ctx.toast('live.camera_sent', { tone: 'info' });
    });
    ctx.onAction('live-say', () => {
      const input = /** @type {HTMLInputElement | null} */ (el.querySelector('#liveSayInput'));
      const text = input?.value.trim() ?? '';
      if (!text) return;
      if (input) input.value = '';
      void c.say(text);
    });
    el.querySelector('[data-live="say-form"]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      /** @type {HTMLButtonElement | null} */ (el.querySelector('[data-action="live-say"]'))?.click();
    });
    ctx.onLocaleChange(() => {
      setHtml(el, sheetMarkup().value);
      showState(el);
      const box = /** @type {HTMLElement | null} */ (el.querySelector('[data-live="transcript"]'));
      if (box) setHtml(box, renderTranscript(c.transcript.entries()).value);
    });
  }
  showState(el);
  ctx.openDialog(el, { onClose: () => c.stop('stopped'), initialFocus: /** @type {HTMLElement | null} */ (el.querySelector('[data-live="start"]')) });
}
