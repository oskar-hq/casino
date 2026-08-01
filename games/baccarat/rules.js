/**
 * Punto Banco – die Ziehregeln.
 *
 * Baccarat hat keine Entscheidungen: Ob eine dritte Karte kommt, steht
 * vollständig in den Regeln. Deshalb stecken sie hier in eigenen Funktionen,
 * getrennt von der Engine – so lassen sie sich Fall für Fall gegen die
 * Standardtabelle prüfen.
 */

/** Kartenwert beim Baccarat: Bilder und Zehn zählen 0, das Ass 1. */
export function cardPoints(card) {
  if (!card) return 0;
  if (['T', 'J', 'Q', 'K'].includes(card.rank)) return 0;
  if (card.rank === 'A') return 1;
  return Number(card.rank);
}

/** Der Wert einer Hand: Summe modulo 10. */
export function handTotal(cards) {
  return cards.reduce((sum, card) => sum + cardPoints(card), 0) % 10;
}

/** 8 oder 9 aus den ersten beiden Karten beendet die Runde sofort. */
export const isNatural = (total) => total === 8 || total === 9;

/**
 * Zieht der Spieler (Punto) eine dritte Karte?
 * Regel: bei 0 bis 5 ja, bei 6 oder 7 nein.
 */
export function playerDraws(playerTotal) {
  return playerTotal <= 5;
}

/**
 * Zieht die Bank (Banco) eine dritte Karte?
 *
 * Hat der Spieler keine dritte Karte gezogen, spielt die Bank wie der Spieler
 * (bis 5 ziehen). Sonst hängt es vom Bankwert **und** von der dritten
 * Spielerkarte ab – das ist die klassische Tabelle:
 *
 *   Bank 0–2 → immer ziehen
 *   Bank 3   → ziehen, außer die dritte Karte war eine 8
 *   Bank 4   → ziehen bei 2–7
 *   Bank 5   → ziehen bei 4–7
 *   Bank 6   → ziehen bei 6–7
 *   Bank 7   → stehen bleiben
 *
 * @param {number} bankerTotal Wert der Bank aus zwei Karten
 * @param {number|null} playerThird Punktwert der dritten Spielerkarte, sonst null
 */
export function bankerDraws(bankerTotal, playerThird) {
  if (bankerTotal >= 7) return false;
  if (playerThird === null || playerThird === undefined) return bankerTotal <= 5;

  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true;
    case 3:
      return playerThird !== 8;
    case 4:
      return playerThird >= 2 && playerThird <= 7;
    case 5:
      return playerThird >= 4 && playerThird <= 7;
    case 6:
      return playerThird === 6 || playerThird === 7;
    default:
      return false;
  }
}

/** Wer gewinnt? */
export function outcomeOf(playerTotal, bankerTotal) {
  if (playerTotal > bankerTotal) return 'player';
  if (bankerTotal > playerTotal) return 'banker';
  return 'tie';
}

/**
 * Auszahlung einer Wette – Einsatz **inklusive**.
 *
 * Player zahlt 1:1, Banker ebenfalls 1:1, davon aber 5 % Kommission auf den
 * Gewinn (daher effektiv 0,95:1). Tie zahlt 8:1. Bei Unentschieden bekommen
 * Player- und Banker-Wetten ihren Einsatz zurück.
 */
export function payoutFor(side, amount, outcome) {
  if (outcome === 'tie') {
    if (side === 'tie') return amount * 9; // Einsatz + 8:1
    return amount; // Einsatz zurück
  }
  if (side !== outcome) return 0;
  if (side === 'player') return amount * 2;
  // Banker: Einsatz + Gewinn abzüglich 5 % Kommission, kaufmännisch gerundet.
  return amount + (amount - commissionOn(amount));
}

/** Die 5-%-Kommission auf einen gewonnenen Banker-Einsatz. */
export function commissionOn(amount) {
  return Math.round(amount * 0.05);
}

export const SIDES = ['player', 'banker', 'tie'];

export const SIDE_LABELS = {
  player: 'Player',
  banker: 'Banker',
  tie: 'Tie',
};
