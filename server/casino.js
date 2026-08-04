/**
 * Der Casino-Floor: Gäste, das gemeinsame Guthaben und alle Tische.
 *
 * Grundregeln, die hier durchgesetzt werden:
 *  - Ein Guthaben pro Spielername, geteilt über **alle** Spiele.
 *  - Kein Rebuy: Wer bei 0 steht, kann nicht mehr setzen. Nur der Host kann
 *    per Reset-Knopf alle wieder auf das Startguthaben setzen.
 *  - Ein Spieler sitzt an höchstens **einem** Tisch. Sonst ließe sich dasselbe
 *    Guthaben an zwei Tischen gleichzeitig setzen.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { CasinoTable, normalizeDifficulty } from '../core/table.js';
import { GameError } from '../core/engine.js';
import { Rng } from '../core/rng.js';
import { getModule, listModules, validateConfig } from '../games/index.js';

/** Zeichen ohne Verwechslungsgefahr (kein 0/O, kein 1/I). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

export class CasinoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CasinoError';
    this.code = code;
  }
}

/** Namen landen in fremden Browsern – Steuerzeichen und Klammern raus. */
export function sanitizeName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  if (name.length < 2) {
    throw new CasinoError('invalid_name', 'Der Name muss 2 bis 16 Zeichen lang sein.');
  }
  return name;
}

export function sanitizeTableName(raw, fallback) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return name.length >= 2 ? name : fallback;
}

const nameKeyOf = (name) => name.toLocaleLowerCase('de-DE');

export class Casino {
  /**
   * @param {object} options
   * @param {import('./db.js').CasinoDb} options.db
   * @param {object} options.config aus server/config.js
   * @param {Function} [options.log]
   * @param {import('../core/rng.js').Rng} [options.rng]
   */
  constructor({ db, config, log = () => {}, rng = new Rng() }) {
    this.db = db;
    this.config = config;
    this.log = log;
    this.rng = rng;

    /** @type {Map<string, object>} playerId → Gast */
    this.players = new Map();
    /** @type {Map<string, CasinoTable>} Code → Tisch */
    this.tables = new Map();
    /** @type {Map<string, number>} Bot-Guthaben (nur im RAM) */
    this.botChips = new Map();
    /** Zuhörer für Zustandsänderungen (das WS-Protokoll hängt sich hier ein). */
    this.listeners = new Set();

    this.hostId = db.meta('host_id', null);
    this.name = db.meta('casino_name', config.casinoName);

    this.wallet = {
      balance: (playerId) => this.balanceOf(playerId),
      debit: (playerId, amount, reason) => this.debit(playerId, amount, reason),
      credit: (playerId, amount, reason) => this.credit(playerId, amount, reason),
      openBotWallet: (playerId) => this.botChips.set(playerId, this.config.startChips),
      closeBotWallet: (playerId) => this.botChips.delete(playerId),
    };

    this.restoreTables();
  }

  // ------------------------------------------------------------ Zuhörer

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(kind, payload = {}) {
    for (const listener of this.listeners) {
      try {
        listener(kind, payload);
      } catch (error) {
        this.log('Listener-Fehler:', error.message);
      }
    }
  }

  // ------------------------------------------------------------- Gäste

  /**
   * Betritt das Casino. Gleicher Name = gleiches Guthaben; ein Token aus dem
   * localStorage stellt die Sitzung nach einem Reload wieder her.
   */
  enter({ name, playerId = null, token = null }) {
    // 1) Sitzung fortsetzen, wenn Token und ID zusammenpassen.
    if (playerId && token) {
      const stored = this.db.findPlayerById(playerId);
      if (stored && stored.token === token) {
        this.maybeTopUp(stored);
        const player = this.hydrate(stored);
        if (name) {
          const wanted = sanitizeName(name);
          if (wanted !== player.name) this.rename(player, wanted);
        }
        this.db.touchPlayer(player.id);
        return player;
      }
    }

    // 2) Sonst über den Namen – der Name *ist* die Geldbörse.
    const cleanName = sanitizeName(name);
    const key = nameKeyOf(cleanName);
    const existing = this.db.findPlayerByNameKey(key);
    if (existing) {
      const active = this.players.get(existing.id);
      if (active?.online) {
        throw new CasinoError(
          'name_taken',
          'Unter diesem Namen ist gerade jemand im Casino. Nimm einen anderen.',
        );
      }
      this.maybeTopUp(existing);
      const player = this.hydrate(existing);
      player.name = cleanName;
      this.db.renamePlayer(player.id, cleanName, key);
      this.db.touchPlayer(player.id);
      return player;
    }

    const row = this.db.createPlayer({
      id: randomUUID(),
      name: cleanName,
      nameKey: key,
      token: randomBytes(24).toString('hex'),
      chips: this.config.startChips,
    });
    const player = this.hydrate(row);
    this.log(`+ ${cleanName} betritt das Casino (${player.chips} Chips)`);
    if (!this.hostId && !this.config.hostPin) this.setHost(player.id);
    return player;
  }

