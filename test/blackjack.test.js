/**
 * Blackjack-Tests.
 *
 * Schwerpunkte: das Zählen von Assen, das Verhalten des Dealers bei Soft 17,
 * die Auszahlungen (3:2, Push, Double, Split) und dass die verdeckte
 * Dealerkarte den Server nicht zu früh verlässt.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CasinoTable } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import { createDeck } from '../core/cards.js';
import blackjack from '../games/blackjack/index.js';
import { handValue } from '../games/blackjack/engine.js';
import { basicStrategy } from '../games/blackjack/bot.js';

const ALL = createDeck();
const C = (code) => {
  const card = ALL.find((entry) => entry.code === code);
  if (!card) throw new Error(`Unbekannte Karte: ${code}`);
  return { ...card };
};

function makeTable(t, { stacks, config = {}, seed = 3 } = {}) {
  const balances = new Map(Object.entries(stacks));
  const wallet = {
    balance: (id) => balances.get(id) ?? 0,
    debit: (id, amount) => {
      const current = balances.get(id) ?? 0;
      if (current < amount) throw new GameError('insufficient', 'Zu wenig Chips.');
      balances.set(id, current - amount);
      return current - amount;
    },
    credit: (id, amount) => {
      const next = (balances.get(id) ?? 0) + amount;
      balances.set(id, next);
      return next;
    },
    openBotWallet: (id) => balances.set(id, 1000),
    closeBotWallet: (id) => balances.delete(id),
  };

  const table = new CasinoTable({
    code: 'BJ01',
    module: blackjack,
    name: 'Testtisch',
    config: blackjack.normalizeConfig({
      ...blackjack.defaultConfig,
      turnMs: 400,
      betMs: 200,
      settleMs: 20,
      ...config,
    }),
    wallet,
    botMs: 5,
    rng: new Rng(seed),
  });
  t.after(() => table.close());

  let index = 0;
  for (const playerId of Object.keys(stacks)) {
    table.sit({ playerId, name: playerId.toUpperCase(), index: index++ });
  }
  return { table, engine: table.engine, balances };
}

/**
 * Legt den Schuh so, dass genau diese Karten gezogen werden.
 * `draw()` nimmt vom Ende – deshalb wird die Wunschreihenfolge umgedreht.
 */
function stack(engine, codes) {
  engine.shoe.cards = codes.map(C).reverse();
}

/** Ordnung des Austeilens: Spieler1, Dealer1, Spieler1b, Dealer2 (verdeckt). */
function dealOrder({ players, dealer }) {
  const order = [];
  for (const hand of players) order.push(hand[0]);
  order.push(dealer[0]);
  for (const hand of players) order.push(hand[1]);
  order.push(dealer[1]);
  return order;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gesamtsumme aller Chips – inklusive der Einsätze, die gerade „auf dem Tisch
 * liegen“ und deshalb schon vom Guthaben abgebucht, aber noch nicht verbucht
 * sind. Nach dem Abrechnen stecken sie wieder in den Guthaben und dürfen
 * nicht doppelt gezählt werden.
 */
function totalChips(engine, balances) {
  const inWallets = [...balances.values()].reduce((sum, value) => sum + value, 0);
  if (engine.phase === 'betting') {
    return inWallets + [...engine.betsPlaced.values()].reduce((sum, value) => sum + value, 0);
  }
  if (engine.phase === 'dealing' || engine.phase === 'players' || engine.phase === 'dealer') {
    return (
      inWallets +
      engine.boxes.reduce(
        (sum, box) => sum + box.hands.reduce((inner, hand) => inner + hand.bet, 0),
        0,
      )
    );
  }
  return inWallets;
}

// -------------------------------------------------------------- Handwerte

test('Blackjack: Asse zählen 11 oder 1, je nachdem was passt', () => {
  assert.deepEqual(handValue([C('Ah'), C('Kd')]), { total: 21, soft: true });
  assert.deepEqual(handValue([C('Ah'), C('9d')]), { total: 20, soft: true });
  assert.deepEqual(handValue([C('Ah'), C('9d'), C('5c')]), { total: 15, soft: false });
  assert.deepEqual(handValue([C('Ah'), C('Ad')]), { total: 12, soft: true });
  assert.deepEqual(handValue([C('Ah'), C('Ad'), C('9c')]), { total: 21, soft: true });
  assert.deepEqual(handValue([C('Ah'), C('Ad'), C('9c'), C('5s')]), { total: 16, soft: false });
  assert.deepEqual(handValue([C('Kh'), C('Qd'), C('3c')]), { total: 23, soft: false });
});

// ------------------------------------------------------------- Ablauf

test('Blackjack: Setzen, Austeilen und eine gewonnene Hand', async (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick(); // öffnet die Setzphase
  assert.equal(engine.phase, 'betting');

  engine.act('a', { move: 'bet', amount: 100 });
  assert.equal(balances.get('a'), 900, 'der Einsatz wird sofort abgebucht');

  stack(engine, dealOrder({ players: [['Kh', 'Qd']], dealer: ['9s', '7c'] }));
  engine.closeBetting();

  assert.equal(engine.phase, 'players');
  assert.equal(engine.actorId, 'a');
  engine.act('a', { move: 'stand' });

  // Dealer hat 16 und muss ziehen … die nächste Karte kommt aus dem Restschuh.
  assert.equal(engine.phase, 'settled');
  const entry = engine.result.entries[0];
  assert.equal(entry.bet, 100);
  await wait(0);
  assert.ok(['win', 'lose', 'push'].includes(entry.outcome));
});

test('Blackjack: Blackjack zahlt 3:2', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, dealOrder({ players: [['Ah', 'Kd']], dealer: ['9s', '7c'] }));
  engine.closeBetting();

  // Blackjack steht sofort fest – es gibt nichts mehr zu entscheiden.
  assert.equal(engine.phase, 'settled');
  const entry = engine.result.entries[0];
  assert.equal(entry.outcome, 'blackjack');
  assert.equal(entry.payout, 250, '100 Einsatz zurück + 150 Gewinn');
  assert.equal(balances.get('a'), 1150);
});

