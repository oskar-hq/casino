/**
 * Texas Hold'em, No-Limit – die Spiellogik.
 *
 * Server-autoritativ: Der Client schickt nur Absichten ("raise auf 120"),
 * geprüft und verbucht wird ausschließlich hier. Hole Cards stehen nie im
 * öffentlichen Zustand – sie kommen nur über `privateState()` zu ihrem
 * Besitzer bzw. beim Showdown zu allen.
 *
 * Der Stack eines Spielers **ist** sein Guthaben auf dem Floor: Ein Einsatz
 * wird sofort vom Wallet abgebucht, Gewinne werden sofort gutgeschrieben.
 * Deshalb darf ein Spieler auch nur an einem Tisch gleichzeitig sitzen.
 *
 * Die 7-Karten-Auswertung macht `pokersolver` – ein selbstgeschriebener
 * Evaluator wäre die klassische Fehlerquelle.
 */

import pokersolver from 'pokersolver';

import { GameEngine, GameError } from '../../core/engine.js';
import { freshDeck } from '../../core/cards.js';
import { decideHoldem } from './bot.js';

const { Hand } = pokersolver;

/** Wie lange das Ergebnis stehen bleibt, bevor die nächste Hand läuft (ms). */
export const SHOWDOWN_MS = 5000;
export const FOLD_WIN_MS = 2200;
/** Pause zwischen zwei Händen, damit man dem Tisch folgen kann. */
export const NEXT_HAND_MS = 1200;
/** Pause zwischen zwei Boardkarten, wenn alle all-in sind. */
export const RUN_OUT_MS = 900;

const STREETS = ['preflop', 'flop', 'turn', 'river'];

