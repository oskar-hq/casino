/**
 * Plinko-Tests.
 *
 * Kern ist die Rechnung: Die Verteilung der Kugel ist binomial, und die
 * Auszahlungstabellen müssen dazu passen – sonst zahlt das Gerät mehr aus,
 * als hereinkommt. Dazu die Zusicherung, dass das Fach wirklich aus dem
 * Weg folgt, den der Client zum Animieren bekommt.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CasinoTable } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import plinko from '../games/plinko/index.js';
import {
  PAYTABLES,
  RISKS,
  ROWS,
  binomial,
  multipliersFor,
  normalizeRisk,
  payoutFor,
  returnToPlayer,
  slotProbability,
} from '../games/plinko/paytable.js';

function makeTable(t, { balance = 100_000, config = {}, seed = 13 } = {}) {
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
    code: 'PL01',
    module: plinko,
    name: 'Plinko',
    config: plinko.normalizeConfig({ ...plinko.defaultConfig, dropMs: 10, ...config }),
    wallet,
    botMs: 5,
    rng: new Rng(seed),
  });
  t.after(() => table.close());
  table.sit({ playerId: 'a', name: 'A', index: 0 });
  return { table, engine: table.engine, balances };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ Rechnung

test('Plinko: die Fächer folgen der Binomialverteilung', () => {
  let summe = 0;
  for (let slot = 0; slot <= ROWS; slot++) summe += slotProbability(slot);
  assert.ok(Math.abs(summe - 1) < 1e-9, 'alle Wahrscheinlichkeiten zusammen ergeben 1');

  // Ganz außen führt genau ein Weg hin, in die Mitte sehr viele.
  assert.equal(binomial(ROWS, 0), 1);
  assert.equal(binomial(ROWS, ROWS), 1);
  assert.equal(binomial(12, 6), 924);
  assert.ok(
    slotProbability(6) > slotProbability(0) * 900,
    'die Mitte muss um Größenordnungen wahrscheinlicher sein als der Rand',
  );
});

test('Plinko: die Tabellen sind symmetrisch und haben ein Fach je Ausgang', () => {
  for (const risiko of RISKS) {
    const tabelle = PAYTABLES[risiko];
    assert.equal(tabelle.length, ROWS + 1, `${risiko}: falsche Fachanzahl`);
    for (let i = 0; i < tabelle.length; i++) {
      assert.equal(tabelle[i], tabelle.at(-1 - i), `${risiko}: Fach ${i} ist nicht spiegelbildlich`);
    }
    // Nach außen darf es nur größer werden.
    for (let i = 1; i <= ROWS / 2; i++) {
      assert.ok(
        tabelle[i - 1] >= tabelle[i],
        `${risiko}: Fach ${i - 1} zahlt weniger als das weiter innen liegende ${i}`,
      );
    }
  }
});

/**
 * Die wichtigste Zusicherung des ganzen Spiels: Über viele Würfe darf nicht
 * mehr zurückkommen, als eingesetzt wurde.
 */
test('Plinko: jede Risikostufe zahlt rechnerisch unter 100 % zurück', () => {
  for (const risiko of RISKS) {
    const rtp = returnToPlayer(risiko);
    assert.ok(rtp < 1, `${risiko}: Auszahlungsquote ${rtp.toFixed(4)} – das Gerät erzeugt Chips`);
    assert.ok(rtp > 0.9, `${risiko}: Auszahlungsquote ${rtp.toFixed(4)} ist unnötig hart`);
  }
});

test('Plinko: höheres Risiko heißt größere Spannweite, nicht mehr Gewinn', () => {
  const spanne = (risiko) => {
    const tabelle = multipliersFor(risiko);
    return tabelle[0] / tabelle[Math.floor(ROWS / 2)];
  };
  assert.ok(spanne('high') > spanne('medium'));
  assert.ok(spanne('medium') > spanne('low'));
  // Die Quoten liegen trotzdem alle dicht beieinander.
  // (Bewusst mit Pfeilfunktion: `map` würde sonst den Index als zweites
  // Argument durchreichen – und das ist bei returnToPlayer die Reihenzahl.)
  const quoten = RISKS.map((risiko) => returnToPlayer(risiko));
  assert.ok(Math.max(...quoten) - Math.min(...quoten) < 0.05);
});