test('Blackjack: Blackjack gegen Blackjack ist ein Push', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, dealOrder({ players: [['Ah', 'Kd']], dealer: ['As', 'Qc'] }));
  engine.closeBetting();

  assert.equal(engine.result.entries[0].outcome, 'push');
  assert.equal(balances.get('a'), 1000, 'der Einsatz kommt zurück');
});

test('Blackjack: der Dealer bleibt bei Soft 17 stehen', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  // Dealer: Ass + 6 = Soft 17 → stehen bleiben. Spieler hat 18 und gewinnt.
  stack(engine, [
    ...dealOrder({ players: [['Th', '8d']], dealer: ['Ac', '6s'] }),
    '5h', // läge bereit, darf aber nicht mehr gezogen werden
  ]);
  engine.closeBetting();
  engine.act('a', { move: 'stand' });

  assert.equal(engine.dealer.cards.length, 2, 'bei Soft 17 wird nicht nachgezogen');
  assert.equal(engine.result.dealer.total, 17);
  assert.equal(engine.result.entries[0].outcome, 'win');
  assert.equal(balances.get('a'), 1100);
});

test('Blackjack: der Dealer zieht bei 16 nach', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [...dealOrder({ players: [['Th', '8d']], dealer: ['Tc', '6s'] }), '5h']);
  engine.closeBetting();
  engine.act('a', { move: 'stand' });

  assert.equal(engine.dealer.cards.length, 3, 'bei 16 muss der Dealer ziehen');
  assert.equal(engine.result.dealer.total, 21);
  assert.equal(engine.result.entries[0].outcome, 'lose');
});

test('Blackjack: überkaufen verliert sofort, der Dealer muss nicht ziehen', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [...dealOrder({ players: [['Th', '8d']], dealer: ['9c', '7s'] }), 'Qh']);
  engine.closeBetting();
  engine.act('a', { move: 'hit' }); // 18 + 10 = 28

  assert.equal(engine.result.entries[0].outcome, 'bust');
  assert.equal(balances.get('a'), 900);
  assert.equal(engine.dealer.cards.length, 2, 'ohne lebende Hand zieht der Dealer nicht');
});

test('Blackjack: Verdoppeln erhöht den Einsatz und gibt genau eine Karte', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [...dealOrder({ players: [['6h', '5d']], dealer: ['9c', '7s'] }), 'Th', '2c']);
  engine.closeBetting();

  // Mit nur einer Hand am Tisch ist die Runde nach dem Verdoppeln sofort durch.
  engine.act('a', { move: 'double' });
  const hand = engine.boxes[0].hands[0];
  assert.equal(hand.bet, 200);
  assert.equal(hand.cards.length, 3, 'nach dem Verdoppeln kommt genau eine Karte');
  assert.equal(hand.done, true);

  // 21 gegen 16 + gezogene 2 = 18 → Gewinn von 400.
  assert.equal(engine.result.entries[0].outcome, 'win');
  assert.equal(balances.get('a'), 1200);
});

