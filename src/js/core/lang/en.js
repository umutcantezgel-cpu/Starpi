// @ts-check
// English language pack (see index.js for the meaning of each entry). Polarity patterns run on
// folded, lowercase text.

/** @type {import('./index.js').LanguagePack} */
export const en = {
  code: 'en',
  name: 'English',

  months: {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10,
    november: 11, december: 12,
  },
  monthAbbreviations: {
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  },
  // "may" is a verb far more often than a month.
  ambiguousMonths: ['may'],
  weekdays: { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 },
  monthContext: ['in', 'on', 'by', 'until', 'till', 'since', 'from', 'of', 'early', 'late', 'mid', 'end', 'during', 'next', 'last', 'this', 'per'],
  monthPosition: ['early', 'late', 'mid', 'end of'],
  dayMonthLinks: ['of'],
  ordinalSuffixes: ['st', 'nd', 'rd', 'th'],
  numericDateContext: [],
  clockWords: [],
  meridiem: { am: 'am', pm: 'pm' },

  numberFormat: { decimal: '.', group: ',' },
  scales: [
    [1e3, ['k', 'thousand']],
    [1e6, ['million', 'millions', 'mn']],
    [1e9, ['billion', 'billions', 'bn']],
  ],
  percentWords: ['percent', String.raw`per\s?cent`],
  currencyWords: ['euro', 'dollar'],
  unitWords: [
    'days?', 'weeks?', 'months?', 'years?', 'pcs', 'people', 'employees', 'users?', 'teams?', 'sprints?', 'phases?', 'stages?',
  ],
  approxWords: [
    'about', 'around', 'approximately', String.raw`approx\.?`, 'roughly', 'nearly', 'almost', 'some', 'over', 'more than',
    'less than', 'under', 'up to', 'circa',
  ],
  numberWords: {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  },
  numberParts: ['one', 'thousand', 'million', 'billion', 'dozen'],
  numberJoiners: ['and'],

  boilerplate: [
    'according', 'source', 'sources', 'document', 'documents', 'excerpt', 'excerpts', 'mentioned', 'states', 'stated', 'says',
    'file', 'text', 'based', 'shown', 'listed',
    // words that qualify a number (the number itself is checked as a fact)
    'about', 'around', 'approximately', 'approx', 'roughly', 'nearly', 'almost', 'circa', 'thousand', 'million', 'millions',
    'billion', 'billions', 'percent',
  ],
  stopwords: [
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
    'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
    'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he',
    'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me',
    'more', 'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours',
    'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
    'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very',
    'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
    'you', 'your', 'yours',
  ],
  // "e.g." and "i.e." end in single letters.
  abbreviations: ['etc', 'inc', 'corp', 'ltd', 'vs', 'e', 'g', 'i', 'mr', 'mrs', 'ms', 'dr', 'prof', 'jr', 'sr', 'st', 'fig', 'approx', 'tel'],
  letters: '',

  polarity: {
    negators: ['not', 'no', 'never', 'none', 'nothing', 'nobody', 'neither', 'nor', 'without', 'cannot'],
    plainNegators: ['not', 'no', 'never'],
    qualifiers: ['yet', 'also', 'always', 'still', 'really', 'even', 'automatically', 'longer', 'anymore', 'ever', 'currently', 'necessarily'],
    contractions: [
      [/\bcan'?t\b/g, 'can not'],
      [/\bwon'?t\b/g, 'will not'],
      [/n't\b/g, ' not'],
      [/\bcannot\b/g, 'can not'],
    ],
    infixNegators: ['not'],
    prefixNegators: ['not', 'no'],
    rewrites: [
      // "neither A nor B" negates once: "not A or B".
      [/\bneither\b([^.;:!?]*?)\bnor\b/g, 'not$1or not'],
      [/\bnothing but\b/g, 'only'],
      [/\b(?:stopped|ceased)\s+(?=\p{L}+ing\b)/gu, 'not '],
    ],
    clauseNegations: [String.raw`\bit is not (?:true|the case|correct) that\b`],
    nothingAgainst: { nothing: ['nothing'], verbs: ['speaks'], against: ['against'], phrases: ['no objection'], allowed: 'allowed' },
    bounds: { negators: ['no', 'not'], comparatives: ['later', 'earlier', 'more', 'less', 'fewer', 'longer', 'shorter'], than: ['than'], additives: ['only', 'just'] },
    modals: ['may', 'must', 'should', 'can'],
    timeBounds: { negators: ['not'], words: ['before', 'after'] },
    idioms: [String.raw`\bwhether or not\b`, String.raw`\bno\.(?=\s*\d)`, String.raw`\bgo\/no-go\b`],
    antonyms: [
      [/\b(?:disabled|disables|disable|switched off|turned off)\b/g, 'enabled', true],
      [/\b(?:enables|enable|switched on|turned on)\b/g, 'enabled'],
      [/\b(?:prohibited|forbidden|barred|banned|not permitted|not allowed|(?:may|must|should) not)\b/g, 'allowed', true],
      [/\b(?:permitted|allowed)\b|(?<!\d\s)\bmay\b(?!\s+\d)/g, 'allowed'],
      [/\b(?:rejected|rejects|reject)\b/g, 'accepted', true],
      [/\b(?:accepts|accept)\b/g, 'accepted'],
      [/\b(?:failed|fails|fail)\b/g, 'passed', true],
      [/\b(?:passes|pass|succeeded)\b/g, 'passed'],
      [/\boffline\b/g, 'online', true],
      [/\bunsupported\b/g, 'supported', true],
      [/\bunavailable\b/g, 'available', true],
      [/\b(?:decreased|decreases|decrease|fell|falls|dropped|drops|reduced|reduces|reduce|cut|cuts|lowered)\b/g, 'increased', true],
      [/\b(?:increases|increase|rose|rises|rise|grew|grows|raised)\b/g, 'increased'],
      [/\bopen (?=questions?\b)/g, 'resolved ', true],
      [/\b(?:resolved|settled|clarified|answered|decided)\b/g, 'resolved'],
      [/\bexcluded\b/g, 'included', true],
      [/\bdenied\b/g, 'granted', true],
      [/\b(?:unless|except when|except if)\b/g, '', true],
      [/\b(?:held back|withheld|kept back)\b/g, '', true],
      [/\b(?:exempt|exempted)\b/g, '', true],
      [/\bun(used|encrypted|signed|authori[sz]ed|approved|planned|changed|limited|restricted|locked|reachable|monitored|managed|disputed|resolved|necessary|known|verified|protected|paid|assigned|documented|tested|connected|published|licensed|certified|affected|acceptable|able|safe|secure|stable|sure|clear|likely|usual|official|attended|modified|readable|aware|solved|answered|confirmed|scheduled|heated|finished|complete)\b/g, '$1', true],
      [/\bin(active|complete|valid|correct|accessible|sufficient|accurate|compatible|eligible|secure|consistent|dependent|visible|applicable|effective|frequent)\b/g, '$1', true],
      [/\bim(possible|proper|plausible|mature|precise|practical)\b/g, '$1', true],
      [/\bil(legal|logical)\b/g, '$1', true],
      [/\bir(relevant|regular|reversible|responsible)\b/g, '$1', true],
      [/\bdis(allowed|connected|approved|continued|qualified)\b/g, '$1', true],
      // A word followed by "less" ("wireless" stays a word when the other text never says "wire"). The
      // boundaries are written out: \b is ASCII-only, which made the pattern quadratic on long words
      // that mix ASCII and other letters.
      [/(?<![\p{L}\p{N}])(\p{L}{3,})less(?![\p{L}\p{N}])/gu, '$1', true],
    ],
    timeConditions: ['until', 'till', 'before'],
    rangeStarts: ['from'],
    rangeEnds: ['until', 'till'],
    clauseJoiners: ['and', 'or', 'but', 'while', 'whereas', 'although', 'though', 'because'],
    leadingWords: ['and', 'or', 'but', 'while', 'whereas', 'although', 'though', 'because', 'so', 'then'],
    restrictive: ['only', 'solely', 'exclusively', 'merely'],
    without: ['without'],
  },
};
