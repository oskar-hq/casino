/**
 * Slots – ein Automat, drei Walzen, feste Auszahlungstabelle.
 *
 * Fairer RNG: Jede Walze wird unabhängig aus ihrem Streifen gezogen, jede
 * Position gleich wahrscheinlich. Die Auszahlungen stehen offen in der
 * Paytable – nichts wird "nachjustiert", der Ausgang steht mit dem Zug fest.
 *
 * Solo-Spiel: Ein Mensch pro Automat, keine Bots.
 */

import { GameEngine, GameError } from '../../core/engine.js';

/**
 * Der Walzenstreifen. Häufige Symbole kommen öfter vor – dadurch ergibt sich
 * die Trefferwahrscheinlichkeit, ohne dass irgendwo geschummelt wird.
 */
export const REEL = [
  'cherry', 'cherry', 'cherry', 'cherry', 'cherry', 'cherry',
  'lemon', 'lemon', 'lemon', 'lemon', 'lemon',
  'bell', 'bell', 'bell', 'bell',
  'clover', 'clover', 'clover',
  'diamond', 'diamond',
  'seven',
];

export const SYMBOLS = {
  cherry: { label: 'Kirsche', icon: '🍒' },
  lemon: { label: 'Zitrone', icon: '🍋' },
  bell: { label: 'Glocke', icon: '🔔' },
  clover: { label: 'Kleeblatt', icon: '🍀' },
  diamond: { label: 'Diamant', icon: '💎' },
  seven: { label: 'Sieben', icon: '7️⃣' },
};

/**
 * Auszahlungstabelle – Vielfaches des Einsatzes.
 *
 * Drei gleiche zahlen groß, zwei gleiche nur bei den selteneren Symbolen.
 * Das ist kein Geschmacksurteil, sondern Rechnung: Ein Paar ist rund
 * zwanzigmal wahrscheinlicher als ein Drilling. Zahlte jedes Paar mit, läge
 * die Auszahlungsquote über 100 % und der Automat würde Chips erzeugen.
 *
 * Mit dieser Tabelle liegt die Quote bei etwa 95 % des Einsatzes, ein Treffer
 * fällt in rund 22 % der Drehs. (Nachgerechnet in test/slots.test.js.)
 */
export const PAYTABLE = {
  three: { seven: 600, diamond: 90, clover: 30, bell: 14, lemon: 9, cherry: 4 },
  two: { seven: 15, diamond: 5, clover: 2, bell: 1, lemon: 0, cherry: 0 },
};

/** Wie lange die Walzen laufen, bevor das Ergebnis steht. */
export const SPIN_MS = 1400;

export class SlotsEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    this.reels = [REEL[0], REEL[6], REEL[11]];
    this.spinning = false;
    this.lastResult = null;
    this.spins = 0;
    this.totalWagered = 0;
    this.totalWon = 0;
  }

  get spinMs() {
    return this.config.spinMs ?? SPIN_MS;
  }

  /** Kein Reihum – wer sitzt, drückt selbst. */
  get actorId() {
    return null;
  }

  act(playerId, action) {
    if (action?.move !== 'spin') {
      throw new GameError('bad_action', 'An diesem Automaten kann man nur drehen.');
    }
    if (this.spinning) throw new GameError('spinning', 'Die Walzen laufen noch.');

    const seat = this.ctx.seats().find((entry) => entry.playerId === playerId);
    if (!seat) throw new GameError('not_seated', 'Setz dich an den Automaten.');

    const wanted = Math.floor(Number(action.amount));
    if (!Number.isFinite(wanted)) throw new GameError('bad_amount', 'Ungültiger Einsatz.');
    const bet = Math.max(this.config.minBet, Math.min(this.config.maxBet, wanted));
    if (this.ctx.wallet.balance(playerId) < bet) {
      throw new GameError('insufficient', 'Dafür reicht dein Guthaben nicht.');
    }

    // Einsatz sofort abbuchen, Ergebnis sofort ziehen – die Animation zeigt
    // danach nur noch, was bereits feststeht.
    this.ctx.wallet.debit(playerId, bet, 'slots:bet');
    const symbols = [0, 1, 2].map(() => this.ctx.rng.pick(REEL));
    const payout = evaluateSpin(symbols, bet);

    this.spinning = true;
    this.spins += 1;
    this.totalWagered += bet;
    this.pending = { playerId, bet, symbols, payout };
    this.ctx.emit({ kind: 'spin', duration: this.spinMs });

    this.ctx.later(() => {
      this.finishSpin();
      this.ctx.sync();
    }, this.spinMs);
  }

  finishSpin() {
    const { playerId, bet, symbols, payout } = this.pending;
    this.reels = symbols;
    this.spinning = false;

    if (payout.amount > 0) {
      this.ctx.wallet.credit(playerId, payout.amount, 'slots:win');
      this.totalWon += payout.amount;
    }
    this.lastResult = {
      playerId,
      bet,
      symbols,
      amount: payout.amount,
      kind: payout.kind,
      symbol: payout.symbol,
      multiplier: payout.multiplier,
      net: payout.amount - bet,
    };
    this.pending = null;
    this.ctx.emit({ kind: 'spin_result', result: this.lastResult });
  }

  publicState() {
    return {
      reels: this.reels,
      spinning: this.spinning,
      result: this.lastResult,
      minBet: this.config.minBet,
      maxBet: this.config.maxBet,
      spinMs: this.spinMs,
      paytable: PAYTABLE,
      symbols: SYMBOLS,
      stats: { spins: this.spins, wagered: this.totalWagered, won: this.totalWon },
    };
  }

  privateState(playerId) {
    return {
      balance: this.ctx.wallet.balance(playerId),
      canSpin: !this.spinning,
    };
  }

  dispose() {
    // Ein laufender Dreh wird noch fertig abgerechnet – der Einsatz ist weg,
    // also muss auch der Gewinn ausgezahlt werden.
    if (this.spinning && this.pending) this.finishSpin();
  }
}

/**
 * Wertet einen Dreh aus.
 * @returns {{amount: number, kind: string|null, symbol: string|null, multiplier: number}}
 */
export function evaluateSpin(symbols, bet) {
  const [a, b, c] = symbols;
  if (a === b && b === c) {
    const multiplier = PAYTABLE.three[a] ?? 0;
    return { amount: bet * multiplier, kind: 'three', symbol: a, multiplier };
  }
  // Zwei gleiche: Es zählt das Symbol, das doppelt vorkommt.
  const pair = a === b ? a : b === c ? b : a === c ? a : null;
  if (pair) {
    const multiplier = PAYTABLE.two[pair] ?? 0;
    return { amount: bet * multiplier, kind: 'two', symbol: pair, multiplier };
  }
  return { amount: 0, kind: null, symbol: null, multiplier: 0 };
}
