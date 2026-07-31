/**
 * Fundament-Tests.
 *
 * Der Tisch wird hier bewusst mit einem **Fantasie-Spiel** betrieben, das es
 * im Casino gar nicht gibt. Genau das ist der Punkt: Wenn Sitzverwaltung,
 * Bots, Bedenkzeit und Wallet mit einem beliebigen Modul funktionieren, ist
 * der Tisch wirklich spielunabhängig – und ein neues Spiel braucht später
 * keine Änderung am Fundament.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { GameEngine, GameError } from '../core/engine.js';
import { CasinoTable } from '../core/table.js';
import { Rng } from '../core/rng.js';
import { Shoe, createDeck, createShoeCards } from '../core/cards.js';
import { CasinoDb } from '../server/db.js';
import { Casino } from '../server/casino.js';
import { config as baseConfig } from '../server/config.js';

// ------------------------------------------------------------ Testspiel

/**
 * „Höher/Tiefer“: Reihum setzt jeder 10 Chips, der Zug endet sofort. Nach
 * einer Runde bekommt der letzte Spieler den ganzen Topf. Reicht völlig,
 * um Sitzplätze, Timer und Wallet zu prüfen.
 */
class ToyEngine extends GameEngine {
  constructor(ctx) {
    super(ctx);
    this.pot = 0;
    this.turnIndex = 0;
    this.order = [];
    this.currentDeadline = null;
    this.history = [];
  }

  get actorId() {
    return this.order[this.turnIndex] ?? null;
  }

  get deadline() {
    return this.actorId ? this.currentDeadline : null;
  }

  tick() {
    if (this.order.length) return;
    const seats = this.ctx.seats();
    if (seats.length < 2) return;
    this.order = seats.map((seat) => seat.playerId);
    this.turnIndex = 0;
    this.currentDeadline = Date.now() + this.config.turnMs;
  }

  seatsChanged() {
    if (!this.order.length) return;
    // Wer aufsteht, fliegt aus der laufenden Runde.
    const present = new Set(this.ctx.seats().map((seat) => seat.playerId));
    this.order = this.order.filter((id) => present.has(id));
    if (this.turnIndex >= this.order.length) this.finish();
  }

  act(playerId, action) {
    if (playerId !== this.actorId) throw new GameError('not_your_turn', 'Du bist nicht dran.');
    if (action.move !== 'bet') throw new GameError('bad_action', 'Unbekannter Zug.');
    this.ctx.wallet.debit(playerId, 10, 'toy');
    this.pot += 10;
    this.history.push({ playerId, move: 'bet' });
    this.advance();
  }

  timeout(playerId) {
    this.history.push({ playerId, move: 'timeout' });
    this.advance();
  }

  botAct(playerId, difficulty) {
    this.history.push({ playerId, move: 'bot', difficulty });
    this.ctx.wallet.debit(playerId, 10, 'toy');
    this.pot += 10;
    this.advance();
  }

  advance() {
    this.turnIndex += 1;
    this.currentDeadline = Date.now() + this.config.turnMs;
    if (this.turnIndex >= this.order.length) this.finish();
  }

  finish() {
    const winner = this.order.at(-1);
    if (winner && this.pot) this.ctx.wallet.credit(winner, this.pot, 'toy-win');
    this.pot = 0;
    this.order = [];
    this.turnIndex = 0;
    this.currentDeadline = null;
  }

  publicState() {
    return { pot: this.pot, moves: this.history.length };
  }

  privateState(playerId) {
    return { secret: `nur-für-${playerId}` };
  }
}

const toyModule = {
  id: 'toy',
  name: 'Höher/Tiefer',
  tagline: 'Testspiel',
  icon: '🎲',
  minPlayers: 2,
  maxPlayers: 4,
  supportsBots: true,
  defaultConfig: { turnMs: 200 },
  configFields: [{ key: 'turnMs', label: 'Bedenkzeit', type: 'int', min: 50, max: 5000, step: 50 }],
  createEngine: (ctx) => new ToyEngine(ctx),
};

// ----------------------------------------------------------------- Aufbau

/**
 * Baut einen Testtisch. `t` ist der Testkontext – der Tisch wird darüber
 * garantiert wieder geschlossen, auch wenn eine Zusicherung fehlschlägt.
 * Sonst liefen die Timer des Testspiels endlos weiter.
 */
