/**
 * Baccarat-Tests.
 *
 * Kern ist die Ziehtabelle: Sie hat keine Entscheidungen, aber viele Fälle –
 * und genau da schleichen sich Fehler ein. Deshalb wird sie hier vollständig
 * gegen die Standardtabelle geprüft, dazu die Kommission auf Banker-Gewinne.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CasinoTable } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import { createDeck } from '../core/cards.js';
import baccarat from '../games/baccarat/index.js';
import {
  bankerDraws,
  cardPoints,
  commissionOn,
  handTotal,
  isNatural,
  outcomeOf,
  payoutFor,
  playerDraws,
} from '../games/baccarat/rules.js';

const ALL = createDeck();
const C = (code) => {
  const card = ALL.find((entry) => entry.code === code);
  if (!card) throw new Error(`Unbekannte Karte: ${code}`);
  return { ...card };
};

function makeTable(t, { stacks = { a: 1000 }, config = {}, seed = 9 } = {}) {
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
    code: 'BC01',
    module: baccarat,
    name: 'Punto Banco',
    config: baccarat.normalizeConfig({
      ...baccarat.defaultConfig,
      // Eigene Grenzen: Die Tests rechnen mit kleinen, gut lesbaren Betraegen
      // und sollen nicht kaputtgehen, wenn die Tischtarife neu gesetzt werden.
      minBet: 1,
      maxBet: 1_000_000,
      betMs: 200,
      dealMs: 10,
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

/** Legt den Schuh so, dass genau diese Karten gezogen werden. */
function stack(engine, codes) {
  engine.shoe.cards = codes.map(C).reverse();
}

