/**
 * Ein Tisch auf dem Floor.
 *
 * Der Tisch kennt kein einziges Spiel namentlich: Er verwaltet Sitzplätze,
 * Zuschauer, Bedenkzeit und Bots und ruft ansonsten nur die Methoden aus
 * `core/engine.js` auf. Genau deshalb lässt sich ein neues Spiel ergänzen,
 * ohne hier oder in einem anderen Spiel etwas zu ändern.
 *
 * Ablauf nach jeder Änderung:
 *   sync() → engine.tick() → Zustand verteilen → wer ist dran?
 *          → Bot einplanen ODER Zug-Timer stellen (Timeout = Auto-Fold/Check)
 */

import { randomUUID } from 'node:crypto';

import { GameError } from './engine.js';
import { Rng } from './rng.js';

/** Namen für Bots – bewusst harmlos und ohne Bezug zu echten Anbietern. */
export const BOT_NAMES = [
  'Ada',
  'Bruno',
  'Cleo',
  'Dante',
  'Elif',
  'Fynn',
  'Greta',
  'Hugo',
  'Ida',
  'Jonas',
  'Karla',
  'Lex',
];

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

export const DIFFICULTY_LABELS = {
  easy: 'leicht',
  medium: 'mittel',
  hard: 'schwer',
};

export function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : 'medium';
}

export class CasinoTable {
  /**
   * @param {object} options
   * @param {string} options.code Tischcode (auch Beitrittscode)
   * @param {object} options.module Spielmodul aus games/
   * @param {string} options.name Anzeigename des Tisches
   * @param {object} options.config Tischeinstellungen (bereits validiert)
   * @param {string|null} options.ownerId Wer den Tisch erstellt hat
   * @param {object} options.wallet Wallet-Zugriff (server-autoritativ)
   * @param {() => void} options.onChange Wird nach jeder Zustandsänderung gerufen
   * @param {number} options.botMs Bedenkzeit eines Bots
   * @param {Function} options.log
   * @param {import('./rng.js').Rng} [options.rng]
   */
  constructor({
    code,
    module,
    name,
    config,
    ownerId = null,
    wallet,
    onChange = () => {},
    botMs = 1100,
    log = () => {},
    rng = new Rng(),
  }) {
    this.code = code;
    this.module = module;
    this.name = name;
    this.config = config;
    this.ownerId = ownerId;
    this.wallet = wallet;
    this.onChange = onChange;
    this.botMs = botMs;
    this.log = log;
    this.rng = rng;

    this.createdAt = Date.now();
    this.lastActivity = Date.now();

    /** @type {Array<null|{playerId,name,isBot,difficulty,away,joinedAt}>} */
    this.seats = new Array(module.maxPlayers).fill(null);
    /** @type {Set<string>} Zuschauer (sehen zu, setzen nicht) */
    this.spectators = new Set();

    this.timers = new Set();
    this.actorTimer = null;
    this.actorKey = null;
    /** Einmalige Ereignisse für Animationen, werden beim Verteilen geleert. */
    this.pendingEvents = [];

    this.inSync = false;
    this.dirty = false;
    this.closed = false;

    this.engine = module.createEngine(this.engineContext());
  }

