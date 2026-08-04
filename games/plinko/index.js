/**
 * Spielmodul: Plinko.
 *
 * Ein Gerät, an dem mehrere Leute nebeneinander stehen können – jeder lässt
 * seine eigenen Kugeln fallen, unabhängig von den anderen. Keine Bots: Es
 * gibt nichts zu entscheiden, ein Bot wäre nur ein Zufallsgenerator mit Namen.
 */

import { PAYTABLES, RISKS, RISK_LABELS, ROWS, normalizeRisk, returnToPlayer } from './paytable.js';
import { PlinkoEngine } from './engine.js';

export default {
  id: 'plinko',
  name: 'Plinko',
  tagline: `Kugel fällt durch ${ROWS} Nagelreihen, drei Risikostufen`,
  icon: '🔻',
  minPlayers: 1,
  maxPlayers: 5,
  supportsBots: false,
  /** Kein Spieltisch, sondern ein Gerät – siehe `.felt[data-layout]`. */
  layout: 'machine',

  defaultConfig: {
    minBet: 500,
    maxBet: 25_000,
    risk: 'medium',
    dropMs: 2400,
  },

  configFields: [
    { key: 'minBet', label: 'Mindesteinsatz', type: 'int', min: 50, max: 10_000, step: 50, suffix: 'Chips' },
    { key: 'maxBet', label: 'Höchsteinsatz', type: 'int', min: 500, max: 250_000, step: 500, suffix: 'Chips' },
    {
      key: 'risk',
      label: 'Voreingestelltes Risiko',
      type: 'select',
      options: RISKS.map((risk) => ({ value: risk, label: RISK_LABELS[risk] })),
    },
  ],

  normalizeConfig(config) {
    const minBet = Math.max(1, Math.floor(config.minBet));
    const maxBet = Math.max(minBet, Math.floor(config.maxBet));
    return { ...config, minBet, maxBet, risk: normalizeRisk(config.risk) };
  },

  describeStakes: (config) => `${config.minBet}–${config.maxBet}`,

  info: {
    rows: ROWS,
    paytables: PAYTABLES,
    rtp: Object.fromEntries(RISKS.map((risk) => [risk, returnToPlayer(risk)])),
  },

  createEngine: (ctx) => new PlinkoEngine(ctx),
};
