// Voice in the running app (desktop Chromium, no real microphone or voices): the microphone button
// falls back from a failing browser recognition to recording for the local voice server (the voice
// fake), the voice preview is spoken through the speech queue, and the Live sheet holds a free
// Gemini Live conversation over a routed WebSocket (token from the live-token route with the user's
// key in its header, never in a URL), labelled free, with the spoken free notice.
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, test } from './fixtures.mjs';

const FAKES_PORT = Number(process.env.STARPI_FAKES_PORT || 4610);
const VOICE_FAKE = `http://127.0.0.1:${FAKES_PORT + 5}`;
// A fake key, built at runtime so the secret scan does not read it as a credential.
const GEMINI_KEY = ['AIzaSyA', 'e2e', 'live', 'gem', '0123456789abcdefghi'].join('-');
const LIVE_SOCKET = /^wss:\/\/generativelanguage\.googleapis\.com\/ws\//;

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'voice runs on desktop Chromium only');

/**
 * Stand-ins for the hardware Chromium lacks here: a microphone (an oscillator as a MediaStream),
 * a speech recognition that fails like an unreachable vendor service, and speechSynthesis that
 * records what it is asked to say.
 * @param {import('@playwright/test').Page} page
 * @param {{ voice?: Record<string, unknown>, geminiKey?: string }} [options]
 */
async function stubVoice(page, options = {}) {
  await page.addInitScript(
    ([voice, geminiKey]) => {
      if (voice) localStorage.setItem('starpi_voice_v1', JSON.stringify(voice));
      if (geminiKey) sessionStorage.setItem('starpi_gemini_key', geminiKey);
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.frequency.value = 330;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        return dest.stream;
      };
      class UnreachableRecognition {
        constructor() {
          this.lang = '';
          this.onstart = null;
          this.onend = null;
          this.onerror = null;
          this.onresult = null;
        }
        start() {
          setTimeout(() => {
            this.onstart?.();
            this.onerror?.({ error: 'network' });
            this.onend?.();
          }, 20);
        }
        stop() {}
        abort() {}
      }
      Object.assign(window, { SpeechRecognition: UnreachableRecognition, webkitSpeechRecognition: UnreachableRecognition, __spoken: [] });
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speak(/** @type {SpeechSynthesisUtterance} */ u) {
            /** @type {any} */ (window).__spoken.push(u.text);
            setTimeout(() => u.onend?.(/** @type {any} */ (new Event('end'))), 10);
          },
          cancel() {},
          getVoices: () => [],
          addEventListener() {},
          removeEventListener() {},
        },
      });
    },
    [options.voice ?? null, options.geminiKey ?? null],
  );
}

/** @param {import('@playwright/test').Page} page */
const spoken = (page) => page.evaluate(() => /** @type {string[]} */ (/** @type {any} */ (window).__spoken));

/** @param {import('@playwright/test').Page} page @param {string} label */
async function axe(page, label) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('voice', () => {
  test.beforeEach(async ({ page }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // No site functions in this preview: the site offers no voices of its own.
    await page.route('**/api/voice/voices', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"route_missing"}' }));
  });

  test('dictation falls back from the browser recognition to recording for the local voice server', async ({ page, diagnostics: _diagnostics }) => {
    await stubVoice(page, { voice: { localUrl: VOICE_FAKE } });
    await page.goto('/');
    await page.fill('#chatInput', 'Note:');
    await page.click('#voiceBtn');
    await expect(page.locator('#toastRegion')).toContainText("The browser's speech service is not available (network)");
    await expect(page.locator('#voiceSourceChip')).toContainText('Local voice server · recording');
    await expect(page.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(700);
    await page.click('#voiceBtn');
    await expect(page.locator('#chatInput')).toHaveValue('Note: This is a simulated transcript.');
    await expect(page.locator('#voiceBtn')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#voiceSourceChip')).toBeHidden();
  });

  test('the voice preview is spoken through the speech queue, and the settings pass axe', async ({ page, diagnostics: _diagnostics }) => {
    await stubVoice(page);
    await page.goto('/');
    await page.click('#nav-settings');
    const section = page.locator('#voiceSettings');
    await expect(section).toContainText('Speech input');
    await expect(section.locator('#vsStt')).toContainText('Automatic order');
    await page.click('[data-action="voice-preview"]');
    await expect.poll(() => spoken(page)).toEqual(['This is how your answers will sound when they are read aloud.']);
    await page.check('#vsAutoRead');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('starpi_voice_v1') ?? '{}').autoRead)).toBe(true);
    await axe(page, 'voice settings');
  });

  test('the Live sheet holds a free Gemini Live conversation with a token from the user key', async ({ page, diagnostics: _diagnostics }) => {
    await stubVoice(page, { geminiKey: GEMINI_KEY });
    /** @type {Array<{ key: string | undefined, url: string, body: any }>} */
    const tokenCalls = [];
    await page.route('**/api/voice/live-token', async (route) => {
      const req = route.request();
      tokenCalls.push({ key: req.headers()['x-goog-api-key'], url: req.url(), body: req.postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'auth_tokens/e2e-token-1',
          wsUrl: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
          model: 'gemini-live-test',
          setup: { model: 'models/gemini-live-test', generationConfig: { responseModalities: ['AUDIO'] } },
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
          connectBy: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
    });
    /** @type {string[]} */
    const socketUrls = [];
    /** @type {any[]} */
    const received = [];
    await page.routeWebSocket(LIVE_SOCKET, (ws) => {
      socketUrls.push(ws.url());
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message));
        received.push(msg);
        if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
        if (msg.realtimeInput?.text) {
          const silence = Buffer.alloc(4800).toString('base64');
          ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: silence } }] } } }));
          ws.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Hello from the live service.' } } }));
          ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        }
      });
    });

    await page.goto('/');
    await page.click('#liveOpenBtn');
    const sheet = page.locator('#liveSheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Free conversation');
    await axe(page, 'live sheet');
    await sheet.locator('[data-live="start"]').click();
    await expect(sheet.locator('[data-live="state"]')).toContainText('Listening');
    await expect(sheet.locator('[data-live="state"]')).toContainText('Gemini Live');

    await sheet.locator('#liveSayInput').fill('Hello there');
    await sheet.locator('[data-action="live-say"]').click();
    const answer = sheet.locator('[data-live-entry="assistant"]');
    await expect(answer).toContainText('Hello from the live service.');
    await expect(answer).toContainText('Free · not checked');
    await expect(sheet.locator('[data-live-entry="user"]')).toContainText('Hello there');
    await expect.poll(() => spoken(page)).toContain('Free conversation, answers are not checked.');

    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].key).toBe(GEMINI_KEY);
    expect(tokenCalls[0].url).not.toMatch(/[?&]key=/);
    expect(tokenCalls[0].body).toEqual({ voice: 'Kore', locale: 'en', camera: false });
    expect(socketUrls).toEqual(['wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fe2e-token-1']);
    expect(received[0]).toEqual({ setup: { model: 'models/gemini-live-test', generationConfig: { responseModalities: ['AUDIO'] } } });
    // Microphone frames follow once the spoken notice has ended (half duplex).
    await expect.poll(() => received.some((m) => m.realtimeInput?.audio?.mimeType === 'audio/pcm;rate=16000'), { timeout: 15_000 }).toBe(true);

    await sheet.locator('[data-live="stop"]').click();
    await expect(sheet.locator('[data-live="state"]')).toContainText('Conversation ended');
    await sheet.locator('[data-action="live-close"]').click();
    await expect(sheet).toBeHidden();
  });
});
