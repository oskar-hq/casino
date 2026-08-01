/**
 * Roulette-Bots.
 *
 * Beim Roulette gibt es keine gute Strategie – jede Wette hat denselben
 * Hausvorteil von 1/37. Die Schwierigkeit steuert deshalb nur den Spielstil:
 *   leicht  – streut viele kleine Einsätze auf Zahlen (viel Glücksspiel)
 *   mittel  – Mischung aus Außen- und Innenwetten
 *   schwer  – setzt überwiegend auf die einfachen Chancen und größer
 *
 * Das ist bewusst eine Geschmacks-, keine Gewinnfrage: Ein Bot, der "besser"
 * Roulette spielt, ist mathematisch nicht möglich.
 */

const PROFILES = {
  easy: { bets: [2, 5], outsideChance: 0.25, fraction: 0.02 },
  medium: { bets: [1, 3], outsideChance: 0.55, fraction: 0.04 },
  hard: { bets: [1, 2], outsideChance: 0.85, fraction: 0.06 },
};

const OUTSIDE = [
  { type: 'red' },
  { type: 'black' },
  { type: 'even' },
  { type: 'odd' },
  { type: 'low' },
  { type: 'high' },
  { type: 'dozen', args: [1, 2, 3] },
  { type: 'column', args: [1, 2, 3] },
];

/** Startzahlen gültiger Transversalen und Sixainnen. */
const STREET_STARTS = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];

/**
 * Wählt die Wetten eines Bots für eine Runde.
 * @returns {Array<{type: string, arg: any, amount: number}>}
 */
export function chooseBotBets({ balance, minBet, maxBet, difficulty, rng }) {
  const profile = PROFILES[difficulty] ?? PROFILES.medium;
  if (balance < minBet) return [];

  const [low, high] = profile.bets;
  const count = low + rng.int(high - low + 1);
  const budget = Math.max(minBet, Math.round(balance * profile.fraction));
  const perBet = Math.max(minBet, Math.min(maxBet, Math.round(budget / count)));

  const bets = [];
  let spent = 0;
  for (let i = 0; i < count; i++) {
    if (spent + perBet > balance) break;
    bets.push({ ...pickBet(rng, profile), amount: perBet });
    spent += perBet;
  }
  return bets;
}

function pickBet(rng, profile) {
  if (rng.chance(profile.outsideChance)) {
    const choice = rng.pick(OUTSIDE);
    return { type: choice.type, arg: choice.args ? rng.pick(choice.args) : null };
  }
  // Innenwette: Plein, Cheval, Transversale oder Carré.
  const kind = rng.int(4);
  if (kind === 0) return { type: 'straight', arg: rng.int(37) };
  if (kind === 1) {
    // Zwei senkrecht benachbarte Zahlen sind immer ein gültiges Cheval.
    const base = 1 + rng.int(33);
    return { type: 'split', arg: [base, base + 3] };
  }
  if (kind === 2) return { type: 'street', arg: rng.pick(STREET_STARTS) };
  // Carré: linke oder mittlere Spalte, nicht in der letzten Reihe.
  const row = rng.int(11);
  const column = rng.int(2);
  return { type: 'corner', arg: row * 3 + 1 + column };
}

export { PROFILES };
