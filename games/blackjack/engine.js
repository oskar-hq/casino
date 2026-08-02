/**
 * Blackjack – alle an einem Tisch, jeder spielt seine eigene Hand gegen den
 * Dealer.
 *
 * Regeln dieses Tisches:
 *   - 6-Deck-Schuh, neu gemischt an der Cut-Card (nie mitten in einer Runde)
 *   - Der Dealer zieht bis 17 und **bleibt bei Soft 17 stehen**
 *   - Blackjack zahlt 3:2, Gewinn 1:1, Push gibt den Einsatz zurück
 *   - Hit / Stand / Double / Split; Split-Asse bekommen nur eine Karte
 *
 * Ablauf: Einsätze (Countdown) → austeilen → reihum Spielerzüge →
 * Dealer → Auszahlung → nächste Runde.
 */

import { GameEngine, GameError } from '../../core/engine.js';
import { Shoe } from '../../core/cards.js';
import { ReadySet } from '../../core/ready.js';
import { botBetAmount, decideBlackjack } from './bot.js';

export const SETTLE_MS = 4500;
export const DEAL_STEP_MS = 260;

/** Wie viele Hände ein Spieler durch Splits höchstens haben darf. */
const MAX_HANDS = 4;

export class BlackjackEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    this.shoe = new Shoe({ decks: this.config.decks, rng: ctx.rng, penetration: 0.25 });
    this.phase = 'idle'; // idle | betting | dealing | players | dealer | settled
    this.roundNumber = 0;
    /** @type {PlayerBox[]} Spieler mit Einsatz in dieser Runde. */
    this.boxes = [];
    this.dealer = { cards: [], done: false };
    /** Wer ist gerade dran: Index in boxes + Index seiner Hand. */
    this.turnBox = -1;
    this.turnHand = 0;
    this.currentDeadline = null;
    this.betsPlaced = new Map();
    this.result = null;
    this.timer = null;
    /** Wer ist mit dem Setzen fertig? Sind alle so weit, wird sofort gegeben. */
    this.readySet = new ReadySet(() => this.ctx.seats());
  }

  get timings() {
    return {
      bet: this.config.betMs ?? 15_000,
      settle: this.config.settleMs ?? SETTLE_MS,
      dealStep: this.config.dealStepMs ?? DEAL_STEP_MS,
    };
  }

  // ------------------------------------------------------------ Rundenlauf

  tick() {
    if (this.phase === 'idle') {
      if (!this.ctx.hasAudience()) return;
      if (!this.ctx.seats().length) return;
      this.openBetting();
    }
    // In der Setzphase ist niemand einzeln „am Zug“ – Bots setzen deshalb
    // nicht über die normale Zugsteuerung, sondern gleich hier. Das passiert
    // bewusst noch im selben Durchlauf: Sonst würde an einem reinen Bot-Tisch
    // nie jemand setzen und es käme nie zu einer Runde.
    if (this.phase === 'betting') {
      this.placeBotBets();
      this.maybeDealEarly();
    }
  }

  placeBotBets() {
    for (const seat of this.ctx.seats()) {
      if (!seat.isBot || this.betsPlaced.has(seat.playerId)) continue;
      const amount = botBetAmount({
        balance: seat.chips,
        minBet: this.config.minBet,
        maxBet: this.config.maxBet,
        difficulty: seat.difficulty,
        rng: this.ctx.rng,
      });
      if (amount <= 0 || seat.chips < amount) continue;
      try {
        this.placeBet(seat.playerId, amount);
      } catch (error) {
        this.ctx.log(`Bot ${seat.name} konnte nicht setzen: ${error.message}`);
      }
    }
  }

  openBetting() {
    // Zwischen den Runden ist der richtige Moment fürs Neumischen.
    if (this.shoe.reshuffleIfNeeded()) {
      this.ctx.emit({ kind: 'shuffle' });
    }
    this.phase = 'betting';
    this.roundNumber += 1;
    this.result = null;
    this.boxes = [];
    this.betsPlaced = new Map();
    this.readySet.reset();
    this.dealer = { cards: [], done: false };
    this.currentDeadline = Date.now() + this.timings.bet;
    this.timer = this.ctx.later(() => {
      this.closeBetting();
      this.ctx.sync();
    }, this.timings.bet);
  }

  /** Einsatz setzen oder ändern, solange das Fenster offen ist. */
  placeBet(playerId, amount) {
    if (this.phase !== 'betting') {
      throw new GameError('not_betting', 'Gerade kann nicht gesetzt werden.');
    }
    const seat = this.ctx.seats().find((entry) => entry.playerId === playerId);
    if (!seat) throw new GameError('not_seated', 'Setz dich erst an den Tisch.');

    const wanted = Math.floor(Number(amount));
    if (!Number.isFinite(wanted) || wanted < 0) {
      throw new GameError('bad_amount', 'Ungültiger Einsatz.');
    }
    const previous = this.betsPlaced.get(playerId) ?? 0;
    // Erst den alten Einsatz zurückgeben, dann den neuen abbuchen.
    if (previous) this.ctx.wallet.credit(playerId, previous, 'blackjack:bet-change');
    this.betsPlaced.delete(playerId);
    if (wanted === 0) return 0;

    const bet = Math.max(this.config.minBet, Math.min(this.config.maxBet, wanted));
    if (this.ctx.wallet.balance(playerId) < bet) {
      throw new GameError('insufficient', 'Dafür reicht dein Guthaben nicht.');
    }
    this.ctx.wallet.debit(playerId, bet, 'blackjack:bet');
    this.betsPlaced.set(playerId, bet);
    return bet;
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
    if (!this.betsPlaced.size) return;
    this.closeBetting();
  }

  closeBetting() {
    const seats = this.ctx.seats();
    // Wer zwischenzeitlich aufgestanden ist, bekommt seinen Einsatz zurück –
    // sonst bliebe er ohne Gegenwert auf dem Tisch liegen.
    const seated = new Set(seats.map((seat) => seat.playerId));
    for (const [playerId, amount] of this.betsPlaced) {
      if (seated.has(playerId)) continue;
      this.ctx.wallet.credit(playerId, amount, 'blackjack:refund');
      this.betsPlaced.delete(playerId);
    }

    this.boxes = seats
      .filter((seat) => (this.betsPlaced.get(seat.playerId) ?? 0) > 0)
      .map((seat) => ({
        playerId: seat.playerId,
        name: seat.name,
        isBot: seat.isBot,
        difficulty: seat.difficulty,
        seatIndex: seat.index,
        hands: [newHand(this.betsPlaced.get(seat.playerId))],
      }));

    if (!this.boxes.length) {
      // Niemand hat gesetzt – gleich das nächste Fenster öffnen.
      this.phase = 'idle';
      return;
    }
    this.deal();
  }

  deal() {
    this.phase = 'dealing';
    // Zwei Runden reihum, der Dealer bekommt eine offene und eine verdeckte.
    for (const box of this.boxes) box.hands[0].cards.push(this.shoe.draw());
    this.dealer.cards.push(this.shoe.draw());
    for (const box of this.boxes) box.hands[0].cards.push(this.shoe.draw());
    this.dealer.cards.push(this.shoe.draw()); // Hole Card – bleibt verdeckt

    this.ctx.emit({ kind: 'deal_hole', seats: this.boxes.map((box) => box.seatIndex) });

    // Natural Blackjack ist sofort entschieden.
    for (const box of this.boxes) {
      const hand = box.hands[0];
      if (handValue(hand.cards).total === 21) hand.blackjack = true;
    }

    this.phase = 'players';
    this.turnBox = -1;
    this.turnHand = 0;
    this.advanceTurn();
  }

  // ---------------------------------------------------------------- Am Zug

  get actorId() {
    if (this.phase === 'betting') return null; // alle setzen gleichzeitig
    if (this.phase !== 'players') return null;
    return this.boxes[this.turnBox]?.playerId ?? null;
  }

  get deadline() {
    if (this.phase === 'betting') return this.currentDeadline;
    return this.actorId ? this.currentDeadline : null;
  }

  currentHand() {
    return this.boxes[this.turnBox]?.hands[this.turnHand] ?? null;
  }

  /** Sucht die nächste Hand, die noch eine Entscheidung braucht. */
  advanceTurn() {
    let boxIndex = this.turnBox;
    let handIndex = this.turnHand + 1;
    if (boxIndex === -1) {
      boxIndex = 0;
      handIndex = 0;
    }

    while (boxIndex < this.boxes.length) {
      const box = this.boxes[boxIndex];
      while (handIndex < box.hands.length) {
        const hand = box.hands[handIndex];
        if (needsDecision(hand)) {
          this.turnBox = boxIndex;
          this.turnHand = handIndex;
          this.currentDeadline = Date.now() + this.config.turnMs;
          return;
        }
        handIndex += 1;
      }
      boxIndex += 1;
      handIndex = 0;
    }

    this.turnBox = -1;
    this.playDealer();
  }

  act(playerId, action) {
    if (action?.move === 'bet') {
      this.placeBet(playerId, action.amount);
      // Wer den Einsatz ändert, ist offensichtlich noch nicht fertig.
      this.readySet.set(playerId, false);
      return;
    }
    if (action?.move === 'ready') {
      this.setReady(playerId, action.value !== false);
      return;
    }
    if (this.phase !== 'players') throw new GameError('not_playing', 'Gerade ist kein Zug dran.');
    if (this.actorId !== playerId) throw new GameError('not_your_turn', 'Du bist nicht am Zug.');

    const box = this.boxes[this.turnBox];
    const hand = this.currentHand();

    switch (action?.move) {
      case 'hit':
        this.hit(hand);
        break;
      case 'stand':
        hand.done = true;
        break;
      case 'double':
        this.double(box, hand);
        break;
      case 'split':
        this.split(box, hand);
        return; // Nach dem Split ist dieselbe Box weiter dran.
      default:
        throw new GameError('bad_action', 'Diesen Zug gibt es beim Blackjack nicht.');
    }

    if (!needsDecision(hand)) this.advanceTurn();
    else this.currentDeadline = Date.now() + this.config.turnMs;
  }

  hit(hand) {
    hand.cards.push(this.shoe.draw());
    const { total } = handValue(hand.cards);
    if (total >= 21) hand.done = true;
  }

  double(box, hand) {
    if (hand.cards.length !== 2) {
      throw new GameError('cannot_double', 'Verdoppeln geht nur mit den ersten beiden Karten.');
    }
    if (this.ctx.wallet.balance(box.playerId) < hand.bet) {
      throw new GameError('insufficient', 'Zum Verdoppeln reicht dein Guthaben nicht.');
    }
    this.ctx.wallet.debit(box.playerId, hand.bet, 'blackjack:double');
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(this.shoe.draw());
    hand.done = true;
  }

  split(box, hand) {
    if (hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank) {
      throw new GameError('cannot_split', 'Teilen geht nur bei zwei gleichen Werten.');
    }
    if (box.hands.length >= MAX_HANDS) {
      throw new GameError('too_many_hands', `Mehr als ${MAX_HANDS} Hände gehen nicht.`);
    }
    if (this.ctx.wallet.balance(box.playerId) < hand.bet) {
      throw new GameError('insufficient', 'Zum Teilen reicht dein Guthaben nicht.');
    }
    this.ctx.wallet.debit(box.playerId, hand.bet, 'blackjack:split');

    const moved = hand.cards.pop();
    const extra = newHand(hand.bet);
    extra.cards.push(moved);
    extra.fromSplit = true;
    hand.fromSplit = true;

    // Beide Hälften bekommen sofort eine zweite Karte.
    hand.cards.push(this.shoe.draw());
    extra.cards.push(this.shoe.draw());

    // Geteilte Asse bekommen genau eine Karte und werden nicht weitergespielt.
    if (moved.rank === 'A') {
      hand.done = true;
      extra.done = true;
    }
    box.hands.splice(this.turnHand + 1, 0, extra);

    if (!needsDecision(hand)) this.advanceTurn();
    else this.currentDeadline = Date.now() + this.config.turnMs;
  }

  timeout(playerId) {
    if (this.phase === 'betting') return;
    if (this.actorId !== playerId) return;
    // Zeit abgelaufen = stehen bleiben. Das ist die sichere Vorgabe.
    const hand = this.currentHand();
    if (hand) hand.done = true;
    this.advanceTurn();
  }

  botAct(playerId, difficulty) {
    const box = this.boxes[this.turnBox];
    if (!box || box.playerId !== playerId) return;
    const move = decideBlackjack({
      hand: this.currentHand(),
      dealerUpcard: this.dealer.cards[0],
      canDouble: this.canDouble(box, this.currentHand()),
      canSplit: this.canSplit(box, this.currentHand()),
      difficulty,
      rng: this.ctx.rng,
    });
    this.act(playerId, { move });
  }

  canDouble(box, hand) {
    return Boolean(
      hand &&
        hand.cards.length === 2 &&
        !hand.done &&
        this.ctx.wallet.balance(box.playerId) >= hand.bet,
    );
  }

  canSplit(box, hand) {
    return Boolean(
      hand &&
        hand.cards.length === 2 &&
        hand.cards[0].rank === hand.cards[1].rank &&
        box.hands.length < MAX_HANDS &&
        this.ctx.wallet.balance(box.playerId) >= hand.bet,
    );
  }

  // ---------------------------------------------------------------- Dealer

  playDealer() {
    this.phase = 'dealer';
    this.currentDeadline = null;

    // Sind alle überkauft oder haben Blackjack, muss der Dealer nicht ziehen.
    const anyLive = this.boxes.some((box) =>
      box.hands.some((hand) => !hand.blackjack && handValue(hand.cards).total <= 21),
    );

    if (anyLive) {
      // Bis 17 ziehen und dort stehen bleiben – auch bei Soft 17 (S17).
      while (handValue(this.dealer.cards).total < 17) {
        this.dealer.cards.push(this.shoe.draw());
      }
    }
    this.dealer.done = true;
    this.settle();
  }

  settle() {
    const dealerValue = handValue(this.dealer.cards);
    const dealerBust = dealerValue.total > 21;
    const dealerBlackjack = this.dealer.cards.length === 2 && dealerValue.total === 21;

    const entries = [];
    for (const box of this.boxes) {
      for (const hand of box.hands) {
        const value = handValue(hand.cards);
        // Ein Blackjack nach dem Teilen zählt als normale 21.
        const naturalBlackjack = hand.blackjack && !hand.fromSplit;
        let outcome;
        let payout = 0;

        if (value.total > 21) {
          outcome = 'bust';
        } else if (naturalBlackjack && !dealerBlackjack) {
          outcome = 'blackjack';
          payout = hand.bet + Math.floor((hand.bet * 3) / 2);
        } else if (dealerBlackjack && !naturalBlackjack) {
          outcome = 'lose';
        } else if (dealerBlackjack && naturalBlackjack) {
          outcome = 'push';
          payout = hand.bet;
        } else if (dealerBust || value.total > dealerValue.total) {
          outcome = 'win';
          payout = hand.bet * 2;
        } else if (value.total === dealerValue.total) {
          outcome = 'push';
          payout = hand.bet;
        } else {
          outcome = 'lose';
        }

        if (payout > 0) this.ctx.wallet.credit(box.playerId, payout, `blackjack:${outcome}`);
        hand.outcome = outcome;
        hand.payout = payout;
        entries.push({
          playerId: box.playerId,
          seat: box.seatIndex,
          name: box.name,
          bet: hand.bet,
          total: value.total,
          outcome,
          payout,
          net: payout - hand.bet,
        });
      }
    }

    this.result = {
      dealer: { total: dealerValue.total, bust: dealerBust, blackjack: dealerBlackjack },
      entries,
    };
    this.phase = 'settled';
    this.ctx.emit({ kind: 'result', result: this.result });

    this.timer = this.ctx.later(() => {
      this.phase = 'idle';
      this.ctx.sync();
    }, this.timings.settle);
  }

  // ---------------------------------------------------------------- Ansicht

  publicState() {
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      minBet: this.config.minBet,
      maxBet: this.config.maxBet,
      shoe: { remaining: this.shoe.remaining, total: this.shoe.total },
      dealer: {
        // Die zweite Dealerkarte bleibt verdeckt, bis der Dealer dran ist.
        cards: this.hiddenDealerCards(),
        total: this.dealerVisibleTotal(),
        done: this.dealer.done,
      },
      result: this.result,
      // Einsätze in der Setzphase sind öffentlich – das ist am Tisch auch so.
      bets: [...this.betsPlaced.entries()].map(([playerId, amount]) => ({ playerId, amount })),
      ready: this.readySet.progress(),
      boxes: this.boxes.map((box, boxIndex) => ({
        playerId: box.playerId,
        seat: box.seatIndex,
        name: box.name,
        active: boxIndex === this.turnBox,
        hands: box.hands.map((hand, handIndex) => ({
          cards: hand.cards,
          bet: hand.bet,
          ...handValue(hand.cards),
          blackjack: hand.blackjack && !hand.fromSplit,
          doubled: hand.doubled,
          done: hand.done,
          outcome: hand.outcome ?? null,
          payout: hand.payout ?? 0,
          active: boxIndex === this.turnBox && handIndex === this.turnHand,
        })),
      })),
    };
  }

  /** Vor dem Dealerzug ist nur die erste Karte offen. */
  hiddenDealerCards() {
    if (this.phase === 'dealer' || this.phase === 'settled' || this.dealer.done) {
      return this.dealer.cards;
    }
    return this.dealer.cards.map((card, index) => (index === 0 ? card : null));
  }

  dealerVisibleTotal() {
    if (this.dealer.done) return handValue(this.dealer.cards).total;
    if (!this.dealer.cards.length) return 0;
    return handValue([this.dealer.cards[0]]).total;
  }

  privateState(playerId) {
    const box = this.boxes.find((entry) => entry.playerId === playerId);
    const hand = this.actorId === playerId ? this.currentHand() : null;
    return {
      bet: this.betsPlaced.get(playerId) ?? 0,
      balance: this.ctx.wallet.balance(playerId),
      canBet: this.phase === 'betting',
      youReady: this.readySet.has(playerId),
      options: hand
        ? {
            canHit: true,
            canStand: true,
            canDouble: this.canDouble(box, hand),
            canSplit: this.canSplit(box, hand),
          }
        : null,
    };
  }

  seatsChanged() {
    // Wer mitten in der Runde geht, spielt seine Hand nicht weiter.
    if (this.phase !== 'players') return;
    const present = new Set(this.ctx.seats().map((seat) => seat.playerId));
    let changed = false;
    for (const box of this.boxes) {
      if (present.has(box.playerId)) continue;
      for (const hand of box.hands) hand.done = true;
      changed = true;
    }
    if (changed && !needsDecision(this.currentHand())) this.advanceTurn();
  }

  dispose() {
    // Noch nicht gespielte Einsätze zurückgeben.
    if (this.phase === 'betting') {
      for (const [playerId, amount] of this.betsPlaced) {
        this.ctx.wallet.credit(playerId, amount, 'blackjack:refund');
      }
    } else if (this.phase !== 'settled' && this.phase !== 'idle') {
      for (const box of this.boxes) {
        for (const hand of box.hands) {
          this.ctx.wallet.credit(box.playerId, hand.bet, 'blackjack:refund');
        }
      }
    }
    this.betsPlaced = new Map();
    this.boxes = [];
    this.phase = 'idle';
    this.result = null;
  }
}

// ------------------------------------------------------------------ Helfer

function newHand(bet) {
  return {
    cards: [],
    bet,
    done: false,
    doubled: false,
    blackjack: false,
    fromSplit: false,
    outcome: null,
    payout: 0,
  };
}

function needsDecision(hand) {
  if (!hand || hand.done) return false;
  return handValue(hand.cards).total < 21;
}

/**
 * Zählt eine Hand. Asse zählen 11, solange das nicht über 21 geht – sonst 1.
 * `soft` heißt: Ein Ass wird gerade als 11 gewertet.
 */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (!card) continue;
    if (card.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (['T', 'J', 'Q', 'K'].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  // Bleibt ein Ass mit 11 stehen, ist die Hand „soft“.
  return { total, soft: aces > 0 };
}
