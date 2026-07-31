/**
 * Kartendarstellung – vollständig selbst gezeichnet (SVG, keine Bilddateien).
 *
 * Bewusst klassisch statt minimalistisch: Eckindizes oben links und – um 180°
 * gedreht – unten rechts, die traditionelle Symbolanordnung für 2 bis 10 und
 * gespiegelte Figuren für Bube, Dame und König. Damit sind die Karten auch auf
 * einem Handydisplay auf einen Blick lesbar.
 *
 * Alle Formen sind aus Kreisen, Linien und Bögen aufgebaut – keine Vorlagen,
 * keine fremden Illustrationen.
 */

import { el } from './dom.js';

export const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const SUIT_NAMES = { s: 'Pik', h: 'Herz', d: 'Karo', c: 'Kreuz' };
export const SUIT_COLORS = { s: 'black', c: 'black', h: 'red', d: 'red' };
export const RANK_LABELS = { T: '10', J: 'B', Q: 'D', K: 'K', A: 'A' };

/** Farbsymbole in einem 24×24-Feld, Mittelpunkt (12, 12). */
const SUIT_PATHS = {
  s: 'M12 1.6C9.4 6.2 2.6 8.8 2.6 14.2c0 2.9 2.2 5 5 5 1.4 0 2.7-.6 3.6-1.6-.2 2.4-1.2 4.3-2.7 5.2h7c-1.5-.9-2.5-2.8-2.7-5.2.9 1 2.2 1.6 3.6 1.6 2.8 0 5-2.1 5-5C21.4 8.8 14.6 6.2 12 1.6z',
  h: 'M12 22.4c-.5 0-1-.2-1.4-.6C7.1 18.6 2.2 14.4 2.2 9.6c0-3.3 2.5-5.9 5.7-5.9 1.7 0 3.3.8 4.1 2.1.8-1.3 2.4-2.1 4.1-2.1 3.2 0 5.7 2.6 5.7 5.9 0 4.8-4.9 9-8.4 12.2-.4.4-.9.6-1.4.6z',
  d: 'M12 1.4 21.4 12 12 22.6 2.6 12z',
  c: 'M12 1.8a4.4 4.4 0 0 0-3.6 6.9 4.4 4.4 0 1 0-1.7 8.4c1.2 0 2.3-.5 3.1-1.3-.3 2.7-1.4 4.9-2.9 6h10.2c-1.5-1.1-2.6-3.3-2.9-6 .8.8 1.9 1.3 3.1 1.3a4.4 4.4 0 1 0-1.7-8.4A4.4 4.4 0 0 0 12 1.8z',
};

/**
 * Klassische Symbolanordnung im 100×140-Feld.
 * Symbole in der unteren Kartenhälfte stehen auf dem Kopf – wie im Original.
 */
const COL = { left: 30, mid: 50, right: 70 };
const ROW3 = [32, 70, 108];
const ROW4 = [32, 57, 83, 108];
const HALF_UP = 51;
const HALF_DOWN = 89;

const PIPS = {
  2: [[COL.mid, ROW3[0]], [COL.mid, ROW3[2]]],
  3: [[COL.mid, ROW3[0]], [COL.mid, ROW3[1]], [COL.mid, ROW3[2]]],
  4: [
    [COL.left, ROW3[0]], [COL.right, ROW3[0]],
    [COL.left, ROW3[2]], [COL.right, ROW3[2]],
  ],
  5: [
    [COL.left, ROW3[0]], [COL.right, ROW3[0]],
    [COL.mid, ROW3[1]],
    [COL.left, ROW3[2]], [COL.right, ROW3[2]],
  ],
  6: [
    [COL.left, ROW3[0]], [COL.right, ROW3[0]],
    [COL.left, ROW3[1]], [COL.right, ROW3[1]],
    [COL.left, ROW3[2]], [COL.right, ROW3[2]],
  ],
  7: [
    [COL.left, ROW3[0]], [COL.right, ROW3[0]],
    [COL.mid, HALF_UP],
    [COL.left, ROW3[1]], [COL.right, ROW3[1]],
    [COL.left, ROW3[2]], [COL.right, ROW3[2]],
  ],
  8: [
    [COL.left, ROW3[0]], [COL.right, ROW3[0]],
    [COL.mid, HALF_UP],
    [COL.left, ROW3[1]], [COL.right, ROW3[1]],
    [COL.mid, HALF_DOWN],
    [COL.left, ROW3[2]], [COL.right, ROW3[2]],
  ],
  9: [
    [COL.left, ROW4[0]], [COL.right, ROW4[0]],
    [COL.left, ROW4[1]], [COL.right, ROW4[1]],
    [COL.mid, 70],
    [COL.left, ROW4[2]], [COL.right, ROW4[2]],
    [COL.left, ROW4[3]], [COL.right, ROW4[3]],
  ],
  10: [
    [COL.left, ROW4[0]], [COL.right, ROW4[0]],
    [COL.mid, 45],
    [COL.left, ROW4[1]], [COL.right, ROW4[1]],
    [COL.left, ROW4[2]], [COL.right, ROW4[2]],
    [COL.mid, 95],
    [COL.left, ROW4[3]], [COL.right, ROW4[3]],
  ],
};

