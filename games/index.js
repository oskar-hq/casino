/**
 * Die Registrierung aller Spielmodule – der **einzige** Ort, den ein neues
 * Spiel anfassen muss.
 *
 * Ein Modul hinzufügen heißt: Ordner unter `games/` anlegen, Modul-Objekt
 * exportieren, hier in `MODULES` eintragen. Weder der Floor noch ein anderes
 * Spiel ändert sich dadurch.
 *
 * Ein Modul sieht so aus:
 * {
 *   id, name, tagline, icon,
 *   minPlayers, maxPlayers, supportsBots, solo?,
 *   defaultConfig: {…},
 *   configFields: [{ key, label, type, min, max, step, options, suffix }],
 *   describeStakes?(config) → string,
 *   createEngine(ctx) → GameEngine
 * }
 */

import { moduleDefaults } from '../server/config.js';

import baccarat from './baccarat/index.js';
import blackjack from './blackjack/index.js';
import holdem from './holdem/index.js';
import plinko from './plinko/index.js';
import roulette from './roulette/index.js';
import slots from './slots/index.js';

/** Reihenfolge = Reihenfolge auf dem Floor. */
const MODULES = [holdem, blackjack, slots, plinko, roulette, baccarat];

/** Vorgaben aus dem Modul, überschrieben von den Env-Variablen. */
const withEnvDefaults = (module) => ({
  ...module,
  defaultConfig: { ...module.defaultConfig, ...moduleDefaults(module.id) },
});

const REGISTRY = new Map(MODULES.map((module) => [module.id, withEnvDefaults(module)]));

export function listModules() {
  return [...REGISTRY.values()];
}

export function getModule(id) {
  return REGISTRY.get(String(id ?? '')) ?? null;
}

/**
 * Prüft und normalisiert die Tischeinstellungen. Alles, was der Client
 * schickt, läuft hier durch – unbekannte Schlüssel fliegen raus, Zahlen
 * werden in ihre erlaubten Grenzen gezwungen.
 */
export function validateConfig(module, raw = {}) {
  const config = { ...module.defaultConfig };
  for (const field of module.configFields ?? []) {
    if (!(field.key in raw)) continue;
    const value = raw[field.key];
    if (field.type === 'int') {
      const parsed = Math.round(Number(value));
      if (!Number.isFinite(parsed)) continue;
      const step = field.step ?? 1;
      const min = field.min ?? 0;
      const max = field.max ?? Number.MAX_SAFE_INTEGER;
      const snapped = min + Math.round((parsed - min) / step) * step;
      config[field.key] = Math.max(min, Math.min(max, snapped));
    } else if (field.type === 'bool') {
      config[field.key] = Boolean(value);
    } else if (field.type === 'select') {
      const allowed = (field.options ?? []).map((option) => option.value);
      if (allowed.includes(value)) config[field.key] = value;
    }
  }
  // Nachbedingungen des Moduls (z. B. Big Blind > Small Blind).
  return module.normalizeConfig ? module.normalizeConfig(config) : config;
}
