/**
 * Texas-Hold'em-Tests.
 *
 * Schwerpunkt sind die Stellen, an denen Poker gern subtil falsch wird:
 * Blinds und Button-Rotation, Mindesterhöhungen, das kurze All-in, das die
 * Setzrunde *nicht* neu eröffnet, Side-Pots und die Chip-Erhaltung.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CasinoTable } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import { createDeck } from '../core/cards.js';
import holdem from '../games/holdem/index.js';

const ALL = createDeck();
const C = (code) => {
  const card = ALL.find((entry) => entry.code === code);
  if (!card) throw new Error(`Unbekannte Karte: ${code}`);
  return { ...card };
};

/** Tisch mit eigenem Wallet, damit Chips exakt nachrechenbar sind. */
function makePokerTable(t, { stacks, config = {}, seed = 1 } = {}) {
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
    openBotWallet: (id) => balances.set(id, stacks.bot ?? 1000),
    closeBotWallet: (id) => balances.delete(id),
  };

  const table = new CasinoTable({
    code: 'PKR1',
    module: holdem,
    name: 'Testtisch',
    config: holdem.normalizeConfig({
      ...holdem.defaultConfig,
      turnMs: 400,
      // Anzeigepausen aus – sonst müssten die Tests in Echtzeit warten.
      showdownMs: 20,
      foldWinMs: 20,
      nextHandMs: 10,
      runOutMs: 5,
      ...config,
    }),
    wallet,
    botMs: 5,
    rng: new Rng(seed),
  });
  t.after(() => table.close());

  let index = 0;
  for (const playerId of Object.keys(stacks)) {
    if (playerId === 'bot') continue;
    table.sit({ playerId, name: playerId.toUpperCase(), index: index++ });
  }
  return { table, engine: table.engine, balances, wallet };
}

const totalChips = (balances, engine) =>
  [...balances.values()].reduce((sum, value) => sum + value, 0) +
  engine.players.reduce((sum, player) => sum + player.total, 0);

/**
 * Legt Hole Cards und Board fest. Der Reststapel wird so gebaut, dass die
 * Engine beim Aufdecken genau diese Karten zieht (inkl. der Burn-Cards).
 */
function rig(engine, { hands = {}, board = [] } = {}) {
  const used = [];
  for (const [playerId, codes] of Object.entries(hands)) {
    const player = engine.playerOf(playerId);
    if (!player) throw new Error(`Kein Spieler ${playerId} in der Hand`);
    player.cards = codes.map(C);
    used.push(...codes);
  }
  used.push(...board);

  const spare = ALL.filter((card) => !used.includes(card.code)).map((card) => ({ ...card }));
  const burn = () => spare.pop();
  const boardCards = board.map(C);
  // Reihenfolge, in der die Engine zieht: Burn, Flop×3, Burn, Turn, Burn, River.
  const order = [
    burn(),
    ...boardCards.slice(0, 3),
    burn(),
    boardCards[3],
    burn(),
    boardCards[4],
  ].filter(Boolean);
  // `deck.pop()` nimmt vom Ende – deshalb umgedreht ablegen.
  engine.deck = [...spare, ...order.reverse()];
}

/** Startet sofort eine Hand (im Betrieb passiert das mit kurzer Pause). */
function startHand(engine) {
  engine.startHand();
  return engine;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wartet, bis die Hand durch ist. Sind alle all-in, deckt die Engine das
 * Board bewusst mit Pausen auf – das ist asynchron und muss abgewartet werden.
 */
async function settle(engine, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!['showdown', 'payout', 'waiting'].includes(engine.phase)) {
    if (Date.now() > deadline) throw new Error(`Hand blieb in Phase "${engine.phase}" hängen`);
    await wait(5);
  }
  return engine.phase;
}

// ------------------------------------------------------------- Blinds