/** Gebreihenfolge: Player, Banker, Player, Banker, dann die dritten Karten. */
const dealOrder = (player, banker, extras = []) => [
  player[0],
  banker[0],
  player[1],
  banker[1],
  ...extras,
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------------------------------------------- Kartenwerte

test('Baccarat: Bilder und Zehn zählen 0, das Ass 1', () => {
  assert.equal(cardPoints(C('Ts')), 0);
  assert.equal(cardPoints(C('Jh')), 0);
  assert.equal(cardPoints(C('Qd')), 0);
  assert.equal(cardPoints(C('Kc')), 0);
  assert.equal(cardPoints(C('As')), 1);
  assert.equal(cardPoints(C('9h')), 9);
});

test('Baccarat: der Handwert ist die Summe modulo 10', () => {
  assert.equal(handTotal([C('9h'), C('7d')]), 6, '16 → 6');
  assert.equal(handTotal([C('Ks'), C('Qd')]), 0);
  assert.equal(handTotal([C('As'), C('8h')]), 9);
  assert.equal(handTotal([C('5s'), C('5h'), C('5d')]), 5, '15 → 5');
  assert.equal(handTotal([C('9s'), C('9h'), C('9d')]), 7, '27 → 7');
});

test('Baccarat: 8 und 9 sind ein Natural', () => {
  assert.equal(isNatural(8), true);
  assert.equal(isNatural(9), true);
  assert.equal(isNatural(7), false);
  assert.equal(isNatural(0), false);
});

// ------------------------------------------------------------ Ziehregeln

test('Baccarat: der Spieler zieht bis 5 und bleibt ab 6 stehen', () => {
  for (let total = 0; total <= 5; total++) {
    assert.equal(playerDraws(total), true, `bei ${total} muss gezogen werden`);
  }
  assert.equal(playerDraws(6), false);
  assert.equal(playerDraws(7), false);
});

test('Baccarat: ohne dritte Spielerkarte spielt die Bank wie der Spieler', () => {
  for (let total = 0; total <= 5; total++) {
    assert.equal(bankerDraws(total, null), true, `Bank ${total} muss ziehen`);
  }
  assert.equal(bankerDraws(6, null), false);
  assert.equal(bankerDraws(7, null), false);
});

/**
 * Die vollständige Standardtabelle. Zeile = Bankwert, Spalte = Punktwert der
 * dritten Spielerkarte (0 bis 9). true = Bank zieht.
 */
test('Baccarat: die Ziehtabelle der Bank stimmt in jedem Feld', () => {
  const Z = false;
  const D = true;
  const TABELLE = {
    0: [D, D, D, D, D, D, D, D, D, D],
    1: [D, D, D, D, D, D, D, D, D, D],
    2: [D, D, D, D, D, D, D, D, D, D],
    3: [D, D, D, D, D, D, D, D, Z, D],
    4: [Z, Z, D, D, D, D, D, D, Z, Z],
    5: [Z, Z, Z, Z, D, D, D, D, Z, Z],
    6: [Z, Z, Z, Z, Z, Z, D, D, Z, Z],
    7: [Z, Z, Z, Z, Z, Z, Z, Z, Z, Z],
  };

  for (const [bankerTotal, row] of Object.entries(TABELLE)) {
    for (let third = 0; third <= 9; third++) {
      assert.equal(
        bankerDraws(Number(bankerTotal), third),
        row[third],
        `Bank ${bankerTotal} gegen dritte Karte ${third}`,
      );
    }
  }
});

test('Baccarat: Bank bei 8 oder 9 zieht nie (Natural)', () => {
  for (let third = 0; third <= 9; third++) {
    assert.equal(bankerDraws(8, third), false);
    assert.equal(bankerDraws(9, third), false);
  }
});

test('Baccarat: das Ergebnis ergibt sich aus den Werten', () => {
  assert.equal(outcomeOf(9, 7), 'player');
  assert.equal(outcomeOf(3, 8), 'banker');
  assert.equal(outcomeOf(6, 6), 'tie');
});

// ----------------------------------------------------------- Auszahlungen

test('Baccarat: Player zahlt 1:1', () => {
  assert.equal(payoutFor('player', 100, 'player'), 200);
  assert.equal(payoutFor('player', 100, 'banker'), 0);
});

test('Baccarat: Banker zahlt 1:1 abzüglich 5 % Kommission', () => {
  assert.equal(payoutFor('banker', 100, 'banker'), 195, '100 + 100 − 5 Kommission');
  assert.equal(payoutFor('banker', 20, 'banker'), 39, '20 + 20 − 1');
  assert.equal(payoutFor('banker', 100, 'player'), 0);
  assert.equal(commissionOn(100), 5);
  assert.equal(commissionOn(10), 1, 'kaufmännisch gerundet');
});

test('Baccarat: Tie zahlt 8:1', () => {
  assert.equal(payoutFor('tie', 100, 'tie'), 900, 'Einsatz + 800');
  assert.equal(payoutFor('tie', 100, 'player'), 0);
});

test('Baccarat: bei Tie bekommen Player und Banker ihren Einsatz zurück', () => {
  assert.equal(payoutFor('player', 100, 'tie'), 100);
  assert.equal(payoutFor('banker', 100, 'tie'), 100, 'ohne Kommission – es ist kein Gewinn');
});

// ---------------------------------------------------------------- Ablauf

test('Baccarat: Natural beendet die Runde ohne dritte Karten', async (t) => {
  const { engine, balances } = makeTable(t, { config: { resultMs: 5000 } });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'player', amount: 100 });
  // Player 9 (4+5), Banker 5 (2+3) – Natural, also keine dritte Karte.
  stack(engine, dealOrder(['4s', '5h'], ['2d', '3c'], ['9s', '9h']));
  engine.deal();
  await wait(60);

  assert.equal(engine.player.length, 2);
  assert.equal(engine.banker.length, 2);
  assert.equal(engine.result.natural, true);
  assert.equal(engine.result.outcome, 'player');
  assert.equal(balances.get('a'), 900 + 200);
});

test('Baccarat: der Spieler zieht, die Bank folgt der Tabelle', async (t) => {
  const { engine } = makeTable(t, { config: { resultMs: 5000 } });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'banker', amount: 100 });
  // Player 3 (1+2) → zieht. Banker 5 (2+3), dritte Spielerkarte ist eine 6
  // → laut Tabelle zieht die Bank.
  stack(engine, dealOrder(['As', '2h'], ['2d', '3c'], ['6s', '2c']));
  engine.deal();
  await wait(60);

  assert.equal(engine.player.length, 3, 'der Spieler hat gezogen');
  assert.equal(engine.banker.length, 3, 'die Bank auch');
  assert.equal(engine.result.playerTotal, 9, '1+2+6');
  assert.equal(engine.result.bankerTotal, 7, '2+3+2');
  assert.equal(engine.result.outcome, 'player');
});

