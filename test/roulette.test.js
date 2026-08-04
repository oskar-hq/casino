/**
 * Roulette-Tests.
 *
 * Schwerpunkte: die Zahlenmengen und Quoten aller Wettarten (das ist die
 * eigentliche Fehlerquelle), die Gleichverteilung des Rades und dass die
 * gefallene Zahl vor dem Dreh nirgends im Zustand auftaucht.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CasinoTable } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import roulette from '../games/roulette/index.js';
import {
  BET_TYPES,
  RED_NUMBERS,
  WHEEL_ORDER,
  betPayout,
  colorOf,
  parseBet,
} from '../games/roulette/bets.js';

function makeTable(t, { stacks = { a: 1000 }, config = {}, seed = 5 } = {}) {
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
    code: 'RL01',
    module: roulette,
    name: 'Kessel',
    config: roulette.normalizeConfig({
      ...roulette.defaultConfig,
      // Eigene Grenzen: Die Tests rechnen mit kleinen, gut lesbaren Betraegen
      // und sollen nicht kaputtgehen, wenn die Tischtarife neu gesetzt werden.
      minBet: 1,
      maxBet: 1_000_000,
      betMs: 200,
      spinMs: 20,
      resultMs: 20,
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- Das Rad

test('Roulette: das Rad hat 37 Fächer, jede Zahl genau einmal', () => {
  assert.equal(WHEEL_ORDER.length, 37);
  assert.equal(new Set(WHEEL_ORDER).size, 37);
  for (let n = 0; n <= 36; n++) assert.ok(WHEEL_ORDER.includes(n), `${n} fehlt`);
});

test('Roulette: 18 rote, 18 schwarze und die grüne Null', () => {
  assert.equal(RED_NUMBERS.size, 18);
  assert.equal(colorOf(0), 'green');
  const schwarz = [];
  for (let n = 1; n <= 36; n++) if (colorOf(n) === 'black') schwarz.push(n);
  assert.equal(schwarz.length, 18);
  // Stichproben nach dem echten Tableau.
  assert.equal(colorOf(1), 'red');
  assert.equal(colorOf(2), 'black');
  assert.equal(colorOf(19), 'red');
  assert.equal(colorOf(36), 'red');
});

test('Roulette: jede Zahl fällt gleich oft', () => {
  const rng = new Rng();
  const counts = new Array(37).fill(0);
  const draws = 74_000;
  for (let i = 0; i < draws; i++) counts[rng.int(37)] += 1;
  const expected = draws / 37;
  for (let n = 0; n <= 36; n++) {
    assert.ok(
      Math.abs(counts[n] - expected) < expected * 0.15,
      `Zahl ${n}: erwartet ~${Math.round(expected)}, war ${counts[n]}`,
    );
  }
});

// ------------------------------------------------------------ Wettarten

test('Roulette: Plein deckt genau eine Zahl ab und zahlt 35:1', () => {
  const bet = parseBet('straight', 17);
  assert.deepEqual(bet.numbers, [17]);
  assert.equal(bet.payout, 35);
  assert.equal(betPayout(bet, 10, 17), 360, 'Einsatz zurück plus 350');
  assert.equal(betPayout(bet, 10, 18), 0);

  assert.equal(parseBet('straight', 37), null, '37 gibt es nicht');
  assert.equal(parseBet('straight', -1), null);
  assert.ok(parseBet('straight', 0), 'auf die Null darf man setzen');
});

test('Roulette: Cheval nur auf wirklich benachbarte Zahlen', () => {
  assert.deepEqual(parseBet('split', [1, 2]).numbers, [1, 2], 'waagerecht');
  assert.deepEqual(parseBet('split', [1, 4]).numbers, [1, 4], 'senkrecht');
  assert.deepEqual(parseBet('split', [35, 36]).numbers, [35, 36]);
  assert.ok(parseBet('split', [0, 1]), 'Null und 1 grenzen aneinander');

  assert.equal(parseBet('split', [1, 5]), null, 'diagonal ist kein Cheval');
  assert.equal(parseBet('split', [3, 4]), null, 'über den Reihenrand hinweg nicht');
  assert.equal(parseBet('split', [1, 1]), null, 'zweimal dieselbe Zahl nicht');
  assert.equal(parseBet('split', [1]), null);
  assert.equal(parseBet('split', 17), null);
});

test('Roulette: Transversale und Sixainne', () => {
  assert.deepEqual(parseBet('street', 1).numbers, [1, 2, 3]);
  assert.deepEqual(parseBet('street', 34).numbers, [34, 35, 36]);
  assert.equal(parseBet('street', 2), null, 'eine Querreihe beginnt bei 1, 4, 7 …');

  assert.deepEqual(parseBet('line', 1).numbers, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseBet('line', 31).numbers, [31, 32, 33, 34, 35, 36]);
  assert.equal(parseBet('line', 34), null, 'nach 34 kommt keine zweite Reihe mehr');
  assert.equal(parseBet('line', 1).payout, 5);
});

test('Roulette: Carré deckt vier Zahlen um eine Ecke ab', () => {
  assert.deepEqual(parseBet('corner', 1).numbers, [1, 2, 4, 5]);
  assert.deepEqual(parseBet('corner', 32).numbers, [32, 33, 35, 36]);
  assert.equal(parseBet('corner', 3), null, 'rechts von der 3 ist Schluss');
  assert.equal(parseBet('corner', 34), null, 'in der letzten Reihe gibt es keine Ecke');
  assert.equal(parseBet('corner', 1).payout, 8);
});

test('Roulette: Trio nur in den klassischen Kombinationen mit der Null', () => {
  assert.deepEqual(parseBet('trio', [0, 1, 2]).numbers, [0, 1, 2]);
  assert.deepEqual(parseBet('trio', [0, 2, 3]).numbers, [0, 2, 3]);
  assert.equal(parseBet('trio', [0, 1, 3]), null);
  assert.equal(parseBet('trio', [1, 2, 3]), null, 'ohne Null ist es eine Transversale');
});

test('Roulette: Dutzende und Kolonnen', () => {
  assert.equal(parseBet('dozen', 1).numbers.length, 12);
  assert.deepEqual(parseBet('dozen', 1).numbers[0], 1);
  assert.deepEqual(parseBet('dozen', 3).numbers.at(-1), 36);
  assert.equal(parseBet('dozen', 4), null);

  const erste = parseBet('column', 1).numbers;
  assert.equal(erste.length, 12);
  assert.deepEqual(erste.slice(0, 4), [1, 4, 7, 10], 'die erste Kolonne geht 1, 4, 7 …');
  assert.deepEqual(parseBet('column', 3).numbers.slice(0, 3), [3, 6, 9]);
  assert.equal(parseBet('column', 1).payout, 2);
});

test('Roulette: die einfachen Chancen decken je 18 Zahlen ab – ohne die Null', () => {
  for (const type of ['red', 'black', 'even', 'odd', 'low', 'high']) {
    const bet = parseBet(type, null);
    assert.equal(bet.numbers.length, 18, `${type} muss 18 Zahlen abdecken`);
    assert.equal(bet.numbers.includes(0), false, `${type} darf die Null nicht enthalten`);
    assert.equal(bet.payout, 1);
  }
  assert.equal(parseBet('even', null).numbers.includes(2), true);
  assert.equal(parseBet('odd', null).numbers.includes(2), false);
  assert.equal(parseBet('low', null).numbers.at(-1), 18);
  assert.equal(parseBet('high', null).numbers[0], 19);
});

test('Roulette: bei der Null verlieren alle Außenwetten', () => {
  for (const type of ['red', 'black', 'even', 'odd', 'low', 'high']) {
    assert.equal(betPayout(parseBet(type, null), 100, 0), 0, `${type} muss bei 0 verlieren`);
  }
  assert.equal(betPayout(parseBet('dozen', 1), 100, 0), 0);
  assert.equal(betPayout(parseBet('column', 2), 100, 0), 0);
  assert.equal(betPayout(parseBet('straight', 0), 10, 0), 360, 'nur das Plein auf die Null zahlt');
});

test('Roulette: alle Quoten passen zur Anzahl abgedeckter Zahlen', () => {
  // Bei fairem Spiel wäre die Quote (37 - k) / k. Der Hausvorteil entsteht
  // dadurch, dass stattdessen (36 - k) / k gezahlt wird – bei jeder Wettart gleich.
  for (const [type, definition] of Object.entries(BET_TYPES)) {
    const bet = parseBet(type, sampleArg(type));
    assert.ok(bet, `${type} ließ sich nicht bauen`);
    assert.equal(bet.numbers.length, definition.size, `${type}: falsche Feldgröße`);
    assert.equal(
      definition.payout,
      (36 - definition.size) / definition.size,
      `${type}: Quote passt nicht zur Feldgröße`,
    );
  }
});

test('Roulette: unbekannte Wettarten werden abgewiesen', () => {
  assert.equal(parseBet('jackpot', 1), null);
  assert.equal(parseBet('straight', 'abc'), null);
  assert.equal(parseBet('dozen', 0), null);
});

// ---------------------------------------------------------------- Ablauf

test('Roulette: setzen, drehen, abrechnen', async (t) => {
  // Die Ergebnisanzeige lange stehen lassen, sonst läuft schon die nächste Runde.
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 }, config: { resultMs: 5000 } });
  engine.tick();
  assert.equal(engine.phase, 'betting');

  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 100 });
  assert.equal(balances.get('a'), 900, 'der Einsatz liegt auf dem Tableau');

  engine.spin();
  assert.equal(engine.phase, 'spinning');
  await wait(60);

  assert.equal(engine.phase, 'result');
  const number = engine.result.number;
  const erwartet = colorOf(number) === 'red' ? 900 + 200 : 900;
  assert.equal(balances.get('a'), erwartet, `bei ${number} (${colorOf(number)})`);
});

test('Roulette: mehrere Wetten gleichzeitig werden einzeln abgerechnet', async (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'straight', arg: 7, amount: 10 });
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 50 });
  engine.act('a', { move: 'bet', betType: 'dozen', arg: 1, amount: 20 });
  assert.equal(balances.get('a'), 920);

  engine.spin();
  engine.winningNumber = 7; // Rot, erstes Dutzend, und das Plein trifft
  engine.settle();

  const eintrag = engine.result.entries[0];
  assert.equal(eintrag.staked, 80);
  assert.equal(eintrag.won, 360 + 100 + 60, 'Plein + Rot + Dutzend');
  assert.equal(balances.get('a'), 920 + 520);
});

test('Roulette: gleiche Wette zweimal wird aufgestockt', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'straight', arg: 5, amount: 10 });
  engine.act('a', { move: 'bet', betType: 'straight', arg: 5, amount: 15 });

  const bets = engine.bets.get('a');
  assert.equal(bets.length, 1, 'es bleibt eine Wette');
  assert.equal(bets[0].amount, 25);
});

test('Roulette: Zurücknehmen gibt die Chips zurück', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 50 });
  engine.act('a', { move: 'bet', betType: 'straight', arg: 3, amount: 20 });
  assert.equal(balances.get('a'), 930);

  engine.act('a', { move: 'undo' });
  assert.equal(balances.get('a'), 950, 'die letzte Wette kommt zurück');

  engine.act('a', { move: 'clear' });
  assert.equal(balances.get('a'), 1000, 'und dann der Rest');
  assert.throws(() => engine.act('a', { move: 'undo' }), /nichts liegen/);
});

test('Roulette: nach dem Schließen des Fensters geht nichts mehr', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.spin();
  assert.throws(
    () => engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 10 }),
    /rien ne va plus/,
  );
  assert.throws(() => engine.act('a', { move: 'undo' }), /nichts mehr zurück/);
});

test('Roulette: Einsätze werden auf die Tischgrenzen gestutzt', (t) => {
  const { engine, balances } = makeTable(t, {
    stacks: { a: 1000 },
    config: { minBet: 5, maxBet: 100 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 9999 });
  assert.equal(balances.get('a'), 900);
  engine.act('a', { move: 'bet', betType: 'black', arg: null, amount: 1 });
  assert.equal(balances.get('a'), 895);
});

test('Roulette: ohne Deckung keine Wette (kein Rebuy)', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 4 }, config: { minBet: 5 } });
  engine.tick();
  assert.throws(
    () => engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 5 }),
    /reicht dein Guthaben nicht/,
  );
});

// ---------------------------------------------------------- Geheimhaltung

test('Roulette: die Zahl steht vor dem Dreh nirgends im Zustand', (t) => {
  const { table, engine } = makeTable(t, { stacks: { a: 1000 }, config: { spinMs: 5000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 10 });

  const beimSetzen = table.stateFor('a');
  assert.equal(beimSetzen.public.number, null, 'während des Setzens gibt es noch keine Zahl');
  assert.equal(engine.winningNumber, null);

  engine.spin();
  const beimDrehen = table.stateFor('a');
  assert.equal(beimDrehen.public.number, null, 'auch während der Drehung nicht');

  engine.settle();
  assert.equal(table.stateFor('a').public.number, engine.winningNumber, 'erst danach');
});

test('Roulette: fremde Wetten sind sichtbar, aber nur als Summe', (t) => {
  const { table, engine } = makeTable(t, { stacks: { a: 1000, b: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'straight', arg: 13, amount: 40 });

  const sichtB = table.stateFor('b');
  const einsatzVonA = sichtB.public.stakes.find((entry) => entry.playerId === 'a');
  assert.equal(einsatzVonA.total, 40, 'am echten Tisch sieht man die Chips ja auch liegen');
  assert.equal(sichtB.private.bets.length, 0, 'aber B hat selbst nichts liegen');

  const sichtA = table.stateFor('a');
  assert.equal(sichtA.private.bets[0].label, 'Plein 13');
});

test('Roulette: wer den Tisch verlässt, bekommt seine Chips zurück', (t) => {
  const { table, engine, balances } = makeTable(t, { stacks: { a: 1000, b: 1000 } });
  engine.tick();
  engine.act('b', { move: 'bet', betType: 'red', arg: null, amount: 200 });
  assert.equal(balances.get('b'), 800);

  table.stand('b');
  assert.equal(balances.get('b'), 1000, 'nicht gedrehte Einsätze kommen zurück');
});

test('Roulette: der Abbruch gibt offene Einsätze zurück', (t) => {
  const { engine, balances } = makeTable(t, { stacks: { a: 1000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 300 });
  engine.dispose();
  assert.equal(balances.get('a'), 1000);
});

// ------------------------------------------------------------- „Bereit“

/**
 * Der Countdown allein war die Hauptquelle für Verwirrung: Man hatte gesetzt,
 * aber nichts passierte. Deshalb kann jeder signalisieren, dass er fertig ist –
 * sobald alle so weit sind, dreht das Rad sofort.
 */