test("Hold'em: Blinds und erste Aktion bei drei Spielern", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 0;
  // nextButtonSeat() rückt weiter – vorher auf den letzten Platz stellen.
  engine.buttonSeat = 2;
  startHand(engine);

  assert.equal(engine.buttonSeat, 0, 'der Button wandert reihum');
  const [a, b, c] = engine.players;
  assert.equal(a.committed, 0, 'der Button zahlt keinen Blind');
  assert.equal(b.committed, 5, 'links vom Button steht der Small Blind');
  assert.equal(c.committed, 10, 'danach der Big Blind');
  assert.equal(engine.currentBet, 10);
  assert.equal(engine.minRaise, 10);
  assert.equal(engine.actorId, 'a', 'preflop beginnt links vom Big Blind');
});

test("Hold'em: heads-up ist der Button der Small Blind und handelt zuerst", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);

  assert.equal(engine.buttonSeat, 0);
  const [a, b] = engine.players;
  assert.equal(a.committed, 5, 'der Button zahlt heads-up den Small Blind');
  assert.equal(b.committed, 10);
  assert.equal(engine.actorId, 'a', 'preflop handelt der Button zuerst');

  // Postflop dreht sich die Reihenfolge um.
  engine.act('a', { move: 'call' });
  engine.act('b', { move: 'check' });
  assert.equal(engine.phase, 'flop');
  assert.equal(engine.actorId, 'b', 'postflop handelt der Big Blind zuerst');
});

test("Hold'em: der Big Blind darf preflop noch erhöhen (Option)", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  engine.act('a', { move: 'call' });
  engine.act('b', { move: 'call' });
  assert.equal(engine.actorId, 'c', 'der Big Blind kommt trotz gleichem Einsatz zu Wort');
  assert.equal(engine.optionsFor('c').canCheck, true);
  assert.equal(engine.optionsFor('c').canRaise, true);

  engine.act('c', { move: 'raise', amount: 30 });
  assert.equal(engine.currentBet, 30);
  assert.equal(engine.actorId, 'a', 'nach der Erhöhung sind alle wieder dran');
});

// ------------------------------------------------------- Mindesterhöhung

test("Hold'em: Mindesterhöhung wird durchgesetzt", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  assert.throws(() => engine.act('a', { move: 'raise', amount: 15 }), /Mindestens 20/);
  assert.throws(() => engine.act('a', { move: 'raise', amount: 10 }), /erhöhst du gar nicht/);

  engine.act('a', { move: 'raise', amount: 20 });
  assert.equal(engine.currentBet, 20);
  assert.equal(engine.minRaise, 10);

  // Die nächste Erhöhung muss die vorige Erhöhung (10) mindestens wiederholen.
  assert.throws(() => engine.act('b', { move: 'raise', amount: 25 }), /Mindestens 30/);
  engine.act('b', { move: 'raise', amount: 50 });
  assert.equal(engine.minRaise, 30, 'die Erhöhung war 30 – so viel gilt ab jetzt');
});

test("Hold'em: ein kurzes All-in eröffnet die Setzrunde nicht neu", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 130, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  engine.act('a', { move: 'raise', amount: 100 });
  engine.act('b', { move: 'allin' }); // 130 gesamt – nur +30 statt der nötigen +90
  assert.equal(engine.currentBet, 130);
  assert.equal(engine.minRaise, 90, 'die Mindesterhöhung bleibt bei der letzten vollen Erhöhung');

  engine.act('c', { move: 'fold' });
  assert.equal(engine.actorId, 'a', 'A muss die 30 noch entscheiden');
  const options = engine.optionsFor('a');
  assert.equal(options.canCall, true);
  assert.equal(options.callAmount, 30);
  assert.equal(options.canRaise, false, 'nach kurzem All-in darf A nicht erneut erhöhen');
  assert.throws(() => engine.act('a', { move: 'raise', amount: 400 }), /nur mitgehen oder aussteigen/);
});

test("Hold'em: eine volle Erhöhung eröffnet die Setzrunde neu", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  engine.act('a', { move: 'raise', amount: 30 });
  engine.act('b', { move: 'call' });
  engine.act('c', { move: 'raise', amount: 90 });
  assert.equal(engine.actorId, 'a');
  assert.equal(engine.optionsFor('a').canRaise, true, 'nach voller Erhöhung darf A wieder erhöhen');
});

// ------------------------------------------------------------- Showdown

