/**
 * „Bereit“-Verwaltung für Spiele mit Setzfenster.
 *
 * Roulette, Baccarat und Blackjack lassen alle gleichzeitig setzen und lösen
 * dann aus. Ohne Zutun passiert das erst, wenn der Countdown abläuft – und
 * genau das ist verwirrend: Man hat gesetzt, aber nichts passiert.
 *
 * Mit diesem Baustein kann jeder am Tisch signalisieren „ich bin fertig“.
 * Sobald **alle sitzenden Menschen** bereit sind, geht es sofort los; der
 * Countdown bleibt als Rückfalllösung für alle, die nicht reagieren.
 * Bots gelten immer als bereit – sie setzen ohnehin sofort.
 */

export class ReadySet {
  /** @param {() => Array<{playerId: string, isBot: boolean}>} seats */
  constructor(seats) {
    this.seats = seats;
    this.ready = new Set();
  }

  /** Neue Runde – alle wieder auf „nicht bereit“. */
  reset() {
    this.ready.clear();
  }

  has(playerId) {
    return this.ready.has(playerId);
  }

  set(playerId, value) {
    if (value) this.ready.add(playerId);
    else this.ready.delete(playerId);
    return this.ready.has(playerId);
  }

  toggle(playerId) {
    return this.set(playerId, !this.ready.has(playerId));
  }

  /** Wer nicht mehr am Tisch sitzt, blockiert den Start nicht. */
  prune() {
    const present = new Set(this.seats().map((seat) => seat.playerId));
    for (const playerId of [...this.ready]) {
      if (!present.has(playerId)) this.ready.delete(playerId);
    }
  }

  /** Die sitzenden Menschen – nur auf die wird gewartet. */
  humans() {
    return this.seats().filter((seat) => !seat.isBot);
  }

  /**
   * Sind alle so weit? An einem reinen Bot-Tisch ist die Antwort `false`:
   * Dort soll der Countdown den Takt vorgeben, sonst rasen die Runden durch.
   */
  allReady() {
    this.prune();
    const humans = this.humans();
    if (!humans.length) return false;
    return humans.every((seat) => this.ready.has(seat.playerId));
  }

  /** Für die Anzeige: „2/3 bereit“. */
  progress() {
    this.prune();
    const humans = this.humans();
    return {
      ready: humans.filter((seat) => this.ready.has(seat.playerId)).length,
      total: humans.length,
      ids: [...this.ready],
    };
  }
}
