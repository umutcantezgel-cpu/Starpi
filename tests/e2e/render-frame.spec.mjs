// Rendering in the browser under the production headers: math as MathML and highlighted code in an
// answer without a CSP violation; HTML, SVG and diagram previews in the sandboxed render frame, where
// scripts run only after "Run preview", nothing can be fetched and the parent stays out of reach; the
// frames report their height; and the grounding frame shows search suggestions without running them.
import { expect, mockSupabase, test } from './fixtures.mjs';

const PAGE = [
  '<!doctype html><title>Demo</title>',
  '<style>h1 { color: rgb(200, 0, 0); }</style>',
  '<h1 id="t">Static</h1>',
  '<img src="https://example.com/beacon.png" alt="">',
  '<script>document.getElementById("t").textContent = "Ran";</script>',
].join('\n');

const PROBE = [
  '<p id="out">pending</p>',
  '<script>',
  '(async () => {',
  '  const r = {};',
  "  try { await fetch('/build-manifest.json'); r.fetch = 'allowed'; } catch { r.fetch = 'blocked'; }",
  "  try { r.parent = typeof parent.document.title; } catch { r.parent = 'blocked'; }",
  "  try { localStorage.setItem('k', '1'); r.storage = 'allowed'; } catch { r.storage = 'blocked'; }",
  "  try { r.cookie = typeof document.cookie; } catch { r.cookie = 'blocked'; }",
  "  r.popup = window.open('https://example.com/') === null ? 'blocked' : 'allowed';",
  '  r.origin = self.origin;',
  "  document.getElementById('out').textContent = JSON.stringify(r);",
  '})();',
  '</script>',
].join('\n');

const ANSWER = [
  'Energy: $E = mc^2$, and the area is $$\\int_0^1 x\\,dx = \\tfrac{1}{2}$$ (prices like $5 and $10 stay text).',
  '',
  '```js',
  'const answer = 42; // the answer',
  '```',
  '',
  '```html',
  PAGE,
  '```',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="alert(1)"><rect width="120" height="60" fill="#0a7"/><text x="10" y="35">Logo</text><script>alert(2)</script></svg>',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[Done]',
  '```',
].join('\n');

/**
 * Answers OpenRouter requests with the given reply, as in the free chat.
 * @param {import('@playwright/test').Page} page
 * @param {string} reply
 */
async function mockOpenRouter(page, reply) {
  // Init scripts run in every frame; the sandboxed ones have no storage.
  await page.addInitScript(() => {
    if (self.origin !== 'null') sessionStorage.setItem('starpi_openrouter_key', 'test-key');
  });
  await page.route('https://openrouter.ai/**', async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ choices: [{ message: { content: reply } }] }) });
  });
}

/**
 * Opens the app in free chat and returns the rendered answer to `reply`.
 * @param {import('@playwright/test').Page} page
 * @param {string} reply
 */
async function answerWith(page, reply) {
  await mockSupabase(page, { hardened: true, anonymousAuth: true });
  await mockOpenRouter(page, reply);
  await page.goto('/');
  await page.click('[data-action="set-chat-mode"][data-arg="free"]');
  await page.fill('#chatInput', 'Show me.');
  await page.press('#chatInput', 'Enter');
  const answer = page.locator('#chatMessages > div').last().locator('.message-content');
  await expect(answer.locator('.code-block').first()).toBeVisible();
  return answer;
}

/**
 * The block of the given fence language.
 * @param {import('@playwright/test').Locator} answer
 * @param {string} language
 */
const block = (answer, language) => answer.locator('.code-block').filter({ has: answer.page().locator(`.code-head[data-lang="${language}"]`) });

/**
 * The render frame of a block, once its page has loaded.
 * @param {import('@playwright/test').Page} page
 */
async function renderFrame(page) {
  await expect.poll(() => page.frames().some((f) => f.url().endsWith('/render-frame'))).toBe(true);
  return /** @type {import('@playwright/test').Frame} */ (page.frames().find((f) => f.url().endsWith('/render-frame')));
}

/**
 * Removes the diagnostics a test provoked on purpose and returns them.
 * @param {string[]} diagnostics
 * @param {RegExp[]} expected
 */
function takeExpected(diagnostics, expected) {
  const taken = diagnostics.filter((d) => expected.some((re) => re.test(d)));
  diagnostics.splice(0, diagnostics.length, ...diagnostics.filter((d) => !taken.includes(d)));
  return taken;
}

