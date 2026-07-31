/**
 * Der Vertrag zwischen Tisch und Spielmodul.
 *
 * Ein Spielmodul (games/<name>/index.js) beschreibt sich selbst und liefert
 * eine Engine-Klasse. Der Tisch (core/table.js) kennt **kein** einziges Spiel
 * namentlich – er ruft nur die hier beschriebenen Methoden auf. Ein neues Spiel
 * hinzuzufügen heißt deshalb: Ordner anlegen, Modul in games/index.js
 * eintragen, fertig. Bestehende Spiele bleiben unangetastet.
 *
 * Server-Autorität: Die Engine ist die einzige Stelle, an der Spielzustand
 * entsteht. `publicState()` darf nur enthalten, was **alle** sehen dürfen;
 * verdeckte Karten gehören ausschließlich in `privateState(playerId)`.
 */

/** Fehler mit Code, den der Client als Fehlermeldung angezeigt bekommt. */
export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

/**
 * Der Kontext, den ein Tisch seiner Engine mitgibt.
 *
 * @typedef {object} EngineContext
 * @property {object} config      Tischeinstellungen (Blinds, Timer …)
 * @property {import('./rng.js').Rng} rng
 * @property {() => Seat[]} seats  Aktuelle Besetzung (Kopie, nach Sitzplatz sortiert)
 * @property {Wallet} wallet       Chips abbuchen/gutschreiben (server-autoritativ)
 * @property {(fn: Function, ms: number) => any} later  Timer, der mit dem Tisch stirbt
 * @property {() => void} sync     „Zustand hat sich geändert“ – Tisch neu verteilen
 * @property {(event: object) => void} emit  Einmaliges Ereignis an alle (Animationen)
 * @property {(...args: any[]) => void} log
 *
 * @typedef {object} Seat
 * @property {number} index
 * @property {string} playerId
 * @property {string} name
 * @property {boolean} isBot
 * @property {'easy'|'medium'|'hard'} difficulty
 * @property {number} chips     Aktueller Wallet-Stand
 * @property {boolean} away     Verbindung getrennt / sitzt aus
 *
 * @typedef {object} Wallet
 * @property {(playerId: string) => number} balance
 * @property {(playerId: string, amount: number, reason: string) => number} debit
 * @property {(playerId: string, amount: number, reason: string) => number} credit
 */

/**
 * Basisklasse. Alle Methoden haben eine harmlose Standardimplementierung,
 * damit ein Modul nur überschreiben muss, was es wirklich braucht.
 */
export class GameEngine {
  /** @param {EngineContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
  }

  get config() {
    return this.ctx.config;
  }

  // ------------------------------------------------------------ Lebenszyklus

  /**
   * Wird nach jeder Zustandsänderung aufgerufen (Spieler setzt sich, Aktion
   * ausgeführt, Timer abgelaufen). Hier entscheidet die Engine, ob eine neue
   * Runde beginnen kann oder eine Phase weiterläuft.
   */
  tick() {}

  /** Ein Spieler hat sich hingesetzt oder ist aufgestanden. */
  seatsChanged() {}

  /** Tisch wird geschlossen – Timer aufräumen, offene Einsätze zurückgeben. */
  dispose() {}

  // ---------------------------------------------------------------- Am Zug

  /**
   * Wer muss gerade handeln? `null`, wenn niemand einzeln dran ist
   * (z. B. Roulette: alle setzen gleichzeitig).
   * @returns {string|null}
   */
  get actorId() {
    return null;
  }

  /** Zeitpunkt (ms seit Epoch), bis zu dem gehandelt werden muss, sonst `null`. */
  get deadline() {
    return null;
  }

  /**
   * Eine Aktion eines Menschen. Muss **jede** Eingabe prüfen – der Client ist
   * nicht vertrauenswürdig. Bei Regelverstoß: `throw new GameError(...)`.
   */
  // eslint-disable-next-line no-unused-vars
  act(playerId, action) {
    throw new GameError('unsupported', 'Dieses Spiel kennt diese Aktion nicht.');
  }

  /** Die Bedenkzeit ist abgelaufen – die Engine wählt die Standardaktion. */
  // eslint-disable-next-line no-unused-vars
  timeout(playerId) {}

  /** Ein Bot ist am Zug. `difficulty` ist 'easy' | 'medium' | 'hard'. */
  // eslint-disable-next-line no-unused-vars
  botAct(playerId, difficulty) {}

  // ---------------------------------------------------------------- Ansicht

  /** Zustand, den **alle** am Tisch sehen dürfen. Niemals verdeckte Karten. */
  publicState() {
    return {};
  }

  /** Nur für diesen einen Spieler – z. B. die eigenen Hole Cards. */
  // eslint-disable-next-line no-unused-vars
  privateState(playerId) {
    return null;
  }
}
