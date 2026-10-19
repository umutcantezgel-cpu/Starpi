// @ts-check
// Turkish language pack (see index.js for the meaning of each entry).
//
// Case: Turkish lowercases "I" to "ı" and "İ" to "i", which toLowerCase() does not; `caseFold` says
// so, and lowerCase(text, 'tr') applies it where a text is read as Turkish (language guess, number
// words). The folded form that facts and polarity compare (facts.js fold) spells both "ı" and "İ" as
// "i" and, as for German, "ö" as "oe" and "ü" as "ue", so a word matches whatever its case: the
// polarity patterns below are written in that form ("degil" stays "değil", "çevrimdışı" becomes
// "çevrimdişi").
//
// Negation is mostly a suffix of the verb ("desteklenmiyor", "desteklenmedi", "şifresiz"); the
// antonym rules rewrite the common forms into the marker and the positive form. Words that other
// packs read differently are left out of the lists every language shares: "on" (ten; an English
// word) and "bin" (thousand; an English and a German word) are no number words for the fact reader
// and no stop words, "elli" and "kirk" (names) no number words, "mar" and "may" no month abbreviations.

/**
 * A pattern for whole words with letters beyond ASCII (\b is ASCII-only).
 * @param {string} body
 */
const W = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'gu');

/**
 * Weekday names with the endings a day takes in a span or a habit: from ("pazartesiden"), to
 * ("cumaya") and every ("salıları"); a day takes them directly, without an apostrophe. Each base
 * name is listed with its endings as vowel harmony shapes them.
 * @type {Array<[string, number, string[]]>}
 */
const WEEKDAY_FORMS = [
  ['pazartesi', 1, ['den', 'ye', 'leri']],
  ['salı', 2, ['dan', 'ya', 'ları']],
  ['sali', 2, ['dan', 'ya', 'lari']],
  ['çarşamba', 3, ['dan', 'ya', 'ları']],
  ['carsamba', 3, ['dan', 'ya', 'lari']],
  ['perşembe', 4, ['den', 'ye', 'leri']],
  ['persembe', 4, ['den', 'ye', 'leri']],
  ['cuma', 5, ['dan', 'ya', 'ları', 'lari']],
  ['cumartesi', 6, ['den', 'ye', 'leri']],
  ['pazar', 7, ['dan', 'a', 'ları', 'lari']],
];

