/**
 * Plinko – die Kugel fällt durch ein Nagelfeld in ein Fach mit Multiplikator.
 *
 * Der Server würfelt den kompletten Weg aus, sobald jemand fallen lässt: an
 * jedem Nagel eine faire Münze, links oder rechts. Aus der Summe der
 * Rechts-Ablenkungen ergibt sich das Fach. Der Client bekommt diesen Weg
 * mitgeschickt und animiert ihn Nagel für Nagel nach – die Kugel landet auf
 * dem Bildschirm also wirklich dort, wo abgerechnet wird.
 *
 * Dass der Client das Fach vorab kennt, ist unbedenklich: Der Einsatz ist in
 * dem Moment längst abgebucht und lässt sich nicht mehr ändern.
 *
 * Mehrere Leute können gleichzeitig fallen lassen – jede Kugel läuft für sich.
 */

import { GameEngine, GameError } from '../../core/engine.js';
import { ROWS, multipliersFor, normalizeRisk, payoutFor } from './paytable.js';

/** Wie lange eine Kugel fällt (ms). */
export const DROP_MS = 2400;
/** Wie viele abgeschlossene Würfe in der Anzeige stehen bleiben. */
const HISTORY_LENGTH = 15;
/** Obergrenze gleichzeitig fallender Kugeln pro Spieler. */
const MAX_ACTIVE_PER_PLAYER = 3;

export class PlinkoEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    /** @type {Array<object>} Kugeln, die gerade fallen. */
    this.drops = [];
    /** @type {Array<object>} Die letzten Ergebnisse. */
    this.history = [];
    this.dropCounter = 0;
    this.totalWagered = 0;
    this.totalWon = 0;
  }

  get rows() {
    return ROWS;
  }

  get dropMs() {
    return this.config.dropMs ?? DROP_MS;
  }

  /** Kein Reihum – wer sitzt, lässt selbst fallen. */
  get actorId() {
    return null;
  }

  act(playerId, action) {
    if (action?.move !== 'drop') {
      throw new GameError('bad_action', 'Hier kann man nur eine Kugel fallen lassen.');
    }
    const seat = this.ctx.seats().find((entry) => entry.playerId === playerId);
    if (!seat) throw new GameError('not_seated', 'Setz dich erst an das Gerät.');

    const aktive = this.drops.filter((drop) => drop.playerId === playerId).length;
    if (aktive >= MAX_ACTIVE_PER_PLAYER) {
      throw new GameError('too_many_drops', 'Lass erst deine Kugeln ankommen.');
    }

    const gewünscht = Math.floor(Number(action.amount));
    if (!Number.isFinite(gewünscht)) throw new GameError('bad_amount', 'Ungültiger Einsatz.');
    const bet = Math.max(this.config.minBet, Math.min(this.config.maxBet, gewünscht));
    if (this.ctx.wallet.balance(playerId) < bet) {
      throw new GameError('insufficient', 'Dafür reicht dein Guthaben nicht.');
    }

    const risk = normalizeRisk(action.risk ?? this.config.risk);

    // Einsatz sofort abbuchen und den Weg auswürfeln.
    this.ctx.wallet.debit(playerId, bet, 'plinko:bet');
    const path = this.rollPath();
    const slot = path.reduce((sum, schritt) => sum + schritt, 0);
    const payout = payoutFor(risk, slot, bet);

    this.dropCounter += 1;
    this.totalWagered += bet;

    const drop = {
      id: `d${this.dropCounter}`,
      playerId,
      name: seat.name,
      seat: seat.index,
      bet,
      risk,
      path,
      slot,
      payout,
      startedAt: Date.now(),
    };
    this.drops.push(drop);
    this.ctx.emit({ kind: 'drop', drop: publicDrop(drop), duration: this.dropMs });

    this.ctx.later(() => {
      this.landDrop(drop.id);
      this.ctx.sync();
    }, this.dropMs);
    return drop;
  }

  /**
   * Der Weg der Kugel: pro Nagelreihe eine faire Münze.
   * 0 = nach links, 1 = nach rechts.
   */
  rollPath() {
    return Array.from({ length: this.rows }, () => this.ctx.rng.int(2));
  }

  /** Die Kugel ist unten angekommen – jetzt wird abgerechnet. */
  landDrop(dropId) {
    const index = this.drops.findIndex((drop) => drop.id === dropId);
    if (index === -1) return;
    const [drop] = this.drops.splice(index, 1);

    if (drop.payout > 0) {
      this.ctx.wallet.credit(drop.playerId, drop.payout, 'plinko:win');
      this.totalWon += drop.payout;
    }
    const ergebnis = {
      id: drop.id,
      playerId: drop.playerId,
      name: drop.name,
      seat: drop.seat,
      bet: drop.bet,
      risk: drop.risk,
      slot: drop.slot,
      payout: drop.payout,
      net: drop.payout - drop.bet,
      multiplier: multipliersFor(drop.risk)[drop.slot],
    };
    this.history.unshift(ergebnis);
    this.history = this.history.slice(0, HISTORY_LENGTH);
    this.ctx.emit({ kind: 'landed', result: ergebnis });
  }

  publicState() {
    return {
      rows: this.rows,
      dropMs: this.dropMs,
      minBet: this.config.minBet,
      maxBet: this.config.maxBet,
      defaultRisk: normalizeRisk(this.config.risk),
      multipliers: Object.fromEntries(
        ['low', 'medium', 'high'].map((risk) => [risk, multipliersFor(risk)]),
      ),
      // Die fallenden Kugeln inklusive Weg – der Client animiert sie damit.
      drops: this.drops.map(publicDrop),
      history: this.history,
      stats: { drops: this.dropCounter, wagered: this.totalWagered, won: this.totalWon },
    };
  }

  privateState(playerId) {
    return {
      balance: this.ctx.wallet.balance(playerId),
      active: this.drops.filter((drop) => drop.playerId === playerId).length,
      maxActive: MAX_ACTIVE_PER_PLAYER,
    };
  }

  dispose() {
    // Laufende Kugeln noch abrechnen – der Einsatz ist schon weg.
    for (const drop of [...this.drops]) this.landDrop(drop.id);
    this.drops = [];
  }
}

/** Was von einer fallenden Kugel nach außen geht. */
function publicDrop(drop) {
  return {
    id: drop.id,
    playerId: drop.playerId,
    name: drop.name,
    seat: drop.seat,
    bet: drop.bet,
    risk: drop.risk,
    path: drop.path,
    slot: drop.slot,
    startedAt: drop.startedAt,
  };
}