test('Roulette: wer allein am Tisch sitzt, startet mit „bereit“ sofort', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 }, config: { betMs: 60_000 } });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 50 });
  assert.equal(engine.phase, 'betting', 'ohne Signal wartet das Rad');

  engine.act('a', { move: 'ready' });
  assert.equal(engine.phase, 'spinning', 'mit Signal geht es sofort los');
});

test('Roulette: ohne Einsatz dreht sich nichts', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 }, config: { betMs: 60_000 } });
  engine.tick();
  engine.act('a', { move: 'ready' });
  assert.equal(engine.phase, 'betting', 'ein leeres Tableau lohnt keine Drehung');
});

test('Roulette: mit mehreren Leuten wird auf alle gewartet', (t) => {
  const { engine } = makeTable(t, {
    stacks: { a: 1000, b: 1000, c: 1000 },
    config: { betMs: 60_000 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 20 });

  engine.act('a', { move: 'ready' });
  assert.equal(engine.phase, 'betting', 'B und C sind noch nicht so weit');
  assert.deepEqual(engine.publicState().ready, { ready: 1, total: 3, ids: ['a'] });

  engine.act('b', { move: 'ready' });
  assert.equal(engine.phase, 'betting');

  engine.act('c', { move: 'ready' });
  assert.equal(engine.phase, 'spinning', 'jetzt sind alle bereit');
});

test('Roulette: wer noch etwas ändert, gilt wieder als nicht bereit', (t) => {
  const { engine } = makeTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { betMs: 60_000 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 20 });
  engine.act('a', { move: 'ready' });
  assert.equal(engine.readySet.has('a'), true);

  engine.act('a', { move: 'bet', betType: 'black', arg: null, amount: 20 });
  assert.equal(engine.readySet.has('a'), false, 'eine neue Wette hebt das Signal auf');

  engine.act('b', { move: 'ready' });
  assert.equal(engine.phase, 'betting', 'A muss erneut bestätigen');
});