export class HoldemEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    this.handNumber = 0;
    /** Sitzplatznummer des Dealer-Buttons (rotiert jede Hand). */
    this.buttonSeat = null;
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | showdown | payout
    /** @type {HandPlayer[]} Reihenfolge = Sitzreihenfolge im Uhrzeigersinn. */
    this.players = [];
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.actorPos = -1;
    this.currentDeadline = null;
    this.result = null;
    this.nextHandTimer = null;
  }

  get smallBlind() {
    return this.config.smallBlind;
  }

  get bigBlind() {
    return this.config.bigBlind;
  }

  /**
   * Anzeigedauern. Über die Tischeinstellungen übersteuerbar – die Tests
   * drehen sie herunter, damit nicht in Echtzeit gewartet werden muss.
   */
  get timings() {
    return {
      showdown: this.config.showdownMs ?? SHOWDOWN_MS,
      foldWin: this.config.foldWinMs ?? FOLD_WIN_MS,
      nextHand: this.config.nextHandMs ?? NEXT_HAND_MS,
      runOut: this.config.runOutMs ?? RUN_OUT_MS,
    };
  }

  stackOf(player) {
    return this.ctx.wallet.balance(player.playerId);
  }

  // ----------------------------------------------------------- Rundenstart

  /** Wer kann mitspielen? Nur wer sitzt und noch Chips hat (kein Rebuy). */
  eligibleSeats() {
    return this.ctx
      .seats()
      .filter((seat) => seat.chips > 0)
      .sort((a, b) => a.index - b.index);
  }

  tick() {
    if (this.phase !== 'waiting') return;
    if (this.nextHandTimer) return;
    // Ohne Publikum wird nicht weitergespielt – sonst zocken Bots nachts durch.
    if (!this.ctx.hasAudience()) return;
    const seats = this.eligibleSeats();
    if (seats.length < 2) return;

    this.nextHandTimer = this.ctx.later(() => {
      this.nextHandTimer = null;
      if (this.phase === 'waiting') this.startHand();
      this.ctx.sync();
    }, this.timings.nextHand);
  }

  startHand() {
    const seats = this.eligibleSeats();
    if (seats.length < 2) return;

    this.handNumber += 1;
    this.result = null;
    this.board = [];
    this.deck = freshDeck(this.ctx.rng);

    this.players = seats.map((seat) => ({
      playerId: seat.playerId,
      name: seat.name,
      isBot: seat.isBot,
      difficulty: seat.difficulty,
      seatIndex: seat.index,
      cards: [],
      /** In dieser Setzrunde gesetzt. */
      committed: 0,
      /** In dieser Hand insgesamt gesetzt – Grundlage der Side-Pots. */
      total: 0,
      folded: false,
      allIn: false,
      /** Hatte in dieser Setzrunde schon das Wort (auf aktuellem Raise-Level). */
      acted: false,
      startStack: seat.chips,
      lastAction: null,
    }));

    // Button rotiert auf den nächsten besetzten Platz.
    this.buttonSeat = this.nextButtonSeat();
    const buttonPos = this.players.findIndex((p) => p.seatIndex === this.buttonSeat);

    this.dealHoleCards(buttonPos);
    this.postBlinds(buttonPos);

    this.phase = 'preflop';
    this.ctx.emit({ kind: 'hand_started', hand: this.handNumber, button: this.buttonSeat });
  }

  /** Der Button wandert im Uhrzeigersinn zum nächsten mitspielenden Platz. */
  nextButtonSeat() {
    const seats = this.players.map((p) => p.seatIndex);
    if (this.buttonSeat === null) return seats[this.ctx.rng.int(seats.length)];
    const ahead = seats.find((seat) => seat > this.buttonSeat);
    return ahead ?? seats[0];
  }

  dealHoleCards(buttonPos) {
    // Reihum je eine Karte, beginnend links vom Button – wie am echten Tisch.
    for (let round = 0; round < 2; round++) {
      for (let step = 1; step <= this.players.length; step++) {
        const player = this.players[(buttonPos + step) % this.players.length];
        player.cards.push(this.deck.pop());
      }
    }
    this.ctx.emit({ kind: 'deal_hole', seats: this.players.map((p) => p.seatIndex) });
  }

  postBlinds(buttonPos) {
    const n = this.players.length;
    // Heads-up: Der Button ist der Small Blind und handelt preflop zuerst.
    const sbPos = n === 2 ? buttonPos : (buttonPos + 1) % n;
    const bbPos = n === 2 ? (buttonPos + 1) % n : (buttonPos + 2) % n;

    this.postBlind(this.players[sbPos], this.smallBlind, 'sb');
    this.postBlind(this.players[bbPos], this.bigBlind, 'bb');

    // Der zu zahlende Einsatz ist der volle Big Blind – auch wenn der
    // Big-Blind-Spieler ihn selbst nur teilweise aufbringen konnte (all-in).
    this.currentBet = Math.max(this.bigBlind, ...this.players.map((p) => p.committed));
    this.minRaise = this.bigBlind;

    // Preflop handelt der Spieler links vom Big Blind zuerst (heads-up: der Button).
    const firstPos = n === 2 ? buttonPos : (bbPos + 1) % n;
    this.setActor(this.findNextActor(firstPos - 1));
  }

  /** Blind setzen – wer weniger hat als der Blind, ist damit all-in. */
  postBlind(player, amount, label) {
    const stack = this.stackOf(player);
    const paid = Math.min(amount, stack);
    if (paid > 0) this.ctx.wallet.debit(player.playerId, paid, `holdem:${label}`);
    player.committed += paid;
    player.total += paid;
    if (this.stackOf(player) === 0) player.allIn = true;
  }

  // -------------------------------------------------------------- Am Zug

  get actorId() {
    if (!STREETS.includes(this.phase)) return null;
    return this.players[this.actorPos]?.playerId ?? null;
  }

  get deadline() {
    return this.actorId ? this.currentDeadline : null;
  }

  setActor(pos) {
    this.actorPos = pos;
    this.currentDeadline = pos === -1 ? null : Date.now() + this.config.turnMs;
  }

  playerOf(playerId) {
    return this.players.find((p) => p.playerId === playerId) ?? null;
  }

  /** Spieler, die überhaupt noch handeln können (nicht gefoldet, nicht all-in). */
  ableToAct() {
    return this.players.filter((p) => !p.folded && !p.allIn);
  }

  /**
   * Muss dieser Spieler noch handeln?
   * - Wer weniger gesetzt hat als der aktuelle Einsatz: ja (callen oder folden).
   * - Wer schon ausgeglichen hat, aber noch nicht am Wort war: nur, wenn
   *   überhaupt noch jemand mitgehen könnte (sonst gibt es nichts zu setzen).
   */
  needsAction(player) {
    if (player.folded || player.allIn) return false;
    if (player.committed < this.currentBet) return true;
    if (!player.acted) return this.ableToAct().length >= 2;
    return false;
  }

  findNextActor(fromPos) {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const pos = (((fromPos + step) % n) + n) % n;
      if (this.needsAction(this.players[pos])) return pos;
    }
    return -1;
  }

  // ------------------------------------------------------------- Aktionen

  /**
   * Was darf dieser Spieler gerade? Der Client zeichnet daraus seine Knöpfe –
   * geprüft wird trotzdem noch einmal in `act()`.
   */
  optionsFor(playerId) {
    const player = this.playerOf(playerId);
    if (!player || this.actorId !== playerId) return null;

    const stack = this.stackOf(player);
    const toCall = Math.min(this.currentBet - player.committed, stack);
    const maxTo = player.committed + stack;
    // Ein Raise muss den Mindestbetrag erreichen – außer man geht dafür all-in.
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxTo);

    return {
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: toCall,
      // Wer nur wegen eines kurzen All-ins noch einmal gefragt wird, darf nicht
      // erneut erhöhen – er war auf diesem Raise-Level schon am Wort.
      canRaise: !player.acted && maxTo > this.currentBet && stack > 0,
      isRaise: this.currentBet > 0,
      minRaiseTo,
      maxRaiseTo: maxTo,
      currentBet: this.currentBet,
      committed: player.committed,
      stack,
      bigBlind: this.bigBlind,
      pot: this.potTotal(),
    };
  }

  act(playerId, action) {
    if (!STREETS.includes(this.phase)) {
      throw new GameError('not_betting', 'Gerade läuft keine Setzrunde.');
    }
    if (this.actorId !== playerId) {
      throw new GameError('not_your_turn', 'Du bist nicht am Zug.');
    }
    const player = this.playerOf(playerId);
    const move = String(action?.move ?? '');

    switch (move) {
      case 'fold':
        this.doFold(player);
        break;
      case 'check':
        this.doCheck(player);
        break;
      case 'call':
        this.doCall(player);
        break;
      case 'bet':
      case 'raise':
        this.doRaise(player, Number(action.amount));
        break;
      case 'allin': {
        // Alles reinschieben. Reicht der Stack nicht einmal für den aktuellen
        // Einsatz, ist das kein Erhöhen, sondern ein Mitgehen für weniger.
        const maxTo = player.committed + this.stackOf(player);
        if (maxTo <= this.currentBet) this.doCall(player);
        else this.doRaise(player, maxTo, { allowShort: true });
        break;
      }
      default:
        throw new GameError('bad_action', 'Diesen Zug gibt es beim Poker nicht.');
    }
    this.afterAction(player);
  }

  doFold(player) {
    player.folded = true;
    player.acted = true;
    player.lastAction = { move: 'fold' };
  }

  doCheck(player) {
    if (player.committed < this.currentBet) {
      throw new GameError('cannot_check', 'Du musst mitgehen, erhöhen oder aussteigen.');
    }
    player.acted = true;
    player.lastAction = { move: 'check' };
  }

  doCall(player) {
    const stack = this.stackOf(player);
    const owed = this.currentBet - player.committed;
    if (owed <= 0) {
      // "Call" ohne Einsatz ist einfach ein Check – nicht am Spieler scheitern lassen.
      return this.doCheck(player);
    }
    const paid = Math.min(owed, stack);
    this.commit(player, paid);
    player.acted = true;
    player.lastAction = { move: paid < owed ? 'allin' : 'call', amount: paid };
    return undefined;
  }

  /**
   * Erhöhen. `target` ist der Betrag, den der Spieler in **dieser Setzrunde**
   * insgesamt stehen haben will (nicht der Aufschlag) – das ist eindeutig und
   * lässt sich sauber prüfen.
   */
  doRaise(player, target, { allowShort = false } = {}) {
    if (!Number.isFinite(target)) {
      throw new GameError('bad_amount', 'Ungültiger Betrag.');
    }
    const amount = Math.floor(target);
    const stack = this.stackOf(player);
    const maxTo = player.committed + stack;

    if (player.acted && this.currentBet > 0) {
      // Nur durch ein kurzes All-in wieder gefragt → nur call oder fold.
      throw new GameError('cannot_reraise', 'Auf diesen Einsatz darfst du nur mitgehen oder aussteigen.');
    }
    if (amount <= this.currentBet) {
      throw new GameError('raise_too_small', 'Damit erhöhst du gar nicht.');
    }
    if (amount > maxTo) {
      throw new GameError('insufficient', 'So viel hast du nicht.');
    }
    const isAllIn = amount === maxTo;
    const raiseSize = amount - this.currentBet;
    if (raiseSize < this.minRaise && !isAllIn && !allowShort) {
      throw new GameError(
        'raise_too_small',
        `Mindestens ${this.currentBet + this.minRaise} – oder gleich all-in.`,
      );
    }

    this.commit(player, amount - player.committed);

    // Nur eine **volle** Erhöhung öffnet die Setzrunde neu. Ein kurzes All-in
    // lässt Spieler, die schon am Wort waren, nur noch callen oder folden.
    if (raiseSize >= this.minRaise) {
      this.minRaise = raiseSize;
      for (const other of this.players) {
        if (other !== player && !other.folded && !other.allIn) other.acted = false;
      }
    }
    this.currentBet = amount;
    player.acted = true;
    player.lastAction = {
      move: isAllIn ? 'allin' : this.currentBet === amount && raiseSize === amount ? 'bet' : 'raise',
      amount,
    };
  }

  /** Chips vom Wallet in den Pot – die einzige Stelle, die Geld bewegt. */
  commit(player, amount) {
    const value = Math.max(0, Math.floor(amount));
    if (value === 0) return;
    this.ctx.wallet.debit(player.playerId, value, 'holdem:bet');
    player.committed += value;
    player.total += value;
    if (this.stackOf(player) === 0) player.allIn = true;
  }

  afterAction(player) {
    this.ctx.emit({
      kind: 'action',
      seat: player.seatIndex,
      name: player.name,
      action: player.lastAction,
    });

    // Nur noch einer übrig → er bekommt den Pot ohne Showdown.
    if (this.players.filter((p) => !p.folded).length <= 1) {
      this.finishHand({ showdown: false });
      return;
    }

    const next = this.findNextActor(this.actorPos);
    if (next === -1) this.nextStreet();
    else this.setActor(next);
  }

  timeout(playerId) {
    const player = this.playerOf(playerId);
    if (!player || this.actorId !== playerId) return;
    // Zeit abgelaufen: kostenlos weiter = Check, sonst aussteigen.
    if (player.committed >= this.currentBet) this.doCheck(player);
    else this.doFold(player);
    player.lastAction = { ...player.lastAction, timeout: true };
    this.afterAction(player);
  }

  botAct(playerId, difficulty) {
    const player = this.playerOf(playerId);
    if (!player || this.actorId !== playerId) return;
    const decision = decideHoldem({
      engine: this,
      player,
      difficulty,
      options: this.optionsFor(playerId),
      rng: this.ctx.rng,
    });
    this.act(playerId, decision);
  }

  // -------------------------------------------------------------- Streets

  nextStreet() {
    // Wenn niemand mehr setzen kann, laufen die restlichen Karten einfach durch.
    const runOut = this.ableToAct().length < 2;

    for (const player of this.players) {
      player.committed = 0;
      player.acted = false;
      if (!player.folded) player.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    const index = STREETS.indexOf(this.phase);
    if (index === STREETS.length - 1) {
      this.finishHand({ showdown: true });
      return;
    }

    this.phase = STREETS[index + 1];
    this.dealBoard(this.phase);

    if (runOut) {
      // Karten mit Pause aufdecken, damit man dem All-in folgen kann.
      this.setActor(-1);
      this.ctx.later(() => {
        this.nextStreet();
        this.ctx.sync();
      }, this.timings.runOut);
      return;
    }

    // Postflop beginnt links vom Button.
    const buttonPos = this.players.findIndex((p) => p.seatIndex === this.buttonSeat);
    this.setActor(this.findNextActor(buttonPos));
    if (this.actorPos === -1) this.nextStreet();
  }

  dealBoard(street) {
    this.deck.pop(); // Burn-Card, wie am echten Tisch.
    const count = street === 'flop' ? 3 : 1;
    const cards = [];
    for (let i = 0; i < count; i++) cards.push(this.deck.pop());
    this.board.push(...cards);
    this.ctx.emit({ kind: 'board', street, cards });
  }

  // -------------------------------------------------------------- Auszahlung

  potTotal() {
    return this.players.reduce((sum, player) => sum + player.total, 0);
  }

  /**
   * Zerlegt den Topf in Haupt- und Nebentöpfe.
   *
   * Für jede Einsatzhöhe, die irgendjemand erreicht hat, entsteht eine Schicht:
   * Alle, die mindestens so viel gesetzt haben, zahlen die Differenz ein;
   * mitgewinnen kann davon nur, wer nicht ausgestiegen ist. Dadurch bekommt
   * ein All-in-Spieler nie mehr, als er selbst riskiert hat, und nicht
   * abgegoltene Erhöhungen wandern automatisch zurück.
   */
  buildPots() {
    const levels = [...new Set(this.players.map((p) => p.total).filter((total) => total > 0))].sort(
      (a, b) => a - b,
    );
    const pots = [];
    let previous = 0;
    for (const level of levels) {
      const contributors = this.players.filter((p) => p.total >= level);
      const amount = (level - previous) * contributors.length;
      const eligible = contributors.filter((p) => !p.folded).map((p) => p.playerId);
      previous = level;
      if (amount <= 0) continue;
      const last = pots.at(-1);
      // Schichten mit gleicher Anspruchsberechtigung zusammenfassen.
      if (last && sameMembers(last.eligible, eligible)) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    return pots;
  }

  /** 7-Karten-Auswertung über pokersolver. */
  solveFor(player) {
    const codes = [...this.board, ...player.cards].map((card) => card.code);
    const hand = Hand.solve(codes);
    return { player, hand };
  }

  finishHand({ showdown = false } = {}) {
    const contenders = this.players.filter((p) => !p.folded);
    const pots = this.buildPots();
    const winnings = new Map();
    const addWin = (playerId, amount) =>
      winnings.set(playerId, (winnings.get(playerId) ?? 0) + amount);

    let solved = null;
    if (showdown && contenders.length > 1) {
      solved = new Map(contenders.map((player) => [player.playerId, this.solveFor(player)]));
    }

    for (const pot of pots) {
      const eligible = pot.eligible;
      if (!eligible.length) continue;
      if (eligible.length === 1 || !solved) {
        addWin(eligible[0], pot.amount);
        continue;
      }
      const hands = eligible.map((playerId) => solved.get(playerId).hand);
      const best = Hand.winners(hands);
      const winnerIds = eligible.filter((playerId) => best.includes(solved.get(playerId).hand));
      const share = Math.floor(pot.amount / winnerIds.length);
      let remainder = pot.amount - share * winnerIds.length;
      // Ungerade Chips gehen an den ersten Spieler links vom Button.
      for (const playerId of this.orderFromButton(winnerIds)) {
        addWin(playerId, share + (remainder > 0 ? 1 : 0));
        if (remainder > 0) remainder -= 1;
      }
    }

    for (const [playerId, amount] of winnings) {
      if (amount > 0) this.ctx.wallet.credit(playerId, amount, 'holdem:win');
    }

    this.result = {
      showdown: Boolean(solved),
      pot: this.potTotal(),
      pots: pots.map((pot) => ({ amount: pot.amount, eligible: pot.eligible })),
      winners: [...winnings.entries()].map(([playerId, amount]) => {
        const player = this.playerOf(playerId);
        return {
          playerId,
          seat: player?.seatIndex ?? null,
          name: player?.name ?? '?',
          amount,
          hand: solved?.get(playerId)?.hand.descr ?? null,
        };
      }),
      // Beim Showdown werden die Karten aller Verbliebenen aufgedeckt.
      reveal: solved
        ? contenders.map((player) => ({
            seat: player.seatIndex,
            playerId: player.playerId,
            cards: player.cards,
            hand: solved.get(player.playerId).hand.descr,
          }))
        : [],
    };

    this.phase = solved ? 'showdown' : 'payout';
    this.setActor(-1);
    this.ctx.emit({ kind: 'result', result: this.result });

    this.ctx.later(
      () => {
        this.phase = 'waiting';
        this.players = [];
        this.board = [];
        this.ctx.sync();
      },
      solved ? this.timings.showdown : this.timings.foldWin,
    );
  }

  /** Sortiert IDs nach Sitzreihenfolge ab dem Platz links vom Button. */
  orderFromButton(playerIds) {
    const set = new Set(playerIds);
    const n = this.players.length;
    const buttonPos = Math.max(0, this.players.findIndex((p) => p.seatIndex === this.buttonSeat));
    const ordered = [];
    for (let step = 1; step <= n; step++) {
      const player = this.players[(buttonPos + step) % n];
      if (set.has(player.playerId)) ordered.push(player.playerId);
    }
    return ordered;
  }

  // ------------------------------------------------------------ Sitzwechsel

  seatsChanged() {
    if (!STREETS.includes(this.phase)) return;
    const present = new Set(this.ctx.seats().map((seat) => seat.playerId));
    let changed = false;
    for (const player of this.players) {
      if (player.folded || present.has(player.playerId)) continue;
      // Wer den Tisch mitten in der Hand verlässt, steigt aus. Seine Einsätze
      // bleiben im Pot – wie am echten Tisch.
      player.folded = true;
      player.acted = true;
      changed = true;
    }
    if (!changed) return;

    if (this.players.filter((p) => !p.folded).length <= 1) {
      this.finishHand({ showdown: false });
      return;
    }
    if (this.actorPos !== -1 && this.players[this.actorPos]?.folded) {
      const next = this.findNextActor(this.actorPos);
      if (next === -1) this.nextStreet();
      else this.setActor(next);
    }
  }

  // ---------------------------------------------------------------- Ansicht

  publicState() {
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      buttonSeat: this.buttonSeat,
      board: this.board,
      pot: this.potTotal(),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      result: this.result,
      players: this.players.map((player) => ({
        playerId: player.playerId,
        seat: player.seatIndex,
        name: player.name,
        committed: player.committed,
        total: player.total,
        folded: player.folded,
        allIn: player.allIn,
        lastAction: player.lastAction,
        // Nur die Anzahl – die Karten selbst bleiben geheim.
        cardCount: player.cards.length,
        cards: this.revealedCardsFor(player),
      })),
    };
  }

  /** Fremde Karten gibt es nur beim Showdown zu sehen. */
  revealedCardsFor(player) {
    const revealed = this.result?.reveal?.find((entry) => entry.playerId === player.playerId);
    return revealed ? revealed.cards : null;
  }

  privateState(playerId) {
    const player = this.playerOf(playerId);
    if (!player) return null;
    return {
      cards: player.cards,
      folded: player.folded,
      allIn: player.allIn,
      committed: player.committed,
      options: this.optionsFor(playerId),
    };
  }

  dispose() {
    // Laufende Einsätze zurückgeben – sonst verschwinden Chips beim Reset.
    if (STREETS.includes(this.phase)) {
      for (const player of this.players) {
        if (player.total > 0) this.ctx.wallet.credit(player.playerId, player.total, 'holdem:refund');
      }
    }
    this.players = [];
    this.board = [];
    this.phase = 'waiting';
    this.result = null;
  }
}

function sameMembers(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}
