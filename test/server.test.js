/**
 * Integrationstests über echte WebSocket-Verbindungen.
 *
 * Hier wird nicht mehr die Spiellogik geprüft (das machen die Modultests),
 * sondern die Schicht darüber: Eintritt, Floor, Sitzplätze, dass jeder
 * Empfänger seine **eigene** Sicht bekommt, der Reset-Knopf und das
 * Wiederverbinden.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { TestClient, startServer, until } from './helpers.js';

/** Startet Server + aufräumen am Testende. */
async function setup(t, overrides = {}) {
  const server = await startServer(overrides);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
  });
  const connect = async (name) => {
    const client = await TestClient.connect(server.url, name);
    clients.push(client);
    return client;
  };
  return { server, connect };
}

/** Wartet auf den nächsten Tischzustand, der eine Bedingung erfüllt. */
const tableWhere = (client, predicate) =>
  client.next((message) => message.type === 'table_state' && predicate(message.state));

// ------------------------------------------------------------- Eintritt

test('Server: Eintritt liefert Guthaben und den Floor', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');

  assert.equal(anna.name, 'Anna');
  assert.ok(anna.token, 'ohne Token gäbe es kein Wiederverbinden');

  const floor = await anna.wait('floor_state');
  assert.equal(floor.you.chips, 1000);
  assert.equal(floor.you.isHost, true, 'der erste Gast wird Host');
  assert.deepEqual(
    floor.floor.games.map((game) => game.id).sort(),
    ['baccarat', 'blackjack', 'holdem', 'roulette', 'slots'],
    'alle Spiele stehen auf dem Floor',
  );
  assert.deepEqual(floor.floor.tables, []);
});

test('Server: derselbe Name führt zurück auf dasselbe Guthaben', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna');
  server.casino.debit(anna.playerId, 400, 'test');

  anna.close();
  await until(() => !server.casino.player(anna.playerId)?.online);

  const wieder = await connect('Anna');
  assert.equal(wieder.playerId, anna.playerId);
  const floor = await wieder.wait('floor_state');
  assert.equal(floor.you.chips, 600);
});

test('Server: ein zweiter Gast mit gleichem Namen wird abgewiesen', async (t) => {
  const { server, connect } = await setup(t);
  await connect('Anna');

  const zweiter = new TestClient(server.url);
  await zweiter.open();
  t.after(() => zweiter.close());
  zweiter.send({ type: 'enter', name: 'anna' });
  const error = await zweiter.wait('error');
  assert.equal(error.code, 'name_taken');
});

test('Server: zu kurze Namen werden abgewiesen', async (t) => {
  const { server } = await setup(t);
  const client = new TestClient(server.url);
  await client.open();
  t.after(() => client.close());
  client.send({ type: 'enter', name: 'x' });
  const error = await client.wait('error');
  assert.equal(error.code, 'invalid_name');
});

test('Server: ohne Eintritt geht nichts', async (t) => {
  const { server } = await setup(t);
  const client = new TestClient(server.url);
  await client.open();
  t.after(() => client.close());

  client.send({ type: 'create_table', game: 'holdem' });
  const error = await client.wait('error');
  assert.equal(error.code, 'not_entered');
});

test('Server: unbekannte Nachrichten und kaputtes JSON werfen den Client nicht raus', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'gibtsnicht' });
  const unbekannt = await anna.wait('error');
  assert.equal(unbekannt.code, 'unknown_type');

  anna.socket.send('{kaputt');
  const json = await anna.next((message) => message.type === 'error' && message.code === 'bad_json');
  assert.ok(json);

  // Die Verbindung lebt weiter.
  anna.send({ type: 'ping' });
  assert.ok(await anna.next('pong'));
});

// ----------------------------------------------------------------- Tische