test('Roulette: wer den Tisch verlässt, hält den Start nicht auf', (t) => {
  const { table, engine } = makeTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { betMs: 60_000 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 20 });
  engine.act('a', { move: 'ready' });
  assert.equal(engine.phase, 'betting');

  table.stand('b');
  assert.equal(engine.phase, 'spinning', 'jetzt ist A allein und bereit');
});

test('Roulette: an einem reinen Bot-Tisch entscheidet weiter der Countdown', async (t) => {
  const { table } = makeTable(t, {
    stacks: {},
    config: { betMs: 150, spinMs: 20, resultMs: 20, minBet: 5, maxBet: 20 },
    seed: 4,
  });
  table.addSpectator('zuschauer');
  table.addBot('medium');
  const engine = table.engine;

  table.sync();
  // Bots setzen sofort – trotzdem darf nicht sofort gedreht werden, sonst
  // rasen die Runden ohne Publikum durch.
  assert.equal(engine.phase, 'betting');
  await wait(400);
  assert.ok(engine.roundNumber >= 1);
});

test('Roulette: „bereit“ geht nur im Setzfenster und nur im Sitzen', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 1000 }, config: { betMs: 60_000 } });
  engine.tick();
  assert.throws(() => engine.act('zuschauer', { move: 'ready' }), /an den Tisch/);

  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 10 });
  engine.act('a', { move: 'ready' });
  assert.equal(engine.phase, 'spinning');
  assert.throws(() => engine.act('a', { move: 'ready' }), /wird nicht gesetzt/);
});