test("Hold'em: der Showdown wertet über alle sieben Karten aus", (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);
  rig(engine, {
    hands: { a: ['Ah', 'Kh'], b: ['2c', '7d'] },
    board: ['Qh', 'Jh', 'Th', '3s', '4d'],
  });

  engine.act('a', { move: 'call' });
  engine.act('b', { move: 'check' });
  engine.act('b', { move: 'check' });
  engine.act('a', { move: 'check' });
  engine.act('b', { move: 'check' });
  engine.act('a', { move: 'check' });
  engine.act('b', { move: 'check' });
  engine.act('a', { move: 'check' });

  assert.equal(engine.phase, 'showdown');
  assert.equal(engine.result.winners.length, 1);
  assert.equal(engine.result.winners[0].playerId, 'a');
  assert.match(engine.result.winners[0].hand, /Royal Flush/i);
  assert.equal(balances.get('a'), 1010);
  assert.equal(balances.get('b'), 990);
});

test("Hold'em: geteilter Pot bei gleichwertigen Händen", (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);
  // Das Board ist die beste Hand für beide – der Pot wird geteilt.
  rig(engine, {
    hands: { a: ['2c', '3d'], b: ['2h', '3s'] },
    board: ['Ah', 'Ad', 'Ac', 'Ks', 'Kd'],
  });

  engine.act('a', { move: 'call' });
  engine.act('b', { move: 'check' });
  for (let i = 0; i < 6; i++) engine.act(engine.actorId, { move: 'check' });

  assert.equal(engine.result.winners.length, 2, 'beide bekommen etwas');
  assert.equal(balances.get('a'), 1000);
  assert.equal(balances.get('b'), 1000);
});

test("Hold'em: ein zu kleiner Big Blind ändert nichts am zu zahlenden Einsatz", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 7 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2; // → Button auf Sitz 0 (a)
  startHand(engine);

  const c = engine.playerOf('c');
  assert.equal(c.committed, 7, 'C konnte den Big Blind nur teilweise stellen');
  assert.equal(c.allIn, true);
  assert.equal(engine.currentBet, 10, 'gezahlt werden muss trotzdem der volle Big Blind');
});

test("Hold'em: ungerade Chips gehen an den ersten Spieler links vom Button", (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 7 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2; // → Button auf Sitz 0 (a), Small Blind ist B
  startHand(engine);
  // A und B halten dasselbe Paar Zweien und teilen sich alles;
  // C ist mit 7 Chips all-in und hat nur eine hohe Karte.
  rig(engine, {
    hands: { a: ['2h', '3d'], b: ['2s', '3c'], c: ['5c', '6d'] },
    board: ['2c', '7d', '9h', 'Jd', '4s'],
  });

  engine.act('a', { move: 'call' }); // auf 10
  engine.act('b', { move: 'call' }); // Small Blind gleicht auf 10 aus
  for (let i = 0; i < 6 && engine.actorId; i++) engine.act(engine.actorId, { move: 'check' });

  assert.equal(engine.phase, 'showdown');
  assert.equal(engine.result.pot, 27, '10 + 10 + 7');
  const winners = Object.fromEntries(
    engine.result.winners.map((entry) => [entry.playerId, entry.amount]),
  );
  // Hauptpot 21 (3 × 7) teilen sich A und B → 10 und 11, der ungerade Chip geht
  // an den ersten Spieler links vom Button, also B auf Sitz 1.
  // Nebenpot 6 (2 × 3) ebenfalls geteilt → je 3.
  assert.equal(winners.a, 13);
  assert.equal(winners.b, 14);
  assert.equal(balances.get('a') + balances.get('b') + balances.get('c'), 2007);
});

test("Hold'em: wer alle anderen zum Aussteigen bringt, gewinnt ohne Showdown", (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  engine.act('a', { move: 'raise', amount: 50 });
  engine.act('b', { move: 'fold' });
  engine.act('c', { move: 'fold' });

  assert.equal(engine.phase, 'payout');
  assert.equal(engine.result.showdown, false);
  assert.equal(engine.result.reveal.length, 0, 'ohne Showdown wird nichts aufgedeckt');
  assert.equal(balances.get('a'), 1015, 'A bekommt seinen Einsatz plus die Blinds');
  assert.equal(balances.get('b'), 995);
  assert.equal(balances.get('c'), 990);
});

