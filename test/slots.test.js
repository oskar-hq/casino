/**
 * Slots-Tests.
 *
 * Schwerpunkte: die Auszahlungstabelle, die Fairness des Zufalls (jede
 * Walzenposition gleich wahrscheinlich) und dass Einsatz und Gewinn sauber
 * über das Wallet laufen.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CasinoTable } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import slots from '../games/slots/index.js';
import { PAYTABLE, REEL, evaluateSpin } from '../games/slots/engine.js';

function makeTable(t, { balance = 1000, config = {}, seed = 7 } = {}) {
  const balances = new Map([['a', balance]]);
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
    openBotWallet: () => {},
    closeBotWallet: () => {},
  };

  const table = new CasinoTable({
    code: 'SL01',
    module: slots,
    name: 'Automat',
    config: slots.normalizeConfig({ ...slots.defaultConfig, spinMs: 10, ...config }),
    wallet,
    botMs: 5,
    rng: new Rng(seed),
  });
  t.after(() => table.close());
  table.sit({ playerId: 'a', name: 'A', index: 0 });
  return { table, engine: table.engine, balances };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- Paytable

test('Slots: drei gleiche zahlen nach Tabelle', () => {
  assert.deepEqual(evaluateSpin(['seven', 'seven', 'seven'], 10), {
    amount: 10 * PAYTABLE.three.seven,
    kind: 'three',
    symbol: 'seven',
    multiplier: PAYTABLE.three.seven,
  });
  assert.equal(evaluateSpin(['cherry', 'cherry', 'cherry'], 10).amount, 10 * PAYTABLE.three.cherry);
  assert.equal(evaluateSpin(['diamond', 'diamond', 'diamond'], 5).amount, 5 * PAYTABLE.three.diamond);
});

test('Slots: zwei gleiche zahlen klein – egal an welcher Stelle', () => {
  const pair = 10 * PAYTABLE.two.seven;
  assert.equal(evaluateSpin(['seven', 'seven', 'lemon'], 10).amount, pair);
  assert.equal(evaluateSpin(['lemon', 'seven', 'seven'], 10).amount, pair);
  assert.equal(evaluateSpin(['seven', 'lemon', 'seven'], 10).amount, pair);
  assert.equal(evaluateSpin(['seven', 'seven', 'lemon'], 10).symbol, 'seven');
});

test('Slots: häufige Symbole zahlen nur als Drilling', () => {
  // Zwei Kirschen sind fast jeder fünfte Dreh – dafür gibt es nichts.
  assert.equal(evaluateSpin(['cherry', 'cherry', 'bell'], 10).amount, 0);
  assert.equal(evaluateSpin(['lemon', 'lemon', 'bell'], 10).amount, 0);
  assert.ok(evaluateSpin(['cherry', 'cherry', 'cherry'], 10).amount > 0);
});

test('Slots: drei verschiedene zahlen nichts', () => {
  const result = evaluateSpin(['cherry', 'lemon', 'bell'], 50);
  assert.equal(result.amount, 0);
  assert.equal(result.kind, null);
});

test('Slots: jedes Symbol der Tabelle kommt auf der Walze vor', () => {
  for (const symbol of Object.keys(PAYTABLE.three)) {
    assert.ok(REEL.includes(symbol), `${symbol} fehlt auf der Walze`);
  }
  for (const symbol of new Set(REEL)) {
    assert.ok(PAYTABLE.three[symbol] > 0, `${symbol} hat keine Dreier-Auszahlung`);
    assert.ok(PAYTABLE.two[symbol] >= 0, `${symbol} fehlt in der Zweier-Tabelle`);
  }
});

test('Slots: seltenere Symbole zahlen mehr', () => {
  const häufigkeit = (symbol) => REEL.filter((entry) => entry === symbol).length;
  const symbole = [...new Set(REEL)].sort((a, b) => häufigkeit(a) - häufigkeit(b));
  for (let i = 1; i < symbole.length; i++) {
    assert.ok(
      PAYTABLE.three[symbole[i - 1]] >= PAYTABLE.three[symbole[i]],
      `${symbole[i - 1]} ist seltener als ${symbole[i]}, zahlt aber nicht mehr`,
    );
    assert.ok(
      PAYTABLE.two[symbole[i - 1]] >= PAYTABLE.two[symbole[i]],
      `Zweier-Tabelle: ${symbole[i - 1]} ist seltener als ${symbole[i]}`,
    );
  }
});

/**
 * Die entscheidende Rechnung des Automaten. Zahlte er im Schnitt mehr aus, als
 * eingesetzt wird, würde er Chips aus dem Nichts erzeugen – eine Trefferquote
 * nahe null wäre umgekehrt einfach kein Spaß.
 */
test('Slots: die Auszahlungsquote liegt rechnerisch unter 100 %', () => {
  const n = REEL.length;
  const counts = {};
  for (const symbol of REEL) counts[symbol] = (counts[symbol] ?? 0) + 1;

  let rtp = 0;
  let hitRate = 0;
  for (const [symbol, count] of Object.entries(counts)) {
    const pThree = (count / n) ** 3;
    const pTwo = 3 * (count / n) ** 2 * ((n - count) / n);
    rtp += pThree * PAYTABLE.three[symbol] + pTwo * PAYTABLE.two[symbol];
    hitRate += pThree + (PAYTABLE.two[symbol] > 0 ? pTwo : 0);
  }

  assert.ok(rtp > 0.9 && rtp < 1, `Auszahlungsquote rechnerisch ${rtp.toFixed(4)}`);
  assert.ok(hitRate > 0.15, `Trefferquote nur ${(hitRate * 100).toFixed(1)} %`);
});