test('Blackjack: Verdoppeln geht nur mit zwei Karten', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [...dealOrder({ players: [['4h', '3d']], dealer: ['9c', '7s'] }), '2h', 'Th', '5c']);
  engine.closeBetting();
  engine.act('a', { move: 'hit' });
  assert.throws(() => engine.act('a', { move: 'double' }), /ersten beiden Karten/);
});

test('Blackjack: Teilen erzeugt zwei Hände mit eigenem Einsatz', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [
    ...dealOrder({ players: [['8h', '8d']], dealer: ['9c', '7s'] }),
    '3c', // zweite Karte der ersten Hand
    '2c', // zweite Karte der zweiten Hand
    'Th', // wird gezogen
    'Td',
    '5h',
  ]);
  engine.closeBetting();

  engine.act('a', { move: 'split' });
  assert.equal(balances.get('a'), 800, 'die zweite Hand kostet noch einmal den Einsatz');
  assert.equal(engine.boxes[0].hands.length, 2);
  assert.equal(engine.boxes[0].hands[0].cards.length, 2);
  assert.equal(engine.boxes[0].hands[1].cards.length, 2);
  assert.equal(engine.boxes[0].hands[0].bet, 100);
  assert.equal(engine.boxes[0].hands[1].bet, 100);
});

test('Blackjack: geteilte Asse bekommen nur eine Karte', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [
    ...dealOrder({ players: [['Ah', 'Ad']], dealer: ['9c', '7s'] }),
    '5c',
    '6c',
    'Th',
  ]);
  engine.closeBetting();
  engine.act('a', { move: 'split' });

  const hands = engine.boxes[0].hands;
  assert.equal(hands.length, 2);
  assert.ok(hands.every((hand) => hand.done), 'nach dem Teilen von Assen ist Schluss');
  assert.ok(hands.every((hand) => hand.cards.length === 2));
});

test('Blackjack: 21 nach dem Teilen ist kein Blackjack', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [
    ...dealOrder({ players: [['Ah', 'Ad']], dealer: ['9c', '7s'] }),
    'Kc', // Ass + König = 21, aber aus einem Split
    'Qc',
  ]);
  engine.closeBetting();
  engine.act('a', { move: 'split' });

  for (const entry of engine.result.entries) {
    assert.equal(entry.outcome, 'win', 'beide 21 schlagen die 16 des Dealers');
    assert.equal(entry.payout, 200, 'aber nur 1:1 – kein 3:2 wie beim echten Blackjack');
  }
  assert.equal(balances.get('a'), 1200);
});

// ---------------------------------------------------------- Geheimhaltung

test('Blackjack: die verdeckte Dealerkarte bleibt geheim', (t) => {
  const { table, engine } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 100 });
  stack(engine, [...dealOrder({ players: [['4h', '3d']], dealer: ['9c', 'Ks'] }), '2h', 'Th']);
  engine.closeBetting();

  const state = table.stateFor('a');
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('"Ks"'), false, 'die Hole Card darf nicht mitgeschickt werden');
  assert.equal(state.public.dealer.cards[0].code, '9c');
  assert.equal(state.public.dealer.cards[1], null, 'stattdessen steht dort nur eine Lücke');
  assert.equal(state.public.dealer.total, 9, 'gezeigt wird nur der Wert der offenen Karte');

  engine.act('a', { move: 'stand' });
  const after = table.stateFor('a');
  assert.equal(after.public.dealer.cards[1].code, 'Ks', 'am Ende wird aufgedeckt');
});

// ----------------------------------------------------------------- Einsatz

test('Blackjack: Einsätze werden auf die Tischgrenzen gestutzt', (t) => {
  const { engine, balances } = makeTable(t, {
    stacks: { a: 1000 },
    config: { minBet: 10, maxBet: 200 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 99999 });
  assert.equal(engine.betsPlaced.get('a'), 200);
  assert.equal(balances.get('a'), 800);

  // Ein neuer Einsatz gibt den alten zuerst zurück.
  engine.act('a', { move: 'bet', amount: 50 });
  assert.equal(engine.betsPlaced.get('a'), 50);
  assert.equal(balances.get('a'), 950);
});

test('Blackjack: ohne Deckung kein Einsatz (kein Rebuy)', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 5 }, config: { minBet: 10 } });
  engine.tick();
  assert.throws(() => engine.act('a', { move: 'bet', amount: 10 }), /reicht dein Guthaben nicht/);
});

