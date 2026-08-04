/**
 * Spielmodul: Slots.
 *
 * Ein Automat für eine Person – deshalb `solo: true` und keine Bots. Der Floor
 * sorgt dafür, dass sich niemand an einen besetzten Automaten setzt.
 */

import { PAYTABLE, REEL, SYMBOLS, SlotsEngine } from './engine.js';

export default {
  id: 'slots',
  name: 'Slots',
  tagline: 'Drei Walzen, feste Auszahlungstabelle, fairer Zufall',
  icon: '🎰',
  minPlayers: 1,
  maxPlayers: 1,
  supportsBots: false,
  solo: true,

  defaultConfig: {
    minBet: 500,
    maxBet: 10_000,
    spinMs: 1400,
  },

  configFields: [
    { key: 'minBet', label: 'Mindesteinsatz', type: 'int', min: 50, max: 5000, step: 50, suffix: 'Chips' },
    { key: 'maxBet', label: 'Höchsteinsatz', type: 'int', min: 500, max: 100_000, step: 500, suffix: 'Chips' },
  ],

  normalizeConfig(config) {
    const minBet = Math.max(1, Math.floor(config.minBet));
    const maxBet = Math.max(minBet, Math.floor(config.maxBet));
    return { ...config, minBet, maxBet };
  },

  describeStakes: (config) => `${config.minBet}–${config.maxBet}`,

  info: { paytable: PAYTABLE, symbols: SYMBOLS, reelLength: REEL.length },

  createEngine: (ctx) => new SlotsEngine(ctx),
};
