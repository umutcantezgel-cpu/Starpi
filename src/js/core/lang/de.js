// @ts-check
// German language pack (see index.js for the meaning of each entry). Polarity patterns run on
// folded, lowercase text: ä → ae, ö → oe, ü → ue, ß → ss.

/** @type {import('./index.js').LanguagePack} */
export const de = {
  code: 'de',
  name: 'German',

  months: {
    januar: 1, jänner: 1, jaenner: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8,
    september: 9, oktober: 10, november: 11, dezember: 12,
  },
  monthAbbreviations: {
    jan: 1, feb: 2, mär: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12,
  },
  ambiguousMonths: [],
  weekdays: { montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6, sonntag: 7 },
  monthContext: ['in', 'im', 'bis', 'ab', 'seit', 'vom', 'von', 'ende', 'anfang', 'mitte', 'während', 'nächsten', 'kommenden', 'zum'],
  monthPosition: ['ende', 'anfang', 'mitte'],
  dayMonthLinks: [],
  ordinalSuffixes: [],
  // "am 3.4.", "bis 31.8.": a day and month without a year.
  numericDateContext: ['am', 'vom', 'bis', 'ab', 'zum', 'seit', 'den', 'dem'],
  clockWords: ['uhr'],
  meridiem: null,

  numberFormat: { decimal: ',', group: '.' },
  scales: [
    [1e3, [String.raw`tsd\.?`, 'tausend']],
    [1e6, [String.raw`mio\.?`, 'millionen']],
    [1e9, [String.raw`mrd\.?`, 'milliarden', 'milliarde']],
  ],
  percentWords: ['prozent'],
  currencyWords: ['euro', 'dollar'],
  unitWords: [
    'std', 'sek', 'tage?n?', 'wochen?', 'monate?n?', 'jahre?n?', 'stück', 'personen', 'mitarbeiter(?:innen)?', 'nutzer(?:innen)?',
    'teams?', 'sprints?', 'phasen?', 'stufen?',
  ],
  approxWords: [
    'circa', String.raw`ca\.`, 'rund', 'etwa', 'ungefähr', 'ungefaehr', 'fast', 'knapp', 'über', 'mehr als', 'weniger als', 'bis zu',
  ],
  // German writes the English words.
  versionWords: ['version', 'firmware', 'release', 'build', 'patch', 'software'],
  numberWords: {
    zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12,
    dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20,
    dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100,
  },
  // "ein" and "eins" only take part in a larger number ("einhundert", "eins komma fünf").
  numberParts: ['eins?', 'tausend', 'millionen', 'mio', 'milliarden?', 'mrd', 'dutzend'],
  ownNumberParts: [],
  numberJoiners: ['und'],

  boilerplate: [
    'laut', 'gemaess', 'quelle', 'quellen', 'dokument', 'dokumente', 'dokumenten', 'auszug', 'auszuege', 'auszuegen', 'genannt',
    'erwaehnt', 'heisst', 'steht', 'datei', 'text', 'basierend', 'angegeben', 'aufgefuehrt',
    // words that qualify a number (the number itself is checked as a fact)
    'circa', 'rund', 'etwa', 'ungefaehr', 'knapp', 'tausend', 'tsd', 'millionen', 'mio', 'milliarde', 'milliarden', 'mrd', 'prozent',
  ],
  stopwords: [
    'aber', 'alle', 'allem', 'allen', 'aller', 'alles', 'als', 'also', 'an', 'andere', 'anderen', 'auch', 'auf',
    'aus', 'bei', 'beim', 'bin', 'bis', 'bist', 'da', 'damit', 'dann', 'das', 'dass', 'dein', 'deine', 'dem', 'den',
    'denn', 'der', 'des', 'dessen', 'dich', 'die', 'dies', 'diese', 'diesem', 'diesen', 'dieser', 'dieses', 'dir',
    'doch', 'dort', 'du', 'durch', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines', 'er', 'es', 'etwas', 'euch',
    'euer', 'eure', 'für', 'gegen', 'gibt', 'hab', 'habe', 'haben', 'hat', 'hatte', 'hatten', 'hier', 'hin',
    'ich', 'ihm', 'ihn', 'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'im', 'in', 'ins', 'ist', 'ja', 'jede', 'jedem',
    'jeden', 'jeder', 'jedes', 'jetzt', 'kann', 'kein', 'keine', 'können', 'man', 'mein', 'meine', 'mich', 'mir',
    'mit', 'muss', 'nach', 'nicht', 'nichts', 'noch', 'nun', 'nur', 'ob', 'oder', 'ohne', 'sehr', 'sein', 'seine',
    'sich', 'sie', 'sind', 'so', 'soll', 'sollte', 'sondern', 'um', 'und', 'uns', 'unser', 'unsere', 'unter', 'vom',
    'von', 'vor', 'wann', 'war', 'waren', 'warum', 'was', 'weil', 'welche', 'welchem', 'welchen', 'welcher',
    'welches', 'wenn', 'wer', 'werde', 'werden', 'wie', 'wieder', 'will', 'wir', 'wird', 'wo', 'wurde', 'wurden',
    'zu', 'zum', 'zur', 'über',
  ],
  // "z. B.", "u. a." and "d. h." end in single letters.
  abbreviations: [
    'z', 'b', 'u', 'a', 'd', 'h', 'bzw', 'ca', 'nr', 'dr', 'st', 'usw', 'vgl', 'inkl', 'ggf', 'evtl', 'etc', 'mio', 'mrd', 'tsd',
    'prof', 'abs', 'tel',
  ],
  letters: 'äöüß',
  capitalisesNouns: true,

  polarity: {
    negators: ['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines', 'nie', 'niemals', 'nichts', 'niemand', 'weder', 'ohne'],
    plainNegators: ['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines', 'nie', 'niemals'],
    qualifiers: ['auch', 'noch', 'immer', 'bereits', 'schon', 'ebenfalls', 'dabei', 'mehr', 'automatisch', 'unbedingt', 'derzeit', 'jedoch'],
    contractions: [],
    infixNegators: ['nicht'],
    prefixNegators: ['nicht', 'kein'],
    rewrites: [
      // "weder A noch B" negates once: "nicht A oder nicht B".
      [/\bweder\b([^.;:!?]*?)\bnoch\b/g, 'nicht$1oder nicht'],
      [/\bnichts als\b/g, 'nur'],
    ],
    clauseNegations: [String.raw`\bes (?:ist|stimmt|trifft) nicht (?:so|zu)?,? dass\b`, String.raw`\bes stimmt nicht,? dass\b`],
    nothingAgainst: { nothing: ['nichts'], verbs: [], against: ['dagegen', 'gegen'], phrases: [], allowed: 'erlaubt' },
    bounds: { negators: ['nicht'], comparatives: ['spaeter', 'frueher', 'mehr', 'weniger', 'laenger', 'kuerzer'], than: ['als'], additives: ['nur'] },
    modals: ['darf', 'duerfen', 'soll', 'sollen', 'muss', 'muessen', 'kann', 'koennen'],
    timeBounds: { negators: ['nicht'], words: ['vor', 'nach'] },
    idioms: [String.raw`\bob oder nicht\b`],
    antonyms: [
      [/\b(?:deaktiviert|deaktivieren|abgeschaltet|ausgeschaltet)\b/g, 'aktiviert', true],
      [/\b(?:aktivieren|eingeschaltet)\b/g, 'aktiviert'],
      [/\b(?:verboten|untersagt|unzulaessig|gesperrt|(?:darf|duerfen|soll|sollen) (?:\p{L}+ ){0,4}?nicht)\b/gu, 'erlaubt', true],
      [/\b(?:zulaessig|gestattet|freigeschaltet|darf|duerfen)\b/g, 'erlaubt'],
      [/\b(?:abgelehnt|zurueckgewiesen)\b/g, 'akzeptiert', true],
      [/\b(?:durchgefallen|fehlgeschlagen|gescheitert)\b/g, 'bestanden', true],
      [/\b(?:gesunken|sinkt|sank|sinken|verringert|reduziert|gesenkt)\b/g, 'gestiegen', true],
      [/\b(?:steigt|stieg|steigen|erhoeht)\b/g, 'gestiegen'],
      [/\boffene (?=fragen?\b)/g, 'geklaert ', true],
      [/\b(?:geklaert|entschieden|beantwortet)\b/g, 'geklaert'],
      [/\bausgeschlossen\b/g, 'eingeschlossen', true],
      [/\b(?:es sei denn|ausser wenn|ausser falls)\b,?/g, '', true],
      [/\b(?:zurueckgehalten|einbehalten)\b/g, '', true],
      [/\b(?:ausgenommen|befreit)\b/g, '', true],
      [/\bun(genutzt|verschluesselt|signiert|verbraucht|veraendert|befugt|genehmigt|geplant|begrenzt|gesperrt|erreichbar|ueberwacht|bekannt|noetig|erlaubt|vollstaendig|moeglich|verwaltet|beheizt|geklaert|gueltig|wirksam|sicher|bestaetigt|berechtigt|geprueft|verfuegbar|abhaengig|eingeschraenkt|getestet|dokumentiert|bezahlt|verbunden|benutzt|geloest|beantwortet|entschieden|klar|wahrscheinlich|ueblich|regelmaessig|beschaedigt|verschlossen|beaufsichtigt|veroeffentlicht|lizenziert|zertifiziert|betroffen|stabil|zuverlaessig|vollendet)(e|er|es|en|em)?\b/g, '$1$2', true],
      [/\bin(aktiv|kompatibel|konsistent|effizient|korrekt|valide)\b/g, '$1', true],
      [/\bil(legal|loyal)\b/g, '$1', true],
      [/\bir(relevant|reversibel|regulaer)\b/g, '$1', true],
      [/(?<![\p{L}\p{N}])(\p{L}{3,})los(?![\p{L}\p{N}])/gu, '$1', true],
    ],
    timeConditions: ['bevor', 'ehe', String.raw`bis(?!\s+zu\b)`],
    rangeStarts: ['von'],
    rangeEnds: ['bis'],
    clauseJoiners: ['und', 'oder', 'waehrend', 'wobei', 'weil', 'sowie'],
    leadingWords: ['und', 'oder', 'aber', 'jedoch', 'dagegen', 'allerdings', 'sondern', 'weil', 'denn', 'wobei', 'waehrend', 'sowie'],
    restrictive: ['nur', 'ausschliesslich', 'lediglich', 'erst'],
    without: ['ohne'],
  },

  gate: {
    // The capital sharp s is not in the shared Latin ranges.
    chars: 'ẞ',
    numberWords: {
      // German writes a number as one word ("dreihundertfünfundzwanzig"): number-words.js splits it
      // into these words. Spellings without umlaut and ß are listed too.
      cardinals: {
        null: 0, ein: 1, eins: 1, eine: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8,
        neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, fuenfzehn: 15,
        sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40,
        fünfzig: 50, fuenfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, einhalb: 0.5, eineinhalb: 1.5,
        anderthalb: 1.5,
      },
      scales: { hundert: 100, dutzend: 12, tausend: 1e3, million: 1e6, millionen: 1e6, milliarde: 1e9, milliarden: 1e9, billion: 1e12, billionen: 1e12 },
      // "ein", "eine" are the article; "einhalb" only follows a count ("zweieinhalb").
      parts: ['ein', 'eins', 'eine', 'einhalb'],
      joiners: ['und'],
      fractions: {
        ...inflected({ halb: 0.5 }), hälfte: 0.5, haelfte: 0.5, drittel: 1 / 3, achtel: 0.125, siebtel: 1 / 7,
      },
      multipliers: { ...inflected({ doppelt: 2 }), ...inflected({ zweifach: 2, dreifach: 3, vierfach: 4 }) },
      // The stems take an ending: "acht" alone is the cardinal.
      ordinals: inflected({ erst: 1, zweit: 2, dritt: 3, viert: 4, fünft: 5, fuenft: 5, sechst: 6, siebt: 7, acht: 8, neunt: 9, zehnt: 10 }, false),
      adverbs: ['einmal', 'einfach', 'einfache', 'einfachen', 'einfacher', 'einfaches', 'erstens', 'zweitens', 'drittens', 'einst', 'einzeln'],
      contextual: [...Object.keys(inflected({ halb: 0, doppelt: 0 })), 'hälfte', 'haelfte'],
      countNouns: [
        'sekunde', 'sekunden', 'minute', 'minuten', 'stunde', 'stunden', 'tag', 'tage', 'tagen', 'woche', 'wochen', 'monat',
        'monate', 'monaten', 'jahr', 'jahre', 'jahren', 'jahrzehnt', 'jahrhundert', 'meter', 'kilometer', 'liter', 'gramm',
        'kilogramm', 'pfund', 'tasse', 'tassen', 'dosis', 'portion', 'portionen', 'stück', 'stueck', 'teil', 'teile', 'seite',
        'seiten', 'person', 'personen', 'menge', 'anzahl', 'zahl', 'preis', 'preise', 'kosten', 'größe', 'groesse', 'rate',
        'geschwindigkeit', 'budget', 'anteil', 'prozent', 'euro', 'dollar', 'nutzer', 'mitarbeiter',
      ],
      fractionLeads: [],
      negative: ['minus'],
      compound: true,
      suffixes: {
        ordinal: ['ste', 'sten', 'ster', 'stes', 'stem', 'te', 'ten', 'ter', 'tes', 'tem'],
        fraction: ['stel', 'tel'],
        multiplier: ['fach', 'fache', 'fachen', 'facher', 'faches', 'fachem', 'mal'],
      },
    },
    spoken: {
      abbreviations: {
        'z. B.': 'zum Beispiel', 'd. h.': 'das heißt', 'u. a.': 'unter anderem', 'bzw.': 'beziehungsweise', 'ca.': 'circa',
        'usw.': 'und so weiter', 'etc.': 'et cetera', 'inkl.': 'inklusive', 'ggf.': 'gegebenenfalls', 'evtl.': 'eventuell',
        'vgl.': 'vergleiche', 'Nr.': 'Nummer', 'Dr.': 'Doktor', 'Prof.': 'Professor', 'Tel.': 'Telefon', 'Abs.': 'Absatz',
        'Abb.': 'Abbildung', 'mind.': 'mindestens', 'zzgl.': 'zuzüglich',
      },
      units: {
        '%': ['Prozent', 'Prozent'], 'km/h': ['Kilometer pro Stunde', 'Kilometer pro Stunde'], km: ['Kilometer', 'Kilometer'],
        cm: ['Zentimeter', 'Zentimeter'], mm: ['Millimeter', 'Millimeter'], kg: ['Kilogramm', 'Kilogramm'],
        mg: ['Milligramm', 'Milligramm'], ml: ['Milliliter', 'Milliliter'], h: ['Stunde', 'Stunden'], 'Std.': ['Stunde', 'Stunden'],
        min: ['Minute', 'Minuten'], ms: ['Millisekunde', 'Millisekunden'], '°C': ['Grad Celsius', 'Grad Celsius'],
        kB: ['Kilobyte', 'Kilobyte'], MB: ['Megabyte', 'Megabyte'], GB: ['Gigabyte', 'Gigabyte'], TB: ['Terabyte', 'Terabyte'],
        MHz: ['Megahertz', 'Megahertz'], GHz: ['Gigahertz', 'Gigahertz'], kW: ['Kilowatt', 'Kilowatt'],
        kWh: ['Kilowattstunde', 'Kilowattstunden'], '€': ['Euro', 'Euro'], 'm²': ['Quadratmeter', 'Quadratmeter'],
        'km²': ['Quadratkilometer', 'Quadratkilometer'], 'm³': ['Kubikmeter', 'Kubikmeter'], 'Mio.': ['Million', 'Millionen'],
        'Mrd.': ['Milliarde', 'Milliarden'], 'Tsd.': ['Tausend', 'Tausend'],
      },
      approx: 'etwa',
    },
  },
};

/**
 * A word with the endings of a German adjective ("halb", "halbe", "halben", …), each with the same value.
 * @param {Record<string, number>} words
 * @param {boolean} [bare]  also the word without an ending
 * @returns {Record<string, number>}
 */
function inflected(words, bare = true) {
  const endings = bare ? ['', 'e', 'en', 'er', 'es', 'em'] : ['e', 'en', 'er', 'es', 'em'];
  return Object.fromEntries(Object.entries(words).flatMap(([w, n]) => endings.map((e) => [`${w}${e}`, n])));
}
