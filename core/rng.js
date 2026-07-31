/**
 * Zufall für den ganzen Floor.
 *
 * Im Betrieb kommt der Zufall aus `node:crypto` – jede Karte, jeder Walzenstopp
 * und jede Roulettezahl also aus dem Betriebssystem-Entropiepool, nicht aus
 * `Math.random`. Für Tests lässt sich derselbe Generator mit einem Seed
 * deterministisch machen (mulberry32), damit Spielverläufe reproduzierbar sind.
 *
 * Wichtig: Der RNG lebt ausschließlich auf dem Server. Clients bekommen nur
 * Ergebnisse zu sehen, nie den Zustand des Generators.
 */

import { randomBytes, randomInt } from 'node:crypto';

/** Gleichverteilte Fließkommazahl in [0, 1) aus 48 echten Zufallsbits. */
function cryptoFloat() {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** Deterministischer Generator aus einem 32-Bit-Seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  /**
   * @param {number|null} seed `null` = echter Zufall (Produktivbetrieb),
   *   eine Zahl = deterministisch (Tests).
   */
  constructor(seed = null) {
    this.seeded = seed !== null && seed !== undefined;
    this.source = this.seeded ? mulberry32(seed) : null;
  }

  /** Fließkommazahl in [0, 1). */
  float() {
    return this.seeded ? this.source() : cryptoFloat();
  }

  /**
   * Ganzzahl in [0, maxExclusive). Im Kryptomodus über `randomInt`, damit
   * keine Modulo-Verzerrung entsteht.
   */
  int(maxExclusive) {
    const max = Math.floor(maxExclusive);
    if (!Number.isFinite(max) || max <= 0) {
      throw new RangeError(`Rng.int braucht eine positive Obergrenze, bekam ${maxExclusive}`);
    }
    return this.seeded ? Math.floor(this.source() * max) : randomInt(max);
  }

  /** Zufälliges Element. */
  pick(array) {
    return array[this.int(array.length)];
  }

  /** Mischt in-place (Fisher-Yates) und gibt das Array zurück. */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /** Trifft mit Wahrscheinlichkeit `p` (0..1) zu – für Bot-Entscheidungen. */
  chance(p) {
    return this.float() < p;
  }
}

/** Der RNG des laufenden Servers. */
export const rng = new Rng();
