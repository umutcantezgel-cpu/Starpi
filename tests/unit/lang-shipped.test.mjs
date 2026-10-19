// The shipped language packs (src/js/core/lang/fr.js, es.js, it.js, tr.js): loaded on demand, they
// leave every English and German report of the labelled answer sets byte for byte unchanged, and
// each reaches the fact reader, retrieval, sentence splitting, the negation check, the language
// guess, the sentence gate and the spoken form. Turkish lowercases with its own dotted and dotless i.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { checkText } from '../../src/js/core/gate.js';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { extractFacts, fold, guessLanguage } from '../../src/js/core/facts.js';
import { LANGUAGES, languagePack, loadShippedLanguages, lowerCase, registerLanguage, SHIPPED_LANGUAGES } from '../../src/js/core/lang/index.js';
import { numberWordTag } from '../../src/js/core/number-words.js';
import { negationInversion, sourceClauses } from '../../src/js/core/polarity.js';
import { splitSentences } from '../../src/js/core/sentences.js';
import { spokenForm } from '../../src/js/core/spoken.js';
import { BM25Index, tokenize } from '../../src/js/rag/bm25.js';
import { loadCorpora, loadItems, loadParaphrases, loadRelationItems, loadV2Items } from '../../scripts/eval-source-check.mjs';

/** @param {string} text */
const facts = (text) => extractFacts(text).map((f) => `${f.kind} ${f.values.join(',')}`);
/** @param {string} source @param {string} claim */
const inverted = (source, claim) => negationInversion(claim, [{ index: 0, clauses: sourceClauses(source) }]) !== null;
/**
 * The gate on one statement against one excerpt: what it releases and what it holds back.
 * @param {string} statement @param {string} excerpt @param {string} [locale]
 */
function gate(statement, excerpt, locale) {
  const r = checkText(`${statement} [S1].`, { sources: [{ label: '[S1]', text: excerpt }], locale });
  return { released: r.released.length, withheld: r.withheld.map((w) => `${w.reason}:${w.token}`) };
}

/** Reports of every labelled answer (version 3, the current rules), before the shipped packs load. */
let reportsBefore = /** @type {string[]} */ ([]);
/** @type {() => string[]} */
let reports = () => [];

before(async () => {
  const corpora = await loadCorpora();
  const items = [...(await loadItems()), ...(await loadV2Items({ unblind: true })), ...(await loadParaphrases()), ...(await loadRelationItems({ unblind: true }))];
  reports = () => items.map((item) => JSON.stringify(groundAnswer(blocksFromMarkdown(item.answer, corpora[item.corpus]), corpora[item.corpus])));
  assert.deepEqual([...LANGUAGES], ['en', 'de'], 'nothing loaded the shipped packs yet');
  reportsBefore = reports();
  await loadShippedLanguages();
});

describe('shipped language packs', () => {
  it('register French, Spanish, Italian and Turkish once, after the built-in packs', async () => {
    assert.deepEqual([...LANGUAGES], ['en', 'de', 'fr', 'es', 'it', 'tr']);
    assert.deepEqual([...SHIPPED_LANGUAGES], [...LANGUAGES]);
    assert.deepEqual((await loadShippedLanguages(['fr', 'xx', 'en'])).map((p) => p.code), ['fr', 'en']);
    assert.deepEqual([...LANGUAGES], ['en', 'de', 'fr', 'es', 'it', 'tr']);
    assert.equal(languagePack('tr-TR')?.name, 'Turkish');
    assert.throws(() => registerLanguage({ code: 'fr' }), /already registered/);
  });

  it('leave every English and German report of the labelled answer sets unchanged', () => {
    const after = reports();
    assert.equal(after.length, reportsBefore.length);
    const changed = after.flatMap((r, i) => (r === reportsBefore[i] ? [] : [i]));
    assert.deepEqual(changed, []);
  });

  it('refuse malformed case folding and number rules', () => {
    const bad = [
      [{ code: 'xb', caseFold: { i: 'ı' } }, /caseFold/],
      [{ code: 'xb', caseFold: { I: 'ıı1' } }, /caseFold/],
      [{ code: 'xb', gate: { numberWords: { additions: [[10, 9, 1]] } } }, /additions/],
      [{ code: 'xb', gate: { numberWords: { elision: 'yes' } } }, /elision/],
      [{ code: 'xb', gate: { numberWords: { tenJoiners: ['y y'] } } }, /tenJoiners/],
    ];
    for (const [pack, message] of bad) assert.throws(() => registerLanguage(/** @type {any} */ (pack)), message, JSON.stringify(pack));
  });
});

