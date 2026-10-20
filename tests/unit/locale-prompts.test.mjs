// What models read in French, Spanish, Italian and Turkish: every prompt table has all six
// languages, a user of a new language gets instructions and labels in it (or English instructions
// that name it), machine-read markers ([Doc: …, Chunk: n], <<<EXCERPT>>>, [S1]) stay as they are,
// and English and German keep their wording.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildContextPack, expandLabels } from '../../src/js/ai/context-pack.js';
import { memoryNote, systemNoteFor } from '../../src/js/ai/memory.js';
import { getPurpose, isPromptLocale } from '../../src/js/ai/purposes.js';
import { packLanguage, webPack } from '../../src/js/ai/search.js';
import { TOOL_RESULT_RULE } from '../../src/js/ai/tools/registry.js';
import { TURN_INSTRUCTIONS, turnMessages } from '../../src/js/live/ask.js';
import { buildSystemPrompt, freeSystemPrompt, FREE_RULES, LOCAL_IDENTITY, REMOTE_IDENTITY, spokenSystemPrompt, turnContext } from '../../src/js/prompts.js';
import { researchLocale, sectionOfHeading, SECTION_HEADINGS, sourcesPrompt, webPrompt } from '../../src/js/research/prompts.js';

const NEW = /** @type {const} */ (['fr', 'es', 'it', 'tr']);
const ALL = /** @type {const} */ (['en', 'de', ...NEW]);

/** @param {import('../../src/js/ai/contract.js').Message} m */
const textOf = (m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

describe('system prompts', () => {
  it('exist in all six languages, each in its own language', () => {
    for (const table of [LOCAL_IDENTITY, REMOTE_IDENTITY, FREE_RULES, TOOL_RESULT_RULE, TURN_INSTRUCTIONS, SECTION_HEADINGS]) {
      assert.deepEqual(Object.keys(table).sort(), [...ALL].sort());
    }
    assert.match(REMOTE_IDENTITY.fr, /Réponds en français/);
    assert.match(REMOTE_IDENTITY.es, /Responde en español/);
    assert.match(REMOTE_IDENTITY.it, /Rispondi in italiano/);
    assert.match(REMOTE_IDENTITY.tr, /Türkçe yanıt ver/);
  });

  it('keep the machine-read parts: excerpt fences and the citation label', () => {
    for (const locale of ALL) {
      const prompt = buildSystemPrompt({ locale, target: 'cloud', context: '' });
      assert.match(prompt, /<<<EXCERPT>>>/, locale);
      assert.match(prompt, /<<<END EXCERPT>>>/, locale);
      assert.match(prompt, /\[Doc: [^,\]]+\.pdf, Chunk: 2\]/, locale);
      assert.match(freeSystemPrompt('cloud', locale), /<<<FILE>>>[\s\S]*<<<CONTEXT>>>/, locale);
      assert.ok(spokenSystemPrompt({ locale, who: 'cloud', context: null }).length > 100, locale);
    }
    assert.match(buildSystemPrompt({ locale: 'fr', target: 'cloud', context: '' }), /Aucun extrait correspondant/);
    assert.match(buildSystemPrompt({ locale: 'tr', target: 'local', context: 'x' }), /^Sen Starpi’sin, cihaz üzerinde/);
  });

  it('write the date of a turn the way the language writes it', () => {
    const now = new Date('2026-03-05T09:30:00Z');
    assert.match(turnContext({ locale: 'fr', now, timeZone: 'UTC' }), /^<<<CONTEXT>>>\nDate et heure actuelles: jeudi 5 mars 2026/);
    assert.match(turnContext({ locale: 'es', now, timeZone: 'UTC' }), /Fecha y hora actuales: jueves, 5 de marzo de 2026/);
    assert.match(turnContext({ locale: 'it', now, timeZone: 'UTC' }), /Data e ora attuali: giovedì 5 marzo 2026/);
    assert.match(turnContext({ locale: 'tr', now, timeZone: 'UTC', notes: ['Not bir'] }), /Geçerli tarih ve saat: 5 Mart 2026 Perşembe[\s\S]*Notlar:\nNot bir/);
    assert.match(turnContext({ locale: 'en', now, timeZone: 'UTC' }), /Current date and time: Thursday,? 5 March 2026/);
  });
});

