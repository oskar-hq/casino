/**
 * Baccarat (Punto Banco).
 *
 * Alle setzen an einem Tisch auf Player, Banker oder Tie; gespielt wird aus
 * einem gemeinsamen Schuh. Niemand trifft eine Entscheidung – ob eine dritte
 * Karte kommt, steht vollständig in den Regeln (siehe rules.js).
 *
 * Ablauf: Setzfenster mit Countdown → Karten geben → Ziehregeln anwenden →
 * abrechnen → nächste Runde.
 */

import { GameEngine, GameError } from '../../core/engine.js';
import { Shoe } from '../../core/cards.js';
import { ReadySet } from '../../core/ready.js';
import { chooseBotBet } from './bot.js';
import {
  SIDES,
  bankerDraws,
  cardPoints,
  commissionOn,
  handTotal,
  isNatural,
  outcomeOf,
  payoutFor,
  playerDraws,
} from './rules.js';

export const DEAL_MS = 2600;
export const RESULT_MS = 5000;

export class BaccaratEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    this.shoe = new Shoe({ decks: this.config.decks, rng: ctx.rng, penetration: 0.2 });
    this.phase = 'idle'; // idle | betting | dealing | result
    this.roundNumber = 0;
    /** @type {Map<string, {side: string, amount: number}>} eine Wette pro Spieler */
    this.bets = new Map();
    this.player = [];
    this.banker = [];
    this.currentDeadline = null;
    this.result = null;
    this.history = [];
    /** Wer ist mit dem Setzen fertig? Sind alle so weit, wird sofort gegeben. */
    this.readySet = new ReadySet(() => this.ctx.seats());
  }

  get timings() {
    return {
      bet: this.config.betMs ?? 20_000,
      deal: this.config.dealMs ?? DEAL_MS,
      result: this.config.resultMs ?? RESULT_MS,
    };
  }

  /** Auch hier ist niemand einzeln am Zug – alle setzen gleichzeitig. */
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
    if (this.phase === 'betting') {
      this.placeBotBets();
      this.maybeDealEarly();
    }
  }

  openBetting() {
    // Zwischen den Runden neu mischen, nie mitten in einer Coup.
    if (this.shoe.reshuffleIfNeeded()) this.ctx.emit({ kind: 'shuffle' });

    this.phase = 'betting';
    this.roundNumber += 1;
    this.bets = new Map();
    this.player = [];
    this.banker = [];
    this.result = null;
    this.readySet.reset();
    this.currentDeadline = Date.now() + this.timings.bet;
    this.ctx.emit({ kind: 'betting_open', until: this.currentDeadline });
    this.ctx.later(() => {
      this.deal();
      this.ctx.sync();
    }, this.timings.bet);
  }

  placeBotBets() {
    for (const seat of this.ctx.seats()) {
      if (!seat.isBot || this.bets.has(seat.playerId)) continue;
      const choice = chooseBotBet({
        balance: seat.chips,
        minBet: this.config.minBet,
        maxBet: this.config.maxBet,
        difficulty: seat.difficulty,
        history: this.history,
        rng: this.ctx.rng,
      });
      if (!choice) continue;
      try {
        this.placeBet(seat.playerId, choice.side, choice.amount);
      } catch {
        /* Reicht das Guthaben nicht, setzt der Bot eben aus. */
      }
    }
  }

  /** Setzen bzw. den eigenen Einsatz ändern. */
  placeBet(playerId, side, amount) {
    if (this.phase !== 'betting') {
      throw new GameError('not_betting', 'Das Setzfenster ist zu.');
    }
    if (!SIDES.includes(side)) {
      throw new GameError('bad_bet', 'Gesetzt wird auf Player, Banker oder Tie.');
    }
    const seat = this.ctx.seats().find((entry) => entry.playerId === playerId);
    if (!seat) throw new GameError('not_seated', 'Setz dich erst an den Tisch.');

    const wanted = Math.floor(Number(amount));
    if (!Number.isFinite(wanted) || wanted < 0) {
      throw new GameError('bad_amount', 'Ungültiger Einsatz.');
    }

    // Einen bestehenden Einsatz zuerst zurückgeben – es gilt immer nur einer.
    const previous = this.bets.get(playerId);
    if (previous) {
      this.ctx.wallet.credit(playerId, previous.amount, 'baccarat:bet-change');
      this.bets.delete(playerId);
    }
    if (wanted === 0) return 0;

    const value = Math.max(this.config.minBet, Math.min(this.config.maxBet, wanted));
    if (this.ctx.wallet.balance(playerId) < value) {
      throw new GameError('insufficient', 'Dafür reicht dein Guthaben nicht.');
    }
    this.ctx.wallet.debit(playerId, value, 'baccarat:bet');
    this.bets.set(playerId, { side, amount: value });
    return value;
  }

  act(playerId, action) {
    if (action?.move === 'bet') {
      this.placeBet(playerId, action.side, action.amount);
      // Wer den Einsatz ändert, ist offensichtlich noch nicht fertig.
      this.readySet.set(playerId, false);
      return;
    }
    if (action?.move === 'clear') {
      this.placeBet(playerId, this.bets.get(playerId)?.side ?? 'player', 0);
      this.readySet.set(playerId, false);
      return;
    }
    if (action?.move === 'ready') {
      this.setReady(playerId, action.value !== false);
      return;
    }
    throw new GameError('bad_action', 'Diesen Zug gibt es beim Baccarat nicht.');
  }

  /** „Ich bin fertig.“ Sind alle so weit, wird sofort gegeben. */
  setReady(playerId, value) {
    if (this.phase !== 'betting') {
      throw new GameError('not_betting', 'Gerade wird nicht gesetzt.');
    }
    if (!this.ctx.seats().some((seat) => seat.playerId === playerId)) {
      throw new GameError('not_seated', 'Setz dich erst an den Tisch.');
    }
    this.readySet.set(playerId, value);
    this.maybeDealEarly();
  }

  /** Gibt vorzeitig, wenn alle bereit sind und wenigstens einer gesetzt hat. */
  maybeDealEarly() {
    if (this.phase !== 'betting') return;
    if (!this.readySet.allReady()) return;
    if (!this.bets.size) return;
    this.deal();
  }

  // -------------------------------------------------------------- Die Coup

  deal() {
    if (this.phase !== 'betting') return;

    // Wer nicht mehr am Tisch sitzt, bekommt seinen Einsatz zurück.
    const seated = new Set(this.ctx.seats().map((seat) => seat.playerId));
    for (const [playerId, bet] of [...this.bets]) {
      if (seated.has(playerId)) continue;
      this.ctx.wallet.credit(playerId, bet.amount, 'baccarat:refund');
      this.bets.delete(playerId);
    }

    if (!this.bets.size) {
      // Ohne Einsätze wird nicht gegeben – gleich das nächste Fenster.
      this.phase = 'idle';
      this.currentDeadline = null;
      return;
    }

    this.phase = 'dealing';
    this.currentDeadline = null;

    // Zwei Karten für Player, zwei für Banker – abwechselnd.
    this.player = [this.shoe.draw()];
    this.banker = [this.shoe.draw()];
    this.player.push(this.shoe.draw());
    this.banker.push(this.shoe.draw());

    const playerTwo = handTotal(this.player);
    const bankerTwo = handTotal(this.banker);
    const natural = isNatural(playerTwo) || isNatural(bankerTwo);

    let playerThird = null;
    if (!natural) {
      if (playerDraws(playerTwo)) {
        const card = this.shoe.draw();
        this.player.push(card);
        playerThird = cardPoints(card);
      }
      if (bankerDraws(bankerTwo, playerThird)) {
        this.banker.push(this.shoe.draw());
      }
    }

    this.ctx.emit({ kind: 'deal', natural });
    // Erst nach der Austeil-Animation abrechnen.
    this.ctx.later(() => {
      this.settle({ natural, playerTwo, bankerTwo });
      this.ctx.sync();
    }, this.timings.deal);
  }

  settle({ natural, playerTwo, bankerTwo }) {
    const playerTotal = handTotal(this.player);
    const bankerTotal = handTotal(this.banker);
    const outcome = outcomeOf(playerTotal, bankerTotal);

    const entries = [];
    let commission = 0;
    for (const [playerId, bet] of this.bets) {
      const payout = payoutFor(bet.side, bet.amount, outcome);
      if (bet.side === 'banker' && outcome === 'banker') commission += commissionOn(bet.amount);
      if (payout > 0) this.ctx.wallet.credit(playerId, payout, `baccarat:${outcome}`);
      entries.push({
        playerId,
        side: bet.side,
        amount: bet.amount,
        payout,
        net: payout - bet.amount,
        won: payout > bet.amount,
      });
    }

    this.result = {
      outcome,
      playerTotal,
      bankerTotal,
      natural,
      playerCards: this.player,
      bankerCards: this.banker,
      firstTotals: { player: playerTwo, banker: bankerTwo },
      commission,
      entries,
    };
    this.history.unshift({ outcome, playerTotal, bankerTotal });
    this.history = this.history.slice(0, 20);

    this.phase = 'result';
    this.ctx.emit({ kind: 'result', result: this.result });
    this.ctx.later(() => {
      this.phase = 'idle';
      this.ctx.sync();
    }, this.timings.result);
  }

  // ---------------------------------------------------------------- Ansicht

  publicState() {
    // Die Einsätze liegen offen auf dem Tisch – wie im echten Spiel.
    const stakes = [];
    for (const [playerId, bet] of this.bets) {
      stakes.push({ playerId, side: bet.side, amount: bet.amount });
    }
    const totals = { player: 0, banker: 0, tie: 0 };
    for (const bet of this.bets.values()) totals[bet.side] += bet.amount;

    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      minBet: this.config.minBet,
      maxBet: this.config.maxBet,
      shoe: { remaining: this.shoe.remaining, total: this.shoe.total },
      // Vor der Abrechnung liegen die Karten schon offen – beim Baccarat gibt
      // es nichts zu entscheiden, also auch nichts geheim zu halten.
      player: { cards: this.player, total: this.player.length ? handTotal(this.player) : null },
      banker: { cards: this.banker, total: this.banker.length ? handTotal(this.banker) : null },
      result: this.result,
      history: this.history,
      stakes,
      totals,
      ready: this.readySet.progress(),
    };
  }

  privateState(playerId) {
    const bet = this.bets.get(playerId) ?? null;
    return {
      balance: this.ctx.wallet.balance(playerId),
      canBet: this.phase === 'betting',
      youReady: this.readySet.has(playerId),
      bet,
    };
  }

  seatsChanged() {
    if (this.phase !== 'betting') return;
    const present = new Set(this.ctx.seats().map((seat) => seat.playerId));
    for (const [playerId, bet] of [...this.bets]) {
      if (present.has(playerId)) continue;
      this.ctx.wallet.credit(playerId, bet.amount, 'baccarat:refund');
      this.bets.delete(playerId);
    }
    // Wer weg ist, darf den Start nicht länger aufhalten.
    this.maybeDealEarly();
  }

  dispose() {
    if (this.phase === 'betting' || this.phase === 'dealing') {
      for (const [playerId, bet] of this.bets) {
        this.ctx.wallet.credit(playerId, bet.amount, 'baccarat:refund');
      }
    }
    this.bets = new Map();
    this.phase = 'idle';
    this.result = null;
  }
}
