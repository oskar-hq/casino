/**
 * Alle Stellschrauben an einem Ort – gesetzt über Umgebungsvariablen.
 *
 * Damit lässt sich der Container ohne Codeänderung konfigurieren (Startchips,
 * Blinds, Timer). Die spielspezifischen Vorgaben stehen bei den Modulen selbst;
 * hier landen nur die Werte, die der Floor als Ganzes braucht, plus die
 * Env-Überschreibungen für die Default-Tischeinstellungen.
 */

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'ja'].includes(String(value).toLowerCase());
};

const env = process.env;

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST ?? '0.0.0.0',

  /** Name im Kopf der Seite. Generisch halten – kein echter Anbieter. */
  casinoName: env.CASINO_NAME ?? 'Chip Palace',

  /** Startguthaben jedes Spielers und Zielwert des Reset-Knopfes. */
  startChips: Math.max(1, int(env.CASINO_START_CHIPS, 1000)),

  /** Bedenkzeit pro Zug in ms; danach Auto-Fold/Check. */
  turnMs: Math.max(5000, int(env.CASINO_TURN_MS, 30000)),

  /** Bedenkzeit eines Bots, damit man seine Züge mitlesen kann. */
  botMs: Math.max(150, int(env.CASINO_BOT_MS, 1100)),

  /** Wer den PIN kennt, kann sich zum Host machen. Leer = erster Gast wird Host. */
  hostPin: env.CASINO_HOST_PIN ?? '',

  /** SQLite-Datei. ':memory:' hält alles nur im RAM (z. B. für Tests). */
  dbFile: env.CASINO_DB ?? 'data/casino.db',

  /** Wie lange ein leerer Tisch überlebt, bevor er abgeräumt wird (ms). */
  tableTtlMs: Math.max(60_000, int(env.CASINO_TABLE_TTL_MS, 30 * 60 * 1000)),

  /** Gnadenfrist, bis ein getrennter Spieler seinen Sitz verliert (ms). */
  seatGraceMs: Math.max(10_000, int(env.CASINO_SEAT_GRACE_MS, 120_000)),

  /** Erlaubt dem Host, den Namen des Floors zu ändern. */
  allowRename: bool(env.CASINO_ALLOW_RENAME, true),

  /**
   * Env-Überschreibungen für Tisch-Vorgaben, nach Spiel-ID gruppiert.
   * Ein Modul erhält diese Werte über `moduleDefaults(id)` und mischt sie
   * über seine eigenen Vorgaben.
   */
  gameDefaults: {
    holdem: {
      smallBlind: int(env.HOLDEM_SMALL_BLIND, undefined),
      bigBlind: int(env.HOLDEM_BIG_BLIND, undefined),
      turnMs: int(env.HOLDEM_TURN_MS, undefined),
    },
    blackjack: {
      decks: int(env.BLACKJACK_DECKS, undefined),
      minBet: int(env.BLACKJACK_MIN_BET, undefined),
      maxBet: int(env.BLACKJACK_MAX_BET, undefined),
      betMs: int(env.BLACKJACK_BET_MS, undefined),
    },
    slots: {
      minBet: int(env.SLOTS_MIN_BET, undefined),
      maxBet: int(env.SLOTS_MAX_BET, undefined),
    },
    roulette: {
      minBet: int(env.ROULETTE_MIN_BET, undefined),
      maxBet: int(env.ROULETTE_MAX_BET, undefined),
      betMs: int(env.ROULETTE_BET_MS, undefined),
    },
    baccarat: {
      decks: int(env.BACCARAT_DECKS, undefined),
      minBet: int(env.BACCARAT_MIN_BET, undefined),
      maxBet: int(env.BACCARAT_MAX_BET, undefined),
      betMs: int(env.BACCARAT_BET_MS, undefined),
    },
  },
};

/** Die per Env gesetzten Vorgaben eines Spiels (ohne `undefined`-Löcher). */
export function moduleDefaults(gameId) {
  const raw = config.gameDefaults[gameId] ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}