describe('facts in each language', () => {
  it('read dates, weekdays and spelled numbers as the English facts', () => {
    const english = facts('The launch is on 3 March 2027 with twelve people.');
    assert.deepEqual(facts('Le lancement a lieu le 3 mars 2027 avec douze personnes.'), english);
    assert.deepEqual(facts('Il lancio è il 3 marzo 2027 con dodici persone.'), english);
    assert.deepEqual(facts('Lansman 3 Mart 2027 tarihinde yapılacak.'), facts('The launch is on 3 March 2027.'));
    // Spanish links day and month with "de" and reads the year as a number of its own.
    assert.deepEqual(facts('El lanzamiento es el 3 de marzo de 2027.'), ['date d:--03-03', 'number n:2027']);
    assert.deepEqual(facts('La réunion a lieu le mardi.'), facts('The meeting is on Tuesday.'));
    assert.deepEqual(facts('La reunión es el jueves.'), facts('The meeting is on Thursday.'));
    assert.deepEqual(facts('La riunione è venerdì.'), facts('The meeting is on Friday.'));
    assert.deepEqual(facts('Toplantı ÇARŞAMBA günü.'), facts('The meeting is on Wednesday.'));
    assert.deepEqual(facts('Le budget est de 4 millions d’euros, soit 30 pour cent.'), facts('The budget is 4 million euro, 30 percent.'));
    assert.deepEqual(facts('Il budget è di 4 milioni, il 30 per cento.'), facts('The budget is 4 million, 30 percent.'));
    assert.deepEqual(facts('Bütçe 4 milyon.'), facts('The budget is 4 million.'));
  });

  it('read the words other languages use differently only where they mean a number', () => {
    // "on" (Turkish ten), "seize" (French sixteen), "once" (Spanish eleven) and "due" (Italian two)
    // stay English words for the fact reader.
    assert.deepEqual(facts('We seize the day once more and turn on the light; the fee is due.'), []);
  });
});

describe('retrieval and sentences in each language', () => {
  it('drop the stop words of every language, and fold the Turkish capital İ', () => {
    assert.deepEqual(tokenize('le plan de la direction pour les équipes'), ['plan', 'direction', 'équipes']);
    assert.deepEqual(tokenize('el plan de la dirección para los equipos'), ['plan', 'dirección', 'equipos']);
    assert.deepEqual(tokenize('il piano della direzione per le squadre'), ['piano', 'direzione', 'per', 'squadre']);
    assert.deepEqual(tokenize('İstanbul ve İzmir için bir plan'), ['istanbul', 'izmir', 'plan']);
  });

  it('find a Turkish word in capitals and in lowercase alike', () => {
    assert.deepEqual(tokenize('KULLANIM KILAVUZU: ISITMA SİSTEMİ'), tokenize('kullanım kılavuzu ısıtma sistemi'));
    assert.deepEqual(tokenize('Bunları ARASINDA bazı notlar'), ['notlar'], 'stop words with the dotless i drop in either case');
    const upper = new BM25Index();
    upper.add([{ docId: 'a', docName: 'a.txt', chunkIndex: 0, start: 0, end: 29, text: 'ISITMA SİSTEMİ BAKIM KILAVUZU' }]);
    assert.deepEqual(upper.search('ısıtma kılavuzu').map((h) => h.chunk.docId), ['a']);
    const lower = new BM25Index();
    lower.add([{ docId: 'b', docName: 'b.txt', chunkIndex: 0, start: 0, end: 29, text: 'ısıtma sistemi bakım kılavuzu' }]);
    assert.deepEqual(lower.search('ISITMA KILAVUZU').map((h) => h.chunk.docId), ['b']);
  });

  it('keep abbreviations inside a sentence', () => {
    assert.deepEqual(splitSentences('El Sr. García llega hoy. Luego sigue.'), ['El Sr. García llega hoy.', 'Luego sigue.']);
    assert.deepEqual(splitSentences('Elma, armut vb. meyveler var. Sonra devam.'), ['Elma, armut vb. meyveler var.', 'Sonra devam.']);
    assert.deepEqual(splitSentences('Voir p. ex. la note. Ensuite la suite.'), ['Voir p. ex. la note.', 'Ensuite la suite.']);
    // "es." stays a sentence end: German writes it there ("Wir schaffen es.").
    assert.deepEqual(splitSentences('Wir schaffen es. Dann geht es weiter.'), ['Wir schaffen es.', 'Dann geht es weiter.']);
  });
});

