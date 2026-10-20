// @ts-check
// Italian language pack (see index.js for the meaning of each entry). Polarity patterns run on
// folded, lowercase text; Italian accents stay as they are. Words that other packs read differently
// are left out of the lists every language shares: "due" (an English word), "sei" (a German verb
// form) and "otto" (a German name) are no number words for the fact reader, "mai" (never; the German
// month) is no negator on its own, "set" and "ago" no month abbreviations, "per", "come", "ci" and
// "vi" no stop words.

/**
 * A pattern for whole words with letters beyond ASCII (\b is ASCII-only).
 * @param {string} body
 */
const W = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'gu');

/** @type {import('./index.js').PackInput} */
export const it = {
  code: 'it',
  name: 'Italian',

  months: {
    gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10,
    novembre: 11, dicembre: 12,
  },
  monthAbbreviations: { gen: 1, mag: 5, giu: 6, lug: 7, ott: 10, dic: 12 },
  ambiguousMonths: [],
  weekdays: {
    lunedì: 1, lunedi: 1, martedì: 2, martedi: 2, mercoledì: 3, mercoledi: 3, giovedì: 4, giovedi: 4, venerdì: 5, venerdi: 5,
    sabato: 6, domenica: 7,
  },
  monthContext: ['in', 'di', 'da', 'dal', 'entro', 'fino', 'inizio', 'metà', 'prima', 'dopo', 'durante'],
  monthPosition: [],
  dayMonthLinks: [],
  ordinalSuffixes: ['º', 'ª'],
  numericDateContext: [],
  clockWords: [],
  meridiem: null,

  numberFormat: { decimal: ',', group: '.' },
  scales: [
    [1e3, ['mila', 'mille']],
    [1e6, ['milioni', 'milione', String.raw`mln\.?`]],
    [1e9, ['miliardi', 'miliardo', String.raw`mld\.?`]],
  ],
  percentWords: [String.raw`per\s?cento`],
  currencyWords: ['dollari', 'dollaro'],
  unitWords: [
    'giorni', 'giorno', 'settimane', 'settimana', 'mesi', 'mese', 'anni', 'anno', 'ore', 'minuti', 'minuto', 'persone',
    'dipendenti', 'utenti', 'squadre', 'squadra', 'fasi', 'pezzi',
  ],
  approxWords: [
    'circa', 'quasi', 'oltre', 'più di', 'piu di', 'meno di', 'fino a', 'intorno a', 'approssimativamente', "all'incirca",
  ],
  versionWords: ['versione', 'versioni', 'firmware', 'release', 'software'],
  numberWords: {
    tre: 3, quattro: 4, cinque: 5, sette: 7, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14,
    quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, trenta: 30, quaranta: 40,
    cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  },
  numberParts: ['un', 'una', 'uno', 'cento', 'mila', 'mille', 'milioni', 'milione', 'miliardi', 'miliardo'],
  numberJoiners: [],

  boilerplate: [
    'secondo', 'fonte', 'fonti', 'documento', 'documenti', 'estratto', 'estratti', 'menzionato', 'menzionata', 'indicato',
    'indicata', 'riportato', 'testo', 'citato',
    // words that qualify a number (the number itself is checked as a fact)
    'circa', 'quasi', 'mila', 'milioni', 'milione', 'miliardi', 'miliardo',
  ],
  stopwords: [
    'a', 'e', 'o', 'ad', 'agli', 'ai', 'al', 'alla', 'alle', 'allo', 'anche', 'con', 'cui', 'da', 'dal', 'dalla', 'dalle', 'dei', 'del',
    'della', 'delle', 'dello', 'degli', 'di', 'ed', 'gli', 'ha', 'hanno', 'il', 'in', 'io', 'la', 'le', 'lei', 'lo', 'loro',
    'lui', 'ma', 'mi', 'mio', 'mia', 'ne', 'negli', 'nei', 'nel', 'nella', 'nelle', 'nello', 'noi', 'non', 'perché', 'più',
    'quale', 'quali', 'quando', 'quello', 'quella', 'questa', 'queste', 'questi', 'questo', 'se', 'si', 'sia', 'sono', 'su',
    'sul', 'sulla', 'sulle', 'tra', 'fra', 'tu', 'tutto', 'tutti', 'tutte', 'un', 'una', 'uno', 'voi', 'è', 'essere',
    'stato', 'stata', 'stati', 'già', 'dove', 'che', 'cosa', 'ogni', 'molto', 'senza', 'suo', 'sua', 'suoi', 'sue', 'nostro',
    'nostra', 'vostro', 'vostra', 'mentre', 'però', 'quindi', 'ancora', 'nessun', 'nessuno', 'nessuna', 'niente',
    'nulla', 'dopo', 'prima', 'sempre', 'viene', 'vengono', 'può', 'possono', 'deve', 'devono', 'sarà', 'abbiamo', 'avete',
  ],
  // "es." (esempio) is left out: in German it ends a sentence ("Wir schaffen es.").
  abbreviations: ['p', 'pag', 'pagg', 'ecc', 'sig', 'sigg', 'dott', 'ing', 'avv', 'prof', 'tel', 'cfr', 'ca'],
  letters: 'ìò',

  polarity: {
    // "mai" (never) counts only together with "non", see rewrites.
    negators: ['non', 'nessun', 'nessuno', 'nessuna', 'niente', 'nulla', 'né', 'senza', 'neanche', 'nemmeno', 'neppure'],
    plainNegators: ['non'],
    qualifiers: ['ancora', 'sempre', 'più', 'piu', 'già', 'gia', 'automaticamente', 'necessariamente', 'attualmente', 'affatto', 'proprio'],
    contractions: [],
    infixNegators: [],
    prefixNegators: [],
    rewrites: [
      // "non … mai", "non … nessuno": Italian negates twice and means it once.
      [/(?<![\p{L}])non((?:\s+[\p{L}']+){0,5}?)\s+(?:mai|nessun[oa]?|niente|nulla|né|neanche|nemmeno|neppure)(?![\p{L}])/gu, 'non$1'],
    ],
    clauseNegations: [String.raw`\bnon è (?:vero|corretto|esatto) che\b`],
    nothingAgainst: { nothing: ['nulla', 'niente'], verbs: [], against: ['contro'], phrases: ['nulla osta'], allowed: 'consentito' },
    bounds: { negators: ['non'], comparatives: ['più', 'piu', 'meno'], than: ['di'], additives: ['solo', 'soltanto'] },
    modals: ['deve', 'devono', 'può', 'possono'],
    timeBounds: { negators: ['non'], words: ['prima', 'dopo'] },
    idioms: [String.raw`\bo meno\b`],
    antonyms: [
      [W('disattivat[oaie]|disabilitat[oaie]|spent[oaie]'), 'attivato', true],
      [W('attivat[oaie]|abilitat[oaie]'), 'attivato'],
      [W('vietat[oaie]|proibit[oaie]'), 'consentito', true],
      [W('consentit[oaie]|permess[oaie]|autorizzat[oaie]'), 'consentito'],
      [W('rifiutat[oaie]|respint[oaie]'), 'accettato', true],
      [W('accettat[oaie]'), 'accettato'],
      [W('fallit[oaie]'), 'superato', true],
      [W('superat[oaie]'), 'superato'],
      [W('diminuit[oaie]|ridott[oaie]|calat[oaie]|sces[oaie]'), 'aumentato', true],
      [W('aumentat[oaie]|cresciut[oaie]'), 'aumentato'],
      [/\b(domand[ae]|question[ei]) apert[ae]\b/g, '$1 notx risolto'],
      [W('risolt[oaie]|chiarit[oaie]|decis[oaie]'), 'risolto'],
      [W('esclus[oaie]'), 'incluso', true],
      [W('a meno che|salvo che|tranne se'), '', true],
      [W('in(attiv[oaie]|complet[oaie]|corrett[oaie]|accessibil[ei]|sufficient[ei]|compatibil[ei]|stabil[ei])'), '$1', true],
      [W('im(possibil[ei]|previst[oaie])'), '$1', true],
      [W('il(legal[ei])'), '$1', true],
      [W('ir(regolar[ei]|reversibil[ei])'), '$1', true],
    ],
    timeConditions: ['prima che', String.raw`fino a(?!\s+\d)`],
    rangeStarts: ['dal', 'dalle'],
    rangeEnds: ['al', 'alle'],
    clauseJoiners: ['e', 'o', 'ma', 'mentre', 'perché', 'poiché', 'sebbene'],
    leadingWords: ['e', 'o', 'ma', 'però', 'tuttavia', 'mentre', 'perché', 'quindi', 'inoltre'],
    restrictive: ['solo', 'soltanto', 'esclusivamente', 'unicamente'],
    without: ['senza'],
  },

  gate: {
    // The ordinal indicators are below the shared Latin letters.
    chars: 'ªº',
    numberWords: {
      // Italian writes a number as one word ("duemilacinquecento", "ventitré"): number-words.js splits it
      // into these words. A ten drops its last vowel before "uno" and "otto" ("ventuno", "trentotto").
      cardinals: {
        zero: 0, un: 1, uno: 1, una: 1, due: 2, tre: 3, tré: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
        dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17,
        diciotto: 18, diciannove: 19, venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70,
        ottanta: 80, novanta: 90,
      },
      scales: { cento: 100, dozzina: 12, mille: 1e3, mila: 1e3, milione: 1e6, milioni: 1e6, miliardo: 1e9, miliardi: 1e9 },
      // "un", "uno", "una" are the article as often as a count; "milioni di utenti" states no number.
      parts: ['un', 'uno', 'una', 'milioni', 'miliardi'],
      joiners: [],
      // "terzo" and "quarto" are the ordinals; "un terzo" and "due terzi" are read as fractions of them.
      fractions: { mezzo: 0.5, mezza: 0.5, metà: 0.5 },
      multipliers: { doppio: 2, doppia: 2, triplo: 3, tripla: 3, raddoppiato: 2, triplicato: 3 },
      ordinals: {
        primo: 1, prima: 1, primi: 1, prime: 1, secondo: 2, seconda: 2, terzo: 3, terza: 3, terzi: 3, quarto: 4, quarta: 4,
        quarti: 4, quinto: 5, quinta: 5, sesto: 6, sesta: 6, settimo: 7,
        settima: 7, ottavo: 8, ottava: 8, nono: 9, nona: 9, decimo: 10, decima: 10,
      },
      adverbs: ['unico', 'unica', 'semplice', 'singolo', 'singola'],
      contextual: ['mezzo', 'mezza', 'metà', 'doppio', 'doppia'],
      countNouns: [
        'secondo', 'secondi', 'minuto', 'minuti', 'ora', 'ore', 'giorno', 'giorni', 'settimana', 'settimane', 'mese', 'mesi',
        'anno', 'anni', 'decennio', 'secolo', 'metro', 'metri', 'chilometro', 'chilometri', 'litro', 'litri', 'grammo',
        'grammi', 'chilo', 'chili', 'tazza', 'tazze', 'dose', 'dosi', 'pezzo', 'pezzi', 'unità', 'pagina', 'pagine', 'persona',
        'persone', 'numero', 'quantità', 'prezzo', 'costo', 'costi', 'dimensione', 'tasso', 'velocità', 'budget', 'quota', 'euro',
      ],
      fractionLeads: ['un'],
      negative: ['meno'],
      compound: true,
      elision: true,
      additions: [],
      tenJoiners: [],
      suffixes: { ordinal: ['esimo', 'esima', 'esimi', 'esime'], fraction: [], multiplier: [] },
    },
    spoken: {
      abbreviations: {
        'ecc.': 'eccetera', 'es.': 'esempio', 'Sig.': 'signor', 'Sig.ra': 'signora', 'Dott.': 'dottor', 'Ing.': 'ingegner',
        'Prof.': 'professor', 'pag.': 'pagina', 'tel.': 'telefono', 'cfr.': 'confronta', 'ca.': 'circa',
      },
      units: {
        '%': ['per cento', 'per cento'], 'km/h': ['chilometro orario', 'chilometri orari'], km: ['chilometro', 'chilometri'],
        cm: ['centimetro', 'centimetri'], mm: ['millimetro', 'millimetri'], kg: ['chilogrammo', 'chilogrammi'],
        mg: ['milligrammo', 'milligrammi'], ml: ['millilitro', 'millilitri'], h: ['ora', 'ore'], min: ['minuto', 'minuti'],
        ms: ['millisecondo', 'millisecondi'], '°C': ['grado Celsius', 'gradi Celsius'], kB: ['kilobyte', 'kilobyte'],
        MB: ['megabyte', 'megabyte'], GB: ['gigabyte', 'gigabyte'], TB: ['terabyte', 'terabyte'], MHz: ['megahertz', 'megahertz'],
        GHz: ['gigahertz', 'gigahertz'], kW: ['chilowatt', 'chilowatt'], kWh: ['chilowattora', 'chilowattora'], '€': ['euro', 'euro'],
        'm²': ['metro quadrato', 'metri quadrati'], 'km²': ['chilometro quadrato', 'chilometri quadrati'],
        'm³': ['metro cubo', 'metri cubi'],
      },
      approx: 'circa',
    },
  },
};
