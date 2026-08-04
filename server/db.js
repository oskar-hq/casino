/**
 * Persistenz über SQLite (`node:sqlite`, im Node-Kern enthalten – keine
 * native Abhängigkeit, die im Container kompiliert werden müsste).
 *
 * Gespeichert wird bewusst wenig:
 *   - `players`  Wallet-Stand pro Spielername innerhalb dieser Casino-Instanz
 *   - `tables`   Tischdefinitionen, damit der Floor einen Neustart übersteht
 *   - `ledger`   Kurzes Buchungsprotokoll (nützlich fürs Nachvollziehen)
 *   - `meta`     Kleinkram wie der aktuelle Host
 *
 * Laufende Hände werden **nicht** gespeichert: Chips sind nach jeder Hand
 * verbucht, ein Neustart mitten in einer Hand gibt offene Einsätze zurück.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL UNIQUE,
  token      TEXT NOT NULL,
  chips      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  last_topup INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tables (
  code       TEXT PRIMARY KEY,
  game       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  owner_id   TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_player ON ledger (player_id, id DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Wie viele Buchungen pro Spieler aufgehoben werden. */
const LEDGER_KEEP = 200;

export class CasinoDb {
  /** @param {string} file Pfad zur Datei oder ':memory:' */
  constructor(file = ':memory:') {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.statements = {
      playerByKey: this.db.prepare('SELECT * FROM players WHERE name_key = ?'),
      playerById: this.db.prepare('SELECT * FROM players WHERE id = ?'),
      insertPlayer: this.db.prepare(
        `INSERT INTO players (id, name, name_key, token, chips, created_at, last_seen, last_topup)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      topUp: this.db.prepare('UPDATE players SET chips = ?, last_topup = ? WHERE id = ?'),
      updateChips: this.db.prepare('UPDATE players SET chips = ?, last_seen = ? WHERE id = ?'),
      touchPlayer: this.db.prepare('UPDATE players SET last_seen = ? WHERE id = ?'),
      renamePlayer: this.db.prepare('UPDATE players SET name = ?, name_key = ? WHERE id = ?'),
      // Der Reset des Hosts zählt als Auffüllung – die 24-Stunden-Frist
      // beginnt danach von vorn.
      resetChips: this.db.prepare('UPDATE players SET chips = ?, last_seen = ?, last_topup = ?'),
      allPlayers: this.db.prepare('SELECT * FROM players ORDER BY chips DESC, name ASC'),
      insertLedger: this.db.prepare(
        `INSERT INTO ledger (player_id, delta, balance, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      ),
      trimLedger: this.db.prepare(
        `DELETE FROM ledger WHERE player_id = ? AND id NOT IN
           (SELECT id FROM ledger WHERE player_id = ? ORDER BY id DESC LIMIT ?)`,
      ),
      ledgerFor: this.db.prepare(
        'SELECT delta, balance, reason, created_at FROM ledger WHERE player_id = ? ORDER BY id DESC LIMIT ?',
      ),
      upsertTable: this.db.prepare(
        `INSERT INTO tables (code, game, name, config, owner_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET game = excluded.game, name = excluded.name,
           config = excluded.config, owner_id = excluded.owner_id`,
      ),
      deleteTable: this.db.prepare('DELETE FROM tables WHERE code = ?'),
      allTables: this.db.prepare('SELECT * FROM tables ORDER BY created_at ASC'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
    };
  }

  /**
   * Nachträglich hinzugekommene Spalten ergänzen.
   *
   * `CREATE TABLE IF NOT EXISTS` lässt eine bestehende Tabelle unangetastet –
   * eine Datenbank aus einer älteren Version hätte die neue Spalte also nicht.
   */
  migrate() {
    const spalten = new Set(
      this.db.prepare('PRAGMA table_info(players)').all().map((row) => row.name),
    );
    if (!spalten.has('last_topup')) {
      this.db.exec('ALTER TABLE players ADD COLUMN last_topup INTEGER NOT NULL DEFAULT 0');
    }
  }

  // -------------------------------------------------------------- Spieler

  findPlayerByNameKey(nameKey) {
    return this.statements.playerByKey.get(nameKey) ?? null;
  }

  findPlayerById(id) {
    return this.statements.playerById.get(id) ?? null;
  }

  createPlayer({ id, name, nameKey, token, chips }) {
    const now = Date.now();
    // Wer neu ist, hat sein Startguthaben gerade bekommen – die Frist für die
    // nächste automatische Auffüllung läuft also ab jetzt.
    this.statements.insertPlayer.run(id, name, nameKey, token, chips, now, now, now);
    return this.findPlayerById(id);
  }

  /** Guthaben auffüllen und den Zeitpunkt vermerken. */
  topUp(playerId, chips, at = Date.now()) {
    this.statements.topUp.run(chips, at, playerId);
  }

  setChips(playerId, chips) {
    this.statements.updateChips.run(chips, Date.now(), playerId);
  }

  touchPlayer(playerId) {
    this.statements.touchPlayer.run(Date.now(), playerId);
  }

  renamePlayer(playerId, name, nameKey) {
    this.statements.renamePlayer.run(name, nameKey, playerId);
  }

  /** Der Reset-Knopf des Hosts: alle zurück auf das Startguthaben. */
  resetAllChips(chips) {
    const now = Date.now();
    this.statements.resetChips.run(chips, now, now);
  }

  allPlayers() {
    return this.statements.allPlayers.all();
  }

  // -------------------------------------------------------------- Buchungen

  recordLedger(playerId, delta, balance, reason) {
    this.statements.insertLedger.run(playerId, delta, balance, reason, Date.now());
    // Gelegentlich aufräumen, damit die Datei nicht endlos wächst.
    if (Math.random() < 0.02) this.statements.trimLedger.run(playerId, playerId, LEDGER_KEEP);
  }

  ledgerFor(playerId, limit = 20) {
    return this.statements.ledgerFor.all(playerId, limit);
  }

  // ---------------------------------------------------------------- Tische

  saveTable({ code, game, name, config, ownerId, createdAt }) {
    this.statements.upsertTable.run(
      code,
      game,
      name,
      JSON.stringify(config ?? {}),
      ownerId ?? null,
      createdAt ?? Date.now(),
    );
  }

  deleteTable(code) {
    this.statements.deleteTable.run(code);
  }

  allTables() {
    return this.statements.allTables.all().map((row) => ({
      code: row.code,
      game: row.game,
      name: row.name,
      config: safeParse(row.config),
      ownerId: row.owner_id,
      createdAt: row.created_at,
    }));
  }

  // ------------------------------------------------------------------ Meta

  meta(key, fallback = null) {
    return this.statements.getMeta.get(key)?.value ?? fallback;
  }

  setMeta(key, value) {
    this.statements.setMeta.run(key, String(value));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* schon geschlossen */
    }
  }
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