function makeTable(t, overrides = {}) {
  const balances = new Map();
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
    code: 'TEST',
    module: toyModule,
    name: 'Testtisch',
    config: { turnMs: 200 },
    wallet,
    botMs: 5,
    ...overrides,
  });
  t.after(() => table.close());
  return { table, balances, wallet };
}

// ------------------------------------------------------------------ RNG

test('RNG: gesät ist reproduzierbar, ungesät nicht', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  const seriesA = Array.from({ length: 10 }, () => a.int(1000));
  const seriesB = Array.from({ length: 10 }, () => b.int(1000));
  assert.deepEqual(seriesA, seriesB);

  const live = new Rng();
  const values = new Set(Array.from({ length: 200 }, () => live.int(1_000_000)));
  assert.ok(values.size > 190, 'echter Zufall darf sich nicht ständig wiederholen');
});

test('RNG: int() bleibt in den Grenzen und deckt sie ab', () => {
  const rng = new Rng(7);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const value = rng.int(6);
    assert.ok(value >= 0 && value < 6);
    seen.add(value);
  }
  assert.equal(seen.size, 6, 'alle sechs Werte müssen vorkommen');
});

test('RNG: shuffle behält alle Karten', () => {
  const rng = new Rng(42);
  const deck = rng.shuffle(createDeck());
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((card) => card.code)).size, 52);
});

// ---------------------------------------------------------------- Karten

test('Deck: 52 eindeutige Karten mit korrekten Werten', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(deck.filter((card) => card.suit === 'h').length, 13);
  assert.equal(deck.find((card) => card.code === 'As').value, 14);
  assert.equal(deck.find((card) => card.code === '2c').value, 2);
  assert.equal(deck.find((card) => card.code === 'Td').value, 10);
});

test('Schuh: eindeutige IDs über mehrere Decks und Neumischen an der Cut-Card', () => {
  const cards = createShoeCards(6);
  assert.equal(cards.length, 312);
  assert.equal(new Set(cards.map((card) => card.id)).size, 312);

  const shoe = new Shoe({ decks: 2, rng: new Rng(5), penetration: 0.5 });
  assert.equal(shoe.remaining, 104);
  shoe.drawMany(60);
  assert.ok(shoe.needsShuffle, 'unter 50 % muss die Cut-Card greifen');
  assert.equal(shoe.reshuffleIfNeeded(), true);
  assert.equal(shoe.remaining, 104);
  assert.equal(shoe.reshuffleIfNeeded(), false);
});

// ----------------------------------------------------------------- Tisch

test('Tisch: hinsetzen, aufstehen, Plätze belegen', (t) => {
  const { table } = makeTable(t);
  assert.equal(table.occupiedCount, 0);

  const seatA = table.sit({ playerId: 'a', name: 'Anna' });
  assert.equal(seatA, 0);
  table.sit({ playerId: 'b', name: 'Ben', index: 3 });
  assert.equal(table.occupiedCount, 2);
  assert.equal(table.seatOf('b').index, 3);

  assert.throws(() => table.sit({ playerId: 'c', name: 'Cem', index: 3 }), /besetzt/);
  assert.throws(() => table.sit({ playerId: 'a', name: 'Anna' }), /schon an diesem Tisch/);
  assert.throws(() => table.sit({ playerId: 'c', name: 'Cem', index: 99 }), /Platz gibt es/);

  table.stand('a');
  assert.equal(table.occupiedCount, 1);
  assert.ok(table.spectators.has('a'), 'wer aufsteht, schaut weiter zu');
});

test('Tisch: Bots setzen, entfernen und Schwierigkeit ändern', (t) => {
  const { table, balances } = makeTable(t);
  const bot = table.addBot('hard');
  assert.equal(bot.isBot, true);
  assert.equal(bot.difficulty, 'hard');
  assert.equal(balances.get(bot.playerId), 1000, 'ein Bot bekommt ein eigenes Guthaben');

  table.addBot('bogus');
  assert.equal(table.seats.filter((seat) => seat?.isBot)[1].difficulty, 'medium');

  table.setBotDifficulty('easy');
  assert.ok(table.seats.filter(Boolean).every((seat) => seat.difficulty === 'easy'));

  table.removeBot(bot.playerId);
  assert.equal(table.botCount, 1);
  assert.equal(balances.has(bot.playerId), false, 'Bot-Guthaben wird wieder freigegeben');
});