test('Baccarat: die Bank bleibt bei 6 gegen eine dritte Karte 3 stehen', async (t) => {
  const { engine } = makeTable(t, { config: { resultMs: 5000 } });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'banker', amount: 100 });
  // Player 2 (A+A) → zieht eine 3. Banker 6 (2+4) → bleibt stehen.
  stack(engine, dealOrder(['As', 'Ah'], ['2d', '4c'], ['3s', '9h']));
  engine.deal();
  await wait(60);

  assert.equal(engine.player.length, 3);
  assert.equal(engine.banker.length, 2, 'die Bank darf hier nicht ziehen');
  assert.equal(engine.result.playerTotal, 5);
  assert.equal(engine.result.bankerTotal, 6);
  assert.equal(engine.result.outcome, 'banker');
});

test('Baccarat: ein gewonnener Banker-Einsatz kostet Kommission', async (t) => {
  const { engine, balances } = makeTable(t, { config: { resultMs: 5000 } });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'banker', amount: 200 });
  assert.equal(balances.get('a'), 800);
  // Banker 9 (4+5), Player 7 (3+4) – Natural für die Bank.
  stack(engine, dealOrder(['3s', '4h'], ['4d', '5c'], ['9s']));
  engine.deal();
  await wait(60);

  assert.equal(engine.result.outcome, 'banker');
  assert.equal(engine.result.commission, 10, '5 % von 200');
  assert.equal(balances.get('a'), 800 + 390, 'Einsatz + 190 Gewinn');
});

test('Baccarat: bei Unentschieden kommt der Einsatz zurück', async (t) => {
  const { engine, balances } = makeTable(t, {
    stacks: { a: 1000, b: 1000 },
    config: { resultMs: 5000 },
  });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'player', amount: 100 });
  engine.act('b', { move: 'bet', side: 'tie', amount: 50 });
  // Beide 8 – Natural und Tie.
  stack(engine, dealOrder(['4s', '4h'], ['5d', '3c'], ['9s']));
  engine.deal();
  await wait(60);

  assert.equal(engine.result.outcome, 'tie');
  assert.equal(balances.get('a'), 1000, 'der Player-Einsatz kommt zurück');
  assert.equal(balances.get('b'), 950 + 450, 'Tie zahlt 8:1');
});

test('Baccarat: es gilt immer nur ein Einsatz pro Spieler', (t) => {
  const { engine, balances } = makeTable(t);
  engine.tick();
  engine.act('a', { move: 'bet', side: 'player', amount: 100 });
  assert.equal(balances.get('a'), 900);

  engine.act('a', { move: 'bet', side: 'banker', amount: 300 });
  assert.equal(balances.get('a'), 700, 'der alte Einsatz wurde zurückgegeben');
  assert.equal(engine.bets.get('a').side, 'banker');
  assert.equal(engine.bets.get('a').amount, 300);

  engine.act('a', { move: 'clear' });
  assert.equal(balances.get('a'), 1000);
  assert.equal(engine.bets.has('a'), false);
});

test('Baccarat: nach dem Schließen des Fensters geht nichts mehr', (t) => {
  const { engine } = makeTable(t);
  engine.tick();
  engine.act('a', { move: 'bet', side: 'player', amount: 100 });
  stack(engine, dealOrder(['4s', '5h'], ['2d', '3c']));
  engine.deal();
  assert.throws(
    () => engine.act('a', { move: 'bet', side: 'banker', amount: 10 }),
    /Setzfenster ist zu/,
  );
});

test('Baccarat: nur Player, Banker oder Tie', (t) => {
  const { engine } = makeTable(t);
  engine.tick();
  assert.throws(() => engine.act('a', { move: 'bet', side: 'dealer', amount: 10 }), /Player, Banker oder Tie/);
});

