/**
 * Spielmodul: Baccarat (Punto Banco).
 *
 * Gemeinsames Setzen an einem Tisch, gemeinsamer Schuh, keine Entscheidungen –
 * deshalb kein Zug-Timer, sondern nur ein Setzfenster.
 */

import { BaccaratEngine } from './engine.js';

export default {
  id: 'baccarat',
  name: 'Baccarat',
  tagline: 'Punto Banco – Player, Banker oder Tie, 5 % Kommission',
  icon: '♣',
  minPlayers: 1,
  maxPlayers: 8,
  supportsBots: true,

  defaultConfig: {
    decks: 8,
    minBet: 1000,
    maxBet: 50_000,
    betMs: 20_000,
  },

  configFields: [
    { key: 'minBet', label: 'Mindesteinsatz', type: 'int', min: 100, max: 20_000, step: 100, suffix: 'Chips' },
    { key: 'maxBet', label: 'Höchsteinsatz', type: 'int', min: 1000, max: 500_000, step: 1000, suffix: 'Chips' },
    { key: 'decks', label: 'Decks im Schuh', type: 'int', min: 4, max: 8, step: 1 },
    {
      key: 'betMs',
      label: 'Zeit zum Setzen',
      type: 'int',
      min: 8000,
      max: 60_000,
      step: 1000,
      display: 'seconds',
    },
  ],

  normalizeConfig(config) {
    const minBet = Math.max(1, Math.floor(config.minBet));
    const maxBet = Math.max(minBet, Math.floor(config.maxBet));
    return { ...config, minBet, maxBet };
  },

  describeStakes: (config) => `${config.minBet}–${config.maxBet}`,

  createEngine: (ctx) => new BaccaratEngine(ctx),
};
