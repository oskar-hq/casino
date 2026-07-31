/**
 * WebSocket-Protokoll: übersetzt Client-Nachrichten in Casino-/Engine-Aufrufe
 * und verteilt den autoritativen Zustand.
 *
 * Grundregel: Der Client schickt nur *Absichten* ("ich will 50 setzen"). Ob das
 * erlaubt ist, entscheidet ausschließlich der Server. Verdeckte Karten gehen
 * nur an ihren Besitzer – sie stecken in `state.private`, das pro Empfänger
 * einzeln aus der Engine geholt wird.
 */

import { GameError } from '../core/engine.js';
import { Casino, CasinoError, sanitizeName } from './casino.js';

const send = (socket, payload) => {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
};

export class CasinoHub {
  /**
   * @param {object} options
   * @param {Casino} options.casino
   * @param {Function} [options.log]
   */
  constructor({ casino, log = () => {} }) {
    this.casino = casino;
    this.log = log;
    /** @type {Set<WebSocket>} Alle offenen Verbindungen. */
    this.sockets = new Set();
    /** Sammelt Änderungen und verteilt gebündelt im nächsten Tick. */
    this.floorDirty = false;
    this.dirtyTables = new Set();
    this.flushScheduled = false;

    this.unsubscribe = casino.onChange((kind, payload) => {
      if (kind === 'table') this.dirtyTables.add(payload.code);
      else this.floorDirty = true;
      if (kind === 'reset') {
        this.broadcastAll({ type: 'chips_reset', by: payload.by, amount: payload.amount });
      }
      this.scheduleFlush();
    });
  }

  // ------------------------------------------------------------ Verbindung