test('Tisch: verdeckte Informationen bleiben beim Besitzer', (t) => {
  const { table } = makeTable(t);
  table.sit({ playerId: 'a', name: 'Anna' });
  table.sit({ playerId: 'b', name: 'Ben' });

  const stateA = table.stateFor('a');
  const stateB = table.stateFor('b');
  assert.equal(stateA.private.secret, 'nur-für-a');
  assert.equal(stateB.private.secret, 'nur-für-b');
  assert.equal(JSON.stringify(stateA.public).includes('nur-für'), false);
});

test('Tisch: fremde Züge werden abgelehnt, eigene ausgeführt', (t) => {
  const { table, balances } = makeTable(t);
  balances.set('a', 100);
  balances.set('b', 100);
  table.sit({ playerId: 'a', name: 'Anna' });
  table.sit({ playerId: 'b', name: 'Ben' });

  assert.equal(table.engine.actorId, 'a');
  assert.throws(() => table.act('b', { move: 'bet' }), /nicht dran/);
  assert.throws(() => table.act('zuschauer', { move: 'bet' }), /an den Tisch setzen/);

  table.act('a', { move: 'bet' });
  assert.equal(balances.get('a'), 90);
  assert.equal(table.engine.actorId, 'b');
});

test('Tisch: Bedenkzeit läuft ab und der Zug wird automatisch beendet', async (t) => {
  const { table, balances } = makeTable(t);
  balances.set('a', 100);
  balances.set('b', 100);
  table.sit({ playerId: 'a', name: 'Anna' });
  table.sit({ playerId: 'b', name: 'Ben' });

  assert.equal(table.engine.actorId, 'a');
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.ok(
    table.engine.history.some((entry) => entry.playerId === 'a' && entry.move === 'timeout'),
    'nach Ablauf der Bedenkzeit greift die Standardaktion',
  );
});