test('Server: Tisch eröffnen, hinsetzen, aufstehen', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'holdem', name: 'Stammtisch', config: {} });
  const created = await anna.wait('table_created');
  const code = created.code;
  assert.match(code, /^[A-Z2-9]{4}$/);

  const zustand = await anna.wait('table_state');
  assert.equal(zustand.state.name, 'Stammtisch');
  assert.equal(zustand.state.youSeated, false, 'wer eröffnet, schaut erst einmal nur zu');
  assert.equal(zustand.state.seats.length, 9);

  anna.send({ type: 'sit', code, seat: 3 });
  const gesetzt = await tableWhere(anna, (state) => state.youSeated);
  assert.equal(gesetzt.state.seats[3].name, 'Anna');
  assert.equal(gesetzt.state.yourChips, 1000);

  anna.send({ type: 'stand' });
  const gestanden = await tableWhere(anna, (state) => !state.youSeated);
  assert.equal(gestanden.state.seats[3].playerId, null);
});

test('Server: ein leerer Tisch lässt sich betreten und wieder verlassen', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');
  anna.send({ type: 'create_table', game: 'blackjack', name: 'BJ' });
  const { code } = await anna.wait('table_created');

  // Beide Antworten kommen unmittelbar hintereinander – deshalb erst die
  // Wartenden anmelden und dann senden.
  anna.clear();
  const verlassen = anna.next('table_left');
  const floorNachher = anna.next('floor_state');
  anna.send({ type: 'leave_table' });
  await verlassen;
  const floor = await floorNachher;
  assert.equal(floor.you.viewing, null);
  assert.equal(floor.floor.tables.length, 1, 'der Tisch bleibt stehen');
});

test('Server: der Floor zeigt Tische aller Spiele mit ihren Einsätzen', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');

  for (const [game, config] of [
    ['holdem', { smallBlind: 25, bigBlind: 50 }],
    ['roulette', {}],
    ['slots', {}],
  ]) {
    anna.send({ type: 'create_table', game, config });
    await anna.next('table_created');
  }

  const floor = await until(async () => {
    const last = anna.last('floor_state');
    return last?.floor.tables.length === 3 ? last : null;
  });
  const poker = floor.floor.tables.find((table) => table.game === 'holdem');
  assert.equal(poker.stakes, '25/50', 'die Blinds stehen auf der Tischkarte');
  assert.equal(floor.floor.tables.find((table) => table.game === 'slots').seats, 1);
});

test('Server: an einen Automaten passt nur eine Person', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');
  const ben = await connect('Ben');

  anna.send({ type: 'create_table', game: 'slots' });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code });
  await tableWhere(anna, (state) => state.youSeated);

  ben.send({ type: 'view_table', code });
  await ben.wait('table_state');
  ben.send({ type: 'sit', code });
  const error = await ben.next('error');
  assert.equal(error.code, 'solo_table');
});

test('Server: ein Spieler sitzt nie an zwei Tischen', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'holdem' });
  const ersterTisch = await anna.wait('table_created');
  anna.send({ type: 'sit', code: ersterTisch.code });
  await tableWhere(anna, (state) => state.youSeated);

  anna.clear();
  anna.send({ type: 'create_table', game: 'blackjack' });
  const zweiterTisch = await anna.next('table_created');
  anna.send({ type: 'sit', code: zweiterTisch.code });
  const error = await anna.next('error');
  assert.equal(error.code, 'already_seated_elsewhere');
});

// -------------------------------------------------------- Sichtbarkeit

test('Server: jeder bekommt seine eigene Sicht – fremde Karten nie', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');
  const ben = await connect('Ben');

  anna.send({
    type: 'create_table',
    game: 'holdem',
    config: { smallBlind: 5, bigBlind: 10 },
  });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code, seat: 0 });
  ben.send({ type: 'view_table', code });
  await ben.wait('table_state');
  ben.send({ type: 'sit', code, seat: 1 });

  // Warten, bis eine Hand läuft und beide Karten haben.
  const annaSicht = await tableWhere(anna, (state) => state.private?.cards?.length === 2);
  const benSicht = await tableWhere(ben, (state) => state.private?.cards?.length === 2);

  const annaKarten = annaSicht.state.private.cards.map((card) => card.code);
  const benKarten = benSicht.state.private.cards.map((card) => card.code);
  assert.notDeepEqual(annaKarten, benKarten, 'zwei Spieler haben nicht dieselben Karten');

  // Annas Karten dürfen in Bens Nachricht nirgends vorkommen.
  const benRoh = JSON.stringify(benSicht);
  for (const code of annaKarten) {
    assert.equal(benRoh.includes(`"${code}"`), false, `${code} darf bei Ben nicht auftauchen`);
  }
  // Öffentlich ist nur die Anzahl.
  const annaÖffentlich = benSicht.state.public.players.find((p) => p.name === 'Anna');
  assert.equal(annaÖffentlich.cardCount, 2);
  assert.equal(annaÖffentlich.cards, null);
});