  /** Der Kontext, den die Engine bekommt. */
  engineContext() {
    return {
      config: this.config,
      rng: this.rng,
      table: this,
      seats: () => this.activeSeats(),
      /** Schaut überhaupt jemand zu? Ohne Publikum spielen Bots nicht weiter. */
      hasAudience: () => this.anyonePresent,
      wallet: this.wallet,
      later: (fn, ms) => this.later(fn, ms),
      sync: () => this.sync(),
      emit: (event) => this.emit(event),
      log: (...args) => this.log(`[${this.code}]`, ...args),
    };
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---------------------------------------------------------------- Timer

  /** setTimeout, das beim Schließen des Tisches mit abgeräumt wird. */
  later(fn, ms) {
    if (this.closed) return null;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      try {
        fn();
      } catch (error) {
        this.log(`[${this.code}] Timer-Fehler:`, error.message);
      }
    }, Math.max(0, ms));
    this.timers.add(timer);
    return timer;
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.actorTimer) clearTimeout(this.actorTimer);
    this.actorTimer = null;
    this.actorKey = null;
  }

  // -------------------------------------------------------------- Sitzplätze

  activeSeats() {
    return this.seats
      .map((seat, index) => (seat ? { ...seat, index, chips: this.wallet.balance(seat.playerId) } : null))
      .filter(Boolean);
  }

  seatOf(playerId) {
    const index = this.seats.findIndex((seat) => seat?.playerId === playerId);
    return index === -1 ? null : { ...this.seats[index], index };
  }

  get occupiedCount() {
    return this.seats.filter(Boolean).length;
  }

  get humanCount() {
    return this.seats.filter((seat) => seat && !seat.isBot).length;
  }

  get botCount() {
    return this.seats.filter((seat) => seat?.isBot).length;
  }

  get freeSeatCount() {
    return this.seats.filter((seat) => !seat).length;
  }

  /** Sitzt hier noch ein Mensch, der verbunden ist? */
  get anyonePresent() {
    return this.seats.some((seat) => seat && !seat.isBot && !seat.away) || this.spectators.size > 0;
  }

  /**
   * Setzt einen Spieler an den Tisch.
   * @param {number|null} preferredIndex gewünschter Platz, sonst der erste freie
   */
  sit({ playerId, name, index = null }) {
    if (this.seatOf(playerId)) {
      throw new GameError('already_seated', 'Du sitzt schon an diesem Tisch.');
    }
    let target = index;
    if (target === null || target === undefined) {
      target = this.seats.findIndex((seat) => !seat);
    }
    target = Number(target);
    if (!Number.isInteger(target) || target < 0 || target >= this.seats.length) {
      throw new GameError('bad_seat', 'Diesen Platz gibt es an diesem Tisch nicht.');
    }
    if (this.seats[target]) {
      throw new GameError('seat_taken', 'Dieser Platz ist schon besetzt.');
    }
    this.seats[target] = {
      playerId,
      name,
      isBot: false,
      difficulty: 'medium',
      away: false,
      joinedAt: Date.now(),
    };
    this.spectators.delete(playerId);
    this.touch();
    this.engine.seatsChanged();
    this.sync();
    return target;
  }

  /** Spieler steht auf – bleibt aber als Zuschauer am Tisch. */
  stand(playerId, { keepWatching = true } = {}) {
    const index = this.seats.findIndex((seat) => seat?.playerId === playerId);
    if (index === -1) return false;
    this.seats[index] = null;
    if (keepWatching) this.spectators.add(playerId);
    this.touch();
    this.engine.seatsChanged();
    this.sync();
    return true;
  }

  /** Setzt einen Bot auf einen freien Platz. */
  addBot(difficulty = 'medium', index = null) {
    if (!this.module.supportsBots) {
      throw new GameError('no_bots', 'An diesem Spiel gibt es keine Bots.');
    }
    let target = index;
    if (target === null || target === undefined) target = this.seats.findIndex((seat) => !seat);
    if (target === -1 || this.seats[target]) {
      throw new GameError('table_full', 'Es ist kein Platz mehr frei.');
    }
    const taken = new Set(this.seats.filter(Boolean).map((seat) => seat.name));
    const name = BOT_NAMES.find((candidate) => !taken.has(candidate)) ?? `Bot ${target + 1}`;
    const bot = {
      playerId: `bot:${randomUUID()}`,
      name,
      isBot: true,
      difficulty: normalizeDifficulty(difficulty),
      away: false,
      joinedAt: Date.now(),
    };
    this.seats[target] = bot;
    // Bots bekommen ein eigenes Guthaben, damit sie mitsetzen können.
    this.wallet.openBotWallet(bot.playerId);
    this.touch();
    this.engine.seatsChanged();
    this.sync();
    return bot;
  }

  /** Entfernt einen Bot (ohne ID den zuletzt gesetzten). */
  removeBot(playerId = null) {
    const indexes = this.seats
      .map((seat, index) => (seat?.isBot ? index : -1))
      .filter((index) => index !== -1);
    const target = playerId
      ? indexes.find((index) => this.seats[index].playerId === playerId)
      : indexes.at(-1);
    if (target === undefined) {
      throw new GameError('no_such_bot', 'An diesem Tisch sitzt kein Bot.');
    }
    const bot = this.seats[target];
    this.seats[target] = null;
    this.wallet.closeBotWallet(bot.playerId);
    this.touch();
    this.engine.seatsChanged();
    this.sync();
    return bot;
  }

  /** Schwierigkeit aller Bots (oder eines bestimmten) ändern. */
  setBotDifficulty(difficulty, playerId = null) {
    const level = normalizeDifficulty(difficulty);
    for (const seat of this.seats) {
      if (!seat?.isBot) continue;
      if (playerId && seat.playerId !== playerId) continue;
      seat.difficulty = level;
    }
    this.touch();
    this.sync();
    return level;
  }

  /** Markiert einen Sitz als „gerade nicht da“ (Verbindung weg). */
  setAway(playerId, away) {
    const seat = this.seats.find((entry) => entry?.playerId === playerId);
    if (!seat || seat.away === away) return false;
    seat.away = away;
    this.touch();
    this.sync();
    return true;
  }

  addSpectator(playerId) {
    if (this.seatOf(playerId)) return;
    this.spectators.add(playerId);
    this.touch();
  }

  removeWatcher(playerId) {
    this.spectators.delete(playerId);
  }

  /** Spieler verlässt den Tisch komplett. */
  leave(playerId) {
    this.stand(playerId, { keepWatching: false });
    this.spectators.delete(playerId);
    this.touch();
    this.sync();
  }

  // ------------------------------------------------------------- Spielablauf

  /** Eine Aktion eines Menschen – die Engine prüft sie. */
  act(playerId, action) {
    if (this.closed) throw new GameError('table_closed', 'Dieser Tisch ist geschlossen.');
    if (!this.seatOf(playerId)) {
      throw new GameError('not_seated', 'Dafür musst du dich an den Tisch setzen.');
    }
    this.touch();
    this.engine.act(playerId, action);
    this.sync();
  }

  /** Einmaliges Ereignis (Animation) für den nächsten Zustands-Push. */
  emit(event) {
    this.pendingEvents.push(event);
  }

  /**
   * Zentrale Schleife. Reentrant-sicher: Ruft die Engine `ctx.sync()` aus
   * `tick()` heraus auf, wird nicht rekursiv gestartet, sondern eine Runde
   * weitergedreht.
   */
  sync() {
    if (this.closed) return;
    if (this.inSync) {
      this.dirty = true;
      return;
    }
    this.inSync = true;
    try {
      let guard = 0;
      do {
        this.dirty = false;
        try {
          this.engine.tick();
        } catch (error) {
          this.log(`[${this.code}] Engine-Fehler in tick():`, error.message);
        }
      } while (this.dirty && ++guard < 8);
    } finally {
      this.inSync = false;
    }
    this.scheduleActor();
    this.onChange(this);
  }

  /** Bot einplanen oder Zug-Timer stellen. */
  scheduleActor() {
    const actorId = this.engine.actorId ?? null;
    const deadline = this.engine.deadline ?? null;
    const key = actorId ? `${actorId}@${deadline ?? 0}` : null;

    // Unverändert? Dann den laufenden Timer weiterlaufen lassen.
    if (key && key === this.actorKey && this.actorTimer) return;

    if (this.actorTimer) clearTimeout(this.actorTimer);
    this.actorTimer = null;
    this.actorKey = key;
    if (!actorId) return;

    const seat = this.seatOf(actorId);
    if (!seat) return;

    if (seat.isBot) {
      this.actorTimer = setTimeout(() => {
        this.actorTimer = null;
        this.runActor(actorId, () => this.engine.botAct(actorId, seat.difficulty), 'Bot-Zug');
      }, this.botMs);
      return;
    }

    if (deadline === null) return;
    this.actorTimer = setTimeout(
      () => {
        this.actorTimer = null;
        this.runActor(actorId, () => this.engine.timeout(actorId), 'Zeitüberschreitung');
      },
      Math.max(50, deadline - Date.now()),
    );
  }

  /** Führt Bot-/Timeout-Zug aus; Fehler dürfen den Tisch nie blockieren. */
  runActor(actorId, fn, label) {
    if (this.closed) return;
    // Zwischenzeitlich ist jemand anders dran – nichts tun.
    if (this.engine.actorId !== actorId) {
      this.sync();
      return;
    }
    try {
      fn();
    } catch (error) {
      this.log(`[${this.code}] ${label} fehlgeschlagen:`, error.message);
      // Nicht hängen bleiben: notfalls die Standardaktion erzwingen.
      try {
        if (this.engine.actorId === actorId) this.engine.timeout(actorId);
      } catch (fallbackError) {
        this.log(`[${this.code}] Auch der Notfallzug schlug fehl:`, fallbackError.message);
      }
    }
    this.sync();
  }

  // ---------------------------------------------------------------- Ansicht

  /** Kurzinfo für die Lobby-Liste. */
  summary() {
    return {
      code: this.code,
      game: this.module.id,
      gameName: this.module.name,
      name: this.name,
      config: { ...this.config },
      ownerId: this.ownerId,
      seats: this.seats.length,
      occupied: this.occupiedCount,
      humans: this.humanCount,
      bots: this.botCount,
      spectators: this.spectators.size,
      players: this.seats
        .filter(Boolean)
        .map((seat) => ({ name: seat.name, isBot: seat.isBot, away: seat.away })),
      stakes: this.module.describeStakes?.(this.config) ?? null,
      createdAt: this.createdAt,
    };
  }

  /**
   * Der volle Tischzustand für einen bestimmten Zuschauer/Spieler.
   * Verdeckte Informationen kommen ausschließlich aus `privateState`.
   */
  stateFor(playerId) {
    return {
      code: this.code,
      game: this.module.id,
      gameName: this.module.name,
      name: this.name,
      config: { ...this.config },
      ownerId: this.ownerId,
      turnMs: this.config.turnMs ?? null,
      seats: this.seats.map((seat, index) =>
        seat
          ? {
              index,
              playerId: seat.playerId,
              name: seat.name,
              isBot: seat.isBot,
              difficulty: seat.isBot ? seat.difficulty : null,
              away: seat.away,
              chips: this.wallet.balance(seat.playerId),
            }
          : { index, playerId: null },
      ),
      spectators: this.spectators.size,
      youSeated: Boolean(this.seatOf(playerId)),
      actorId: this.engine.actorId ?? null,
      deadline: this.engine.deadline ?? null,
      serverTime: Date.now(),
      public: this.engine.publicState(),
      private: this.engine.privateState(playerId) ?? null,
    };
  }

  /** Ereignisse abholen und Puffer leeren. */
  takeEvents() {
    if (!this.pendingEvents.length) return [];
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.engine.dispose();
    } catch (error) {
      this.log(`[${this.code}] dispose() fehlgeschlagen:`, error.message);
    }
    for (const seat of this.seats) {
      if (seat?.isBot) this.wallet.closeBotWallet(seat.playerId);
    }
    this.clearTimers();
  }
}
