/**
 * Blackjack-Bots.
 *
 * Grundlage ist die Basisstrategie (die mathematisch beste Spielweise ohne
 * Kartenzählen). Die Schwierigkeit steuert, wie konsequent ein Bot sie
 * befolgt:
 *   leicht  – spielt oft „nach Gefühl“ (zieht bis 17, verdoppelt kaum)
 *   mittel  – Basisstrategie mit gelegentlichen Ausrutschern
 *   schwer  – Basisstrategie ohne Abweichung
 */

import { handValue } from './engine.js';

const PROFILES = {
  easy: { follow: 0.45, betFraction: 0.03 },
  medium: { follow: 0.88, betFraction: 0.05 },
  hard: { follow: 1, betFraction: 0.07 },
};

/** Zahlenwert der offenen Dealerkarte (Ass = 11). */
function upcardValue(card) {
  if (!card) return 10;
  if (card.rank === 'A') return 11;
  if (['T', 'J', 'Q', 'K'].includes(card.rank)) return 10;
  return Number(card.rank);
}

/**
 * Basisstrategie für einen 6-Deck-Schuh, Dealer steht auf Soft 17.
 * @returns {'hit'|'stand'|'double'|'split'}
 */
export function basicStrategy({ hand, dealerUpcard, canDouble, canSplit }) {
  const cards = hand.cards;
  const up = upcardValue(dealerUpcard);
  const { total, soft } = handValue(cards);

  // 1) Paare teilen
  if (canSplit) {
    const rank = cards[0].rank;
    const pair = ['T', 'J', 'Q', 'K'].includes(rank) ? 10 : rank === 'A' ? 11 : Number(rank);
    if (pair === 11 || pair === 8) return 'split';
    if (pair === 10 || pair === 5) {
      /* Zehner und Fünfer werden nie geteilt – weiter unten normal spielen. */
    } else if (pair === 9) {
      if (up !== 7 && up !== 10 && up !== 11) return 'split';
    } else if (pair === 7) {
      if (up <= 7) return 'split';
    } else if (pair === 6) {
      if (up <= 6) return 'split';
    } else if (pair === 4) {
      if (up === 5 || up === 6) return 'split';
    } else if (pair === 2 || pair === 3) {
      if (up <= 7) return 'split';
    }
  }

  // 2) Weiche Hände (mit Ass als 11)
  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) {
      if (canDouble && up >= 3 && up <= 6) return 'double';
      return up >= 9 ? 'hit' : 'stand';
    }
    if (total === 17 && canDouble && up >= 3 && up <= 6) return 'double';
    if (total >= 15 && total <= 16 && canDouble && up >= 4 && up <= 6) return 'double';
    if (total >= 13 && total <= 14 && canDouble && up >= 5 && up <= 6) return 'double';
    return 'hit';
  }

  // 3) Harte Hände
  if (total >= 17) return 'stand';
  if (total >= 13 && total <= 16) return up <= 6 ? 'stand' : 'hit';
  if (total === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
  if (total === 11) return canDouble ? 'double' : 'hit';
  if (total === 10) return canDouble && up <= 9 ? 'double' : 'hit';
  if (total === 9) return canDouble && up >= 3 && up <= 6 ? 'double' : 'hit';
  return 'hit';
}

/** Was ein schwächerer Bot stattdessen tut: einfach bis 17 ziehen. */
function naiveMove({ hand }) {
  return handValue(hand.cards).total < 17 ? 'hit' : 'stand';
}

export function decideBlackjack({ hand, dealerUpcard, canDouble, canSplit, difficulty, rng }) {
  if (!hand) return 'stand';
  const profile = PROFILES[difficulty] ?? PROFILES.medium;
  const move = rng.chance(profile.follow)
    ? basicStrategy({ hand, dealerUpcard, canDouble, canSplit })
    : naiveMove({ hand });

  // Sicherheitsnetz: nie eine Aktion vorschlagen, die gerade nicht erlaubt ist.
  if (move === 'double' && !canDouble) return 'hit';
  if (move === 'split' && !canSplit) return basicStrategyWithoutSplit({ hand, dealerUpcard, canDouble });
  return move;
}

function basicStrategyWithoutSplit({ hand, dealerUpcard, canDouble }) {
  const move = basicStrategy({ hand, dealerUpcard, canDouble, canSplit: false });
  return move === 'split' ? 'hit' : move;
}

/** Wie viel ein Bot setzt: ein kleiner Teil seines Guthabens. */
export function botBetAmount({ balance, minBet, maxBet, difficulty, rng }) {
  const profile = PROFILES[difficulty] ?? PROFILES.medium;
  if (balance < minBet) return 0;
  const wanted = Math.round(balance * profile.betFraction * (0.7 + rng.float() * 0.6));
  return Math.max(minBet, Math.min(maxBet, Math.min(balance, wanted)));
}

export { PROFILES };