// ------------------------------------------------------ Geheimhaltung II

/**
 * Die Zahl geht bewusst mit dem Dreh-Ereignis raus, damit die Kugel im
 * Browser wirklich auf dem richtigen Fach landen kann. Unbedenklich ist das,
 * weil in diesem Moment nichts mehr gesetzt werden kann – genau das wird
 * hier festgenagelt.
 */
test('Roulette: mit dem Dreh kommt das Zielfach, aber es geht nichts mehr', (t) => {
  const { table, engine, balances } = makeTable(t, {
    stacks: { a: 1000 },
    config: { betMs: 60_000, spinMs: 5000 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 10 });
  table.takeEvents();

  engine.act('a', { move: 'ready' });
  const spin = table.takeEvents().find((event) => event.kind === 'spin');
  assert.ok(spin, 'ein Dreh-Ereignis muss kommen');
  assert.equal(spin.number, engine.winningNumber, 'die Zahl fährt mit');
  assert.equal(
    WHEEL_ORDER[spin.pocket],
    engine.winningNumber,
    'und das Fach passt dazu – sonst liefe die Animation woandershin',
  );

  // Der eigentliche Schutz: Ab jetzt nimmt der Tisch nichts mehr an.
  const vorher = balances.get('a');
  assert.throws(
    () => engine.act('a', { move: 'bet', betType: 'straight', arg: spin.number, amount: 10 }),
    /rien ne va plus/,
    'wer die Zahl kennt, kann trotzdem nicht mehr darauf setzen',
  );
  assert.throws(() => engine.act('a', { move: 'undo' }), /nichts mehr zurück/);
  assert.equal(balances.get('a'), vorher, 'und sein Guthaben ändert sich nicht');

  // Öffentlich steht die Zahl weiterhin erst nach der Abrechnung.
  assert.equal(table.stateFor('a').public.number, null);
  engine.settle();
  assert.equal(table.stateFor('a').public.number, engine.winningNumber);
});

test('Roulette: der öffentliche Zustand schweigt bis zur Abrechnung', (t) => {
  const { table, engine } = makeTable(t, {
    stacks: { a: 1000 },
    config: { betMs: 60_000, spinMs: 5000 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', betType: 'red', arg: null, amount: 10 });
  table.takeEvents(); // Puffer leeren

  // Während des Setzens gibt es noch gar keine Zahl.
  assert.equal(table.stateFor('a').public.number, null);
  assert.equal(engine.winningNumber, null);

  engine.act('a', { move: 'ready' });
  // Während der Drehung steht sie serverseitig fest, im öffentlichen
  // Zustand aber weiterhin nicht – Zuschauer sehen sie erst mit dem Ergebnis.
  assert.ok(engine.winningNumber !== null, 'serverseitig steht sie längst fest');
  assert.equal(table.stateFor('a').public.number, null);
  assert.equal(table.stateFor('zuschauer').public.number, null);
});

// ------------------------------------------------------------------- Bots

test('Roulette: Bots setzen gültige Wetten und der Tisch läuft durch', async (t) => {
  const { table } = makeTable(t, {
    stacks: {},
    config: { betMs: 80, spinMs: 20, resultMs: 20, minBet: 5, maxBet: 50 },
    seed: 21,
  });
  table.addSpectator('zuschauer');
  for (const level of ['easy', 'medium', 'hard']) table.addBot(level);

  const engine = table.engine;
  const abrechnungen = [];
  const originalSettle = engine.settle.bind(engine);
  engine.settle = () => {
    originalSettle();
    abrechnungen.push(engine.result);
  };

  table.sync();
  await wait(1500);

  assert.ok(engine.roundNumber >= 3, `Runden: ${engine.roundNumber}`);
  assert.ok(abrechnungen.length >= 2, `Abrechnungen: ${abrechnungen.length}`);

  for (const result of abrechnungen) {
    assert.ok(result.number >= 0 && result.number <= 36);
    for (const entry of result.entries) {
      for (const bet of entry.bets) {
        // Jede Auszahlung muss exakt zur Quote der Wettart passen.
        assert.ok(bet.payout === 0 || bet.payout % bet.amount === 0);
      }
      assert.equal(
        entry.won,
        entry.bets.reduce((sum, bet) => sum + bet.payout, 0),
        'die Summe der Einzelwetten muss stimmen',
      );
    }
  }
});

/** Ein gültiges Beispielargument je Wettart. */
function sampleArg(type) {
  switch (type) {
    case 'straight':
      return 17;
    case 'split':
      return [1, 4];
    case 'street':
      return 1;
    case 'corner':
      return 1;
    case 'line':
      return 1;
    case 'trio':
      return [0, 1, 2];
    case 'dozen':
    case 'column':
      return 1;
    default:
      return null;
  }
}
