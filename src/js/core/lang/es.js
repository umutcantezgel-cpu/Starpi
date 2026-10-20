// @ts-check
// Spanish language pack (see index.js for the meaning of each entry). Polarity patterns run on
// folded, lowercase text; Spanish accents stay as they are. Words that other packs read differently
// are left out of the lists every language shares: "once" (eleven, an English adverb) and "dos"
// are no number words for the fact reader, "ago" and "mar" no month abbreviations, and "sea",
// "todo" and "era" no stop words.

/**
 * A pattern for whole words with letters beyond ASCII (\b is ASCII-only).
 * @param {string} body
 */
const W = (body) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'gu');

/** @type {import('./index.js').PackInput} */
export const es = {
  code: 'es',
  name: 'Spanish',

  months: {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
    noviembre: 11, diciembre: 12,
  },
  monthAbbreviations: { ene: 1, abr: 4, dic: 12 },
  ambiguousMonths: [],
  weekdays: { lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6, domingo: 7 },
  monthContext: ['en', 'de', 'desde', 'hasta', 'principios', 'finales', 'mediados', 'antes', 'durante'],
  monthPosition: [],
  // "3 de marzo".
  dayMonthLinks: ['de'],
  ordinalSuffixes: ['º', 'ª', 'er', 'ero', 'era'],
  numericDateContext: [],
  clockWords: [],
  meridiem: null,

  numberFormat: { decimal: ',', group: '.' },
  scales: [
    [1e3, ['mil']],
    [1e6, ['millón', 'millon', 'millones']],
    [1e9, ['millardos?']],
  ],
  percentWords: [String.raw`por\s?ciento`],
  currencyWords: ['euros', 'dólar(?:es)?', 'dolar(?:es)?', 'pesos?'],
  unitWords: [
    'días?', 'dias?', 'semanas?', 'meses', 'mes', 'años?', 'anos?', 'horas?', 'minutos?', 'personas', 'empleados?', 'empleadas?',
    'usuarios?', 'usuarias?', 'equipos?', 'fases?', 'etapas?', 'piezas?', 'unidades',
  ],
  approxWords: [
    'aproximadamente', 'alrededor de', 'cerca de', 'casi', 'unos', 'unas', 'más de', 'mas de', 'menos de', 'hasta', String.raw`aprox\.?`,
  ],
  versionWords: ['versión', 'version', 'firmware', 'software'],
  numberWords: {
    tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, trece: 13, catorce: 14, quince: 15,
    dieciséis: 16, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, treinta: 30, cuarenta: 40,
    cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  },
  numberParts: ['un', 'una', 'uno', 'cien', 'ciento', 'mil', 'millón', 'millones'],
  numberJoiners: ['y'],

  boilerplate: [
    'según', 'segun', 'fuente', 'fuentes', 'documento', 'documentos', 'extracto', 'extractos', 'menciona', 'mencionado',
    'mencionada', 'indica', 'indicado', 'archivo', 'texto', 'citado',
    // words that qualify a number (the number itself is checked as a fact)
    'aproximadamente', 'casi', 'millón', 'millones', 'millardo', 'millardos',
  ],
  stopwords: [
    'a', 'y', 'o', 'al', 'algo', 'algunos', 'algunas', 'ante', 'antes', 'como', 'cómo', 'con', 'contra', 'cual', 'cuál', 'cuando', 'cuándo',
    'de', 'del', 'desde', 'donde', 'dónde', 'durante', 'el', 'él', 'ella', 'ellas', 'ellos', 'en', 'entre', 'es', 'esa', 'esas',
    'ese', 'eso', 'esos', 'esta', 'está', 'están', 'estas', 'este', 'esto', 'estos', 'fue', 'ha', 'han', 'hasta', 'hay', 'la',
    'las', 'le', 'les', 'lo', 'los', 'más', 'me', 'mi', 'mis', 'muy', 'nada', 'ni', 'nos', 'nosotros', 'nunca', 'otra',
    'otro', 'otros', 'para', 'pero', 'poco', 'por', 'porque', 'qué', 'que', 'quien', 'quién', 'se', 'ser', 'si', 'sí', 'sin',
    'sobre', 'son', 'su', 'sus', 'también', 'tanto', 'te', 'tiene', 'tienen', 'todos', 'todas', 'tu', 'tus', 'un', 'una',
    'uno', 'unos', 'unas', 'usted', 'y', 'ya', 'yo', 'cada', 'puede', 'pueden', 'sino', 'tras', 'mientras', 'aunque', 'así',
    'hacia', 'sido', 'estaba', 'había', 'hemos', 'ningún', 'ninguna', 'ninguno',
  ],
  abbreviations: ['p', 'pág', 'págs', 'pp', 'aprox', 'etc', 'sr', 'sra', 'srta', 'dr', 'dra', 'núm', 'ud', 'uds', 'ej', 'tel', 'av'],
  letters: 'ñáíóú¿¡',

  polarity: {
    negators: ['no', 'nunca', 'jamás', 'jamas', 'ningún', 'ningun', 'ninguno', 'ninguna', 'nada', 'nadie', 'ni', 'sin', 'tampoco'],
    plainNegators: ['no', 'nunca'],
    qualifiers: ['todavía', 'todavia', 'aún', 'aun', 'siempre', 'también', 'realmente', 'automáticamente', 'automaticamente', 'necesariamente', 'actualmente', 'ya'],
    contractions: [],
    infixNegators: [],
    prefixNegators: [],
    rewrites: [
      // "no … nunca", "no … nada": Spanish negates twice and means it once.
      [/(?<![\p{L}])no((?:\s+[\p{L}']+){1,6}?)\s+(?:nunca|jamás|jamas|nada|nadie|ningún|ningun|ninguno|ninguna|tampoco)(?![\p{L}])/gu, 'no$1'],
    ],
    clauseNegations: [String.raw`\bno es (?:cierto|verdad|correcto) que\b`],
    nothingAgainst: { nothing: ['nada'], verbs: [], against: ['en contra'], phrases: ['no hay inconveniente'], allowed: 'permitido' },
    bounds: { negators: ['no'], comparatives: ['más', 'mas', 'menos'], than: ['de', 'que'], additives: ['solo', 'sólo', 'solamente'] },
    modals: ['debe', 'deben', 'puede', 'pueden'],
    timeBounds: { negators: ['no'], words: ['antes', 'después', 'despues'] },
    idioms: [String.raw`\bo no\b`],
    antonyms: [
      [W('desactivad[oa]s?|deshabilitad[oa]s?|apagad[oa]s?'), 'activado', true],
      [W('activad[oa]s?|habilitad[oa]s?|encendid[oa]s?'), 'activado'],
      [W('prohibid[oa]s?'), 'permitido', true],
      [W('permitid[oa]s?|autorizad[oa]s?'), 'permitido'],
      [W('rechazad[oa]s?'), 'aceptado', true],
      [W('aceptad[oa]s?'), 'aceptado'],
      [W('fuera de línea|fuera de linea|desconectad[oa]s?'), 'en línea', true],
      [W('disminuid[oa]s?|disminuyó|bajó|bajad[oa]s?|reducid[oa]s?|redujo|cayó'), 'aumentado', true],
      [W('aumentad[oa]s?|aumentó|subió|creció'), 'aumentado'],
      [/\b(preguntas?) abiertas?\b/g, '$1 notx resuelto'],
      [W('resuelt[oa]s?|aclarad[oa]s?|decidid[oa]s?'), 'resuelto'],
      [W('excluid[oa]s?'), 'incluido', true],
      [W('a menos que|salvo que|excepto si'), '', true],
      [W('in(activ[oa]s?|complet[oa]s?|válid[oa]s?|valid[oa]s?|correct[oa]s?|accesibles?|suficientes?|compatibles?|estables?|segur[oa]s?)'), '$1', true],
      [W('im(posibles?|previst[oa]s?)'), '$1', true],
      [W('i(legal(?:es)?)'), '$1', true],
    ],
    timeConditions: ['antes', String.raw`hasta(?!\s+\d)`],
    rangeStarts: ['desde'],
    rangeEnds: ['hasta'],
    clauseJoiners: ['y', 'o', 'pero', 'mientras', 'aunque', 'porque'],
    leadingWords: ['y', 'o', 'pero', 'sin embargo', 'aunque', 'porque', 'además', 'entonces'],
    restrictive: ['solo', 'solamente', 'exclusivamente'],
    without: ['sin'],
  },

  gate: {
    // The inverted question and exclamation marks and the ordinal indicators are below the shared
    // Latin letters.
    chars: '¿¡ªº',
    numberWords: {
      cardinals: {
        cero: 0, un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
        once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciséis: 16, dieciseis: 16, diecisiete: 17, dieciocho: 18,
        diecinueve: 19, veinte: 20, veintiún: 21, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidós: 22, veintidos: 22,
        veintitrés: 23, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiséis: 26, veintiseis: 26, veintisiete: 27,
        veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80,
        noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
        cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
        setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
      },
      scales: { docena: 12, mil: 1e3, millón: 1e6, millon: 1e6, millones: 1e6, millardo: 1e9, millardos: 1e9 },
      // "un", "una", "uno" are the article or a pronoun as often as a count.
      parts: ['un', 'una', 'uno'],
      joiners: ['y'],
      // "cuarto" is the ordinal; "un cuarto" and "tres cuartos" are read as fractions of it.
      fractions: { medio: 0.5, media: 0.5, mitad: 0.5, tercio: 1 / 3, tercios: 1 / 3 },
      multipliers: { doble: 2, triple: 3, cuádruple: 4, duplicado: 2, triplicado: 3 },
      ordinals: {
        primero: 1, primera: 1, primer: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, tercer: 3, cuarto: 4, cuarta: 4,
        cuartos: 4, cuartas: 4, quinto: 5, quinta: 5,
        sexto: 6, sexta: 6, séptimo: 7, séptima: 7, octavo: 8, octava: 8, noveno: 9, novena: 9, décimo: 10, décima: 10,
      },
      adverbs: ['primeramente', 'único', 'única', 'simple', 'sencillo'],
      contextual: ['medio', 'media', 'mitad', 'doble', 'tercio'],
      countNouns: [
        'segundo', 'segundos', 'minuto', 'minutos', 'hora', 'horas', 'día', 'días', 'semana', 'semanas', 'mes', 'meses', 'año',
        'años', 'década', 'siglo', 'metro', 'metros', 'kilómetro', 'kilómetros', 'litro', 'litros', 'gramo', 'gramos', 'kilo',
        'kilos', 'taza', 'tazas', 'dosis', 'pieza', 'piezas', 'unidad', 'unidades', 'página', 'páginas', 'persona', 'personas',
        'número', 'cantidad', 'precio', 'costo', 'coste', 'tamaño', 'tasa', 'velocidad', 'presupuesto', 'parte', 'euros',
      ],
      fractionLeads: ['un', 'una'],
      negative: ['menos'],
      compound: false,
      // "doscientos cincuenta", "mil doscientos", "un millón doscientos mil".
      additions: [
        [100, 1, 99], [200, 1, 99], [300, 1, 99], [400, 1, 99], [500, 1, 99], [600, 1, 99], [700, 1, 99], [800, 1, 99], [900, 1, 99],
        [1000, 1, 999], [1e6, 1, 999_999],
      ],
      tenJoiners: ['y'],
      suffixes: { ordinal: [], fraction: [], multiplier: [] },
    },
    spoken: {
      abbreviations: {
        'p. ej.': 'por ejemplo', 'etc.': 'etcétera', 'aprox.': 'aproximadamente', 'Sr.': 'señor', 'Sra.': 'señora',
        'Dr.': 'doctor', 'Dra.': 'doctora', 'pág.': 'página', 'núm.': 'número', 'Ud.': 'usted', 'Uds.': 'ustedes',
      },
      units: {
        '%': ['por ciento', 'por ciento'], 'km/h': ['kilómetro por hora', 'kilómetros por hora'], km: ['kilómetro', 'kilómetros'],
        cm: ['centímetro', 'centímetros'], mm: ['milímetro', 'milímetros'], kg: ['kilogramo', 'kilogramos'],
        mg: ['miligramo', 'miligramos'], ml: ['mililitro', 'mililitros'], h: ['hora', 'horas'], min: ['minuto', 'minutos'],
        ms: ['milisegundo', 'milisegundos'], '°C': ['grado Celsius', 'grados Celsius'], kB: ['kilobyte', 'kilobytes'],
        MB: ['megabyte', 'megabytes'], GB: ['gigabyte', 'gigabytes'], TB: ['terabyte', 'terabytes'], MHz: ['megahercio', 'megahercios'],
        GHz: ['gigahercio', 'gigahercios'], kW: ['kilovatio', 'kilovatios'], kWh: ['kilovatio hora', 'kilovatios hora'],
        '€': ['euro', 'euros'], 'm²': ['metro cuadrado', 'metros cuadrados'], 'km²': ['kilómetro cuadrado', 'kilómetros cuadrados'],
        'm³': ['metro cúbico', 'metros cúbicos'],
      },
      approx: 'aproximadamente',
    },
  },
};