describe('negations in each language', () => {
  const cases = /** @type {Array<[string, string]>} */ ([
    ['La sauvegarde est chiffrée chaque nuit.', 'La sauvegarde n’est pas chiffrée chaque nuit.'],
    ['La sauvegarde est activée sur tous les serveurs.', 'La sauvegarde est désactivée sur tous les serveurs.'],
    ['Le module est pris en charge par la version actuelle.', 'Le module n’est plus pris en charge par la version actuelle.'],
    ['La copia de seguridad se cifra cada noche.', 'La copia de seguridad no se cifra cada noche.'],
    ['La copia de seguridad está activada en todos los servidores.', 'La copia de seguridad está desactivada en todos los servidores.'],
    ['Il backup è cifrato ogni notte.', 'Il backup non è cifrato ogni notte.'],
    ['Il backup è attivato su tutti i server.', 'Il backup è disattivato su tutti i server.'],
    ['Arşive aktarım her gece şifreleniyor.', 'Arşive aktarım her gece şifrelenmiyor.'],
    ['Yedekleme tüm sunucularda etkin.', 'Yedekleme tüm sunucularda devre dışı.'],
    ['Arşiv şifreli olarak gönderilir.', 'Arşiv şifresiz olarak gönderilir.'],
    ['Rapor her ay güncellendi.', 'Rapor her ay güncellenmedi.'],
    ['Rapor her ay yayımlanır.', 'Rapor her ay yayımlanmaz.'],
  ]);
  it('find a statement that says the opposite of its excerpt, and leave a faithful one alone', () => {
    for (const [source, claim] of cases) {
      assert.equal(inverted(source, claim), true, claim);
      assert.equal(inverted(source, source), false, source);
    }
  });

  it('read a double negation as one ("no … nunca", "non … mai")', () => {
    assert.equal(inverted('El módulo funciona siempre.', 'El módulo no funciona nunca.'), true);
    assert.equal(inverted('Il modulo non è mai stato attivato.', 'Il modulo non è stato attivato.'), false);
  });
});

describe('the language guess', () => {
  it('names each language from its function words and letters', () => {
    assert.equal(guessLanguage('Le budget a été approuvé par le comité de pilotage et il est définitif.'), 'fr');
    assert.equal(guessLanguage('El presupuesto fue aprobado por el comité de dirección y es definitivo.'), 'es');
    assert.equal(guessLanguage('Il budget è stato approvato dal comitato direttivo ed è definitivo.'), 'it');
    assert.equal(guessLanguage('Bütçe yönlendirme kurulu tarafından onaylandı ve kesinleşti.'), 'tr');
    // The English and German sentences of the built-in tests read as before.
    assert.equal(guessLanguage('The budget was approved by the steering group and it is final.'), 'en');
    assert.equal(guessLanguage('Das Budget wurde vom Lenkungskreis freigegeben und ist nicht verhandelbar.'), 'de');
  });

  it('reads Turkish in its own lowercase, and a capital I elsewhere as no Turkish letter', () => {
    assert.equal(guessLanguage('BÜTÇE İÇİN ONAY ŞU AN YOK.'), 'tr');
    assert.equal(guessLanguage('In March the budget is final.'), 'en');
  });
});

describe('Turkish case', () => {
  it('lowercases I to ı and İ to i in Turkish only', () => {
    assert.equal(lowerCase('IŞIK İSTANBUL', 'tr'), 'ışık istanbul');
    assert.equal(lowerCase('IŞIK İSTANBUL', 'en'), 'IŞIK İSTANBUL'.toLowerCase());
    assert.equal(lowerCase('Index'), 'index');
  });

  it('folds both i forms alike for comparing, whatever the case', () => {
    assert.equal(fold('ILIK'), fold('ılık'));
    assert.equal(fold('İSTANBUL'), fold('istanbul'));
    assert.equal(fold('İstanbul'), 'istanbul');
  });

  it('reads number words written in capitals', () => {
    assert.deepEqual(numberWordTag('ALTI', 'tr'), { kind: 'cardinal', value: 6 });
    assert.deepEqual(numberWordTag('İKİ', 'tr'), { kind: 'cardinal', value: 2 });
    assert.deepEqual(numberWordTag('ÜÇÜNCÜ', 'tr'), { kind: 'ordinal', value: 3 });
  });
});