test('Tisch: Bots spielen von selbst weiter', async (t) => {
  const { table, balances } = makeTable(t);
  balances.set('a', 100);
  table.sit({ playerId: 'a', name: 'Anna' });
  table.addBot('hard');

  table.act('a', { move: 'bet' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const botMove = table.engine.history.find((entry) => entry.move === 'bot');
  assert.ok(botMove, 'der Bot muss von allein ziehen');
  assert.equal(botMove.difficulty, 'hard', 'die Schwierigkeit wird durchgereicht');
});

test('Tisch: eine kaputte Bot-Entscheidung blockiert den Tisch nicht', async (t) => {
  const { table, balances } = makeTable(t);
  balances.set('a', 100);
  table.sit({ playerId: 'a', name: 'Anna' });
  const bot = table.addBot();
  // Der Bot hat kein Guthaben mehr → sein Zug wirft.
  balances.set(bot.playerId, 0);

  table.act('a', { move: 'bet' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  // Der Zug des Bots scheitert, der Tisch fängt das ab und macht weiter:
  // Die Runde wird zu Ende gebracht und die nächste beginnt.
  assert.ok(
    table.engine.history.some((entry) => entry.playerId === bot.playerId),
    'der gescheiterte Bot-Zug muss als Standardaktion enden',
  );
  assert.equal(table.engine.actorId, 'a', 'danach läuft der Tisch normal weiter');
});

// ---------------------------------------------------------------- Casino

function makeCasino(overrides = {}) {
  const db = new CasinoDb(':memory:');
  const config = { ...baseConfig, startChips: 1000, hostPin: '', ...overrides };
  const casino = new Casino({ db, config });
  return { casino, db };
}

test('Casino: Eintritt vergibt Startguthaben, gleicher Name = gleiche Börse', () => {
  const { casino } = makeCasino();
  const anna = casino.enter({ name: 'Anna' });
  assert.equal(anna.chips, 1000);

  casino.debit(anna.id, 250, 'test');
  assert.equal(casino.balanceOf(anna.id), 750);

  anna.online = false;
  const again = casino.enter({ name: 'anna' });
  assert.equal(again.id, anna.id, 'der Name führt zurück auf dieselbe Geldbörse');
  assert.equal(again.chips, 750);
});

test('Casino: doppelte Namen werden abgewiesen, solange jemand online ist', () => {
  const { casino } = makeCasino();
  const anna = casino.enter({ name: 'Anna' });
  anna.online = true;
  assert.throws(() => casino.enter({ name: 'ANNA' }), /gerade jemand/);
});

test('Casino: Sitzung lässt sich per Token fortsetzen', () => {
  const { casino } = makeCasino();
  const anna = casino.enter({ name: 'Anna' });
  anna.online = true;
  const resumed = casino.enter({ name: 'Anna', playerId: anna.id, token: anna.token });
  assert.equal(resumed.id, anna.id);
});

test('Casino: kein Einsatz ohne Deckung (kein Rebuy)', () => {
  const { casino } = makeCasino({ startChips: 50 });
  const anna = casino.enter({ name: 'Anna' });
  casino.debit(anna.id, 50, 'test');
  assert.equal(casino.balanceOf(anna.id), 0);
  assert.throws(() => casino.debit(anna.id, 1, 'test'), /reicht dein Guthaben nicht/);
});

test('Casino: Namen werden entschärft', () => {
  const { casino } = makeCasino();
  const player = casino.enter({ name: '  <script>x</script>  ' });
  assert.equal(player.name.includes('<'), false);
  assert.throws(() => casino.enter({ name: 'x' }), /2 bis 16/);
});

test('Casino: Reset-Knopf setzt alle auf das Startguthaben', () => {
  const { casino } = makeCasino({ startChips: 1000 });
  const anna = casino.enter({ name: 'Anna' });
  const ben = casino.enter({ name: 'Ben' });
  casino.debit(anna.id, 900, 'test');
  casino.credit(ben.id, 500, 'test');
  assert.equal(casino.balanceOf(anna.id), 100);
  assert.equal(casino.balanceOf(ben.id), 1500);

  assert.throws(() => casino.resetAllChips(ben.id), /nur der Host/i);
  casino.resetAllChips(anna.id); // Anna ist als Erste eingetreten → Host
  assert.equal(casino.balanceOf(anna.id), 1000);
  assert.equal(casino.balanceOf(ben.id), 1000);
});

test('Casino: ein Spieler sitzt an höchstens einem Tisch', () => {
  const { casino } = makeCasino();
  const anna = casino.enter({ name: 'Anna' });
  const one = casino.createTable({ gameId: 'holdem', name: 'Tisch 1', ownerId: anna.id });
  const two = casino.createTable({ gameId: 'holdem', name: 'Tisch 2', ownerId: anna.id });

  casino.sit(anna.id, one.code);
  assert.throws(() => casino.sit(anna.id, two.code), /anderen Tisch/);

  casino.stand(anna.id);
  casino.sit(anna.id, two.code);
  assert.equal(casino.player(anna.id).seatedAt, two.code);
});

test('Casino: Tische überstehen einen Neustart', () => {
  const db = new CasinoDb(':memory:');
  const config = { ...baseConfig, startChips: 1000, hostPin: '' };
  const first = new Casino({ db, config });
  const anna = first.enter({ name: 'Anna' });
  const table = first.createTable({
    gameId: 'holdem',
    name: 'Stammtisch',
    config: { smallBlind: 25, bigBlind: 50 },
    ownerId: anna.id,
  });
  first.close();

  // Neue Instanz auf derselben Datenbank – wie nach einem Container-Neustart.
  const second = new Casino({ db, config });
  const restored = second.table(table.code);
  assert.ok(restored, 'der Tisch muss wieder da sein');
  assert.equal(restored.name, 'Stammtisch');
  assert.equal(restored.config.smallBlind, 25);
  assert.equal(restored.occupiedCount, 0, 'aber leer – laufende Hände werden nicht gerettet');
});

test('Casino: unbekannte Spiele und kaputte Einstellungen werden abgewiesen', () => {
  const { casino } = makeCasino();
  assert.throws(() => casino.createTable({ gameId: 'nichtda', name: 'X' }), /gibt es hier nicht/);

  const table = casino.createTable({
    gameId: 'holdem',
    name: 'T',
    config: { smallBlind: 999_999, bigBlind: -5, unbekannt: 'weg' },
  });
  assert.equal('unbekannt' in table.config, false, 'unbekannte Schlüssel fliegen raus');
  assert.ok(table.config.smallBlind > 0 && table.config.bigBlind > table.config.smallBlind);
});
