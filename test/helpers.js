/**
 * Testhelfer: Server hochfahren, WebSocket-Clients, Karten aus dem Deck holen.
 */

import { once } from 'node:events';

import { WebSocket } from 'ws';

import { createServer } from '../server/app.js';
import { config as baseConfig } from '../server/config.js';
import { createDeck } from '../core/cards.js';

const ALL = createDeck();

/** Holt eine Karte per Code, z. B. C('As'), C('Td'). */
export function C(code) {
  const card = ALL.find((entry) => entry.code === code);
  if (!card) throw new Error(`Unbekannte Karte: ${code}`);
  return { ...card };
}

/** Mehrere Karten auf einmal: CS('As','Kd'). */
export const CS = (...codes) => codes.map(C);

/**
 * Baut ein Deck, das von oben (Ende des Arrays) genau die gewünschten Karten
 * liefert. `draw()` nimmt mit `pop()` vom Ende – deshalb wird umgedreht.
 */
export function riggedDeck(...codes) {
  const wanted = codes.map(C);
  const used = new Set(wanted.map((card) => card.code));
  const rest = ALL.filter((card) => !used.has(card.code)).map((card) => ({ ...card }));
  return [...rest, ...wanted.reverse()];
}

/** Startet einen Testserver mit In-Memory-Datenbank. */
export async function startServer(overrides = {}) {
  const config = {
    ...baseConfig,
    startChips: 1000,
    turnMs: 500,
    botMs: 5,
    seatGraceMs: 60_000,
    hostPin: '',
    ...overrides,
  };
  const instance = createServer({ config, dbFile: ':memory:', log: () => {} });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  return { ...instance, port, url: `ws://127.0.0.1:${port}/ws` };
}

/**
 * Ein Testclient: sammelt eingehende Nachrichten und kann gezielt auf eine
 * bestimmte Nachricht warten.
 */
export class TestClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.messages = [];
    this.waiters = [];
  }

  static async connect(url, name = null) {
    const client = new TestClient(url);
    await client.open();
    if (name) await client.enter(name);
    return client;
  }

  async open() {
    this.socket = new WebSocket(this.url);
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    await once(this.socket, 'open');
    return this;
  }

  send(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  /** Wartet auf die nächste passende Nachricht (auch bereits eingetroffene). */
  wait(match, { timeout = 4000, fresh = false } = {}) {
    const test = typeof match === 'string' ? (message) => message.type === match : match;
    if (!fresh) {
      const existing = this.messages.find(test);
      if (existing) return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { match: test, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return;
        this.waiters.splice(index, 1);
        reject(new Error(`Timeout beim Warten auf ${match}`));
      }, timeout).unref();
    });
  }

  /** Wartet auf eine Nachricht, die *nach* diesem Aufruf eintrifft. */
  next(match, options = {}) {
    return this.wait(match, { ...options, fresh: true });
  }

  clear() {
    this.messages.length = 0;
  }

  /** Letzte Nachricht eines Typs. */
  last(type) {
    return [...this.messages].reverse().find((message) => message.type === type) ?? null;
  }

  async enter(name) {
    this.send({ type: 'enter', name });
    const message = await this.wait('entered');
    this.playerId = message.playerId;
    this.token = message.token;
    this.name = message.name;
    return message;
  }

  close() {
    this.socket?.close();
  }
}

/** Wartet, bis eine Bedingung erfüllt ist (oder es zu lange dauert). */
export async function until(predicate, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Bedingung nicht rechtzeitig erfüllt');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
