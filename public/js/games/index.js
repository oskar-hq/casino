/**
 * Registrierung der Spiel-Sichtmodule – das Gegenstück zu `games/index.js`
 * auf dem Server und der einzige Ort im Frontend, den ein neues Spiel anfasst.
 *
 * Ein Sichtmodul kann liefern (alles optional):
 *   renderCenter(ctx)     → was auf dem Filz liegt
 *   seatDecor(seat, ctx)  → { cards, bet, status, badge, className } pro Platz
 *   renderHand(ctx)       → die eigenen Karten unten
 *   renderActions(ctx)    → die Knöpfe unten
 *   renderSidePanel(ctx)  → Panel am Rand (z. B. die Handrangfolge)
 *   info(ctx)             → Inhalt des Spielinfo-Dialogs
 *   onEvent(event, ctx)   → Animationen und Einblendungen
 */

import baccarat from './baccarat.js';
import blackjack from './blackjack.js';
import holdem from './holdem.js';
import roulette from './roulette.js';
import slots from './slots.js';

const VIEWS = new Map([holdem, blackjack, slots, roulette, baccarat].map((view) => [view.id, view]));

/** Fällt auf ein leeres Modul zurück, falls der Server ein unbekanntes Spiel meldet. */
const FALLBACK = { id: 'unknown' };

export function getView(gameId) {
  return VIEWS.get(gameId) ?? FALLBACK;
}