/** @type {import('./index.js').PackInput} */
export const tr = {
  code: 'tr',
  name: 'Turkish',
  caseFold: { I: 'ı', İ: 'i' },

  // The spellings without "ı" are how an upper-case name reads after toLowerCase() ("MAYIS").
  months: {
    ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6, temmuz: 7, ağustos: 8, agustos: 8,
    eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11, aralık: 12, aralik: 12,
  },
  monthAbbreviations: { oca: 1, şub: 2, nis: 4, haz: 6, tem: 7, ağu: 8, eyl: 9 },
  ambiguousMonths: [],
  weekdays: Object.fromEntries(WEEKDAY_FORMS.flatMap(([day, n, endings]) => [[day, n], ...endings.map((e) => [`${day}${e}`, n])])),
  monthContext: ['geçen', 'gelecek', 'bu', 'önümüzdeki'],
  monthPosition: [],
  dayMonthLinks: [],
  ordinalSuffixes: [],
  numericDateContext: [],
  clockWords: [],
  meridiem: null,

  numberFormat: { decimal: ',', group: '.' },
  scales: [
    [1e3, ['bin']],
    [1e6, ['milyon']],
    [1e9, ['milyar']],
  ],
  percentWords: [],
  currencyWords: ['lira', 'tl', 'avro', 'dolar'],
  unitWords: [
    'gün(?:de|lük|dür)?', 'gun', 'hafta(?:da|lık)?', 'ay(?:da|lık)?', 'yıl(?:da|lık)?', 'yil', 'sene', 'saat(?:te|lik)?',
    'dakika(?:da|lık)?', 'kişi(?:lik)?', 'kisi', 'çalışan', 'calisan', 'kullanıcı', 'kullanici', 'ekip', 'adet', 'aşama', 'asama',
  ],
  approxWords: ['yaklaşık', 'yaklasik', 'aşağı yukarı', 'neredeyse', 'takriben', 'tahminen', 'ortalama', 'en az', 'en fazla'],
  versionWords: ['sürüm', 'surum', 'versiyon', 'yazılım', 'yazilim', 'firmware'],
  numberWords: {
    iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9, yirmi: 20, otuz: 30, kırk: 40, altmış: 60,
    altmis: 60, yetmiş: 70, yetmis: 70, seksen: 80, doksan: 90,
  },
  numberParts: ['bir', 'yüz', 'milyon', 'milyar'],
  numberJoiners: [],

  // Folded forms (see above).
  boilerplate: [
    'goere', 'kaynak', 'kaynaga', 'kaynakta', 'kaynaklar', 'kaynaklara', 'belge', 'belgede', 'belgeler', 'belgelerde',
    'dokueman', 'alinti', 'alintilar', 'dosya', 'dosyada', 'metin', 'metinde', 'belirtilen', 'belirtildigi', 'yazdigi',
    // words that qualify a number (the number itself is checked as a fact)
    'yaklaşik', 'neredeyse', 'milyon', 'milyar', 'yuezde',
  ],
  stopwords: [
    've', 'veya', 'ya', 'da', 'de', 'bir', 'bu', 'şu', 'için', 'ile', 'gibi', 'kadar', 'daha', 'çok', 'ama', 'fakat',
    'ancak', 'ki', 'mı', 'mi', 'mu', 'mü', 'her', 'hem', 'diye', 'olarak', 'olan', 'oldu', 'olur', 'olması', 'ise', 'sonra',
    'önce', 'göre', 'bunu', 'bunun', 'buna', 'bunlar', 'bunları', 'şey', 'sen', 'biz', 'siz', 'onlar', 'onu', 'onun', 'ona',
    'beni', 'bana', 'benim', 'sizin', 'bizim', 'kendi', 'hiç', 'değil', 'yok', 'çünkü', 'eğer', 'nasıl', 'neden', 'nerede',
    'hangi', 'tüm', 'bütün', 'bazı', 'aynı', 'artık', 'yine', 'şimdi', 'sadece', 'ayrıca', 'üzere', 'arasında', 'içinde',
    'edilir', 'edildi', 'eder', 'etmek', 'ettiği', 'olduğu', 'tarafından', 'yani', 'hâlâ', 'zaten',
  ],
  // Turkish writes an ordinal as a number with a dot ("3. sınıf"); a day before a dot is already
  // read as one (sentences.js).
  abbreviations: ['vb', 'vs', 'örn', 'bkz', 'sn', 'dr', 'prof', 'doç', 'yrd', 'tel', 'nolu', 'apt', 'cad', 'sok', 'mah'],
  letters: 'ğış',

  polarity: {
    // A Turkish negator follows the word it negates ("aktif değil", "şifreleme yok").
    // With the copula ("değildir", "yoktur") as well.
    negators: ['değil', 'değildir', 'değiller', 'değildi', 'yok', 'yoktur', 'hiç', 'asla', 'hiçbir', 'hiçbiri'],
    plainNegators: ['değil', 'değildir', 'değiller', 'değildi'],
    qualifiers: ['henuez', 'hala', 'hâlâ', 'zaten', 'otomatik', 'artik', 'şu', 'anda', 'daha', 'kesinlikle'],
    contractions: [],
    infixNegators: [],
    prefixNegators: [],
    rewrites: [],
    clauseNegations: [],
    nothingAgainst: { nothing: [], verbs: [], against: [], phrases: ['sakincasi yok', 'engel yok'], allowed: 'izinli' },
    bounds: { negators: [], comparatives: [], than: [], additives: [] },
    modals: [],
    timeBounds: { negators: [], words: [] },
    idioms: [],
    antonyms: [
      // The negative verb forms (present, past, future, aorist) and the suffix "-siz" ("without").
      [W('(\\p{L}{2,}?)m(i|u|ue)yor(\\p{L}*)'), '$1$2yor$3', true],
      [W('(\\p{L}{3,}?)m(?:e|a)d(i|u|ue)(\\p{L}*)'), '$1d$2$3', true],
      [W('(\\p{L}{3,}?)m(?:e|a)y(ecek|acak)(\\p{L}*)'), '$1$2$3', true],
      [W('(\\p{L}{3,}?(?:il|in|ul|un|uel|uen|len|lan))m(?:e|a)z(\\p{L}*)'), '$1ir$2', true],
      [W('(\\p{L}{3,}?)(?:siz|suz|suez)'), '$1', true],
      [/(?<![\p{L}\p{N}])(?:açik|bekleyen) (?=sorular?(?![\p{L}]))/gu, 'çoezuelmueş ', true],
      [W('çoezueldue|çoezuelmueş|netleşti|karara bağlandi'), 'çoezuelmueş'],
      [W('devre dişi|kapali|pasif|etkisiz'), 'etkin', true],
      [W('etkinleştirilmiş|etkinleştirildi|aktif'), 'etkin'],
      [W('yasak(?:tir)?|yasaklanmiş(?:tir)?|yasaklandi'), 'izinli', true],
      [W('izinli(?:dir)?|izin verilir|serbest(?:tir)?'), 'izinli'],
      [W('reddedildi|reddedilmiş|reddedilen'), 'kabul', true],
      [W('başarisiz|başarisizlik'), 'başarili', true],
      [W('azaldi|duestue|geriledi|azalmiş|duesmueş'), 'artti', true],
      [W('artti|yuekseldi|artmiş'), 'artti'],
      [W('çevrimdişi'), 'çevrimiçi', true],
      [W('hariç'), 'dahil', true],
    ],
    timeConditions: [],
    rangeStarts: [],
    rangeEnds: [],
    clauseJoiners: ['ve', 'veya', 'ya da', 'ama', 'fakat', 'ancak'],
    leadingWords: ['ve', 'veya', 'ama', 'fakat', 'ancak', 'ayrica', 'oysa', 'yine de'],
    restrictive: ['sadece', 'yalnizca', 'yalniz'],
    without: [],
  },

  gate: {
    // The Turkish lira sign; the Turkish letters are in the shared Latin ranges.
    chars: '₺',
    numberWords: {
      // Turkish writes a number as separate words ("bin dokuz yüz seksen dört"); ten and a unit add up
      // ("on beş").
      cardinals: {
        sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30,
        kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90,
      },
      scales: { yüz: 100, düzine: 12, bin: 1e3, milyon: 1e6, milyar: 1e9 },
      // "bir" is the article as often as a count.
      parts: ['bir'],
      joiners: [],
      fractions: { yarım: 0.5, yarı: 0.5, çeyrek: 0.25 },
      multipliers: {},
      ordinals: {
        ilk: 1, birinci: 1, ikinci: 2, üçüncü: 3, dördüncü: 4, beşinci: 5, altıncı: 6, yedinci: 7, sekizinci: 8, dokuzuncu: 9,
        onuncu: 10, yirminci: 20, otuzuncu: 30, kırkıncı: 40, ellinci: 50, yüzüncü: 100, bininci: 1000,
      },
      adverbs: ['tek', 'teker', 'birlikte', 'birden', 'birkaç'],
      contextual: ['yarım', 'yarı', 'çeyrek'],
      countNouns: [
        'saniye', 'dakika', 'saat', 'gün', 'hafta', 'ay', 'yıl', 'sene', 'metre', 'kilometre', 'litre', 'gram', 'kilo', 'kilogram',
        'adet', 'parça', 'sayfa', 'kişi', 'kullanıcı', 'çalışan', 'fiyat', 'maliyet', 'oran', 'hız', 'bütçe', 'pay', 'lira', 'avro',
        'dolar', 'fincan', 'doz',
      ],
      fractionLeads: [],
      negative: ['eksi'],
      compound: false,
      additions: [[10, 1, 9]],
      tenJoiners: [],
      suffixes: { ordinal: ['inci', 'ıncı', 'uncu', 'üncü', 'nci', 'ncı', 'ncu', 'ncü'], fraction: [], multiplier: [] },
    },
    spoken: {
      abbreviations: {
        'vb.': 've benzeri', 'vs.': 've saire', 'örn.': 'örneğin', 'bkz.': 'bakınız', 'Dr.': 'Doktor', 'Prof.': 'Profesör',
        'Doç.': 'Doçent', 'Sn.': 'Sayın', 'Tel.': 'Telefon', 'Cad.': 'Caddesi', 'Sok.': 'Sokağı', 'Mah.': 'Mahallesi',
      },
      units: {
        '%': ['yüzde', 'yüzde'], 'km/h': ['kilometre bölü saat', 'kilometre bölü saat'], km: ['kilometre', 'kilometre'],
        cm: ['santimetre', 'santimetre'], mm: ['milimetre', 'milimetre'], kg: ['kilogram', 'kilogram'], mg: ['miligram', 'miligram'],
        ml: ['mililitre', 'mililitre'], sa: ['saat', 'saat'], dk: ['dakika', 'dakika'], ms: ['milisaniye', 'milisaniye'],
        '°C': ['santigrat derece', 'santigrat derece'], kB: ['kilobayt', 'kilobayt'], MB: ['megabayt', 'megabayt'],
        GB: ['gigabayt', 'gigabayt'], TB: ['terabayt', 'terabayt'], MHz: ['megahertz', 'megahertz'], GHz: ['gigahertz', 'gigahertz'],
        kW: ['kilovat', 'kilovat'], kWh: ['kilovat saat', 'kilovat saat'], '€': ['avro', 'avro'], '₺': ['lira', 'lira'],
        TL: ['lira', 'lira'], 'm²': ['metrekare', 'metrekare'], 'km²': ['kilometrekare', 'kilometrekare'], 'm³': ['metreküp', 'metreküp'],
      },
      approx: 'yaklaşık',
    },
  },
};
