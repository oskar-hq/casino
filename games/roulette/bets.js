/**
 * Die Wettarten des europäischen Roulettes (ein Rad, eine Null) samt
 * Standardquoten.
 *
 * Die Quote ist immer "x zu 1": Bei einem Gewinn bekommt man den Einsatz
 * zurück **und** das Vielfache dazu. Ein Plein (35:1) zahlt also bei 10 Chips
 * Einsatz 360 aus – 10 Einsatz + 350 Gewinn.
 *
 * Jede Wette wird über die Menge der Zahlen definiert, die sie abdeckt.
 * Dadurch braucht die Auswertung genau eine Regel: Liegt die gefallene Zahl
 * in der Menge, gewinnt die Wette.
 */

/** Die roten Zahlen des Rades – der Rest (außer 0) ist schwarz. */
export const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const isRed = (n) => RED_NUMBERS.has(n);
export const isBlack = (n) => n !== 0 && !RED_NUMBERS.has(n);

/**
 * Die Reihenfolge der Zahlen auf dem echten europäischen Rad. Sie beeinflusst
 * das Ergebnis nicht (jede Zahl ist gleich wahrscheinlich), wird aber für die
 * Anzeige der Kugel gebraucht.
 */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ALL_NUMBERS = range(0, 36);

/**
 * Die Wettarten. `numbers` liefert die abgedeckten Zahlen, `payout` die Quote.
 * `arg` ist der Parameter der Wette (z. B. die Zahl beim Plein).
 */
export const BET_TYPES = {
  // ---------------------------------------------------------- Innenwetten
  straight: {
    label: 'Plein',
    payout: 35,
    size: 1,
    parse: (arg) => {
      const n = Number(arg);
      return Number.isInteger(n) && n >= 0 && n <= 36 ? [n] : null;
    },
  },
  split: {
    label: 'Cheval',
    payout: 17,
    size: 2,
    // Zwei benachbarte Zahlen auf dem Tableau (waagerecht oder senkrecht).
    parse: (arg) => {
      const numbers = parseList(arg, 2);
      if (!numbers) return null;
      return areNeighbours(numbers[0], numbers[1]) ? numbers : null;
    },
  },
  street: {
    label: 'Transversale',
    payout: 11,
    size: 3,
    // Eine Querreihe, angegeben über ihre erste Zahl (1, 4, 7 … 34).
    parse: (arg) => {
      const start = Number(arg);
      if (!Number.isInteger(start) || start < 1 || start > 34 || (start - 1) % 3 !== 0) return null;
      return [start, start + 1, start + 2];
    },
  },
  corner: {
    label: 'Carré',
    payout: 8,
    size: 4,
    // Vier Zahlen um eine Ecke, angegeben über die kleinste (links oben).
    parse: (arg) => {
      const start = Number(arg);
      if (!Number.isInteger(start) || start < 1 || start > 32) return null;
      if ((start - 1) % 3 === 2) return null; // rechte Spalte hat keine Ecke rechts
      return [start, start + 1, start + 3, start + 4];
    },
  },
  line: {
    label: 'Sixainne',
    payout: 5,
    size: 6,
    // Zwei benachbarte Querreihen, angegeben über die erste Zahl.
    parse: (arg) => {
      const start = Number(arg);
      if (!Number.isInteger(start) || start < 1 || start > 31 || (start - 1) % 3 !== 0) return null;
      return range(start, start + 5);
    },
  },
  trio: {
    label: 'Trio mit Null',
    payout: 11,
    size: 3,
    // Die klassischen Kombinationen 0-1-2 und 0-2-3.
    parse: (arg) => {
      const numbers = parseList(arg, 3);
      if (!numbers || numbers[0] !== 0) return null;
      const rest = numbers.slice(1).join(',');
      return rest === '1,2' || rest === '2,3' ? numbers : null;
    },
  },

  // ---------------------------------------------------------- Außenwetten
  dozen: {
    label: 'Dutzend',
    payout: 2,
    size: 12,
    parse: (arg) => {
      const index = Number(arg);
      if (![1, 2, 3].includes(index)) return null;
      return range((index - 1) * 12 + 1, index * 12);
    },
  },
  column: {
    label: 'Kolonne',
    payout: 2,
    size: 12,
    parse: (arg) => {
      const index = Number(arg);
      if (![1, 2, 3].includes(index)) return null;
      return range(1, 36).filter((n) => n % 3 === index % 3);
    },
  },
  red: { label: 'Rot', payout: 1, size: 18, parse: () => [...RED_NUMBERS] },
  black: { label: 'Schwarz', payout: 1, size: 18, parse: () => range(1, 36).filter(isBlack) },
  even: { label: 'Gerade', payout: 1, size: 18, parse: () => range(1, 36).filter((n) => n % 2 === 0) },
  odd: { label: 'Ungerade', payout: 1, size: 18, parse: () => range(1, 36).filter((n) => n % 2 === 1) },
  low: { label: 'Manque (1–18)', payout: 1, size: 18, parse: () => range(1, 18) },
  high: { label: 'Passe (19–36)', payout: 1, size: 18, parse: () => range(19, 36) },
};

/** Wandelt "1,2" oder [1,2] in eine sortierte Zahlenliste fester Länge. */
function parseList(arg, length) {
  const raw = Array.isArray(arg) ? arg : String(arg ?? '').split(',');
  const numbers = raw.map(Number);
  if (numbers.length !== length) return null;
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 36)) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  if (new Set(sorted).size !== length) return null;
  return sorted;
}

/** Liegen zwei Zahlen auf dem Tableau nebeneinander? */
function areNeighbours(a, b) {
  if (a === 0) return [1, 2, 3].includes(b);
  // Das Tableau hat drei Zahlen pro Querreihe.
  const rowA = Math.floor((a - 1) / 3);
  const rowB = Math.floor((b - 1) / 3);
  if (rowA === rowB) return Math.abs(a - b) === 1; // waagerecht
  return Math.abs(a - b) === 3; // senkrecht
}

/**
 * Prüft und normalisiert eine Wette.
 * @returns {{type: string, arg: any, numbers: number[], payout: number, label: string}}
 */
export function parseBet(type, arg) {
  const definition = BET_TYPES[type];
  if (!definition) return null;
  const numbers = definition.parse(arg);
  if (!numbers || !numbers.length) return null;
  if (numbers.some((n) => !ALL_NUMBERS.includes(n))) return null;
  return {
    type,
    arg: arg ?? null,
    numbers,
    payout: definition.payout,
    label: describeBet(type, arg, numbers),
  };
}

function describeBet(type, arg, numbers) {
  const definition = BET_TYPES[type];
  switch (type) {
    case 'straight':
      return `Plein ${numbers[0]}`;
    case 'dozen':
      return `${arg}. Dutzend`;
    case 'column':
      return `${arg}. Kolonne`;
    case 'red':
    case 'black':
    case 'even':
    case 'odd':
    case 'low':
    case 'high':
      return definition.label;
    default:
      return `${definition.label} ${numbers.join('/')}`;
  }
}

/** Gewinnt diese Wette bei dieser Zahl? */
export const betWins = (bet, number) => bet.numbers.includes(number);

/**
 * Auszahlung einer Wette: Einsatz zurück plus Quote mal Einsatz.
 * Bei Verlust: 0.
 */
export function betPayout(bet, amount, number) {
  return betWins(bet, number) ? amount * (bet.payout + 1) : 0;
}

/** Farbe einer Zahl – nur für die Anzeige. */
export function colorOf(number) {
  if (number === 0) return 'green';
  return isRed(number) ? 'red' : 'black';
}