/** Ein Farbsymbol an eine Stelle setzen (mit optionaler 180°-Drehung). */
function pip(suit, x, y, size, flipped = false) {
  const scale = size / 24;
  const rotate = flipped ? ' rotate(180)' : '';
  return `<g transform="translate(${x} ${y})${rotate} scale(${scale}) translate(-12 -12)"><path d="${SUIT_PATHS[suit]}"/></g>`;
}

/**
 * Halbe Figur für Bube, Dame und König.
 *
 * Gezeichnet wird nur die obere Hälfte (y ≈ 16 bis 69); die untere entsteht
 * durch eine Drehung um den Kartenmittelpunkt – genau wie beim echten Blatt.
 *
 * Damit die Figur nicht als dunkler Klumpen erscheint, ist das Gewand hell
 * mit farbiger Kontur; kräftig gefüllt sind nur Kopfbedeckung und Kragen.
 */
function courtHalf(rank, suit) {
  // Gesicht: bei allen dreien gleich, damit die Karten als Satz wirken.
  const head = `
    <path class="court-solid" d="M39 45c0-6 5-10 11-10s11 4 11 10c0 1.5-.3 2.9-.8 4.2l-2.2-1.4c.3-.9.5-1.8.5-2.8 0-4.3-3.8-7-8.5-7s-8.5 2.7-8.5 7c0 1 .2 1.9.5 2.8l-2.2 1.4c-.5-1.3-.8-2.7-.8-4.2z"/>
    <circle class="court-face" cx="50" cy="46.5" r="8.6"/>
    <circle class="court-dot" cx="46.9" cy="45" r="1.15"/>
    <circle class="court-dot" cx="53.1" cy="45" r="1.15"/>
    <path class="court-line" d="M47.2 50.4c1.1 1.1 4.5 1.1 5.6 0"/>`;

  // Gewand mit V-Kragen – der Kragen trägt die Farbe, das Gewand bleibt hell.
  const robe = `
    <path class="court-robe" d="M30 69v-3.5c0-6.4 9-10.5 20-10.5s20 4.1 20 10.5V69z"/>
    <path class="court-solid" d="M43.2 56.2 50 64.5l6.8-8.3c2.5.6 4.7 1.5 6.4 2.7L50 69 36.8 58.9c1.7-1.2 3.9-2.1 6.4-2.7z"/>`;

  if (rank === 'K') {
    return `
      <path class="court-solid" d="M33.5 34.5 36 21.5l6.5 7.5L50 18l7.5 11 6.5-7.5 2.5 13z"/>
      <circle class="court-solid" cx="36" cy="20" r="2.1"/>
      <circle class="court-solid" cx="50" cy="16.4" r="2.4"/>
      <circle class="court-solid" cx="64" cy="20" r="2.1"/>
      <rect class="court-solid" x="33" y="34.5" width="34" height="4.6" rx="2.3"/>
      ${head}
      <path class="court-line" d="M43.5 52.5c1.8 3.4 11.2 3.4 13 0"/>
      ${robe}`;
  }

  if (rank === 'Q') {
    return `
      <path class="court-solid" d="M36.5 34.5c-.4-6.6 4.5-10.5 13.5-10.5s13.9 3.9 13.5 10.5z"/>
      <circle class="court-solid" cx="38.5" cy="26.5" r="2.6"/>
      <circle class="court-solid" cx="50" cy="21.5" r="3.2"/>
      <circle class="court-solid" cx="61.5" cy="26.5" r="2.6"/>
      <rect class="court-solid" x="33" y="34.5" width="34" height="4.6" rx="2.3"/>
      ${head}
      <path class="court-line" d="M41 47c-1.5 3-1.5 6.5 0 9M59 47c1.5 3 1.5 6.5 0 9"/>
      ${robe}`;
  }

  // Bube: Barett mit Krempe und Feder
  return `
    <path class="court-solid" d="M37.5 33.5c-1-7 3.5-12 12.5-12s13.5 5 12.5 12z"/>
    <rect class="court-solid" x="32.5" y="33.5" width="35" height="4.8" rx="2.4"/>
    <path class="court-line" d="M62.5 26.5c5.5-1.5 8.5-5 9.5-9.5"/>
    <circle class="court-solid" cx="72.5" cy="16" r="1.8"/>
    ${head}
    ${robe}`;
}