// ------------------------------------------------------------- Fairness

test('Slots: der Zufall bevorzugt keine Walzenposition', () => {
  const rng = new Rng();
  const counts = new Map();
  const draws = 60_000;
  for (let i = 0; i < draws; i++) {
    const symbol = rng.pick(REEL);
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  for (const symbol of new Set(REEL)) {
    const expected = (REEL.filter((entry) => entry === symbol).length / REEL.length) * draws;
    const actual = counts.get(symbol) ?? 0;
    // Großzügige Schranke – geprüft wird grobe Schieflage, nicht Statistik.
    assert.ok(
      Math.abs(actual - expected) < expected * 0.15,
      `${symbol}: erwartet ~${Math.round(expected)}, war ${actual}`,
    );
  }
});

// ---------------------------------------------------------------- Ablauf

test('Slots: Einsatz wird sofort abgebucht, Gewinn nach dem Dreh gutgeschrieben', async (t) => {
  const { engine, balances } = makeTable(t, { balance: 1000 });
  engine.act('a', { move: 'spin', amount: 20 });

  assert.equal(balances.get('a'), 980, 'der Einsatz ist sofort weg');
  assert.equal(engine.spinning, true);

  await wait(60);
  assert.equal(engine.spinning, false);
  const result = engine.lastResult;
  assert.equal(result.bet, 20);
  assert.equal(balances.get('a'), 980 + result.amount);
  assert.equal(result.net, result.amount - 20);
});

test('Slots: während die Walzen laufen, geht kein zweiter Dreh', (t) => {
  const { engine } = makeTable(t, { config: { spinMs: 200 } });
  engine.act('a', { move: 'spin', amount: 10 });
  assert.throws(() => engine.act('a', { move: 'spin', amount: 10 }), /Walzen laufen noch/);
});

test('Slots: das Ergebnis steht schon beim Drücken fest', (t) => {
  const { engine } = makeTable(t, { config: { spinMs: 200 } });
  engine.act('a', { move: 'spin', amount: 10 });
  // Die Animation zeigt nur noch, was bereits gezogen wurde.
  assert.equal(engine.pending.symbols.length, 3);
  assert.ok(engine.pending.payout.amount >= 0);
});

test('Slots: das laufende Ergebnis ist während des Drehens nicht sichtbar', (t) => {
  const { table, engine } = makeTable(t, { config: { spinMs: 200 } });
  engine.act('a', { move: 'spin', amount: 10 });
  const state = table.stateFor('a');
  assert.equal(state.public.spinning, true);
  // Die Walzen zeigen noch den alten Stand – das neue Ergebnis steckt nur
  // serverseitig in `pending` und wird nicht mitgeschickt.
  assert.equal(JSON.stringify(state).includes('pending'), false);
});

test('Slots: Einsätze werden auf die Tischgrenzen gestutzt', async (t) => {
  const { engine, balances } = makeTable(t, {
    balance: 1000,
    config: { minBet: 5, maxBet: 50 },
  });
  engine.act('a', { move: 'spin', amount: 9999 });
  assert.equal(balances.get('a'), 950, 'mehr als der Höchsteinsatz geht nicht');
  await wait(60);

  const before = balances.get('a');
  engine.act('a', { move: 'spin', amount: 1 });
  assert.equal(balances.get('a'), before - 5, 'weniger als der Mindesteinsatz auch nicht');
});

test('Slots: ohne Deckung kein Dreh (kein Rebuy)', (t) => {
  const { engine } = makeTable(t, { balance: 3, config: { minBet: 5 } });
  assert.throws(() => engine.act('a', { move: 'spin', amount: 5 }), /reicht dein Guthaben nicht/);
});

test('Slots: unbekannte Züge werden abgewiesen', (t) => {
  const { engine } = makeTable(t);
  assert.throws(() => engine.act('a', { move: 'hit' }), /nur drehen/);
});

test('Slots: wer nicht sitzt, kann nicht drehen', (t) => {
  const { table } = makeTable(t);
  assert.throws(() => table.act('fremder', { move: 'spin', amount: 10 }), /an den Tisch setzen/);
});

test('Slots: der Abbruch rechnet einen laufenden Dreh noch ab', (t) => {
  const { engine, balances } = makeTable(t, { balance: 1000, config: { spinMs: 5000 } });
  engine.act('a', { move: 'spin', amount: 100 });
  assert.equal(balances.get('a'), 900);

  engine.dispose();
  // Der Einsatz war weg – also muss auch ein möglicher Gewinn kommen.
  assert.equal(engine.spinning, false);
  assert.equal(balances.get('a'), 900 + engine.lastResult.amount);
});

test('Slots: über viele Drehs bleibt die Auszahlungsquote plausibel', async (t) => {
  const { engine, balances } = makeTable(t, { balance: 1_000_000, config: { spinMs: 0 } });
  const spins = 4000;
  for (let i = 0; i < spins; i++) {
    engine.act('a', { move: 'spin', amount: 10 });
    await Promise.resolve();
    if (engine.spinning) engine.finishSpin();
  }

  const rtp = engine.totalWon / engine.totalWagered;
  // Rechnerisch liegt die Quote bei ~0,955. Über 4000 Drehs schwankt sie
  // spürbar (ein einziger Jackpot sind 600 Einsätze), deshalb ein weiter Rahmen.
  assert.ok(rtp > 0.5 && rtp < 1.5, `Auszahlungsquote war ${rtp.toFixed(3)}`);
  assert.equal(
    balances.get('a'),
    1_000_000 - engine.totalWagered + engine.totalWon,
    'jeder Chip ist verbucht',
  );
});