test('Plinko: Auszahlungen werden abgerundet, nie aufgerundet', () => {
  // 1,05 × 999 = 1048,95 → 1048
  assert.equal(payoutFor('low', 4, 999), 1048);
  assert.equal(payoutFor('medium', 6, 1000), 400);
  assert.equal(payoutFor('high', 0, 500), 25_000);
});

test('Plinko: unbekannte Risikostufen fallen auf „normal“ zurück', () => {
  assert.equal(normalizeRisk('extrem'), 'medium');
  assert.equal(normalizeRisk(undefined), 'medium');
  assert.equal(normalizeRisk('high'), 'high');
});

// --------------------------------------------------------------- Ablauf

test('Plinko: Einsatz wird sofort abgebucht, Gewinn nach der Landung', async (t) => {
  const { engine, balances } = makeTable(t, { balance: 100_000 });
  engine.act('a', { move: 'drop', amount: 1000, risk: 'medium' });

  assert.equal(balances.get('a'), 99_000, 'der Einsatz ist sofort weg');
  assert.equal(engine.drops.length, 1, 'die Kugel ist unterwegs');

  await wait(60);
  assert.equal(engine.drops.length, 0);
  const ergebnis = engine.history[0];
  assert.equal(balances.get('a'), 99_000 + ergebnis.payout);
  assert.equal(ergebnis.net, ergebnis.payout - 1000);
});

test('Plinko: das Fach ergibt sich genau aus dem Weg, den der Client bekommt', async (t) => {
  const { table, engine } = makeTable(t, { config: { dropMs: 500 } });

  for (let i = 0; i < 20; i++) {
    engine.act('a', { move: 'drop', amount: 500, risk: 'medium' });
    const drop = engine.drops.at(-1);
    const rechtsAbgelenkt = drop.path.reduce((sum, schritt) => sum + schritt, 0);
    assert.equal(drop.slot, rechtsAbgelenkt, 'das Fach ist die Summe der Rechts-Schritte');
    assert.equal(drop.path.length, ROWS);
    assert.ok(drop.path.every((schritt) => schritt === 0 || schritt === 1));

    // Genau dieser Weg geht auch nach außen – die Animation kann nicht abweichen.
    const öffentlich = table.stateFor('a').public.drops.find((entry) => entry.id === drop.id);
    assert.deepEqual(öffentlich.path, drop.path);
    assert.equal(öffentlich.slot, drop.slot);
    engine.landDrop(drop.id);
  }
});

test('Plinko: die Auszahlung passt zum Fach und zur gewählten Stufe', async (t) => {
  const { engine, balances } = makeTable(t, { config: { dropMs: 5 } });
  for (const risiko of RISKS) {
    const vorher = balances.get('a');
    engine.act('a', { move: 'drop', amount: 1000, risk: risiko });
    const drop = engine.drops.at(-1);
    const erwartet = payoutFor(risiko, drop.slot, 1000);
    engine.landDrop(drop.id);
    assert.equal(balances.get('a'), vorher - 1000 + erwartet, `Stufe ${risiko}`);
    assert.equal(engine.history[0].payout, erwartet);
  }
});

test('Plinko: mehrere Kugeln können gleichzeitig unterwegs sein', (t) => {
  const { engine } = makeTable(t, { config: { dropMs: 5000 } });
  engine.act('a', { move: 'drop', amount: 500 });
  engine.act('a', { move: 'drop', amount: 500 });
  assert.equal(engine.drops.length, 2);
  assert.notEqual(engine.drops[0].id, engine.drops[1].id, 'jede Kugel hat ihre eigene Kennung');
});