test('Server: ein Zuschauer sieht den Tisch, aber keine Hand', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');
  const gast = await connect('Gast');

  anna.send({ type: 'create_table', game: 'holdem' });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code });
  await tableWhere(anna, (state) => state.youSeated);

  gast.send({ type: 'view_table', code });
  const sicht = await gast.wait('table_state');
  assert.equal(sicht.state.youSeated, false);
  assert.equal(sicht.state.private, null, 'ohne Sitzplatz gibt es keine private Sicht');
});

// -------------------------------------------------------------- Aktionen

test('Server: fremde Züge werden abgelehnt', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');
  const ben = await connect('Ben');

  anna.send({ type: 'create_table', game: 'holdem', config: { smallBlind: 5, bigBlind: 10 } });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code, seat: 0 });
  ben.send({ type: 'view_table', code });
  await ben.wait('table_state');
  ben.send({ type: 'sit', code, seat: 1 });

  const laufend = await tableWhere(anna, (state) => state.actorId !== null);
  const amZug = laufend.state.actorId;
  const wartet = amZug === anna.playerId ? ben : anna;

  wartet.clear();
  wartet.send({ type: 'action', code, action: { move: 'fold' } });
  const error = await wartet.next('error');
  assert.equal(error.code, 'not_your_turn');
});

test('Server: ein Zuschauer kann nicht mitspielen', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');
  const gast = await connect('Gast');

  anna.send({ type: 'create_table', game: 'holdem' });
  const { code } = await anna.wait('table_created');
  gast.send({ type: 'view_table', code });
  await gast.wait('table_state');

  gast.send({ type: 'action', code, action: { move: 'fold' } });
  const error = await gast.next('error');
  assert.equal(error.code, 'not_seated');
});

test('Server: Bots setzen sich und spielen mit', async (t) => {
  const { connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'holdem', config: { smallBlind: 5, bigBlind: 10 } });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code, seat: 0 });
  await tableWhere(anna, (state) => state.youSeated);

  anna.send({ type: 'add_bot', code, difficulty: 'hard' });
  anna.send({ type: 'add_bot', code, difficulty: 'easy' });

  const mitBots = await tableWhere(
    anna,
    (state) => state.seats.filter((seat) => seat.isBot).length === 2,
  );
  const bots = mitBots.state.seats.filter((seat) => seat.isBot);
  assert.deepEqual(bots.map((bot) => bot.difficulty).sort(), ['easy', 'hard']);
  assert.ok(bots.every((bot) => bot.chips > 0), 'Bots bringen eigene Chips mit');

  // Es läuft eine Hand an.
  const handLäuft = await tableWhere(anna, (state) => state.public.handNumber >= 1);
  assert.ok(handLäuft.state.public.pot > 0, 'die Blinds liegen im Pot');

  anna.send({ type: 'remove_bot', code });
  const wenigerBots = await tableWhere(
    anna,
    (state) => state.seats.filter((seat) => seat.isBot).length === 1,
  );
  assert.ok(wenigerBots);
});

// ------------------------------------------------------------------ Host

test('Server: der Reset-Knopf füllt alle wieder auf', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna'); // wird Host
  const ben = await connect('Ben');

  server.casino.debit(anna.playerId, 900, 'test');
  server.casino.debit(ben.playerId, 500, 'test');
  assert.equal(server.casino.balanceOf(ben.playerId), 500);

  ben.clear();
  anna.send({ type: 'reset_chips' });

  const meldung = await ben.next('chips_reset');
  assert.equal(meldung.by, 'Anna');
  assert.equal(meldung.amount, 1000);
  assert.equal(server.casino.balanceOf(anna.playerId), 1000);
  assert.equal(server.casino.balanceOf(ben.playerId), 1000);
});