describe('context packs', () => {
  const passages = [{ label: '[Doc: plan.md, Chunk: 1]', doc: 'plan.md', chunk: 1, heading: '', text: 'La médiathèque ouvre à 9 h du mardi au samedi.' }];
  const model = { contextTokens: 4096, who: /** @type {const} */ ('local') };

  it('give the instruction and the headers in the language of the question', () => {
    const fr = buildContextPack({ question: 'Quand ouvre la médiathèque ?', passages, model, locale: 'fr-FR' });
    assert.match(fr.instructions, /Réponds uniquement à partir du contexte/);
    assert.match(fr.user, /^Contexte :\n<<<SOURCES>>>\n\[S1\] plan\.md — /);
    assert.match(fr.user, /\nQuestion : Quand ouvre/);
    const mixed = buildContextPack({ question: 'Ne zaman?', passages, model, locale: 'tr', mode: 'mixed' });
    assert.match(mixed.instructions, /Genel olarak/);
    assert.match(mixed.user, /^Bağlam:\n/);
    const unknown = buildContextPack({ question: 'Quando?', passages, model, locale: 'pt' });
    assert.match(unknown.user, /^Context:\n/, 'a language without a pack text reads English');
    for (const locale of ['es', 'it']) {
      const pack = buildContextPack({ question: '?', passages: [], model, locale });
      assert.match(pack.contextText, locale === 'es' ? /El contexto está vacío/ : /Il contesto è vuoto/);
    }
  });

  it('read the short labels a small model writes in its own language', () => {
    const pack = buildContextPack({ question: 'Quand ?', passages, model, locale: 'fr' });
    for (const short of ['[S1]', '[Source 1]', '[Fuente 1]', '[Fonte 1]', '[Kaynak 1]']) {
      assert.equal(expandLabels(`Mardi ${short}.`, pack.map), 'Mardi [Doc: plan.md, Chunk: 1].', short);
    }
  });
});

describe('notes, web results and tools', () => {
  it('head the notes and the conversation setup in the language', () => {
    assert.match(memoryNote([{ text: 'Préfère les réponses brèves' }], 'fr'), /^Notes de l’utilisateur \(peut-être dépassées\) :\n- Préfère/);
    assert.match(memoryNote([{ text: 'Kısa yanıtlar' }], 'tr-TR'), /^Kullanıcının notları/);
    assert.match(memoryNote([{ text: 'x' }], 'pt'), /^User notes/);
    const note = systemNoteFor({ project: { name: 'Huerto «Norte»', instructions: 'Responde en tablas.' } }, 'es');
    assert.match(note, /^El usuario configuró lo siguiente/);
    assert.match(note, /proyecto «Huerto 'Norte'» del usuario/, 'quotation marks inside a name cannot close it');
  });

  it('frame web results in the language and keep the result markers', () => {
    const results = [{ title: 'Page', url: 'https://example.org/a', snippet: 'Texte' }];
    assert.match(webPack('q', results, { locale: 'it' }).text, /^Risultati della ricerca web[\s\S]*\[W1\][\s\S]*ad es\. \[W1\]/);
    assert.match(webPack('q', results, { locale: 'de-DE' }).text, /^Websuchergebnisse/);
    assert.equal(packLanguage('tr-TR'), 'tr');
    assert.equal(packLanguage(undefined), 'en');
    for (const locale of ALL) assert.match(TOOL_RESULT_RULE[locale], /<<<TOOL_RESULT>>>[\s\S]*<<<END TOOL_RESULT>>>/, locale);
  });

  it('speak a live turn in its language', () => {
    const free = turnMessages(/** @type {any} */ ({ locale: 'tr-TR', mode: 'free', history: [], text: 'Merhaba', sources: [] }));
    assert.match(free.system, /^Sen sesli bir sohbette Starpi’nin sesli asistanısın/);
    const grounded = turnMessages(/** @type {any} */ ({ locale: 'es-ES', mode: 'grounded', history: [], text: 'Hola', sources: [] }));
    assert.match(grounded.system, /\(No se encontraron extractos\.\)$/);
    const other = turnMessages(/** @type {any} */ ({ locale: 'pt-BR', mode: 'free', history: [], text: 'Olá', sources: [] }));
    assert.equal(other.system, TURN_INSTRUCTIONS.en.free);
  });
});

describe('purposes and research', () => {
  it('ask for answers in the language of the interface', () => {
    for (const locale of ALL) assert.ok(isPromptLocale(locale), locale);
    assert.ok(!isPromptLocale('pt'));
    const summary = (/** @type {string} */ locale) => textOf(getPurpose('summarize_doc')?.buildMessages({ text: 'Un texte.' }, { locale: /** @type {any} */ (locale) })[0] ?? { role: 'system', content: [] });
    assert.match(summary('fr'), /at most five sentences, in French\./);
    assert.match(summary('tr'), /in Turkish\./);
    assert.match(summary('en'), /in English\./);
    assert.match(summary('de'), /auf Deutsch\./);
  });

  it('write research answers in the language, under its headings, and read headings in any of them', () => {
    assert.equal(researchLocale('it-IT'), 'it');
    assert.equal(researchLocale('pt-BR'), 'en');
    const fr = sourcesPrompt('fr');
    assert.match(fr, /Then answer in French\./);
    assert.match(fr, /"## Résumé"[\s\S]*"## Détails"[\s\S]*"## Questions ouvertes"[\s\S]*"Aucune\." when nothing is missing/);
    assert.match(sourcesPrompt('en'), /Then answer in English\.[\s\S]*"None\." when nothing is missing/);
    assert.match(webPrompt('es'), /answer in Spanish in a few short paragraphs/);
    assert.match(webPrompt('de'), /antworte dann auf Deutsch/);
    for (const locale of ALL) {
      const h = SECTION_HEADINGS[locale];
      assert.deepEqual([sectionOfHeading(h.summary), sectionOfHeading(`## ${h.details}`), sectionOfHeading(`${h.open_questions}:`)], ['summary', 'details', 'open_questions'], locale);
    }
  });
});