  /**
   * Automatische Auffüllung nach Ablauf der Frist (Standard: 24 Stunden).
   *
   * Nur wer **unter** dem Startguthaben liegt, wird aufgefüllt – wer gut
   * gespielt hat, behält seinen Gewinn. Die Frist beginnt erst mit der
   * Auffüllung neu, damit man nicht alle 24 Stunden zwangsweise auf den
   * Startwert zurückgesetzt wird.
   *
   * @returns {number|null} der aufgefüllte Betrag, sonst `null`
   */
  maybeTopUp(row) {
    const frist = this.config.topUpAfterMs;
    if (!frist) return null;
    if (row.chips >= this.config.startChips) return null;
    if (Date.now() - (row.last_topup ?? 0) < frist) return null;

    const betrag = this.config.startChips;
    this.db.topUp(row.id, betrag);
    const player = this.players.get(row.id);
    if (player) player.chips = betrag;
    row.chips = betrag;
    row.last_topup = Date.now();
    this.log(`↑ ${row.name} wurde auf ${betrag} Chips aufgefüllt (Tagesbonus)`);
    return betrag;
  }

  /** Wann wäre die nächste automatische Auffüllung fällig? */
  topUpDueAt(playerId) {
    const frist = this.config.topUpAfterMs;
    if (!frist) return null;
    const row = this.db.findPlayerById(playerId);
    if (!row) return null;
    return (row.last_topup ?? 0) + frist;
  }

  /** DB-Zeile → Laufzeitobjekt (und in die Map legen). */
  hydrate(row) {
    const existing = this.players.get(row.id);
    if (existing) {
      existing.chips = row.chips;
      return existing;
    }
    const player = {
      id: row.id,
      name: row.name,
      token: row.token,
      chips: row.chips,
      online: false,
      sockets: new Set(),
      /** Tisch, an dem der Spieler *sitzt* (höchstens einer). */
      seatedAt: null,
      /** Tisch, den er gerade ansieht (auch als Zuschauer). */
      viewing: null,
      lastSeen: Date.now(),
    };
    this.players.set(player.id, player);
    return player;
  }

  rename(player, name) {
    const key = nameKeyOf(name);
    const clash = this.db.findPlayerByNameKey(key);
    if (clash && clash.id !== player.id) {
      throw new CasinoError('name_taken', 'Diesen Namen benutzt hier schon jemand.');
    }
    player.name = name;
    this.db.renamePlayer(player.id, name, key);
    // Namensschilder an den Tischen mitziehen.
    for (const table of this.tables.values()) {
      for (const seat of table.seats) {
        if (seat?.playerId === player.id) seat.name = name;
      }
    }
  }

  player(playerId) {
    return this.players.get(playerId) ?? null;
  }

  requirePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) throw new CasinoError('unknown_player', 'Du bist nicht (mehr) im Casino.');
    return player;
  }

  /** Alle gerade anwesenden Gäste – für die Floor-Anzeige. */
  guests() {
    return [...this.players.values()]
      .filter((player) => player.online)
      .map((player) => ({
        id: player.id,
        name: player.name,
        chips: player.chips,
        isHost: player.id === this.hostId,
        table: player.seatedAt ?? player.viewing ?? null,
      }))
      .sort((a, b) => b.chips - a.chips || a.name.localeCompare(b.name, 'de'));
  }

  // ------------------------------------------------------------- Guthaben

  balanceOf(playerId) {
    if (playerId?.startsWith('bot:')) return this.botChips.get(playerId) ?? 0;
    return this.players.get(playerId)?.chips ?? this.db.findPlayerById(playerId)?.chips ?? 0;
  }

  /**
   * Bucht Chips ab. Wirft, wenn das Guthaben nicht reicht – das ist die
   * zentrale Anti-Cheat-Schranke: Kein Einsatz existiert ohne Deckung.
   */
  debit(playerId, amount, reason = 'bet') {
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value < 0) {
      throw new GameError('bad_amount', 'Ungültiger Betrag.');
    }
    if (value === 0) return this.balanceOf(playerId);

    if (playerId?.startsWith('bot:')) {
      const balance = this.botChips.get(playerId) ?? 0;
      if (balance < value) throw new GameError('insufficient', 'Der Bot hat nicht genug Chips.');
      const next = balance - value;
      this.botChips.set(playerId, next);
      return next;
    }

    const player = this.requirePlayer(playerId);
    if (player.chips < value) {
      throw new GameError('insufficient', 'Dafür reicht dein Guthaben nicht.');
    }
    player.chips -= value;
    this.db.setChips(player.id, player.chips);
    this.db.recordLedger(player.id, -value, player.chips, reason);
    return player.chips;
  }

  credit(playerId, amount, reason = 'win') {
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value < 0) {
      throw new GameError('bad_amount', 'Ungültiger Betrag.');
    }
    if (value === 0) return this.balanceOf(playerId);

    if (playerId?.startsWith('bot:')) {
      const next = (this.botChips.get(playerId) ?? 0) + value;
      this.botChips.set(playerId, next);
      return next;
    }

    const player = this.requirePlayer(playerId);
    player.chips += value;
    this.db.setChips(player.id, player.chips);
    this.db.recordLedger(player.id, value, player.chips, reason);
    return player.chips;
  }

  // ---------------------------------------------------------------- Host

  setHost(playerId) {
    this.hostId = playerId;
    this.db.setMeta('host_id', playerId ?? '');
    return this.hostId;
  }

  isHost(playerId) {
    return Boolean(playerId) && playerId === this.hostId;
  }

  requireHost(playerId) {
    if (!this.isHost(playerId)) {
      throw new CasinoError('not_host', 'Das kann nur der Host.');
    }
    return this.requirePlayer(playerId);
  }

  /** Host werden – mit PIN, oder frei, solange niemand Host ist. */
  claimHost(playerId, pin = '') {
    const player = this.requirePlayer(playerId);
    if (this.config.hostPin) {
      if (String(pin) !== this.config.hostPin) {
        throw new CasinoError('bad_pin', 'Falscher Host-PIN.');
      }
    } else if (this.hostId && this.hostId !== playerId) {
      const current = this.players.get(this.hostId);
      if (current?.online) {
        throw new CasinoError('host_present', 'Es gibt bereits einen Host.');
      }
    }
    this.setHost(player.id);
    this.log(`★ ${player.name} ist jetzt Host`);
    return player;
  }

  /** Der Reset-Knopf: neue Session auf Knopfdruck. */
  resetAllChips(byPlayerId) {
    const host = this.requireHost(byPlayerId);
    const amount = this.config.startChips;

    // Laufende Runden abbrechen, damit keine Einsätze in der Luft hängen.
    for (const table of this.tables.values()) {
      try {
        table.engine.dispose();
      } catch (error) {
        this.log(`Reset: dispose() an Tisch ${table.code} fehlgeschlagen:`, error.message);
      }
      table.clearTimers();
      table.engine = table.module.createEngine(table.engineContext());
    }

    this.db.resetAllChips(amount);
    for (const player of this.players.values()) player.chips = amount;
    for (const key of this.botChips.keys()) this.botChips.set(key, amount);

    this.log(`↺ ${host.name} hat alle Guthaben auf ${amount} zurückgesetzt`);
    for (const table of this.tables.values()) table.sync();
    this.notify('reset', { by: host.name, amount });
    return amount;
  }

  setCasinoName(playerId, name) {
    this.requireHost(playerId);
    if (!this.config.allowRename) {
      throw new CasinoError('rename_disabled', 'Umbenennen ist an diesem Server abgeschaltet.');
    }
    this.name = sanitizeTableName(name, this.config.casinoName);
    this.db.setMeta('casino_name', this.name);
    return this.name;
  }

  // --------------------------------------------------------------- Tische

  randomCode() {
    let code;
    do {
      const bytes = randomBytes(CODE_LENGTH);
      code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    } while (this.tables.has(code));
    return code;
  }

  /** Baut einen Tisch (ohne DB-Schreibvorgang – den macht `createTable`). */
  buildTable({ code, gameId, name, config, ownerId }) {
    const module = getModule(gameId);
    if (!module) throw new CasinoError('unknown_game', 'Dieses Spiel gibt es hier nicht.');
    const table = new CasinoTable({
      code,
      module,
      name: sanitizeTableName(name, module.name),
      config: validateConfig(module, config),
      ownerId,
      wallet: this.wallet,
      botMs: this.config.botMs,
      log: this.log,
      rng: this.rng,
      onChange: (changed) => this.notify('table', { code: changed.code }),
    });
    this.tables.set(code, table);
    return table;
  }

  createTable({ gameId, name, config = {}, ownerId = null }) {
    if (this.tables.size >= 40) {
      throw new CasinoError('too_many_tables', 'Es stehen schon genug Tische im Raum.');
    }
    const table = this.buildTable({
      code: this.randomCode(),
      gameId,
      name,
      config,
      ownerId,
    });
    this.db.saveTable({
      code: table.code,
      game: table.module.id,
      name: table.name,
      config: table.config,
      ownerId,
      createdAt: table.createdAt,
    });
    this.log(`+ Tisch ${table.code} (${table.module.name}) eröffnet`);
    this.notify('floor');
    return table;
  }

  /** Tische aus der Datenbank wiederherstellen (einfache Recovery). */
  restoreTables() {
    for (const row of this.db.allTables()) {
      try {
        this.buildTable({
          code: row.code,
          gameId: row.game,
          name: row.name,
          config: row.config,
          ownerId: row.ownerId,
        });
      } catch (error) {
        this.log(`Tisch ${row.code} nicht wiederherstellbar (${error.message}) – verworfen`);
        this.db.deleteTable(row.code);
      }
    }
    if (this.tables.size) this.log(`↺ ${this.tables.size} Tisch(e) wiederhergestellt`);
  }

  table(code) {
    return this.tables.get(String(code ?? '').toUpperCase().trim()) ?? null;
  }

  requireTable(code) {
    const table = this.table(code);
    if (!table) throw new CasinoError('no_such_table', 'Diesen Tisch gibt es nicht (mehr).');
    return table;
  }

  closeTable(code, byPlayerId = null) {
    const table = this.requireTable(code);
    if (byPlayerId && !this.isHost(byPlayerId) && table.ownerId !== byPlayerId) {
      throw new CasinoError('not_allowed', 'Nur der Host oder der Tischgründer kann schließen.');
    }
    if (byPlayerId && table.humanCount > (table.seatOf(byPlayerId) ? 1 : 0)) {
      throw new CasinoError('table_busy', 'An diesem Tisch sitzen noch Leute.');
    }
    for (const player of this.players.values()) {
      if (player.seatedAt === code) player.seatedAt = null;
      if (player.viewing === code) player.viewing = null;
    }
    table.close();
    this.tables.delete(code);
    this.db.deleteTable(code);
    this.log(`− Tisch ${code} geschlossen`);
    this.notify('floor');
    return true;
  }

  /** Der Floor: alle Tische, nach Spiel gruppiert. */
  floorState() {
    const modules = listModules().map((module) => ({
      id: module.id,
      name: module.name,
      tagline: module.tagline,
      icon: module.icon,
      minPlayers: module.minPlayers,
      maxPlayers: module.maxPlayers,
      supportsBots: module.supportsBots,
      solo: Boolean(module.solo),
      defaultConfig: module.defaultConfig,
      configFields: module.configFields,
    }));
    return {
      name: this.name,
      startChips: this.config.startChips,
      hostId: this.hostId,
      hostName: this.players.get(this.hostId)?.name ?? null,
      hostPinRequired: Boolean(this.config.hostPin),
      allowRename: this.config.allowRename,
      games: modules,
      tables: [...this.tables.values()].map((table) => table.summary()),
      guests: this.guests(),
    };
  }

  // ----------------------------------------------------- Tisch betreten

  /** Zuschauen (ohne Sitzplatz). */
  view(playerId, code) {
    const player = this.requirePlayer(playerId);
    const table = this.requireTable(code);
    if (player.viewing && player.viewing !== code) this.unview(playerId);
    player.viewing = code;
    if (player.seatedAt !== code) table.addSpectator(playerId);
    return table;
  }

  unview(playerId) {
    const player = this.player(playerId);
    if (!player?.viewing) return;
    const table = this.table(player.viewing);
    if (table && player.seatedAt !== table.code) table.removeWatcher(playerId);
    player.viewing = null;
  }

  /** Hinsetzen. Ein Spieler sitzt immer an höchstens einem Tisch. */
  sit(playerId, code, index = null) {
    const player = this.requirePlayer(playerId);
    const table = this.requireTable(code);
    if (player.seatedAt && player.seatedAt !== code) {
      throw new CasinoError(
        'already_seated_elsewhere',
        'Du sitzt schon an einem anderen Tisch. Steh dort erst auf.',
      );
    }
    if (table.module.solo && table.humanCount > 0 && !table.seatOf(playerId)) {
      throw new CasinoError('solo_table', 'Dieser Automat ist gerade besetzt.');
    }
    table.sit({ playerId, name: player.name, index });
    player.seatedAt = code;
    player.viewing = code;
    this.notify('floor');
    return table;
  }

  /** Aufstehen (bleibt Zuschauer, solange man den Tisch ansieht). */
  stand(playerId) {
    const player = this.requirePlayer(playerId);
    if (!player.seatedAt) return null;
    const table = this.table(player.seatedAt);
    player.seatedAt = null;
    if (table) {
      table.stand(playerId, { keepWatching: player.viewing === table.code });
      this.notify('floor');
    }
    return table;
  }

  /** Zurück auf den Floor: Sitz freigeben und nicht mehr zuschauen. */
  leaveTable(playerId) {
    const player = this.requirePlayer(playerId);
    const code = player.seatedAt ?? player.viewing;
    if (!code) return null;
    const table = this.table(code);
    player.seatedAt = null;
    player.viewing = null;
    if (table) {
      table.leave(playerId);
      this.notify('floor');
    }
    return table;
  }

  addBot(playerId, code, difficulty) {
    const table = this.requireTable(code);
    this.requireTableControl(playerId, table);
    const bot = table.addBot(normalizeDifficulty(difficulty));
    this.notify('floor');
    return bot;
  }

  removeBot(playerId, code, botId = null) {
    const table = this.requireTable(code);
    this.requireTableControl(playerId, table);
    const bot = table.removeBot(botId);
    this.notify('floor');
    return bot;
  }

  setBotDifficulty(playerId, code, difficulty, botId = null) {
    const table = this.requireTable(code);
    this.requireTableControl(playerId, table);
    return table.setBotDifficulty(difficulty, botId);
  }

  /**
   * Wer darf an einem Tisch Bots setzen und die Einstellungen ändern?
   * Der Casino-Host, der Tischgründer – oder wer sonst dort sitzt, damit ein
   * Tisch nicht blockiert ist, wenn der Gründer weg ist.
   */
  requireTableControl(playerId, table) {
    if (this.isHost(playerId) || table.ownerId === playerId || table.seatOf(playerId)) return;
    throw new CasinoError('not_allowed', 'Dafür musst du an diesem Tisch sitzen.');
  }

  // ----------------------------------------------------------- Aufräumen

  /**
   * Auffüllung auch für Gäste, die schon eine Weile da sind – sonst müsste
   * man das Casino verlassen und neu betreten, damit der Tagesbonus greift.
   */
  sweepTopUps() {
    let aufgefüllt = 0;
    for (const player of this.players.values()) {
      if (!player.online) continue;
      const row = this.db.findPlayerById(player.id);
      if (row && this.maybeTopUp(row) !== null) aufgefüllt += 1;
    }
    if (aufgefüllt) this.notify('floor');
    return aufgefüllt;
  }

  /** Leere Tische abräumen, die lange niemand mehr besucht hat. */
  sweep(now = Date.now()) {
    this.sweepTopUps();
    for (const [code, table] of this.tables) {
      const idle = now - table.lastActivity;
      if (table.humanCount === 0 && table.spectators.size === 0 && idle > this.config.tableTtlMs) {
        table.close();
        this.tables.delete(code);
        this.db.deleteTable(code);
        this.log(`− Tisch ${code} nach Leerlauf abgeräumt`);
      }
    }
  }

  close() {
    for (const table of this.tables.values()) table.close();
    this.tables.clear();
  }
}