test('Server: nur der Host darf zurücksetzen', async (t) => {
  const { connect } = await setup(t);
  await connect('Anna');
  const ben = await connect('Ben');

  ben.clear();
  ben.send({ type: 'reset_chips' });
  const error = await ben.next('error');
  assert.equal(error.code, 'not_host');
});

test('Server: der Reset bricht laufende Runden ab und gibt Einsätze zurück', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'holdem', config: { smallBlind: 5, bigBlind: 10 } });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code, seat: 0 });
  await tableWhere(anna, (state) => state.youSeated);
  anna.send({ type: 'add_bot', code });

  // Warten, bis Blinds im Pot liegen.
  await tableWhere(anna, (state) => state.public.pot > 0);

  anna.send({ type: 'reset_chips' });
  await anna.next('chips_reset');

  assert.equal(server.casino.balanceOf(anna.playerId), 1000, 'auch der Blind ist zurück');
  const table = server.casino.table(code);
  assert.equal(table.engine.phase, 'waiting');
});

test('Server: der Host-PIN schützt den Host-Platz', async (t) => {
  const { connect } = await setup(t, { hostPin: 'geheim' });
  const anna = await connect('Anna');

  const floor = await anna.wait('floor_state');
  assert.equal(floor.you.isHost, false, 'mit PIN wird niemand automatisch Host');

  anna.send({ type: 'claim_host', pin: 'falsch' });
  const error = await anna.next('error');
  assert.equal(error.code, 'bad_pin');

  anna.send({ type: 'claim_host', pin: 'geheim' });
  const ok = await anna.next('host_changed');
  assert.equal(ok.isHost, true);
});

// ------------------------------------------------------ Wiederverbinden

test('Server: nach einem Verbindungsabbruch bleibt der Platz reserviert', async (t) => {
  const { server, connect } = await setup(t, { seatGraceMs: 60_000 });
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'holdem' });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code, seat: 2 });
  await tableWhere(anna, (state) => state.youSeated);

  anna.close();
  await until(() => server.casino.table(code).seats[2]?.away === true);

  // Mit Token zurückkommen – der Platz ist noch da.
  const zurück = new TestClient(server.url);
  await zurück.open();
  t.after(() => zurück.close());
  zurück.send({ type: 'enter', name: 'Anna', playerId: anna.playerId, token: anna.token });
  await zurück.wait('entered');

  const zustand = await zurück.wait('table_state');
  assert.equal(zustand.state.youSeated, true, 'derselbe Platz');
  assert.equal(zustand.state.seats[2].away, false, 'und wieder als anwesend markiert');
});

test('Server: mehrere Tabs desselben Spielers bekommen beide den Zustand', async (t) => {
  const { server, connect } = await setup(t);
  const tab1 = await connect('Anna');

  const tab2 = new TestClient(server.url);
  await tab2.open();
  t.after(() => tab2.close());
  tab2.send({ type: 'enter', name: 'Anna', playerId: tab1.playerId, token: tab1.token });
  await tab2.wait('entered');

  tab1.send({ type: 'create_table', game: 'roulette' });
  const { code } = await tab1.wait('table_created');
  tab1.send({ type: 'sit', code });

  // Der zweite Tab sieht die Änderung auf dem Floor.
  const floor = await tab2.next(
    (message) => message.type === 'floor_state' && message.floor.tables.length === 1,
  );
  assert.equal(floor.floor.tables[0].code, code);
});

// ------------------------------------------------------------ Weggehen

/**
 * Kernzusage: Wer weg will, kommt weg – in jedem Spiel und in jeder Phase.
 * Der Platz wird sofort frei, der Tisch läuft ohne den Weggegangenen weiter.
 */
