/**
 * Roulette (europäisch, eine Null).
 *
 * Alle setzen gemeinsam auf dasselbe Tableau. Ein Countdown läuft, dann dreht
 * sich das Rad und alle Wetten werden nach den Standardquoten abgerechnet.
 *
 * Die Zahl wird gezogen, sobald das Setzfenster schließt – die Raddrehung im
 * Browser zeigt nur noch, was schon feststeht. So kann kein Client durch
 * spätes Setzen etwas beeinflussen.
 */

import { GameEngine, GameError } from '../../core/engine.js';
import { WHEEL_ORDER, betPayout, betWins, colorOf, parseBet } from './bets.js';
import { chooseBotBets } from './bot.js';

export const SPIN_MS = 5200;
export const RESULT_MS = 6000;

/** Wie viele einzelne Wetten ein Spieler pro Runde höchstens platzieren darf. */
const MAX_BETS_PER_PLAYER = 40;

export class RouletteEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    this.phase = 'idle'; // idle | betting | spinning | result
    this.roundNumber = 0;
    /** @type {Map<string, Array>} playerId → Wetten dieser Runde */
    this.bets = new Map();
    this.currentDeadline = null;
    this.winningNumber = null;
    this.result = null;
    this.history = [];
  }

  get timings() {
    return {
      bet: this.config.betMs ?? 25_000,
      spin: this.config.spinMs ?? SPIN_MS,
      result: this.config.resultMs ?? RESULT_MS,
    };
  }

  /** Beim Roulette ist niemand einzeln am Zug – alle setzen gleichzeitig. */
  get actorId() {
    return null;
  }

  get deadline() {
    return this.phase === 'betting' ? this.currentDeadline : null;
  }

  // ------------------------------------------------------------ Rundenlauf

  tick() {
    if (this.phase === 'idle') {
      if (!this.ctx.hasAudience()) return;
      if (!this.ctx.seats().length) return;
      this.openBetting();
    }
    if (this.phase === 'betting') this.placeBotBets();
  }

  openBetting() {
    this.phase = 'betting';
    this.roundNumber += 1;
    this.bets = new Map();
    this.result = null;
    this.winningNumber = null;
    this.currentDeadline = Date.now() + this.timings.bet;
    this.ctx.emit({ kind: 'betting_open', until: this.currentDeadline });
    this.ctx.later(() => {
      this.spin();
      this.ctx.sync();
    }, this.timings.bet);
  }

  placeBotBets() {
    for (const seat of this.ctx.seats()) {
      if (!seat.isBot || this.bets.has(seat.playerId)) continue;
      const wanted = chooseBotBets({
        balance: seat.chips,
        minBet: this.config.minBet,
        maxBet: this.config.maxBet,
        difficulty: seat.difficulty,
        rng: this.ctx.rng,
      });
      for (const { type, arg, amount } of wanted) {
        try {
          this.placeBet(seat.playerId, type, arg, amount);
        } catch {
          /* Reicht das Guthaben nicht, lässt der Bot es eben. */
        }
      }
      // Auch ohne gültige Wette den Eintrag anlegen, damit nicht endlos
      // neu versucht wird.
      if (!this.bets.has(seat.playerId)) this.bets.set(seat.playerId, []);
    }
  }

  /** Chips aufs Tableau legen. Der Einsatz wird sofort abgebucht. */
  placeBet(playerId, type, arg, amount) {
    if (this.phase !== 'betting') {
      throw new GameError('not_betting', 'Das Setzfenster ist zu – rien ne va plus.');
    }
    const seat = this.ctx.seats().find((entry) => entry.playerId === playerId);
    if (!seat) throw new GameError('not_seated', 'Setz dich erst an den Tisch.');

    const bet = parseBet(type, arg);
    if (!bet) throw new GameError('bad_bet', 'Diese Wette gibt es beim Roulette nicht.');

    const wanted = Math.floor(Number(amount));
    if (!Number.isFinite(wanted) || wanted <= 0) {
      throw new GameError('bad_amount', 'Ungültiger Einsatz.');
    }
    const value = Math.max(this.config.minBet, Math.min(this.config.maxBet, wanted));
    if (this.ctx.wallet.balance(playerId) < value) {
      throw new GameError('insufficient', 'Dafür reicht dein Guthaben nicht.');
    }

    const list = this.bets.get(playerId) ?? [];
    if (list.length >= MAX_BETS_PER_PLAYER) {
      throw new GameError('too_many_bets', 'So viele Wetten gehen nicht auf einmal.');
    }

    this.ctx.wallet.debit(playerId, value, 'roulette:bet');
    // Gleiche Wette noch einmal? Dann einfach aufstocken.
    const existing = list.find((entry) => entry.type === type && sameArg(entry.arg, bet.arg));
    if (existing) existing.amount += value;
    else list.push({ ...bet, amount: value });
    this.bets.set(playerId, list);
    return value;
  }

  /** Die zuletzt gelegte Wette zurücknehmen. */
  undoBet(playerId) {
    if (this.phase !== 'betting') {
      throw new GameError('not_betting', 'Jetzt geht nichts mehr zurück.');
    }
    const list = this.bets.get(playerId);
    if (!list?.length) throw new GameError('no_bets', 'Du hast nichts liegen.');
    const removed = list.pop();
    this.ctx.wallet.credit(playerId, removed.amount, 'roulette:undo');
    return removed;
  }

  /** Alle eigenen Wetten zurücknehmen. */
  clearBets(playerId) {
    if (this.phase !== 'betting') {
      throw new GameError('not_betting', 'Jetzt geht nichts mehr zurück.');
    }
    const list = this.bets.get(playerId) ?? [];
    let total = 0;
    for (const bet of list) total += bet.amount;
    if (total) this.ctx.wallet.credit(playerId, total, 'roulette:clear');
    this.bets.set(playerId, []);
    return total;
  }

  act(playerId, action) {
    switch (action?.move) {
      case 'bet':
        this.placeBet(playerId, action.betType, action.arg, action.amount);
        return;
      case 'undo':
        this.undoBet(playerId);
        return;
      case 'clear':
        this.clearBets(playerId);
        return;
      default:
        throw new GameError('bad_action', 'Diesen Zug gibt es beim Roulette nicht.');
    }
  }

  // ------------------------------------------------------------------ Rad

  spin() {
    if (this.phase !== 'betting') return;
    this.phase = 'spinning';
    this.currentDeadline = null;

    // Die Zahl steht jetzt fest – die Animation zeigt sie nur noch.
    this.winningNumber = this.ctx.rng.int(37);
    this.ctx.emit({
      kind: 'spin',
      duration: this.timings.spin,
      number: this.winningNumber,
      pocket: WHEEL_ORDER.indexOf(this.winningNumber),
    });

    this.ctx.later(() => {
      this.settle();
      this.ctx.sync();
    }, this.timings.spin);
  }

  settle() {
    const number = this.winningNumber;
    const entries = [];

    for (const [playerId, list] of this.bets) {
      let staked = 0;
      let won = 0;
      const details = [];
      for (const bet of list) {
        const payout = betPayout(bet, bet.amount, number);
        staked += bet.amount;
        won += payout;
        details.push({
          label: bet.label,
          amount: bet.amount,
          payout,
          hit: betWins(bet, number),
        });
      }
      if (won > 0) this.ctx.wallet.credit(playerId, won, 'roulette:win');
      if (staked > 0 || won > 0) {
        entries.push({ playerId, staked, won, net: won - staked, bets: details });
      }
    }

    this.result = { number, color: colorOf(number), entries };
    this.history.unshift({ number, color: colorOf(number) });
    this.history = this.history.slice(0, 12);
    this.phase = 'result';
    this.ctx.emit({ kind: 'result', result: this.result });

    this.ctx.later(() => {
      this.phase = 'idle';
      this.ctx.sync();
    }, this.timings.result);
  }

  // ---------------------------------------------------------------- Ansicht

  publicState() {
    // Die Einsätze sind öffentlich – am echten Tisch liegen sie ja auch offen.
    const stakes = [];
    for (const [playerId, list] of this.bets) {
      const total = list.reduce((sum, bet) => sum + bet.amount, 0);
      if (total > 0) stakes.push({ playerId, total, count: list.length });
    }

    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      minBet: this.config.minBet,
      maxBet: this.config.maxBet,
      // Erst nach dem Dreh bekannt geben – vorher wäre es ein Blick ins Rad.
      number: this.phase === 'result' ? this.winningNumber : null,
      result: this.result,
      history: this.history,
      stakes,
      wheel: WHEEL_ORDER,
    };
  }

  privateState(playerId) {
    const list = this.bets.get(playerId) ?? [];
    return {
      balance: this.ctx.wallet.balance(playerId),
      canBet: this.phase === 'betting',
      total: list.reduce((sum, bet) => sum + bet.amount, 0),
      bets: list.map((bet) => ({
        type: bet.type,
        arg: bet.arg,
        label: bet.label,
        amount: bet.amount,
        numbers: bet.numbers,
        payout: bet.payout,
      })),
    };
  }

  seatsChanged() {
    // Wer den Tisch verlässt, bekommt seine noch nicht gedrehten Chips zurück.
    if (this.phase !== 'betting') return;
    const present = new Set(this.ctx.seats().map((seat) => seat.playerId));
    for (const playerId of [...this.bets.keys()]) {
      if (present.has(playerId)) continue;
      this.clearBets(playerId);
      this.bets.delete(playerId);
    }
  }

  dispose() {
    // Nur solange noch nicht gedreht wurde – danach ist abgerechnet.
    if (this.phase === 'betting') {
      for (const [playerId, list] of this.bets) {
        const total = list.reduce((sum, bet) => sum + bet.amount, 0);
        if (total) this.ctx.wallet.credit(playerId, total, 'roulette:refund');
      }
    }
    this.bets = new Map();
    this.phase = 'idle';
    this.result = null;
  }
}

function sameArg(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return String(a) === String(b);
  return a === b;
}