// ------------------------------------------------------------ Side-Pots

test("Hold'em: Side-Pots bei ungleichen Stacks", async (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 100, b: 300, c: 500 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);
  // A hat die beste Hand, B die zweitbeste, C die schlechteste.
  rig(engine, {
    hands: { a: ['Ah', 'As'], b: ['Kh', 'Ks'], c: ['Qh', 'Qs'] },
    board: ['2c', '7d', '9h', 'Jd', '4s'],
  });

  engine.act('a', { move: 'allin' }); // 100
  engine.act('b', { move: 'allin' }); // 300
  engine.act('c', { move: 'call' }); // gleicht auf 300 aus

  // Alle sind all-in – die Engine deckt das Board mit kurzen Pausen auf.
  await settle(engine);
  assert.equal(engine.phase, 'showdown');
  // Hauptpot: 3 × 100 = 300 → A (Asse).
  // Side-Pot: 2 × 200 = 400 → B (Könige), denn A ist dort nicht dabei.
  assert.equal(balances.get('a'), 300, 'A gewinnt nur bis zur Höhe seines eigenen Einsatzes');
  assert.equal(balances.get('b'), 400);
  assert.equal(balances.get('c'), 200, 'C bekommt den nicht abgegoltenen Rest zurück');
  assert.equal(balances.get('a') + balances.get('b') + balances.get('c'), 900);
});

test("Hold'em: eine nicht mitgegangene Erhöhung kommt zurück", async (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 1000, b: 200 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);
  rig(engine, {
    hands: { a: ['Ah', 'As'], b: ['2c', '7d'] },
    board: ['3c', '8d', '9h', 'Jd', '4s'],
  });

  engine.act('a', { move: 'raise', amount: 600 });
  engine.act('b', { move: 'allin' }); // nur 200 – das ist ein Mitgehen für weniger
  // A muss nichts mehr entscheiden: Es gibt niemanden mehr, der mitgehen könnte.
  assert.equal(engine.actorId, null);

  await settle(engine);
  assert.equal(engine.phase, 'showdown');
  // A riskiert effektiv nur 200 und gewinnt 400; die restlichen 400 sind zurück.
  assert.equal(balances.get('a'), 1200);
  assert.equal(balances.get('b'), 0);
});

// ----------------------------------------------------- Geheimhaltung

test("Hold'em: fremde Hole Cards verlassen den Server nicht", (t) => {
  const { table, engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);
  rig(engine, { hands: { a: ['Ah', 'As'], b: ['2c', '7d'] } });

  const stateB = table.stateFor('b');
  const serialized = JSON.stringify(stateB.public);
  assert.equal(serialized.includes('"Ah"'), false, 'A-Karten dürfen bei B nicht auftauchen');
  assert.equal(serialized.includes('"As"'), false);
  assert.deepEqual(
    stateB.private.cards.map((card) => card.code),
    ['2c', '7d'],
    'seine eigenen sieht B natürlich',
  );
  // Öffentlich ist nur die Anzahl.
  assert.equal(stateB.public.players.find((p) => p.playerId === 'a').cardCount, 2);
  assert.equal(stateB.public.players.find((p) => p.playerId === 'a').cards, null);

  // Ein Zuschauer sieht gar keine Karten.
  const spectator = table.stateFor('zuschauer');
  assert.equal(spectator.private, null);
});

test("Hold'em: beim Showdown werden die Karten der Verbliebenen aufgedeckt", (t) => {
  const { table, engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);
  rig(engine, {
    hands: { a: ['Ah', 'As'], b: ['2c', '7d'] },
    board: ['3c', '8d', '9h', 'Jd', '4s'],
  });

  engine.act('a', { move: 'call' });
  engine.act('b', { move: 'check' });
  for (let i = 0; i < 6; i++) engine.act(engine.actorId, { move: 'check' });

  const state = table.stateFor('zuschauer');
  const cardsOfA = state.public.players.find((p) => p.playerId === 'a').cards;
  assert.deepEqual(
    cardsOfA.map((card) => card.code),
    ['Ah', 'As'],
    'nach dem Showdown liegen die Karten offen',
  );
});

// --------------------------------------------------------------- Sonstiges