for (const spiel of ['holdem', 'blackjack', 'slots', 'roulette', 'baccarat']) {
  test(`Server: aufstehen geht bei ${spiel} jederzeit`, async (t) => {
    const { server, connect } = await setup(t);
    const anna = await connect('Anna');

    anna.send({ type: 'create_table', game: spiel });
    const { code } = await anna.wait('table_created');
    anna.send({ type: 'sit', code, seat: 0 });
    await tableWhere(anna, (state) => state.youSeated);

    // Bei Solo-Automaten gibt es keine Bots; sonst läuft eine Runde an.
    if (spiel !== 'slots') anna.send({ type: 'add_bot', code });
    // Kurz laufen lassen, damit wirklich mitten in etwas hineingegriffen wird.
    await new Promise((resolve) => setTimeout(resolve, 700));

    anna.send({ type: 'stand' });
    const gestanden = await tableWhere(anna, (state) => !state.youSeated);
    assert.equal(gestanden.state.seats[0].playerId, null, 'der Platz ist sofort frei');

    const table = server.casino.table(code);
    assert.equal(table.seatOf(anna.playerId), null);
    assert.ok(table.spectators.has(anna.playerId), 'zuschauen darf man weiter');
    assert.equal(server.casino.player(anna.playerId).seatedAt, null);
  });

  test(`Server: das Casino verlassen geht bei ${spiel} jederzeit`, async (t) => {
    const { server, connect } = await setup(t);
    const anna = await connect('Anna');

    anna.send({ type: 'create_table', game: spiel });
    const { code } = await anna.wait('table_created');
    anna.send({ type: 'sit', code, seat: 0 });
    await tableWhere(anna, (state) => state.youSeated);
    if (spiel !== 'slots') anna.send({ type: 'add_bot', code });
    await new Promise((resolve) => setTimeout(resolve, 700));

    anna.send({ type: 'leave_casino' });
    await anna.next('left_casino');

    const table = server.casino.table(code);
    assert.equal(table.seatOf(anna.playerId), null, 'der Platz ist frei');
    assert.equal(table.spectators.has(anna.playerId), false, 'und niemand schaut mehr zu');
    assert.equal(server.casino.player(anna.playerId).online, false);
    assert.equal(
      server.casino.guests().some((guest) => guest.id === anna.playerId),
      false,
      'aus der Gästeliste ist er raus',
    );
  });
}

test('Server: nach dem Verlassen kommt man mit demselben Namen zurück', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna');
  server.casino.debit(anna.playerId, 250, 'test');

  anna.send({ type: 'leave_casino' });
  await anna.next('left_casino');

  // Dieselbe Verbindung darf sofort wieder eintreten.
  anna.send({ type: 'enter', name: 'Anna' });
  const wieder = await anna.next('entered');
  assert.equal(wieder.playerId, anna.playerId, 'dieselbe Geldbörse');
  assert.equal(wieder.chips, 750, 'mit demselben Stand');
});

test('Server: wer mitten im Zug aufsteht, blockiert den Tisch nicht', async (t) => {
  const { server, connect } = await setup(t, { botMs: 5 });
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'holdem', config: { smallBlind: 5, bigBlind: 10 } });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code, seat: 0 });
  await tableWhere(anna, (state) => state.youSeated);
  anna.send({ type: 'add_bot', code });
  anna.send({ type: 'add_bot', code });

  // Warten, bis Anna wirklich am Zug ist.
  await tableWhere(anna, (state) => state.actorId === anna.playerId);
  const table = server.casino.table(code);
  const handVorher = table.engine.handNumber;

  anna.send({ type: 'stand' });
  await tableWhere(anna, (state) => !state.youSeated);

  // Die Bots spielen unter sich weiter – der Tisch bleibt nicht auf Anna warten.
  await until(() => table.engine.handNumber > handVorher, { timeout: 15_000 });
  assert.notEqual(table.engine.actorId, anna.playerId);
  assert.deepEqual(
    anna.messages.filter((message) => message.type === 'error'),
    [],
  );
});

