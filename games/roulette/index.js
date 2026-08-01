/**
 * Spielmodul: Roulette (europäisch, eine Null).
 *
 * Alle setzen gemeinsam an einem Tisch – deshalb gibt es hier viele Plätze
 * und keine Reihum-Bedenkzeit, sondern ein Setzfenster mit Countdown.
 */

import { BET_TYPES, WHEEL_ORDER } from './bets.js';
import { RouletteEngine } from './engine.js';

export default {
  id: 'roulette',
  name: 'Roulette',
  tagline: 'Europäisch mit einer Null, gemeinsames Tableau',
  icon: '🎡',
  minPlayers: 1,
  maxPlayers: 8,
  supportsBots: true,

  defaultConfig: {
    minBet: 5,
    maxBet: 500,
    betMs: 25_000,
  },

  configFields: [
    { key: 'minBet', label: 'Mindesteinsatz', type: 'int', min: 1, max: 100, step: 1, suffix: 'Chips' },
    { key: 'maxBet', label: 'Höchsteinsatz', type: 'int', min: 10, max: 5000, step: 10, suffix: 'Chips' },
    {
      key: 'betMs',
      label: 'Zeit zum Setzen',
      type: 'int',
      min: 10_000,
      max: 90_000,
      step: 5000,
      display: 'seconds',
    },
  ],

  normalizeConfig(config) {
    const minBet = Math.max(1, Math.floor(config.minBet));
    const maxBet = Math.max(minBet, Math.floor(config.maxBet));
    return { ...config, minBet, maxBet };
  },

  describeStakes: (config) => `${config.minBet}–${config.maxBet}`,

  info: {
    wheel: WHEEL_ORDER,
    payouts: Object.fromEntries(
      Object.entries(BET_TYPES).map(([key, value]) => [key, { label: value.label, payout: value.payout }]),
    ),
  },

  createEngine: (ctx) => new RouletteEngine(ctx),
};