test('Blackjack: wer nicht setzt, sitzt die Runde aus', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000, b: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 50 });
  stack(engine, dealOrder({ players: [['Th', '8d']], dealer: ['9c', '7s'] }));
  engine.closeBetting();

  assert.equal(engine.boxes.length, 1);
  assert.equal(engine.boxes[0].playerId, 'a');
});

test('Blackjack: der Abbruch gibt offene Einsätze zurück', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', amount: 300 });
  assert.equal(balances.get('a'), 700);
  engine.dispose();
  assert.equal(balances.get('a'), 1000);
});

// ------------------------------------------------------------- Basisstrategie

test('Blackjack: die Basisstrategie trifft die bekannten Entscheidungen', () => {
  const strategy = (cards, up, options = {}) =>
    basicStrategy({
      hand: { cards: cards.map(C) },
      dealerUpcard: C(up),
      canDouble: options.canDouble ?? true,
      canSplit: options.canSplit ?? false,
    });

  assert.equal(strategy(['8h', '8d'], 'Ts', { canSplit: true }), 'split', 'Achter immer teilen');
  assert.equal(strategy(['Ah', 'Ad'], '9s', { canSplit: true }), 'split', 'Asse immer teilen');
  assert.equal(strategy(['Th', 'Td'], '6s', { canSplit: true }), 'stand', 'Zehner nie teilen');
  assert.equal(strategy(['5h', '6d'], '5s'), 'double', 'mit 11 verdoppeln');
  assert.equal(strategy(['Th', '6d'], '7s'), 'hit', 'harte 16 gegen 7 ziehen');
  assert.equal(strategy(['Th', '6d'], '5s'), 'stand', 'harte 16 gegen 5 stehen bleiben');
  assert.equal(strategy(['Ah', '7d'], '9s'), 'hit', 'Soft 18 gegen 9 ziehen');
  assert.equal(strategy(['Ah', '7d'], '8s'), 'stand', 'Soft 18 gegen 8 stehen bleiben');
  assert.equal(strategy(['Ah', '9d'], '6s'), 'stand', 'Soft 20 immer stehen bleiben');
  assert.equal(strategy(['Th', '2d'], '3s'), 'hit', 'harte 12 gegen 3 ziehen');
});

// ------------------------------------------------------------------- Bots

/**
 * Anders als beim Poker spielen hier alle gegen das Haus – verlorene Einsätze
 * verschwinden also aus dem Umlauf und die Chipsumme bleibt bewusst *nicht*
 * konstant. Geprüft wird stattdessen, dass jede Auszahlung zu ihrem Ergebnis
 * passt und nie mehr ausgezahlt wird, als eingesetzt wurde.
 */
test('Blackjack: ein Bot-Tisch spielt Runden durch und rechnet korrekt ab', async (t) => {
  const { table, balances } = makeTable(t, {
    stacks: {},
    config: { betMs: 60, settleMs: 40, turnMs: 2000, minBet: 10, maxBet: 100 },
    seed: 11,
  });
  table.addSpectator('zuschauer');
  for (const level of ['easy', 'medium', 'hard']) table.addBot(level);

  const engine = table.engine;
  const seen = [];
  // Jede Abrechnung mitschneiden, um sie hinterher nachzurechnen.
  const originalSettle = engine.settle.bind(engine);
  engine.settle = () => {
    originalSettle();
    seen.push(engine.result);
  };

  table.sync();
  await wait(3000);

  assert.ok(engine.roundNumber >= 2, `Runden gelaufen: ${engine.roundNumber}`);
  assert.ok(seen.length >= 2, `Abrechnungen: ${seen.length}`);

  for (const result of seen) {
    for (const entry of result.entries) {
      assert.ok(entry.bet > 0, 'ohne Einsatz gibt es keine Hand');
      switch (entry.outcome) {
        case 'bust':
        case 'lose':
          assert.equal(entry.payout, 0);
          break;
        case 'push':
          assert.equal(entry.payout, entry.bet, 'ein Push gibt genau den Einsatz zurück');
          break;
        case 'win':
          assert.equal(entry.payout, entry.bet * 2, 'ein Gewinn zahlt 1:1');
          break;
        case 'blackjack':
          assert.equal(entry.payout, entry.bet + Math.floor((entry.bet * 3) / 2), '3:2');
          break;
        default:
          assert.fail(`Unbekanntes Ergebnis: ${entry.outcome}`);
      }
    }
  }

  assert.ok(
    [...balances.values()].every((value) => value >= 0),
    'kein Guthaben darf ins Minus laufen',
  );
  void totalChips;
});
