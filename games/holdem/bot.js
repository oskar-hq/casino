/**
 * Poker-Bots.
 *
 * Grundgerüst für alle drei Schwierigkeiten:
 *   1. Gewinnwahrscheinlichkeit (Equity) per Monte-Carlo gegen zufällige
 *      Gegnerhände schätzen.
 *   2. Mit den Pot-Odds vergleichen: Was muss ich zahlen, was liegt im Topf?
 *   3. Position und ein schwierigkeitsabhängiger Aggressions-/Bluffanteil
 *      verschieben die Schwelle.
 *
 * Die Unterschiede stecken in `PROFILES`: „leicht“ rechnet ungenau, geht viel
 * zu oft mit und erhöht selten. „Schwer“ simuliert deutlich mehr Hände, achtet
 * genau auf die Pot-Odds, spielt Position aus und blufft regelmäßig.
 */

import pokersolver from 'pokersolver';

import { RANKS, SUITS } from '../../core/cards.js';

const { Hand } = pokersolver;

const ALL_CODES = SUITS.flatMap((suit) => RANKS.map((rank) => `${rank}${suit}`));

const PROFILES = {
  easy: {
    sims: 60,
    /** Wie viel Vorsprung vor den Pot-Odds es zum Erhöhen braucht. */
    raiseEdge: 0.3,
    /** Wie viel schlechter als nötig eine Hand sein darf, um trotzdem mitzugehen. */
    callSlack: 0.14,
    bluff: 0.03,
    sizing: 0.5,
    position: 0.02,
    /** Streuung, damit der Bot nicht berechenbar ist. */
    noise: 0.1,
  },
  medium: {
    sims: 180,
    raiseEdge: 0.16,
    callSlack: 0.03,
    bluff: 0.09,
    sizing: 0.65,
    position: 0.05,
    noise: 0.05,
  },
  hard: {
    sims: 420,
    raiseEdge: 0.08,
    callSlack: -0.01,
    bluff: 0.17,
    sizing: 0.78,
    position: 0.08,
    noise: 0.02,
  },
};

/**
 * Schätzt die Gewinnwahrscheinlichkeit per Monte-Carlo.
 *
 * Es werden zufällige Gegnerhände und die fehlenden Boardkarten aus den noch
 * unbekannten Karten gezogen und ausgewertet. Geteilte Pötte zählen anteilig.
 */
export function estimateEquity({ hole, board, opponents, sims, rng }) {
  const rivals = Math.max(1, Math.min(opponents, 4));
  const known = new Set([...hole, ...board]);
  const pool = ALL_CODES.filter((code) => !known.has(code));
  const boardNeeded = 5 - board.length;
  const need = rivals * 2 + boardNeeded;
  if (need > pool.length) return 0.5;

  let score = 0;
  for (let sim = 0; sim < sims; sim++) {
    // Teilweises Fisher-Yates: Die ersten `need` Plätze reichen als Ziehung.
    for (let i = 0; i < need; i++) {
      const j = i + rng.int(pool.length - i);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const fullBoard = board.concat(pool.slice(0, boardNeeded));
    const mine = Hand.solve(hole.concat(fullBoard));

    let best = mine;
    let tied = 1;
    let beaten = false;
    for (let r = 0; r < rivals; r++) {
      const offset = boardNeeded + r * 2;
      const theirs = Hand.solve([pool[offset], pool[offset + 1]].concat(fullBoard));
      const winners = Hand.winners([best, theirs]);
      if (winners.length === 2) {
        if (best === mine) tied += 1;
        continue;
      }
      if (winners[0] === theirs) {
        best = theirs;
        beaten = true;
        break;
      }
    }
    if (!beaten) score += 1 / tied;
  }
  return score / sims;
}

/**
 * Entscheidet einen Zug.
 * @returns {{move: string, amount?: number}}
 */
export function decideHoldem({ engine, player, difficulty, options, rng }) {
  if (!options) return { move: 'fold' };
  const profile = PROFILES[difficulty] ?? PROFILES.medium;

  const opponents = engine.players.filter((other) => !other.folded && other !== player).length;
  if (opponents === 0) return options.canCheck ? { move: 'check' } : { move: 'fold' };

  const equity = estimateEquity({
    hole: player.cards.map((card) => card.code),
    board: engine.board.map((card) => card.code),
    opponents,
    sims: profile.sims,
    rng,
  });

  const pot = options.pot;
  const toCall = options.callAmount;
  // Wie viel Gewinnchance die Hand mindestens braucht, damit Mitgehen lohnt.
  const required = toCall > 0 ? toCall / (pot + toCall) : 0;
  const position = positionScore(engine, player) * profile.position;
  const jitter = (rng.float() - 0.5) * profile.noise;
  const edge = equity - required + position + jitter;

  // ------------------------------------------------ Niemand hat gesetzt
  if (toCall === 0) {
    const wantsValue = edge > profile.raiseEdge;
    const bluffs = options.canRaise && equity < 0.35 && rng.chance(profile.bluff);
    if (options.canRaise && (wantsValue || bluffs)) {
      return raiseTo(options, sizeBet({ engine, options, profile, equity, rng }));
    }
    return { move: 'check' };
  }

  // ------------------------------------------------ Es steht ein Einsatz
  const raising = options.canRaise && edge > profile.raiseEdge && equity > 0.5;
  if (raising) {
    return raiseTo(options, sizeBet({ engine, options, profile, equity, rng }));
  }

  // Blufferhöhung mit schwacher Hand – nur mit Bluffanteil und nicht bei jedem Preis.
  if (
    options.canRaise &&
    equity < 0.3 &&
    toCall <= pot * 0.35 &&
    rng.chance(profile.bluff * 0.5)
  ) {
    return raiseTo(options, sizeBet({ engine, options, profile, equity: 0.6, rng }));
  }

  if (edge + profile.callSlack >= 0) return { move: 'call' };

  // Wenn der Call fast nichts kostet, lieber schauen als wegwerfen.
  if (toCall <= options.bigBlind && equity > 0.2 && rng.chance(0.6)) return { move: 'call' };
  return { move: 'fold' };
}

/** 0 = handelt als Erster, 1 = handelt als Letzter. */
function positionScore(engine, player) {
  const active = engine.players.filter((other) => !other.folded && !other.allIn);
  if (active.length < 2) return 0;
  const after = active.filter((other) => other !== player && !other.acted).length;
  return 1 - after / Math.max(1, active.length - 1);
}

/** Einsatzhöhe als Anteil vom Pot, mit etwas Streuung. */
function sizeBet({ engine, options, profile, equity, rng }) {
  const pot = Math.max(options.bigBlind, options.pot);
  const fraction = profile.sizing * (0.75 + rng.float() * 0.5);
  let target = options.currentBet + Math.round(pot * fraction);
  // Sehr starke Hände dürfen auch mal alles setzen.
  if (equity > 0.85 && rng.chance(profile.bluff + 0.15)) target = options.maxRaiseTo;
  return target;
}

/** Klemmt einen Wunschbetrag in die erlaubten Grenzen. */
function raiseTo(options, target) {
  const amount = Math.max(options.minRaiseTo, Math.min(options.maxRaiseTo, Math.round(target)));
  if (amount >= options.maxRaiseTo) return { move: 'allin' };
  return { move: 'raise', amount };
}

export { PROFILES };
