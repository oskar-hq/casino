/**
 * Baccarat-Bots.
 *
 * Wie beim Roulette gibt es auch hier keine Strategie, die die Quoten
 * verschiebt: Banker gewinnt etwas öfter (deshalb die Kommission), Tie ist
 * die mit Abstand schlechteste Wette. Die Schwierigkeit steuert deshalb, wie
 * vernünftig ein Bot setzt:
 *
 *   leicht  – jagt Serien in der Verlaufsanzeige und spielt gern Tie
 *   mittel  – meist Banker/Player, selten Tie
 *   schwer  – fast immer Banker (die statistisch beste Wette), nie Tie
 */

const PROFILES = {
  easy: { banker: 0.35, tie: 0.18, streak: 0.5, fraction: 0.03 },
  medium: { banker: 0.55, tie: 0.05, streak: 0.2, fraction: 0.05 },
  hard: { banker: 0.92, tie: 0, streak: 0, fraction: 0.07 },
};

/**
 * Wählt die Wette eines Bots.
 * @returns {{side: string, amount: number}|null}
 */
export function chooseBotBet({ balance, minBet, maxBet, difficulty, history, rng }) {
  const profile = PROFILES[difficulty] ?? PROFILES.medium;
  if (balance < minBet) return null;

  const amount = Math.max(
    minBet,
    Math.min(maxBet, balance, Math.round(balance * profile.fraction * (0.7 + rng.float() * 0.6))),
  );

  // Serienjagd: Das letzte Ergebnis noch einmal setzen. Bringt statistisch
  // nichts, ist aber genau das, was am echten Tisch passiert.
  const last = history?.[0]?.outcome;
  if (last && last !== 'tie' && rng.chance(profile.streak)) {
    return { side: last, amount };
  }

  const roll = rng.float();
  if (roll < profile.tie) return { side: 'tie', amount };
  return { side: roll < profile.tie + profile.banker ? 'banker' : 'player', amount };
}

export { PROFILES };
