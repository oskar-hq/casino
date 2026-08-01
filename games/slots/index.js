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
    minBet: 5,
    maxBet: 100,
    spinMs: 1400,
  },

  configFields: [
    { key: 'minBet', label: 'Mindesteinsatz', type: 'int', min: 1, max: 100, step: 1, suffix: 'Chips' },
    { key: 'maxBet', label: 'Höchsteinsatz', type: 'int', min: 5, max: 1000, step: 5, suffix: 'Chips' },
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
