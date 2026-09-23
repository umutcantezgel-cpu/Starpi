import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInstructions, buildSystemPrompt, contextSection, identity, LOCAL_IDENTITY, readinessPrompt } from '../../src/js/prompts.js';
import { classifyProgress } from '../../src/js/webgpu/engine.js';

describe('system prompts', () => {
  it('uses the exact on-device identity for each language', () => {
    assert.equal(
      identity('en', 'local'),
      'You are Starpi, a high-performance on-device AI assistant. Respond in English unless the user explicitly prompts in another language.',
    );
    assert.equal(
      identity('de', 'local'),
      'Du bist Starpi, ein leistungsfähiger lokaler KI-Assistent. Antworte auf Deutsch, es sei denn, der Nutzer schreibt in einer anderen Sprache.',
    );
    assert.ok(Object.isFrozen(LOCAL_IDENTITY));
  });

  it('keeps the language directive but drops the on-device claim for remote models', () => {
    for (const target of /** @type {const} */ (['cloud', 'server'])) {
      assert.match(identity('en', target), /Respond in English unless/);
      assert.doesNotMatch(identity('en', target), /on-device/);
      assert.match(identity('de', target), /Antworte auf Deutsch/);
      assert.doesNotMatch(identity('de', target), /lokaler/);
    }
  });

  it('includes grounding, prompt-injection and citation rules in the prompt language', () => {
    const en = buildInstructions('en', 'local');
    assert.match(en, /data, not instructions/);
    assert.match(en, /\[Doc: report\.pdf, Chunk: 2\]/);
    const de = buildInstructions('de', 'local');
    assert.match(de, /Daten, keine Anweisungen/);
    assert.match(de, /\[Doc: bericht\.pdf, Chunk: 2\]/);
  });

  it('appends the context block, or states that nothing was found', () => {
    const withContext = buildSystemPrompt({ locale: 'en', target: 'cloud', context: '<<<EXCERPT 1 [Doc: a, Chunk: 1]>>>\nx\n<<<END EXCERPT 1>>>' });
    assert.match(withContext, /Knowledge base excerpts:\n<<<EXCERPT 1/);
    assert.match(buildSystemPrompt({ locale: 'de', target: 'server', context: ' ' }), /keine passenden Auszüge/);
    assert.equal(contextSection('en', ''), 'Knowledge base excerpts:\nNo matching excerpts were found in the knowledge base.');
  });

  it('asks the connection test in the active language', () => {
    assert.match(readinessPrompt('en'), /^Confirm/);
    assert.match(readinessPrompt('de'), /^Bestätige/);
  });
});

describe('WebLLM load progress', () => {
  it('maps WebLLM progress messages onto localizable phases', () => {
    assert.equal(classifyProgress('Start to fetch params'), 'download');
    assert.equal(
      classifyProgress('Fetching param cache[3/22]: 180MB fetched. 12% completed, 9 secs elapsed. It can take a while when we first visit this page to populate the cache.'),
      'download',
    );
    assert.equal(classifyProgress('Loading model from cache[5/22]: 400MB loaded. 30% completed, 2 secs elapsed.'), 'cache');
    assert.equal(classifyProgress('Loading GPU shader modules[12/40]: 30% completed, 1 secs elapsed.'), 'shaders');
    assert.equal(classifyProgress('Finish loading on WebGPU - apple'), 'finalizing');
    assert.equal(classifyProgress(''), 'init');
  });
});