  handleConnection(socket) {
    socket.playerId = null;
    socket.isAlive = true;
    this.sockets.add(socket);

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: 'error', code: 'bad_json', message: 'Ungültige Nachricht.' });
      }
      try {
        this.handleMessage(socket, message);
      } catch (error) {
        if (error instanceof GameError || error instanceof CasinoError) {
          send(socket, { type: 'error', code: error.code, message: error.message });
        } else {
          this.log('Unerwarteter Fehler:', error);
          send(socket, {
            type: 'error',
            code: 'internal',
            message: 'Da ist auf dem Server etwas schiefgelaufen.',
          });
        }
      }
    });

    socket.on('close', () => this.handleDisconnect(socket));
    socket.on('error', () => this.handleDisconnect(socket));
  }

  handleDisconnect(socket) {
    this.sockets.delete(socket);
    const playerId = socket.playerId;
    socket.playerId = null;
    if (!playerId) return;
    const player = this.casino.player(playerId);
    if (!player) return;

    player.sockets.delete(socket);
    if (player.sockets.size) return; // In einem anderen Tab noch offen.

    player.online = false;
    player.lastSeen = Date.now();
    this.log(`« ${player.name} ist weg`);

    // Der Platz bleibt zunächst erhalten (Handy im Standby, kurzer WLAN-Hänger):
    // Der Tisch spielt ihn per Auto-Fold/Check weiter, erst nach der Gnadenfrist
    // wird der Sitz wirklich frei.
    const table = player.seatedAt ? this.casino.table(player.seatedAt) : null;
    if (table) {
      table.setAway(playerId, true);
      table.later(() => {
        const current = this.casino.player(playerId);
        if (!current || current.online || current.seatedAt !== table.code) return;
        this.log(`− ${current.name} verliert den Platz an Tisch ${table.code}`);
        this.casino.stand(playerId);
      }, this.casino.config.seatGraceMs);
    }
    this.casino.unview(playerId);
    this.floorDirty = true;
    this.scheduleFlush();
  }

  // --------------------------------------------------------------- Routing

  handleMessage(socket, message) {
    switch (message?.type) {
      case 'ping':
        return send(socket, { type: 'pong', t: message.t ?? null });
      case 'enter':
        return this.enter(socket, message);
      case 'leave_casino':
        return this.leaveCasino(socket);

      // Floor
      case 'create_table':
        return this.createTable(socket, message);
      case 'close_table':
        return this.closeTable(socket, message);
      case 'view_table':
        return this.viewTable(socket, message);
      case 'leave_table':
        return this.leaveTable(socket);
      case 'sit':
        return this.sit(socket, message);
      case 'stand':
        return this.stand(socket);

      // Bots
      case 'add_bot':
        return this.addBot(socket, message);
      case 'remove_bot':
        return this.removeBot(socket, message);
      case 'set_bot_difficulty':
        return this.setBotDifficulty(socket, message);

      // Host
      case 'claim_host':
        return this.claimHost(socket, message);
      case 'reset_chips':
        return this.resetChips(socket);
      case 'set_casino_name':
        return this.setCasinoName(socket, message);

      // Spiel
      case 'action':
        return this.action(socket, message);

      default:
        return send(socket, {
          type: 'error',
          code: 'unknown_type',
          message: 'Unbekannte Nachricht.',
        });
    }
  }

  /** Der angemeldete Spieler zu einem Socket. */
  requireSession(socket) {
    if (!socket.playerId) {
      throw new CasinoError('not_entered', 'Betritt zuerst das Casino.');
    }
    return this.casino.requirePlayer(socket.playerId);
  }

  // ------------------------------------------------------------- Eintritt

  enter(socket, message) {
    const player = this.casino.enter({
      name: message.name,
      playerId: message.playerId ?? null,
      token: message.token ?? null,
    });

    // Alte Verbindung desselben Spielers sauber ablösen (Tab-Wechsel).
    if (socket.playerId && socket.playerId !== player.id) {
      const previous = this.casino.player(socket.playerId);
      previous?.sockets.delete(socket);
    }
    socket.playerId = player.id;
    player.sockets.add(socket);
    player.online = true;
    player.lastSeen = Date.now();

    // Der Platz war für ihn reserviert – jetzt sitzt er wieder richtig da.
    const table = player.seatedAt ? this.casino.table(player.seatedAt) : null;
    table?.setAway(player.id, false);

    send(socket, {
      type: 'entered',
      playerId: player.id,
      token: player.token,
      name: player.name,
      chips: player.chips,
      isHost: this.casino.isHost(player.id),
    });
    this.sendFloor(socket);
    if (table) this.sendTable(socket, table);
    this.floorDirty = true;
    this.scheduleFlush();
  }

  leaveCasino(socket) {
    const player = this.requireSession(socket);
    this.casino.leaveTable(player.id);
    player.sockets.delete(socket);
    player.online = player.sockets.size > 0;
    socket.playerId = null;
    send(socket, { type: 'left_casino' });
    this.floorDirty = true;
    this.scheduleFlush();
  }

  // ----------------------------------------------------------------- Floor

  createTable(socket, message) {
    const player = this.requireSession(socket);
    const table = this.casino.createTable({
      gameId: message.game,
      name: message.name,
      config: message.config ?? {},
      ownerId: player.id,
    });
    send(socket, { type: 'table_created', code: table.code });
    // Der Gründer schaut direkt zu; hinsetzen tut er sich selbst.
    this.casino.view(player.id, table.code);
    this.sendTable(socket, table);
  }

  closeTable(socket, message) {
    const player = this.requireSession(socket);
    this.casino.closeTable(String(message.code ?? '').toUpperCase(), player.id);
    send(socket, { type: 'table_closed', code: message.code });
  }

  viewTable(socket, message) {
    const player = this.requireSession(socket);
    const table = this.casino.view(player.id, message.code);
    this.sendTable(socket, table);
    this.floorDirty = true;
    this.scheduleFlush();
  }

  leaveTable(socket) {
    const player = this.requireSession(socket);
    this.casino.leaveTable(player.id);
    send(socket, { type: 'table_left' });
    this.sendFloor(socket);
  }

  sit(socket, message) {
    const player = this.requireSession(socket);
    const table = this.casino.sit(
      player.id,
      message.code,
      message.seat === undefined || message.seat === null ? null : Number(message.seat),
    );
    this.pushTable(table);
  }

  stand(socket) {
    const player = this.requireSession(socket);
    const table = this.casino.stand(player.id);
    if (table) this.pushTable(table);
    else this.sendFloor(socket);
  }

  // ------------------------------------------------------------------ Bots

  addBot(socket, message) {
    const player = this.requireSession(socket);
    this.casino.addBot(player.id, message.code, message.difficulty);
  }

  removeBot(socket, message) {
    const player = this.requireSession(socket);
    this.casino.removeBot(player.id, message.code, message.botId ?? null);
  }

  setBotDifficulty(socket, message) {
    const player = this.requireSession(socket);
    this.casino.setBotDifficulty(player.id, message.code, message.difficulty, message.botId ?? null);
  }

  // ------------------------------------------------------------------ Host

  claimHost(socket, message) {
    const player = this.requireSession(socket);
    this.casino.claimHost(player.id, message.pin ?? '');
    send(socket, { type: 'host_changed', isHost: true });
    this.floorDirty = true;
    this.scheduleFlush();
  }

  resetChips(socket) {
    const player = this.requireSession(socket);
    this.casino.resetAllChips(player.id);
  }

  setCasinoName(socket, message) {
    const player = this.requireSession(socket);
    const name = this.casino.setCasinoName(player.id, message.name);
    this.log(`≡ Casino heißt jetzt "${name}"`);
    this.floorDirty = true;
    this.scheduleFlush();
  }

  // ---------------------------------------------------------------- Spiel

  action(socket, message) {
    const player = this.requireSession(socket);
    const table = this.casino.requireTable(message.code);
    table.act(player.id, message.action ?? {});
  }

  // ----------------------------------------------------------- Verteilung

  /** Änderungen sammeln und im nächsten Tick gebündelt verschicken. */
  scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  flush() {
    const tables = [...this.dirtyTables];
    this.dirtyTables.clear();
    const floor = this.floorDirty;
    this.floorDirty = false;

    for (const code of tables) {
      const table = this.casino.table(code);
      if (table) this.pushTable(table);
    }
    if (floor) this.pushFloor();
  }

  /** Wer bekommt einen bestimmten Tisch zu sehen? */
  *watchersOf(table) {
    for (const player of this.casino.players.values()) {
      if (!player.online) continue;
      if (player.viewing !== table.code && player.seatedAt !== table.code) continue;
      for (const socket of player.sockets) yield { player, socket };
    }
  }

  /**
   * Verteilt einen Tischzustand. Jeder Empfänger bekommt seine **eigene**
   * Sicht – `private` wird pro Spieler frisch aus der Engine geholt, damit
   * fremde Hole Cards den Server gar nicht erst verlassen.
   */
  pushTable(table) {
    const events = table.takeEvents();
    for (const { player, socket } of this.watchersOf(table)) {
      send(socket, { type: 'table_state', state: table.stateFor(player.id), events });
    }
  }

  sendTable(socket, table) {
    const playerId = socket.playerId;
    send(socket, { type: 'table_state', state: table.stateFor(playerId), events: [] });
  }

  /** Den Floor an alle schicken, die gerade keinen Tisch ansehen (und an alle Guthaben). */
  pushFloor() {
    const floor = this.casino.floorState();
    for (const player of this.casino.players.values()) {
      if (!player.online) continue;
      for (const socket of player.sockets) {
        send(socket, {
          type: 'floor_state',
          floor,
          you: {
            playerId: player.id,
            name: player.name,
            chips: player.chips,
            isHost: this.casino.isHost(player.id),
            seatedAt: player.seatedAt,
            viewing: player.viewing,
          },
        });
      }
    }
  }

  sendFloor(socket) {
    const player = socket.playerId ? this.casino.player(socket.playerId) : null;
    send(socket, {
      type: 'floor_state',
      floor: this.casino.floorState(),
      you: player
        ? {
            playerId: player.id,
            name: player.name,
            chips: player.chips,
            isHost: this.casino.isHost(player.id),
            seatedAt: player.seatedAt,
            viewing: player.viewing,
          }
        : null,
    });
  }

  broadcastAll(payload) {
    for (const socket of this.sockets) send(socket, payload);
  }

  dispose() {
    this.unsubscribe?.();
  }
}

export { sanitizeName };
