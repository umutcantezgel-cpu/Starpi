// @ts-check
// Settings -> Voice: one card with
// - speech input: the source tried first (or the automatic order) and the user's glossary;
// - speech output: the source, the voice for the interface language, the rate, a preview with a
//   fixed sample sentence, and "read answers aloud";
// - a local voice server's address, the user's ElevenLabs key (premade voices only), the Live voice
//   and whether Live may take a camera picture;
// - where audio goes with each source.
// Every source shows whether it can run now (a key, the site's offer, an address). Texts are i18n
// keys; source and voice names are proper names.
import { getKey, onKeysChange, removeKey, setKey } from '../ai/keys.js';
import { setHtml } from '../dom.js';
import { getIntlLocale, getLocale, t } from '../i18n/index.js';
import { html, icon, label, raw } from '../ui/kit.js';
import { GEMINI_VOICES, STT_SOURCES, TTS_SOURCES } from './catalog.js';
import { SOURCE_KEYS } from './indicators.js';
import { getVoiceSettings, normalizeServerUrl, onVoiceSettingsChange, RATE_MAX, RATE_MIN, setVoiceSettings, voiceFor } from './settings.js';
import { loadSiteOffer, pageContext, STT, TTS } from './sources/index.js';

/** @typedef {import('./sources/shared.js').SourceContext} SourceContext */
/** @typedef {import('./settings.js').VoiceSettings} VoiceSettings */

/**
 * @typedef {object} ViewServices
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onAction
 * @property {(name: string, handler: (el: HTMLElement, event: Event) => unknown) => void} onChange
 * @property {(fn: () => void) => unknown} [onLocaleChange]
 * @property {(message: import('../ui/kit.js').Label, opts?: { tone?: import('../ui/kit.js').Tone }) => unknown} [toast]
 */

/**
 * @typedef {object} ViewDeps
 * @property {SourceContext} [ctx]
 * @property {() => Promise<void>} [preview]
 */

/** Where the audio of each source goes (the privacy list). */
const ROUTE_KEYS = Object.freeze(
  /** @type {Record<string, string>} */ ({
    browser: 'voice.privacy.browser',
    gemini: 'voice.privacy.gemini',
    openai: 'voice.privacy.openai',
    groq: 'voice.privacy.groq',
    elevenlabs: 'voice.privacy.elevenlabs',
    local: 'voice.privacy.local',
    companion: 'voice.privacy.companion',
  }),
);

/**
 * @param {SourceContext} ctx
 * @param {{ available: (ctx: SourceContext) => boolean }} source
 */
const canRun = (ctx, source) => {
  try {
    return source.available(ctx);
  } catch {
    return false;
  }
};

/**
 * Builds the view into `el` and wires its actions.
 * @param {HTMLElement} el
 * @param {ViewServices} services
 * @param {ViewDeps} [deps]
 */
