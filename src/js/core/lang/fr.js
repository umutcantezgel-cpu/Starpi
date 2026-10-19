// @ts-check
// French language pack (see index.js for the meaning of each entry). Polarity patterns run on
// folded, lowercase text; French accents stay as they are (fold() only spells out German umlauts).
// Words that other packs read differently are left out of the lists every language shares: "seize"
// and "sept" are no French number words for the fact reader (an English verb and month), "car" is
// no clause joiner (an English noun), "non" joins no hyphenated word.

/**
 * A pattern for whole words with letters beyond ASCII (\b is ASCII-only).
 * @param {string} body
 */
const W = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'gu');

/** @type {import('./index.js').PackInput} */
export const fr = {
  code: 'fr',
  name: 'French',

  months: {
    janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, août: 8, aout: 8, septembre: 9,
    octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  },
  // Only the short forms no other language writes as a word before a full stop.
  monthAbbreviations: { janv: 1, févr: 2, fevr: 2, avr: 4, juil: 7, déc: 12 },
  ambiguousMonths: [],
  weekdays: { lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 7 },
  monthContext: ['en', 'de', 'début', 'debut', 'fin', 'depuis', 'dès', 'avant', 'après', 'apres', 'courant'],
  monthPosition: [],
  dayMonthLinks: [],
  ordinalSuffixes: ['er', 're', 'ère', 'ème', 'eme', 'e'],
  numericDateContext: [],
  clockWords: [],
  meridiem: null,

  // Digits are grouped with a narrow no-break space ("480 000").
  numberFormat: { decimal: ',', group: ' ' },
  scales: [
    [1e3, ['mille']],
    [1e6, ['millions?']],
    [1e9, ['milliards?', String.raw`mds?\.?`]],
  ],
  percentWords: [String.raw`pour\s?cent`],
  currencyWords: ['euros', 'dollars', 'francs?'],
  unitWords: [
    'jours?', 'semaines?', 'mois', 'ans', 'années?', 'annees?', 'heures?', 'personnes', 'employés?', 'employes?', 'salariés?',
    'salaries?', 'utilisateurs?', 'utilisatrices?', 'équipes?', 'equipes?', 'étapes?', 'etapes?', 'pièces?', 'pieces?',
  ],
  approxWords: [
    'environ', 'à peu près', 'a peu pres', 'près de', 'pres de', 'presque', 'quasiment', 'plus de', 'moins de', "jusqu'à",
    "jusqu'a", 'autour de', 'approximativement', String.raw`env\.`,
  ],
  versionWords: ['version', 'versions', 'firmware', 'logiciel', 'micrologiciel'],
  numberWords: {
    deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, huit: 8, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
    quinze: 15, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, septante: 70, huitante: 80, octante: 80,
    nonante: 90,
  },
  numberParts: ['un', 'une', 'cents?', 'mille', 'millions?', 'milliards?'],
  // Not read alone (English "Sept", "seize"; "neuf" is also "new"), but "dix-sept" or "vingt-neuf" is one number.
  ownNumberParts: ['sept', 'neuf', 'seize'],
  numberJoiners: ['et'],

  boilerplate: [
    'selon', 'source', 'sources', 'document', 'documents', 'extrait', 'extraits', 'mentionné', 'mentionne', 'indiqué', 'indique',
    'fichier', 'texte', 'cité', 'mentionnée', 'indiquée',
    // words that qualify a number (the number itself is checked as a fact)
    'environ', 'presque', 'quasiment', 'mille', 'millions', 'milliard', 'milliards',
  ],
  stopwords: [
    'a', 'au', 'aux', 'avec', 'ce', 'ces', 'cet', 'cette', 'ceci', 'cela', 'ça', 'dans', 'de', 'des', 'du', 'elle', 'elles', 'en',
    'est', 'et', 'été', 'être', 'il', 'ils', 'la', 'le', 'les', 'leur', 'leurs', 'lui', 'ma', 'mais', 'me', 'mes', 'moi',
    'mon', 'ne', 'nos', 'notre', 'nous', 'ont', 'ou', 'où', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 'quoi', 'sa', 'sans',
    'se', 'ses', 'sont', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tu', 'un', 'une', 'vos', 'votre', 'vous', 'aussi', 'avait',
    'avoir', 'comme', 'donc', 'dont', 'entre', 'ici', 'lors', 'même', 'peut', 'puis', 'quand', 'sera', 'tout', 'tous',
    'toute', 'toutes', 'très', 'était', 'sous', 'chez', 'après', 'avant', 'déjà', 'ainsi', 'celui', 'celle', 'ceux', 'dès',
    'aucun', 'aucune', 'jamais', 'rien', 'avons', 'avez', 'sommes', 'êtes', 'fait', 'cependant', 'lorsque', 'auprès',
  ],
  // "p. ex." (and "p." for a page) ends in a single letter.
  abbreviations: ['p', 'ex', 'env', 'cf', 'vol', 'chap', 'éd', 'mme', 'mlle', 'n°', 'hab', 'tél', 'tel'],
  letters: 'âêîôûœëïÿ',

  polarity: {
    // "ne … pas" negates once: "pas" counts, "ne" and "n'" do not.
    negators: ['pas', 'jamais', 'aucun', 'aucune', 'rien', 'sans', 'non', 'ni', 'nul', 'nulle', 'guère'],
    plainNegators: ['pas', 'jamais', 'aucun', 'aucune'],
    qualifiers: ['encore', 'toujours', 'vraiment', 'forcément', 'forcement', 'automatiquement', 'actuellement', 'nécessairement', 'souvent', 'entièrement', 'complètement'],
    contractions: [],
    infixNegators: [],
    prefixNegators: [],
    rewrites: [
      // "ne … plus" is a negation ("n'est plus pris en charge"); "plus" alone means "more".
      [/\bn(?:e |')((?:[\p{L}'-]+ ){0,3}?)plus\b/gu, 'ne $1pas'],
      // "ne … que" means "only".
      [/\bn(?:e |')((?:[\p{L}'-]+ ){0,3}?)que\b/gu, 'seulement $1'],
    ],
    clauseNegations: [String.raw`\bil (?:est faux|n'est pas vrai|n'est pas exact) que\b`],
    nothingAgainst: { nothing: ['rien'], verbs: [], against: ['contre'], phrases: ["rien ne s'oppose", 'aucune objection'], allowed: 'autorisé' },
    bounds: { negators: ['pas'], comparatives: ['plus', 'moins'], than: ['de', 'que'], additives: ['seulement', 'uniquement'] },
    modals: ['doit', 'doivent', 'peut', 'peuvent', 'faut'],
    timeBounds: { negators: ['pas'], words: ['avant', 'après', 'apres'] },
    idioms: [String.raw`\bou non\b`, String.raw`\bnon seulement\b`],
    antonyms: [
      [W('désactivée?s?|desactivee?s?|désactiver|desactiver|désactive|coupée?s?'), 'activé', true],
      [W('activée?s?|activer'), 'activé'],
      [W('interdite?s?|prohibée?s?|(?:ne doit|ne doivent) pas'), 'autorisé', true],
      [W('autorisée?s?|permise?s?'), 'autorisé'],
      [W('refusée?s?|rejetée?s?'), 'accepté', true],
      [W('acceptée?s?'), 'accepté'],
      [W('échouée?s?|échoue|échec'), 'réussi', true],
      [W('réussie?s?'), 'réussi'],
      [W('hors ligne'), 'en ligne', true],
      [W('indisponibles?'), 'disponible', true],
      [W('baissée?s?|baisse|diminuée?s?|diminue|réduite?s?|chuté|chute'), 'augmenté', true],
      [W('augmentée?s?|augmente|hausse'), 'augmenté'],
      [/\b(questions?) ouvertes?\b/g, '$1 notx résolu'],
      [W('résolue?s?|tranchée?s?|clarifiée?s?'), 'résolu'],
      [W('exclue?s?'), 'inclus', true],
      [W('sauf si|à moins que|a moins que'), '', true],
      [W('in(actif|active|actifs|actives|complet|complète|complets|complètes|valide|valides|correcte?s?|accessibles?|suffisante?s?|compatibles?|connue?s?|stable|stables)'), '$1', true],
      [W('im(possibles?|prévue?s?|prévisibles?)'), '$1', true],
      [W('il(légale?s?|légaux|licite)'), '$1', true],
      [W('ir(réguliers?|régulières?|réversibles?)'), '$1', true],
    ],
    timeConditions: ['avant', String.raw`jusqu'(?:au|aux|en)`],
    rangeStarts: [],
    rangeEnds: [],
    clauseJoiners: ['et', 'ou', 'mais', 'tandis que', 'alors que', 'parce que'],
    leadingWords: ['et', 'ou', 'mais', 'donc', 'puis', 'cependant', 'toutefois', 'ensuite', 'alors'],
    restrictive: ['seulement', 'uniquement', 'exclusivement'],
    without: ['sans'],
  },

  gate: {
    // Accented letters are in the shared Latin ranges; French adds nothing.
    chars: '',
    numberWords: {
      cardinals: {
        zéro: 0, zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
        onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40,
        cinquante: 50, soixante: 60, septante: 70, huitante: 80, octante: 80, nonante: 90,
      },
      scales: { cent: 100, cents: 100, douzaine: 12, mille: 1e3, million: 1e6, millions: 1e6, milliard: 1e9, milliards: 1e9 },
      // "un", "une" are the article as often as a count.
      parts: ['un', 'une'],
      joiners: ['et'],
      fractions: { demi: 0.5, demie: 0.5, moitié: 0.5, tiers: 1 / 3, quart: 0.25, quarts: 0.25 },
      multipliers: { double: 2, doublé: 2, doublée: 2, triple: 3, triplé: 3, quadruple: 4 },
      ordinals: {
        premier: 1, première: 1, premiers: 1, premières: 1, second: 2, seconde: 2, deuxième: 2, troisième: 3, quatrième: 4,
        cinquième: 5, sixième: 6, septième: 7, huitième: 8, neuvième: 9, dixième: 10, onzième: 11, douzième: 12, vingtième: 20,
        centième: 100, millième: 1000,
      },
      adverbs: ['premièrement', 'deuxièmement', 'troisièmement', 'unique', 'uniques', 'simple', 'simples'],
      // "tiers" is also an English word ("pricing tiers").
      contextual: ['demi', 'demie', 'moitié', 'double', 'doublé', 'doublée', 'quart', 'tiers'],
      countNouns: [
        'seconde', 'secondes', 'minute', 'minutes', 'heure', 'heures', 'jour', 'jours', 'semaine', 'semaines', 'mois', 'an', 'ans',
        'année', 'années', 'siècle', 'mètre', 'mètres', 'kilomètre', 'kilomètres', 'litre', 'litres', 'gramme', 'grammes',
        'kilo', 'kilos', 'tasse', 'tasses', 'dose', 'doses', 'pièce', 'pièces', 'unité', 'unités', 'page', 'pages', 'personne',
        'personnes', 'nombre', 'quantité', 'prix', 'coût', 'coûts', 'taille', 'taux', 'vitesse', 'budget', 'part', 'euros',
      ],
      fractionLeads: ['un', 'une'],
      negative: ['moins'],
      compound: false,
      // "dix-sept", "soixante-dix", "soixante-dix-neuf"; "quatre-vingts" is four times twenty, and
      // "quatre-vingt-dix", "quatre-vingt-onze" go on from it like "soixante-dix".
      additions: [[10, 7, 9], [60, 10, 19], [80, 10, 19]],
      products: [[4, 20]],
      tenJoiners: ['et'],
      suffixes: { ordinal: ['ième'], fraction: [], multiplier: [] },
    },
    spoken: {
      abbreviations: {
        'p. ex.': 'par exemple', 'etc.': 'et cetera', 'env.': 'environ', 'M.': 'Monsieur', 'Mme': 'Madame', 'Mlle': 'Mademoiselle',
        'Dr': 'Docteur', 'Pr': 'Professeur', 'n°': 'numéro', 'cf.': 'voir', 'chap.': 'chapitre', 'tél.': 'téléphone',
      },
      units: {
        '%': ['pour cent', 'pour cent'], 'km/h': ['kilomètre par heure', 'kilomètres par heure'], km: ['kilomètre', 'kilomètres'],
        cm: ['centimètre', 'centimètres'], mm: ['millimètre', 'millimètres'], kg: ['kilogramme', 'kilogrammes'],
        mg: ['milligramme', 'milligrammes'], ml: ['millilitre', 'millilitres'], h: ['heure', 'heures'], min: ['minute', 'minutes'],
        ms: ['milliseconde', 'millisecondes'], '°C': ['degré Celsius', 'degrés Celsius'], ko: ['kilooctet', 'kilooctets'],
        Mo: ['mégaoctet', 'mégaoctets'], Go: ['gigaoctet', 'gigaoctets'], To: ['téraoctet', 'téraoctets'],
        MB: ['mégaoctet', 'mégaoctets'], GB: ['gigaoctet', 'gigaoctets'], MHz: ['mégahertz', 'mégahertz'], GHz: ['gigahertz', 'gigahertz'],
        kW: ['kilowatt', 'kilowatts'], kWh: ['kilowattheure', 'kilowattheures'], '€': ['euro', 'euros'],
        'm²': ['mètre carré', 'mètres carrés'], 'km²': ['kilomètre carré', 'kilomètres carrés'], 'm³': ['mètre cube', 'mètres cubes'],
      },
      approx: 'environ',
    },
  },
};