// Playwright's own init script for serviceWorkers: 'block' reads navigator.serviceWorker in every
// frame, which a sandboxed frame refuses; that error is the harness's, not the app's.
test.afterEach(({ diagnostics }) => {
  takeExpected(diagnostics, [/^pageerror: Failed to read the 'serviceWorker' property from 'Navigator': .*sandboxed/]);
});

test.describe('rendered answers', () => {
  test('typeset math as MathML and highlight code, without inline styles or CSP violations', async ({ page, diagnostics: _diagnostics }) => {
    const answer = await answerWith(page, ANSWER);
    await expect(answer.locator('.math-inline.math-rendered math')).toHaveCount(1);
    await expect(answer.locator('.math-display.math-rendered math[display="block"]')).toHaveCount(1);
    await expect(answer).toContainText('prices like $5 and $10 stay text');
    await expect(block(answer, 'js').locator('pre code.hljs .hljs-keyword').first()).toHaveText('const');
    await expect(block(answer, 'js').locator('pre')).toHaveText('const answer = 42; // the answer\n');
    expect(await answer.locator('[style], script, style, iframe').count()).toBe(0);
    // The language label is drawn by CSS, not text in the answer.
    await expect(block(answer, 'js').locator('.code-head')).toHaveAttribute('data-lang', 'js');
    await expect(block(answer, 'html').locator('[data-action="preview-code"]')).toHaveText('Preview');
    await expect(block(answer, 'js').locator('[data-action="preview-code"]')).toHaveCount(0);
  });
});

test.describe('render frame', () => {
  test('shows HTML without its scripts until "Run preview", and reports its height', async ({ page, diagnostics }) => {
    const answer = await answerWith(page, ANSWER);
    const html = block(answer, 'html');
    await html.locator('[data-action="preview-code"]').click();
    const iframe = html.locator('.code-preview iframe');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(iframe).toHaveAttribute('src', '/render-frame');
    const frame = page.frameLocator('.code-preview iframe');
    await expect(frame.locator('#t')).toHaveText('Static');
    // The preview's own styles apply; its remote image was dropped instead of being refused by the CSP.
    await expect(frame.locator('#t')).toHaveCSS('color', 'rgb(200, 0, 0)');
    expect(await frame.locator('img').getAttribute('src')).toBeNull();
    await expect.poll(async () => Number.parseInt(await iframe.evaluate((el) => /** @type {HTMLElement} */ (el).style.height), 10)).toBeGreaterThan(40);

    await html.locator('[data-action="run-preview"]').click();
    await expect(frame.locator('#t')).toHaveText('Ran');
    // Running, the page is inserted as written: the frame's CSP refuses its remote image.
    await expect.poll(() => takeExpected(diagnostics, [/img-src/]).length).toBeGreaterThan(0);
    const box = await iframe.boundingBox();
    expect(box?.height).toBeGreaterThan(40);
    expect(box?.height).toBeLessThanOrEqual(720);

    await html.locator('[data-action="preview-code"]').click();
    await expect(html.locator('.code-preview')).toHaveCount(0);
  });

  test('cannot fetch, store or reach its parent, even with the preview running', async ({ page, diagnostics }) => {
    const answer = await answerWith(page, `Probe:\n\n\`\`\`html\n${PROBE}\n\`\`\``);
    const html = block(answer, 'html');
    await html.locator('[data-action="preview-code"]').click();
    const frame = page.frameLocator('.code-preview iframe');
    await expect(frame.locator('#out')).toHaveText('pending');
    await html.locator('[data-action="run-preview"]').click();
    await expect(frame.locator('#out')).not.toHaveText('pending');
    expect(JSON.parse((await frame.locator('#out').textContent()) ?? '{}')).toEqual({
      fetch: 'blocked',
      parent: 'blocked',
      storage: 'blocked',
      cookie: 'blocked',
      popup: 'blocked',
      origin: 'null',
    });

    // The same from outside the preview's scripts, in the frame itself.
    const inside = await renderFrame(page);
    const probe = await inside.evaluate(async () => {
      const outcome = async (/** @type {() => unknown} */ fn) => {
        try {
          await fn();
          return 'allowed';
        } catch {
          return 'blocked';
        }
      };
      return {
        fetch: await outcome(() => fetch('/')),
        storage: await outcome(() => sessionStorage.getItem('k')),
        parentDom: await outcome(() => window.parent.document.body.append('escaped')),
        serviceWorker: await outcome(() => navigator.serviceWorker.register('/sw.js')),
        topNavigation: await outcome(() => window.top?.location.assign('/?escaped=1')),
      };
    });
    expect(probe).toMatchObject({ fetch: 'blocked', storage: 'blocked', parentDom: 'blocked', serviceWorker: 'blocked' });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).search).toBe('');
    expect(await page.evaluate(() => document.body.textContent?.includes('escaped'))).toBe(false);

    const provoked = takeExpected(diagnostics, [/connect-src|Refused to connect|Failed to fetch/i, /allow-popups|Blocked opening/i, /allow-top-navigation|Unsafe attempt to initiate navigation|navigat/i, /service ?worker/i]);
    expect(provoked.some((d) => /connect-src|Refused to connect/i.test(d))).toBe(true);
  });

  test('shows SVG sanitized and draws mermaid diagrams, in both themes', async ({ page, diagnostics: _diagnostics }) => {
    const answer = await answerWith(page, ANSWER);
    const svg = block(answer, 'svg');
    await svg.locator('[data-action="preview-code"]').click();
    await expect(svg.locator('[data-action="run-preview"]')).toHaveCount(0);
    const svgFrame = page.frameLocator('.code-block:has(.code-head[data-lang="svg"]) iframe');
    await expect(svgFrame.locator('svg text')).toHaveText('Logo');
    expect(await svgFrame.locator('svg script').count()).toBe(0);
    expect(await svgFrame.locator('svg').getAttribute('onload')).toBeNull();
    await svg.locator('[data-action="preview-code"]').click();

    const diagram = block(answer, 'mermaid');
    await diagram.locator('[data-action="preview-code"]').click();
    const frame = page.frameLocator('.code-block:has(.code-head[data-lang="mermaid"]) iframe');
    await expect(frame.locator('#preview svg')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('#preview')).toContainText('Start');
    await expect(frame.locator('#preview')).toContainText('Done');
    const iframe = diagram.locator('iframe');
    await expect.poll(async () => (await iframe.boundingBox())?.height ?? 0).toBeGreaterThan(80);
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
    // The diagram is drawn again in the dark theme when the app switches.
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(frame.locator('#preview svg')).toBeVisible();
  });

  test('says when a diagram cannot be drawn and keeps its source', async ({ page, diagnostics: _diagnostics }) => {
    const answer = await answerWith(page, '```mermaid\nthis is not a diagram ->->\n```');
    const diagram = block(answer, 'mermaid');
    await diagram.locator('[data-action="preview-code"]').click();
    await expect(diagram.locator('.code-preview-note')).toHaveText('This diagram could not be drawn here. Its source is shown above.', { timeout: 20_000 });
    await expect(diagram.locator('pre')).toContainText('this is not a diagram');
  });
});