test('Plinko: aber nicht beliebig viele', (t) => {
  const { engine } = makeTable(t, { config: { dropMs: 5000 } });
  for (let i = 0; i < 3; i++) engine.act('a', { move: 'drop', amount: 500 });
  assert.throws(() => engine.act('a', { move: 'drop', amount: 500 }), /Kugeln ankommen/);
});

test('Plinko: Einsätze werden auf die Tischgrenzen gestutzt', (t) => {
  const { engine, balances } = makeTable(t, {
    config: { minBet: 500, maxBet: 5000, dropMs: 5000 },
  });
  engine.act('a', { move: 'drop', amount: 999_999 });
  assert.equal(balances.get('a'), 95_000, 'mehr als der Höchsteinsatz geht nicht');
  engine.act('a', { move: 'drop', amount: 1 });
  assert.equal(balances.get('a'), 94_500, 'weniger als der Mindesteinsatz auch nicht');
});

test('Plinko: ohne Deckung keine Kugel (kein Rebuy)', (t) => {
  const { engine } = makeTable(t, { balance: 100, config: { minBet: 500 } });
  assert.throws(() => engine.act('a', { move: 'drop', amount: 500 }), /reicht dein Guthaben nicht/);
});

test('Plinko: unbekannte Züge und Fremde werden abgewiesen', (t) => {
  const { table, engine } = makeTable(t);
  assert.throws(() => engine.act('a', { move: 'spin' }), /nur eine Kugel fallen lassen/);
  assert.throws(() => table.act('fremder', { move: 'drop', amount: 500 }), /an den Tisch setzen/);
});

test('Plinko: der Abbruch rechnet laufende Kugeln noch ab', (t) => {
  const { engine, balances } = makeTable(t, { config: { dropMs: 5000 } });
  engine.act('a', { move: 'drop', amount: 2000 });
  const drop = engine.drops[0];
  const erwartet = payoutFor(drop.risk, drop.slot, 2000);
  assert.equal(balances.get('a'), 98_000);

  engine.dispose();
  assert.equal(engine.drops.length, 0);
  assert.equal(balances.get('a'), 98_000 + erwartet, 'der Einsatz war weg – also kommt der Gewinn');
});

test('Plinko: über viele Kugeln nähert sich die Quote der Rechnung an', async (t) => {
  const { engine } = makeTable(t, { balance: 100_000_000, config: { dropMs: 0 }, seed: 77 });
  const würfe = 4000;
  for (let i = 0; i < würfe; i++) {
    engine.act('a', { move: 'drop', amount: 1000, risk: 'low' });
    engine.landDrop(engine.drops[0].id);
  }
  const gemessen = engine.totalWon / engine.totalWagered;
  const erwartet = returnToPlayer('low');
  assert.ok(
    Math.abs(gemessen - erwartet) < 0.06,
    `gemessen ${gemessen.toFixed(3)}, erwartet ${erwartet.toFixed(3)}`,
  );
});

test('Plinko: die Fächerverteilung ist symmetrisch', (t) => {
  const { engine } = makeTable(t, { balance: 100_000_000, config: { dropMs: 0 }, seed: 5 });
  const treffer = new Array(ROWS + 1).fill(0);
  for (let i = 0; i < 6000; i++) {
    engine.act('a', { move: 'drop', amount: 500 });
    const drop = engine.drops[0];
    treffer[drop.slot] += 1;
    engine.landDrop(drop.id);
  }
  const linkeHälfte = treffer.slice(0, 6).reduce((a, b) => a + b, 0);
  const rechteHälfte = treffer.slice(7).reduce((a, b) => a + b, 0);
  const abweichung = Math.abs(linkeHälfte - rechteHälfte) / (linkeHälfte + rechteHälfte);
  assert.ok(abweichung < 0.08, `links ${linkeHälfte}, rechts ${rechteHälfte}`);
  assert.ok(treffer[6] > treffer[0], 'die Mitte wird häufiger getroffen als der Rand');
});