/** Der Inhalt der Kartenmitte – je nach Wert Symbole oder Figur. */
function centerArt(rank, suit) {
  if (rank === 'A') {
    return `<g class="ace">${pip(suit, 50, 70, 52)}</g>`;
  }
  if (['J', 'Q', 'K'].includes(rank)) {
    const half = courtHalf(rank, suit);
    return `
      <rect class="court-frame" x="20" y="16" width="60" height="108" rx="8"/>
      <g class="court">${half}</g>
      <g class="court" transform="rotate(180 50 70)">${half}</g>
      <path class="court-split" d="M22 70h56"/>`;
  }
  const count = rank === 'T' ? 10 : Number(rank);
  const layout = PIPS[count] ?? [];
  return layout
    .map(([x, y]) => pip(suit, x, y, 21, y > 70))
    .join('');
}

/** Eckindex: Wert über kleinem Farbsymbol. */
function cornerIndex(rank, suit) {
  const label = RANK_LABELS[rank] ?? rank;
  const long = label.length > 1;
  return `
    <text class="index-rank${long ? ' index-rank--long' : ''}" x="0" y="0">${label}</text>
    <g transform="translate(0 9) scale(.55) translate(-12 -12)"><path d="${SUIT_PATHS[suit]}"/></g>`;
}

/**
 * Baut das SVG-Markup einer offenen Karte.
 * @param {{rank: string, suit: string}} card
 */
export function cardFaceSvg(card) {
  const color = SUIT_COLORS[card.suit];
  return `
    <svg class="card-svg card-svg--${color}" viewBox="0 0 100 140" role="img"
         aria-label="${SUIT_NAMES[card.suit]} ${RANK_LABELS[card.rank] ?? card.rank}">
      <rect class="card-bg" x="1" y="1" width="98" height="138" rx="9"/>
      <g class="corner" transform="translate(11 17)">${cornerIndex(card.rank, card.suit)}</g>
      <g class="corner" transform="translate(89 123) rotate(180)">${cornerIndex(card.rank, card.suit)}</g>
      <g class="art">${centerArt(card.rank, card.suit)}</g>
    </svg>`;
}

/** Rückseite – ein Rautenmuster, das sich gut vom Filz abhebt. */
export function cardBackSvg() {
  return `
    <svg class="card-svg card-svg--back" viewBox="0 0 100 140" aria-label="verdeckte Karte">
      <defs>
        <pattern id="cardback" width="14" height="14" patternUnits="userSpaceOnUse"
                 patternTransform="rotate(45)">
          <rect width="14" height="14" class="back-base"/>
          <circle cx="7" cy="7" r="2.6" class="back-dot"/>
        </pattern>
      </defs>
      <rect class="card-bg" x="1" y="1" width="98" height="138" rx="9"/>
      <rect x="6" y="6" width="88" height="128" rx="6" fill="url(#cardback)"/>
      <rect class="back-frame" x="6" y="6" width="88" height="128" rx="6"/>
    </svg>`;
}

/**
 * Erzeugt ein Kartenelement.
 * @param {object|null} card `null` = verdeckt
 * @param {object} [options]
 * @param {string} [options.extra] zusätzliche CSS-Klassen
 * @param {boolean} [options.small] kleinere Darstellung
 */
export function renderCard(card, { extra = '', small = false } = {}) {
  const classes = ['card', small && 'card--small', !card && 'card--back', extra]
    .filter(Boolean)
    .join(' ');
  const node = el(`div`, { class: classes, html: card ? cardFaceSvg(card) : cardBackSvg() });
  if (card) node.dataset.code = card.code;
  return node;
}

/** Mehrere Karten hintereinander; `null` steht für eine verdeckte Karte. */
export function renderCards(cards, options = {}) {
  return cards.map((card) => renderCard(card, options));
}
