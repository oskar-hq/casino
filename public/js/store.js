/**
 * Sitzungsspeicher: merkt sich Spieler-ID, Token und Name im localStorage,
 * damit ein Reload oder ein Verbindungsabbruch folgenlos bleibt.
 *
 * Das Guthaben steht **nicht** hier – das führt allein der Server.
 */

const SESSION_KEY = 'casino.session';
const NAME_KEY = 'casino.name';

const safeStorage = (() => {
  try {
    const probe = '__casino__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    // Privater Modus o. Ä. – dann eben nur für diese Seite.
    const memory = new Map();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value),
      removeItem: (key) => memory.delete(key),
    };
  }
})();

export const session = {
  load() {
    try {
      const raw = safeStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data?.playerId && data?.token ? data : null;
    } catch {
      return null;
    }
  },
  save({ playerId, token, name }) {
    safeStorage.setItem(SESSION_KEY, JSON.stringify({ playerId, token, name }));
  },
  clear() {
    safeStorage.removeItem(SESSION_KEY);
  },
};

export const lastName = {
  get: () => safeStorage.getItem(NAME_KEY) ?? '',
  set: (name) => safeStorage.setItem(NAME_KEY, name),
};
