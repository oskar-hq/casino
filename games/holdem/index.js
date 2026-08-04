/**
 * Spielmodul: Texas Hold'em, No-Limit.
 *
 * Beschreibt sich selbst für den Floor (Name, Plätze, Einstellungen) und
 * liefert die Engine. Der Tisch kennt sonst nichts von Poker.
 */

import { HoldemEngine } from './engine.js';

/** Die Handrangfolge – als Panel neben dem Tisch. */
export const HAND_RANKINGS = [
  { name: 'Royal Flush', example: 'A♠ K♠ D♠ B♠ 10♠', note: 'Straight Flush bis zum Ass' },
  { name: 'Straight Flush', example: '9♥ 8♥ 7♥ 6♥ 5♥', note: 'Fünf in Folge, eine Farbe' },
  { name: 'Vierling', example: '7♠ 7♥ 7♦ 7♣ K♠', note: 'Vier gleiche Werte' },
  { name: 'Full House', example: 'D♠ D♥ D♦ 4♣ 4♠', note: 'Drilling + Paar' },
  { name: 'Flush', example: 'K♦ 10♦ 8♦ 5♦ 3♦', note: 'Fünf gleiche Farbe' },
  { name: 'Straße', example: '9♠ 8♦ 7♥ 6♣ 5♠', note: 'Fünf in Folge' },
  { name: 'Drilling', example: '5♠ 5♥ 5♦ K♣ 2♠', note: 'Drei gleiche Werte' },
  { name: 'Zwei Paare', example: 'B♠ B♥ 6♦ 6♣ A♠', note: 'Zwei mal zwei gleiche' },
  { name: 'Ein Paar', example: 'A♠ A♥ 9♦ 5♣ 3♠', note: 'Zwei gleiche Werte' },
  { name: 'Höchste Karte', example: 'A♠ D♦ 9♥ 6♣ 3♠', note: 'Sonst zählt die höchste Karte' },
];

export default {
  id: 'holdem',
  name: "Texas Hold'em",
  tagline: 'No-Limit, feste Blinds, bis 9 Spieler',
  icon: '♠',
  minPlayers: 2,
  maxPlayers: 9,
  supportsBots: true,

  defaultConfig: {
    smallBlind: 500,
    bigBlind: 1000,
    turnMs: 30_000,
  },

  configFields: [
    { key: 'smallBlind', label: 'Small Blind', type: 'int', min: 25, max: 25000, step: 25, suffix: 'Chips' },
    { key: 'bigBlind', label: 'Big Blind', type: 'int', min: 50, max: 50000, step: 50, suffix: 'Chips' },
    {
      key: 'turnMs',
      label: 'Bedenkzeit',
      type: 'int',
      min: 10_000,
      max: 120_000,
      step: 5000,
      suffix: 'ms',
      display: 'seconds',
    },
  ],

  /** Big Blind muss über dem Small Blind liegen – sonst ergeben Raises keinen Sinn. */
  normalizeConfig(config) {
    const smallBlind = Math.max(1, Math.floor(config.smallBlind));
    const bigBlind = Math.max(smallBlind + 1, Math.floor(config.bigBlind));
    return { ...config, smallBlind, bigBlind };
  },

  stakesLabel: 'Blinds',
  describeStakes: (config) => `${config.smallBlind}/${config.bigBlind}`,

  /** Zusatzinfos fürs Frontend (Cheat-Sheet am Rand des Tisches). */
  info: { handRankings: HAND_RANKINGS },

  createEngine: (ctx) => new HoldemEngine(ctx),
};