test.describe('grounding frame', () => {
  test('shows search suggestions as delivered, runs none of their scripts and reports its height', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const suggestions =
      '<style>.chip{display:inline-block;padding:8px 12px;border:1px solid rgb(0,128,0);border-radius:16px}</style><div class="chip"><a href="https://www.example.com/search?q=starpi">starpi</a></div><script>document.body.dataset.ran = "yes"</script>';
    const result = await page.evaluate(async (html) => {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      iframe.title = 'Search suggestions';
      /** @type {Array<Record<string, unknown>>} */
      const seen = [];
      const heights = new Promise((resolve) => {
        window.addEventListener('message', (event) => {
          if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
          seen.push(event.data);
          if (event.data.type === 'starpi-grounding-ready') iframe.contentWindow?.postMessage({ type: 'starpi-grounding', html }, '*');
          if (event.data.type === 'starpi-grounding-height' && event.data.height > 0) resolve(event.data.height);
        });
      });
      iframe.src = '/grounding-frame';
      document.body.append(iframe);
      const height = await heights;
      return { height, types: [...new Set(seen.map((m) => m.type))] };
    }, suggestions);
    expect(result.types).toEqual(['starpi-grounding-ready', 'starpi-grounding-height']);
    expect(result.height).toBeGreaterThan(20);
    const frame = page.frames().find((f) => f.url().endsWith('/grounding-frame'));
    expect(frame).toBeTruthy();
    const inside = /** @type {import('@playwright/test').Frame} */ (frame);
    await expect(inside.locator('.chip')).toHaveCSS('border-top-color', 'rgb(0, 128, 0)');
    expect(await inside.evaluate(() => document.body.dataset.ran ?? 'no')).toBe('no');
    expect(await inside.evaluate(() => self.origin)).toBe('null');
    // Links leave the frame for a new browsing context.
    expect(await inside.evaluate(() => document.querySelector('base')?.target)).toBe('_blank');
  });
});