describe('the sentence gate in each language', () => {
  it('releases a number word its excerpt supports and holds back a changed one', () => {
    const cases = /** @type {Array<[string, string, string, string]>} */ ([
      ['fr', 'Le projet compte dix-sept participants', 'Le projet compte dix-huit participants', 'Le projet compte 17 participants.'],
      ['fr', 'Le parc compte soixante-dix-neuf arbres', 'Le parc compte soixante-dix-huit arbres', 'Le parc compte 79 arbres.'],
      ['es', 'El plan dura treinta y cinco días', 'El plan dura treinta y seis días', 'El plan dura 35 días.'],
      ['es', 'El presupuesto es de mil doscientos euros', 'El presupuesto es de mil trescientos euros', 'El presupuesto es de 1200 euros.'],
      ['it', 'Il progetto ha ventuno partecipanti', 'Il progetto ha ventidue partecipanti', 'Il progetto ha 21 partecipanti.'],
      ['it', 'Il budget è di duemilacinquecento euro', 'Il budget è di duemilaseicento euro', 'Il budget è di 2500 euro.'],
      ['tr', 'Projede on beş kişi var', 'Projede on altı kişi var', 'Projede 15 kişi var.'],
      ['tr', 'Bina bin dokuz yüz seksen dört yılında yapıldı', 'Bina bin dokuz yüz seksen beş yılında yapıldı', 'Bina 1984 yılında yapıldı.'],
    ]);
    for (const [locale, faithful, changed, excerpt] of cases) {
      assert.deepEqual(gate(faithful, excerpt, locale), { released: 1, withheld: [] }, faithful);
      const held = gate(changed, excerpt, locale);
      assert.equal(held.released, 0, changed);
      assert.match(held.withheld[0] ?? '', /^number_word:/, changed);
    }
  });

  it('reads ordinals and adverbs as no claim', () => {
    for (const [word, locale] of [['troisième', 'fr'], ['tercero', 'es'], ['ventesimo', 'it'], ['üçüncü', 'tr'], ['premièrement', 'fr']]) {
      assert.notEqual(numberWordTag(word, locale)?.kind, 'cardinal', word);
    }
    assert.deepEqual(gate('C’est la troisième version', 'Une version récente.', 'fr'), { released: 1, withheld: [] });
  });

  it('guesses the language of a statement when none is given', () => {
    assert.deepEqual(gate('El plan dura veinticinco días', 'El plan dura 25 días.'), { released: 1, withheld: [] });
    assert.equal(gate('El plan dura veintiséis días', 'El plan dura 25 días.').released, 0);
  });

  it('allows the characters each language writes', () => {
    const spanish = checkText('¿Cuántos días? ¡Veinticinco [S1]!', { sources: [{ label: '[S1]', text: 'Son 25 días.' }] });
    assert.equal(spanish.withheld.length, 0);
    assert.equal(checkText('Fiyat 25 ₺ [S1].', { sources: [{ label: '[S1]', text: 'Fiyat 25 ₺.' }] }).withheld.length, 0);
  });
});

describe('the spoken form in each language', () => {
  it('expands abbreviations, units and the approximate sign in the language', () => {
    assert.equal(spokenForm('Le trajet dure 3 h, p. ex. en train.', { locale: 'fr' }).text, 'Le trajet dure 3 heures, par exemple en train.');
    assert.equal(spokenForm('El viaje dura 1 h, p. ej. en tren.', { locale: 'es' }).text, 'El viaje dura 1 hora, por ejemplo en tren.');
    assert.equal(spokenForm('Costa ~5 €, ecc.', { locale: 'it' }).text, 'Costa circa 5 euro, eccetera.');
    assert.equal(spokenForm('Yolculuk 3 sa sürer, vb.', { locale: 'tr' }).text, 'Yolculuk 3 saat sürer, ve benzeri.');
  });
});