export function mountVoiceSettings(el, services, deps = {}) {
  const ctx = deps.ctx ?? pageContext;
  const preview = deps.preview ?? (() => import('./speech.js').then((m) => m.previewVoice()));
  /** @param {string} selector */
  const part = (selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));
  const lang = () => (getLocale() === 'de' ? 'de' : getLocale());

  /**
   * An option of a source select, marked when the source cannot run now.
   * @param {string} id
   * @param {string} selected
   * @param {boolean} ready
   */
  const sourceOption = (id, selected, ready) =>
    html`<option value="${id}"${id === selected ? raw(' selected') : ''}>${t(SOURCE_KEYS[id])}${ready ? '' : ` (${t('voice.settings.not_ready')})`}</option>`;

  /** @param {VoiceSettings} s */
  function sttOptions(s) {
    return html`<option value="auto"${s.stt === 'auto' ? raw(' selected') : ''}>${t('voice.settings.stt_auto')}</option>${STT_SOURCES.map((id) => sourceOption(id, s.stt, canRun(ctx, STT[id])))}`;
  }

  /** @param {VoiceSettings} s */
  function ttsOptions(s) {
    return html`${TTS_SOURCES.map((id) => sourceOption(id, s.tts, canRun(ctx, TTS[id])))}`;
  }

  /** @param {VoiceSettings} s */
  function liveOptions(s) {
    return html`${GEMINI_VOICES.map((v) => html`<option value="${v}"${v === s.liveVoice ? raw(' selected') : ''}>${v}</option>`)}`;
  }

  function sttStatus() {
    const ready = STT_SOURCES.filter((id) => canRun(ctx, STT[id]));
    return ready.length
      ? html`<span class="flex items-start gap-1.5">${icon('check-circle-2', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-600')}${label({ key: 'voice.settings.stt_chain', params: { sources: ready.map((id) => t(SOURCE_KEYS[id])).join(' → ') } })}</span>`
      : html`<span class="flex items-start gap-1.5">${icon('triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-600')}${label('voice.settings.stt_none')}</span>`;
  }

  function elevenStatus() {
    const has = getKey('elevenlabs').trim() !== '';
    return html`<span class="chip ${has ? 'chip-ok' : 'chip-neutral'}">${icon(has ? 'check-circle-2' : 'circle-dashed', '')}${label(has ? 'voice.settings.key_saved' : 'voice.settings.key_none')}</span>`;
  }

  function render() {
    const s = getVoiceSettings();
    setHtml(
      el,
      html`<div class="card p-4 sm:p-5 space-y-4" data-voice-settings>
        <div class="card-header"><h3 class="card-title">${icon('mic', 'w-4 h-4 text-amber-600')}${label('voice.settings.title')}</h3></div>
        ${label('voice.settings.subtitle', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed -mt-2' })}

        <section class="space-y-2" aria-labelledby="vsSttTitle">
          ${label('voice.settings.stt_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'vsSttTitle' })}
          <label class="field-label" for="vsStt">${label('voice.settings.stt_label')}</label>
          <select id="vsStt" class="field" data-change="voice-stt">${sttOptions(s)}</select>
          <p class="text-xs text-slate-600" data-vs="stt-status">${sttStatus()}</p>
          <label class="field-label" for="vsGlossary">${label('voice.settings.glossary_label')}</label>
          <textarea id="vsGlossary" rows="2" class="field" data-change="voice-glossary" data-i18n-placeholder="voice.settings.glossary_placeholder" placeholder="${t('voice.settings.glossary_placeholder')}">${s.glossary}</textarea>
          ${label('voice.settings.glossary_hint', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
        </section>

        <section class="space-y-2 pt-3 border-t border-slate-100" aria-labelledby="vsTtsTitle">
          ${label('voice.settings.tts_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'vsTtsTitle' })}
          <div class="grid gap-2 sm:grid-cols-2">
            <div class="space-y-1"><label class="field-label" for="vsTts">${label('voice.settings.tts_label')}</label><select id="vsTts" class="field" data-change="voice-tts">${ttsOptions(s)}</select></div>
            <div class="space-y-1"><label class="field-label" for="vsVoice">${label('voice.settings.voice_label')}</label><select id="vsVoice" class="field" data-change="voice-voice"><option value="">${t('voice.settings.voice_auto')}</option></select></div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label class="text-xs text-slate-600" for="vsRate">${label('voice.settings.rate_label')}</label>
            <input id="vsRate" type="range" min="${RATE_MIN}" max="${RATE_MAX}" step="0.05" value="${s.rate}" class="flex-1 min-w-[8rem]" data-change="voice-rate">
            <output for="vsRate" class="text-xs font-mono text-slate-700" data-vs="rate">${s.rate.toFixed(2)}×</output>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-secondary py-1" data-action="voice-preview">${icon('volume-2', 'w-3.5 h-3.5')}${label('voice.settings.preview')}</button>
            <label class="flex items-center gap-2 text-sm text-slate-800 cursor-pointer select-none">
              <input type="checkbox" id="vsAutoRead" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="voice-auto-read"${s.autoRead ? raw(' checked') : ''}>
              ${label('voice.settings.auto_read')}
            </label>
          </div>
          ${label('voice.settings.tts_hint', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
        </section>

        <section class="space-y-2 pt-3 border-t border-slate-100" aria-labelledby="vsLocalTitle">
          ${label('voice.settings.local_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'vsLocalTitle' })}
          <div class="flex flex-wrap gap-2">
            <label class="sr-only" for="vsLocalUrl">${label('voice.settings.local_label')}</label>
            <input id="vsLocalUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" class="field flex-1 min-w-[12rem]" placeholder="http://127.0.0.1:8000" value="${s.localUrl}">
            <button type="button" class="btn btn-secondary" data-action="voice-save-local">${label('voice.settings.save')}</button>
          </div>
          ${label('voice.settings.local_hint', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
        </section>

        <section class="space-y-2 pt-3 border-t border-slate-100" aria-labelledby="vsElevenTitle">
          <div class="flex flex-wrap items-center justify-between gap-2">${label('voice.settings.eleven_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'vsElevenTitle' })}<span data-vs="eleven-status">${elevenStatus()}</span></div>
          <div class="flex flex-wrap gap-2">
            <label class="sr-only" for="vsElevenKey">${label('voice.settings.eleven_label')}</label>
            <input id="vsElevenKey" type="password" autocomplete="off" spellcheck="false" class="field flex-1 min-w-[12rem]" data-i18n-placeholder="voice.settings.eleven_placeholder" placeholder="${t('voice.settings.eleven_placeholder')}">
            <button type="button" class="btn btn-secondary" data-action="voice-save-eleven-key">${label('voice.settings.save')}</button>
            <button type="button" class="btn btn-ghost text-rose-700" data-action="voice-remove-eleven-key">${icon('trash-2', 'w-3.5 h-3.5')}${label('voice.settings.remove')}</button>
          </div>
          ${label('voice.settings.eleven_hint', { tag: 'p', className: 'text-xs text-slate-500 leading-relaxed' })}
        </section>

        <section class="space-y-2 pt-3 border-t border-slate-100" aria-labelledby="vsLiveTitle">
          ${label('voice.settings.live_title', { tag: 'h4', className: 'text-sm font-semibold text-slate-800', id: 'vsLiveTitle' })}
          <div class="flex flex-wrap items-center gap-3">
            <label class="text-xs text-slate-600" for="vsLiveVoice">${label('voice.settings.live_voice')}</label>
            <select id="vsLiveVoice" class="field w-auto" data-change="voice-live-voice">${liveOptions(s)}</select>
            <label class="flex items-center gap-2 text-sm text-slate-800 cursor-pointer select-none">
              <input type="checkbox" id="vsCamera" class="rounded border-slate-300 text-amber-500 focus:ring-amber-300" data-change="voice-camera"${s.camera ? raw(' checked') : ''}>
              ${label('voice.settings.camera')}
            </label>
          </div>
        </section>

        <p class="text-xs min-w-0" role="status" aria-live="polite" data-vs="result"></p>
        ${(() => {
          const ids = Object.keys(ROUTE_KEYS);
          return html`<details class="disclosure"><summary>${icon('shield', 'w-4 h-4 text-amber-600')}${label('voice.privacy.title')}${icon('chevron-down', 'disclosure-chevron')}</summary><div class="disclosure-body"><ul class="space-y-1 text-xs text-slate-600 leading-relaxed">${ids.map((id) => html`<li><strong class="font-semibold text-slate-800">${t(SOURCE_KEYS[id])}:</strong> ${label(ROUTE_KEYS[id])}</li>`)}</ul></div></details>`;
        })()}
      </div>`.value,
    );
    void fillVoices();
  }

  /** Fills the voice select with the voices of the chosen output source for the interface language. */
  async function fillVoices() {
    const s = getVoiceSettings();
    const select = /** @type {HTMLSelectElement | null} */ (part('#vsVoice'));
    if (!select) return;
    const source = TTS[s.tts];
    const locale = getIntlLocale();
    /** @type {import('./catalog.js').VoiceEntry[]} */
    const voices = await source.voices(ctx, locale).catch(() => []);
    const current = voiceFor(s, s.tts, locale);
    const options = [html`<option value="">${t('voice.settings.voice_auto')}</option>`, ...voices.map((v) => html`<option value="${v.id}"${v.id === current ? raw(' selected') : ''}>${v.label}${v.online ? ` (${t('voice.settings.voice_online')})` : ''}</option>`)];
    setHtml(select, html`${options}`.value);
  }

  function refreshSources() {
    const s = getVoiceSettings();
    const stt = part('#vsStt');
    if (stt) setHtml(stt, sttOptions(s).value);
    const tts = part('#vsTts');
    if (tts) setHtml(tts, ttsOptions(s).value);
    const status = part('[data-vs="stt-status"]');
    if (status) setHtml(status, sttStatus().value);
    const eleven = part('[data-vs="eleven-status"]');
    if (eleven) setHtml(eleven, elevenStatus().value);
  }

  /**
   * @param {import('../ui/kit.js').Label} text
   * @param {'ok' | 'warn'} tone
   */
  function result(text, tone) {
    const box = part('[data-vs="result"]');
    if (box) setHtml(box, html`<span class="flex items-start gap-1.5" data-tone="${tone}">${icon(tone === 'ok' ? 'check-circle-2' : 'triangle-alert', 'w-3.5 h-3.5 mt-0.5 flex-shrink-0')}${label(text)}</span>`.value);
  }

  /** @param {HTMLElement} target */
  const valueOf = (target) => /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (target).value;

  services.onChange('voice-stt', (target) => {
    setVoiceSettings({ stt: /** @type {any} */ (valueOf(target)) });
    refreshSources();
  });
  services.onChange('voice-glossary', (target) => {
    setVoiceSettings({ glossary: valueOf(target) });
    result('voice.settings.saved', 'ok');
  });
  services.onChange('voice-tts', (target) => {
    setVoiceSettings({ tts: /** @type {any} */ (valueOf(target)) });
    void fillVoices();
  });
  services.onChange('voice-voice', (target) => {
    const s = getVoiceSettings();
    const value = valueOf(target);
    const perLang = { ...(s.voices[s.tts] ?? {}) };
    if (value) perLang[lang()] = value;
    else delete perLang[lang()];
    setVoiceSettings({ voices: { [s.tts]: perLang } });
  });
  services.onChange('voice-rate', (target) => {
    const s = setVoiceSettings({ rate: Number(valueOf(target)) });
    const out = part('[data-vs="rate"]');
    if (out) out.textContent = `${s.rate.toFixed(2)}×`;
  });
  services.onChange('voice-auto-read', (target) => setVoiceSettings({ autoRead: /** @type {HTMLInputElement} */ (target).checked }));
  services.onChange('voice-live-voice', (target) => setVoiceSettings({ liveVoice: valueOf(target) }));
  services.onChange('voice-camera', (target) => setVoiceSettings({ camera: /** @type {HTMLInputElement} */ (target).checked }));
  services.onAction('voice-preview', () => {
    preview().catch(() => result('voice.fallback.none', 'warn'));
  });
  services.onAction('voice-save-local', () => {
    const input = /** @type {HTMLInputElement | null} */ (part('#vsLocalUrl'));
    const raw = input?.value.trim() ?? '';
    const url = normalizeServerUrl(raw);
    if (raw && !url) return result('voice.settings.local_invalid', 'warn');
    setVoiceSettings({ localUrl: url });
    if (input) input.value = url;
    refreshSources();
    result(url ? 'voice.settings.local_saved' : 'voice.settings.local_cleared', 'ok');
  });
  services.onAction('voice-save-eleven-key', async () => {
    const input = /** @type {HTMLInputElement | null} */ (part('#vsElevenKey'));
    const key = input?.value.trim() ?? '';
    if (!key) return result('voice.settings.key_empty', 'warn');
    try {
      await setKey('elevenlabs', key);
      if (input) input.value = '';
      result('voice.settings.key_stored', 'ok');
    } catch {
      result('voice.settings.key_failed', 'warn');
    }
    refreshSources();
  });
  services.onAction('voice-remove-eleven-key', async () => {
    await Promise.resolve(removeKey('elevenlabs')).catch(() => {});
    refreshSources();
    result('voice.settings.key_removed', 'ok');
  });

  render();
  onKeysChange(() => refreshSources());
  onVoiceSettingsChange(() => refreshSources());
  services.onLocaleChange?.(() => render());
  void loadSiteOffer().then(() => refreshSources());
  return { render, refreshSources };
}
