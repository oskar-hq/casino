/**
 * Klassisches 52-Karten-Blatt plus Schuh (mehrere Decks) für Blackjack & Co.
 *
 * Eine Karte sieht so aus:
 *   { id: 'As#0', code: 'As', rank: 'A', suit: 's', value: 14 }
 *
 * `code` ist die Kurzschreibweise, die auch `pokersolver` versteht
 * (Rang + Farbe, z. B. 'Td' = Karo 10). `id` ist zusätzlich innerhalb eines
 * Schuhs eindeutig, weil dort dieselbe Karte mehrfach vorkommt.
 */

/** Farben in der Reihenfolge, in der Hände sortiert angezeigt werden. */
export const SUITS = ['s', 'h', 'd', 'c'];

export const SUIT_NAMES = {
  s: 'Pik',
  h: 'Herz',
  d: 'Karo',
  c: 'Kreuz',
};

/** Rot oder schwarz – wird auch fürs Rendering gebraucht. */
export const SUIT_COLORS = { s: 'black', c: 'black', h: 'red', d: 'red' };

/** Ränge von klein nach groß. 'T' ist die 10 (einstellig wegen `code`). */
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export const RANK_VALUES = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));

export const RANK_LABELS = {
  T: '10',
  J: 'B',
  Q: 'D',
  K: 'K',
  A: 'A',
};

/** Anzeigename einer Karte, z. B. "Herz Dame". */
export function cardLabel(card) {
  const rank = RANK_LABELS[card.rank] ?? card.rank;
  return `${SUIT_NAMES[card.suit]} ${rank}`;
}

/** Baut eine einzelne Karte. `copy` unterscheidet Duplikate im Schuh. */
export function makeCard(rank, suit, copy = 0) {
  const code = `${rank}${suit}`;
  return {
    id: copy === 0 ? code : `${code}#${copy}`,
    code,
    rank,
    suit,
    value: RANK_VALUES[rank],
  };
}

/** Ein frisches, ungemischtes 52er-Deck. */
export function createDeck(copy = 0) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(makeCard(rank, suit, copy));
  }
  return deck;
}

/** Mehrere Decks hintereinander – die Grundlage eines Schuhs. */
export function createShoeCards(decks = 1) {
  const cards = [];
  for (let copy = 0; copy < decks; copy++) cards.push(...createDeck(copy));
  return cards;
}

/**
 * Kartenschuh mit Cut-Card.
 *
 * Der Schuh wird neu gemischt, sobald weniger als `penetration` der Karten
 * übrig sind – aber immer erst zwischen zwei Runden, nie mittendrin. Die
 * Reihenfolge der Karten ist geheim und verlässt den Server nie.
 */
export class Shoe {
  /**
   * @param {object} options
   * @param {number} options.decks Anzahl Decks im Schuh
   * @param {import('./rng.js').Rng} options.rng
   * @param {number} options.penetration Anteil Restkarten, ab dem neu gemischt wird
   */
  constructor({ decks = 6, rng, penetration = 0.25 } = {}) {
    this.decks = Math.max(1, Math.floor(decks));
    this.rng = rng;
    this.penetration = penetration;
    this.cards = [];
    this.discarded = 0;
    this.shuffleCount = 0;
    this.reshuffle();
  }

  reshuffle() {
    this.cards = this.rng.shuffle(createShoeCards(this.decks));
    this.discarded = 0;
    this.shuffleCount += 1;
  }

  get remaining() {
    return this.cards.length;
  }

  get total() {
    return this.decks * 52;
  }

  /** Wurde die Cut-Card erreicht? Wird zwischen den Runden abgefragt. */
  get needsShuffle() {
    return this.cards.length <= this.total * this.penetration;
  }

  /** Mischt neu, falls die Cut-Card erreicht ist. Gibt true zurück, wenn gemischt wurde. */
  reshuffleIfNeeded() {
    if (!this.needsShuffle) return false;
    this.reshuffle();
    return true;
  }

  /** Zieht eine Karte. Ein leerer Schuh wird notfalls sofort neu gemischt. */
  draw() {
    if (!this.cards.length) this.reshuffle();
    this.discarded += 1;
    return this.cards.pop();
  }

  /** Zieht mehrere Karten. */
  drawMany(count) {
    const drawn = [];
    for (let i = 0; i < count; i++) drawn.push(this.draw());
    return drawn;
  }
}

/**
 * Einmal-Deck für Poker: frisch gemischte 52 Karten pro Hand.
 * Bewusst kein Schuh – jede Hold'em-Hand bekommt ein volles neues Deck.
 */
export function freshDeck(rng) {
  return rng.shuffle(createDeck());
}

/** Sortiert eine Hand hübsch: erst Farbe, dann Wert absteigend. */
export function sortHand(cards) {
  const suitOrder = Object.fromEntries(SUITS.map((suit, index) => [suit, index]));
  return [...cards].sort(
    (a, b) => suitOrder[a.suit] - suitOrder[b.suit] || b.value - a.value,
  );
}
