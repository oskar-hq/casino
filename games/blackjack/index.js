/**
 * Spielmodul: Blackjack.
 *
 * Alle sitzen am selben Tisch und spielen ihre eigene Hand gegen den Dealer.
 * Der Dealer ist das Haus – er hat kein Guthaben auf dem Floor.
 */

import { BlackjackEngine } from './engine.js';

export default {
  id: 'blackjack',
  name: 'Blackjack',
  tagline: '6-Deck-Schuh, Dealer steht auf Soft 17, Blackjack zahlt 3:2',
  icon: '♦',
  minPlayers: 1,
  maxPlayers: 7,
  supportsBots: true,

  defaultConfig: {
    decks: 6,
    minBet: 500,
    maxBet: 25_000,
    betMs: 15_000,
    turnMs: 30_000,
  },

  configFields: [
    { key: 'minBet', label: 'Mindesteinsatz', type: 'int', min: 50, max: 10_000, step: 50, suffix: 'Chips' },
    { key: 'maxBet', label: 'Höchsteinsatz', type: 'int', min: 500, max: 250_000, step: 500, suffix: 'Chips' },
    { key: 'decks', label: 'Decks im Schuh', type: 'int', min: 1, max: 8, step: 1 },
    {
      key: 'betMs',
      label: 'Zeit zum Setzen',
      type: 'int',
      min: 5000,
      max: 60_000,
      step: 1000,
      display: 'seconds',
    },
    {
      key: 'turnMs',
      label: 'Bedenkzeit',
      type: 'int',
      min: 10_000,
      max: 60_000,
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

  createEngine: (ctx) => new BlackjackEngine(ctx),
};