test('Server: beim Weggehen kommen noch nicht gedrehte Einsätze zurück', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'roulette', config: { minBet: 10, maxBet: 500 } });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code });
  await tableWhere(anna, (state) => state.youSeated);

  anna.send({
    type: 'action',
    code,
    action: { move: 'bet', betType: 'red', arg: null, amount: 200 },
  });
  await until(() => server.casino.balanceOf(anna.playerId) === 800);

  anna.send({ type: 'leave_casino' });
  await anna.next('left_casino');
  assert.equal(
    server.casino.balanceOf(anna.playerId),
    1000,
    'das Rad hat sich nicht gedreht – also gibt es die Chips zurück',
  );
});

test('Server: ein weggegangener Gast bekommt seinen Gewinn trotzdem gutgeschrieben', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna');

  anna.send({ type: 'create_table', game: 'slots', config: { minBet: 10, maxBet: 10 } });
  const { code } = await anna.wait('table_created');
  anna.send({ type: 'sit', code });
  await tableWhere(anna, (state) => state.youSeated);

  const table = server.casino.table(code);
  anna.send({ type: 'action', code, action: { move: 'spin', amount: 10 } });
  await until(() => table.engine.spinning);

  // Mitten im Lauf der Walzen weggehen.
  anna.send({ type: 'leave_casino' });
  await anna.next('left_casino');

  await until(() => !table.engine.spinning, { timeout: 5000 });
  const gewinn = table.engine.lastResult.amount;
  assert.equal(
    server.casino.balanceOf(anna.playerId),
    990 + gewinn,
    'der Einsatz war weg, also muss auch der Gewinn kommen',
  );
});

test('Server: mehrere Gäste können gleichzeitig gehen', async (t) => {
  const { server, connect } = await setup(t);
  const anna = await connect('Anna');
  const ben = await connect('Ben');
  const cem = await connect('Cem');

  anna.send({ type: 'create_table', game: 'holdem' });
  const { code } = await anna.wait('table_created');
  for (const [client, seat] of [
    [anna, 0],
    [ben, 1],
    [cem, 2],
  ]) {
    client.send({ type: 'view_table', code });
    await client.wait('table_state');
    client.send({ type: 'sit', code, seat });
    await tableWhere(client, (state) => state.youSeated);
  }

  for (const client of [anna, ben, cem]) client.send({ type: 'leave_casino' });
  for (const client of [anna, ben, cem]) await client.next('left_casino');

  const table = server.casino.table(code);
  assert.equal(table.occupiedCount, 0, 'der Tisch ist leer');
  assert.equal(server.casino.guests().length, 0, 'und das Casino auch');
});

// ------------------------------------------------------------ Ausdauer

test('Server: ein Tisch mit lauter Bots läuft ohne Fehler durch', async (t) => {
  const { server, connect } = await setup(t, { botMs: 5 });
  const gast = await connect('Gast');

  gast.send({
    type: 'create_table',
    game: 'holdem',
    config: { smallBlind: 5, bigBlind: 10 },
  });
  const { code } = await gast.wait('table_created');
  // Nur zuschauen – die Bots spielen unter sich.
  for (let i = 0; i < 4; i++) gast.send({ type: 'add_bot', code, difficulty: 'medium' });

  await tableWhere(gast, (state) => state.seats.filter((seat) => seat.isBot).length === 4);
  const table = server.casino.table(code);
  const summeVorher = table.seats
    .filter(Boolean)
    .reduce((sum, seat) => sum + server.casino.balanceOf(seat.playerId), 0);

  // Zwischen den Händen liegen bewusst Anzeigepausen (Showdown ~5 s), deshalb
  // reichen zwei Hände als Nachweis, dass die Kette von allein weiterläuft.
  await until(() => table.engine.handNumber >= 2, { timeout: 25_000 });

  const fehler = gast.messages.filter((message) => message.type === 'error');
  assert.deepEqual(fehler, [], 'es darf kein einziger Fehler auftreten');

  const summeNachher =
    table.seats.filter(Boolean).reduce((sum, seat) => sum + server.casino.balanceOf(seat.playerId), 0) +
    table.engine.players.reduce((sum, player) => sum + player.total, 0);
  assert.equal(summeNachher, summeVorher, 'am Pokertisch bleibt die Chipsumme konstant');
});