test("Hold'em: Zeitüberschreitung checkt, wenn es nichts kostet – sonst Fold", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  // A steht vor dem Big Blind → Aussteigen.
  engine.timeout('a');
  assert.equal(engine.playerOf('a').folded, true);

  engine.act('b', { move: 'call' });
  engine.timeout('c'); // Big Blind, nichts zu zahlen → Check
  assert.equal(engine.playerOf('c').folded, false);
  assert.equal(engine.phase, 'flop');
});

test("Hold'em: wer pleite ist, sitzt die Hand aus (kein Rebuy)", (t) => {
  const { engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 0, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  assert.equal(engine.players.length, 2, 'B hat keine Chips und wird nicht ausgeteilt');
  assert.equal(
    engine.players.some((player) => player.playerId === 'b'),
    false,
  );
});

test("Hold'em: wer den Tisch mitten in der Hand verlässt, steigt aus", (t) => {
  const { table, engine } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 2;
  startHand(engine);

  engine.act('a', { move: 'call' });
  table.stand('b');
  assert.equal(engine.playerOf('b').folded, true);
});

test("Hold'em: der Abbruch gibt laufende Einsätze zurück", (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  engine.buttonSeat = 1;
  startHand(engine);
  engine.act('a', { move: 'raise', amount: 200 });

  assert.equal(balances.get('a'), 800);
  engine.dispose();
  assert.equal(balances.get('a'), 1000, 'nach dem Abbruch ist alles wieder da');
  assert.equal(balances.get('b'), 1000);
});

// ------------------------------------------------------------------ Bots

test("Hold'em: ein reiner Bot-Tisch spielt Hände zu Ende", async (t) => {
  const { table, balances } = makePokerTable(t, {
    stacks: { zuschauer: 0 },
    config: { smallBlind: 5, bigBlind: 10, turnMs: 2000 },
    seed: 99,
  });
  // Ein Mensch schaut zu (sonst spielen die Bots bewusst nicht weiter).
  table.addSpectator('zuschauer');
  for (const level of ['easy', 'medium', 'hard']) table.addBot(level);

  const startTotal = [...balances.values()].reduce((sum, value) => sum + value, 0);
  table.sync();

  // Mehrere Hände laufen lassen.
  await wait(4000);

  const engine = table.engine;
  assert.ok(engine.handNumber >= 2, `es müssen Hände gelaufen sein (waren: ${engine.handNumber})`);

  const endTotal =
    [...balances.values()].reduce((sum, value) => sum + value, 0) +
    engine.players.reduce((sum, player) => sum + player.total, 0);
  assert.equal(endTotal, startTotal, 'Chips dürfen weder entstehen noch verschwinden');
});

test("Hold'em: die Chipsumme bleibt über eine ganze Hand konstant", async (t) => {
  const { engine, balances } = makePokerTable(t, {
    stacks: { a: 500, b: 700, c: 300 },
    config: { smallBlind: 5, bigBlind: 10 },
  });
  const before = [...balances.values()].reduce((sum, value) => sum + value, 0);
  engine.buttonSeat = 2;
  startHand(engine);
  rig(engine, {
    hands: { a: ['Ah', 'As'], b: ['Kh', 'Ks'], c: ['Qh', 'Qs'] },
    board: ['2c', '7d', '9h', 'Jd', '4s'],
  });

  engine.act('a', { move: 'raise', amount: 60 });
  engine.act('b', { move: 'call' });
  engine.act('c', { move: 'allin' });
  engine.act('a', { move: 'call' });
  engine.act('b', { move: 'call' });

  assert.equal(totalChips(balances, engine), before, 'auch mitten in der Hand stimmt die Summe');

  // C ist all-in, A und B haben noch Chips und checken die restlichen Straßen durch.
  for (let i = 0; i < 8 && engine.actorId; i++) engine.act(engine.actorId, { move: 'check' });
  await settle(engine);
  assert.equal(engine.phase, 'showdown');
  // Nach der Auszahlung liegt alles wieder in den Guthaben (`total` ist dann
  // nur noch die Historie der Hand und darf nicht mitgezählt werden).
  const after = [...balances.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(after, before, 'und nach der Auszahlung erst recht');
});
