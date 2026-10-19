// The answer-quality eval (scripts/eval-answers.mjs) as a smoke run against the local fake
// providers: it asks the prompts with the app's prompts per language, measures every answer
// without a model (answered, language, key words, source check), asks a judge only when one is
// configured with a key, skips cleanly without a target or key, and writes a report that gates
// nothing.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { judgeRequest, loadPrompts, measure, renderMarkdown, requestFor, runEval, startFakes, targetFrom, writeReport } from '../../scripts/eval-answers.mjs';
import { loadShippedLanguages } from '../../src/js/core/lang/index.js';

/** @type {Awaited<ReturnType<typeof startFakes>>} */
let fakes;

before(async () => {
  await loadShippedLanguages();
  fakes = await startFakes();
});

after(async () => {
  await fakes?.close();
});

describe('the prompts', () => {
  it('hold 60 neutral prompts in English and German and a few in each new language', async () => {
    const prompts = await loadPrompts();
    const count = (/** @type {string} */ lang) => prompts.filter((p) => p.lang === lang).length;
    assert.equal(count('en') + count('de'), 60);
    assert.equal(count('en'), 30);
    for (const lang of ['fr', 'es', 'it', 'tr']) assert.ok(count(lang) >= 3, lang);
    assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length, 'unique ids');
    for (const p of prompts) {
      assert.ok(['free', 'grounded'].includes(p.mode), p.id);
      if (p.mode === 'grounded') assert.ok(p.sources?.length && p.mention?.length, `${p.id}: sources and key words`);
    }
  });

  it('go out with the app’s prompt for their language, sources fenced as excerpts', async () => {
    const prompts = await loadPrompts();
    const target = /** @type {any} */ ({ provider: 'openai', model: 'm' });
    const fr = requestFor(/** @type {any} */ (prompts.find((p) => p.lang === 'fr' && p.mode === 'grounded')), target);
    assert.match(String(fr.system), /Réponds en français/);
    assert.match(String(fr.system), /<<<EXCERPT 1 \[Doc: mediatheque\.md, Chunk: 1\]>>>/);
    const de = requestFor(/** @type {any} */ (prompts.find((p) => p.lang === 'de' && p.mode === 'free')), target);
    assert.match(String(de.system), /Antworte auf Deutsch/);
    const judged = judgeRequest(/** @type {any} */ (prompts[0]), 'Canberra.', target);
    assert.match(String(judged.system), /^\[\[starpi-purpose:eval_judge\]\]/);
    assert.equal(judged.responseFormat?.type, 'json_schema');
  });
});

describe('measuring an answer without a model', () => {
  it('reads the language, the key words and the source check', () => {
    const p = /** @type {any} */ ({ id: 'x', lang: 'es', mode: 'grounded', kind: 'sources', prompt: '¿A qué hora cierra?', mention: ['22:00'], sources: [{ doc: 'aparcamiento.md', text: 'El aparcamiento cierra a las 22:00 y los fines de semana permanece cerrado.' }] });
    const good = measure(p, 'El aparcamiento cierra a las 22:00 [Doc: aparcamiento.md, Chunk: 1].');
    assert.deepEqual([good.language, good.languageOk, good.mention], ['es', true, true]);
    assert.deepEqual(good.grounding, { supported: 1, weak: 0, unsupported: 0, cited: 1 });
    const bad = measure(p, 'El aparcamiento cierra a las 23:00 [Doc: aparcamiento.md, Chunk: 1].');
    assert.equal(bad.mention, false);
    assert.equal(bad.grounding?.unsupported, 1);
    const free = measure(/** @type {any} */ ({ ...p, mode: 'free', mention: undefined }), 'The car park closes at ten at night.');
    assert.deepEqual([free.languageOk, free.mention, free.grounding], [false, null, null]);
  });
});

describe('a run', () => {
  it('asks the fake provider, has the judge score each answer and reports per language', async () => {
    const prompts = (await loadPrompts()).filter((p) => ['en-01', 'en-21', 'de-01', 'fr-01', 'tr-03'].includes(p.id));
    const env = fakes.env;
    const report = await runEval({ target: targetFrom(fakes.target, env), judge: targetFrom(fakes.judge, env), prompts, concurrency: 2, timeoutMs: 10_000 });
    assert.equal(report.skipped, null);
    assert.equal(report.results.length, 5);
    assert.ok(report.results.every((r) => r.answered && r.error === null), JSON.stringify(report.results.map((r) => r.error)));
    assert.ok(report.results.every((r) => r.judge?.score === 3), 'the fake judge gives its fixed verdict');
    assert.deepEqual(Object.keys(report.byLanguage), ['en', 'de', 'fr', 'tr']);
    assert.equal(report.summary?.answeredPct, 100);
    assert.equal(report.summary?.judgeMean, 3);
    // The fake answers German questions in German and everything else in English.
    assert.equal(report.byLanguage.de.languagePct, 100);
    assert.equal(report.byLanguage.fr.languagePct, 0);
    const dir = await mkdtemp(path.join(tmpdir(), 'eval-answers-'));
    try {
      const files = await writeReport(report, dir);
      const md = await readFile(files.markdown, 'utf8');
      assert.match(md, /\| fr \| 1 \| 100 % \| 0 % \|/);
      assert.match(md, /This report measures; it gates nothing\./);
      assert.doesNotMatch(await readFile(files.json, 'utf8'), /fake-key/, 'no key in the report');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips without a target or without its key, and asks no judge without a key', async () => {
    assert.equal(targetFrom('anthropic:some-model', {}), null);
    assert.throws(() => targetFrom('nobody:x', {}), /provider/);
    const skipped = await runEval({ target: null, prompts: await loadPrompts(), skipReason: 'no key for anthropic' });
    assert.equal(skipped.skipped, 'no key for anthropic');
    assert.match(renderMarkdown(skipped), /Skipped: no key for anthropic\./);
    const prompts = (await loadPrompts()).slice(0, 1);
    const unjudged = await runEval({ target: targetFrom(fakes.target, fakes.env), judge: targetFrom('anthropic:judge-model', {}), prompts, timeoutMs: 10_000 });
    assert.equal(unjudged.meta.judge, null);
    assert.equal(unjudged.results[0].judge, null);
  });
});