test('Baccarat: Einsätze werden auf die Tischgrenzen gestutzt', (t) => {
  const { engine, balances } = makeTable(t, { config: { minBet: 10, maxBet: 200 } });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'player', amount: 99999 });
  assert.equal(balances.get('a'), 800);
  engine.act('a', { move: 'bet', side: 'player', amount: 1 });
  assert.equal(balances.get('a'), 990);
});

test('Baccarat: ohne Deckung kein Einsatz (kein Rebuy)', (t) => {
  const { engine } = makeTable(t, { stacks: { a: 5 }, config: { minBet: 10 } });
  engine.tick();
  assert.throws(
    () => engine.act('a', { move: 'bet', side: 'player', amount: 10 }),
    /reicht dein Guthaben nicht/,
  );
});

test('Baccarat: ohne Einsätze wird gar nicht erst gegeben', (t) => {
  const { engine } = makeTable(t);
  engine.tick();
  engine.deal();
  assert.equal(engine.player.length, 0);
  assert.equal(engine.phase, 'idle');
});

test('Baccarat: wer den Tisch verlässt, bekommt seinen Einsatz zurück', (t) => {
  const { table, engine, balances } = makeTable(t, { stacks: { a: 1000, b: 1000 } });
  engine.tick();
  engine.act('b', { move: 'bet', side: 'tie', amount: 150 });
  assert.equal(balances.get('b'), 850);
  table.stand('b');
  assert.equal(balances.get('b'), 1000);
});

test('Baccarat: der Abbruch gibt offene Einsätze zurück', (t) => {
  const { engine, balances } = makeTable(t);
  engine.tick();
  engine.act('a', { move: 'bet', side: 'banker', amount: 400 });
  engine.dispose();
  assert.equal(balances.get('a'), 1000);
});

test('Baccarat: der Schuh wird nur zwischen den Runden neu gemischt', async (t) => {
  const { engine } = makeTable(t, { config: { decks: 4, resultMs: 5000 } });
  engine.tick();
  engine.act('a', { move: 'bet', side: 'player', amount: 10 });
  // Kurz vor der Cut-Card: Der Schuh darf trotzdem die Coup zu Ende geben.
  engine.shoe.cards = engine.shoe.cards.slice(0, 8);
  const vorher = engine.shoe.shuffleCount;
  engine.deal();
  await wait(60);
  assert.equal(engine.shoe.shuffleCount, vorher, 'mitten in der Runde wird nicht gemischt');

  engine.phase = 'idle';
  engine.tick();
  assert.ok(engine.shoe.shuffleCount > vorher, 'erst zur nächsten Runde');
});

// ------------------------------------------------------------------- Bots

test('Baccarat: ein Bot-Tisch spielt Coups durch und rechnet korrekt ab', async (t) => {
  const { table, balances } = makeTable(t, {
    stacks: {},
    config: { betMs: 60, dealMs: 10, resultMs: 20, minBet: 10, maxBet: 100 },
    seed: 33,
  });
  table.addSpectator('zuschauer');
  for (const level of ['easy', 'medium', 'hard']) table.addBot(level);

  const engine = table.engine;
  const abrechnungen = [];
  const originalSettle = engine.settle.bind(engine);
  engine.settle = (info) => {
    originalSettle(info);
    abrechnungen.push(engine.result);
  };

  table.sync();
  await wait(2000);

  assert.ok(engine.roundNumber >= 3, `Runden: ${engine.roundNumber}`);
  assert.ok(abrechnungen.length >= 2, `Abrechnungen: ${abrechnungen.length}`);

  for (const result of abrechnungen) {
    // Die Handwerte müssen zu den Karten passen …
    assert.equal(result.playerTotal, handTotal(result.playerCards));
    assert.equal(result.bankerTotal, handTotal(result.bankerCards));
    assert.ok(result.playerCards.length >= 2 && result.playerCards.length <= 3);
    assert.ok(result.bankerCards.length >= 2 && result.bankerCards.length <= 3);
    // … und jede Auszahlung zur Regel.
    for (const entry of result.entries) {
      assert.equal(
        entry.payout,
        payoutFor(entry.side, entry.amount, result.outcome),
        `${entry.side} bei ${result.outcome}`,
      );
    }
  }

  assert.ok([...balances.values()].every((value) => value >= 0));
});
