/**
 * Baut HTTP- und WebSocket-Server zusammen – ohne sie zu starten.
 * `server/index.js` startet sie, die Tests benutzen dieselbe Funktion.
 *
 * Alles läuft über **einen** Port: Express liefert das Frontend aus `public/`,
 * `ws` hängt auf demselben HTTP-Server unter `/ws`. Genau das braucht ein
 * Cloudflare- oder Tailscale-Funnel.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { Casino } from './casino.js';
import { CasinoDb } from './db.js';
import { CasinoHub } from './protocol.js';
import { config as defaultConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createServer({
  log = () => {},
  staticDir = PUBLIC_DIR,
  config = defaultConfig,
  dbFile = config.dbFile,
} = {}) {
  const db = new CasinoDb(dbFile);
  const casino = new Casino({ db, config, log });
  const hub = new CasinoHub({ casino, log });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Bewusst ohne Cache-Dauer: Dateinamen tragen keine Versionskennung, also
  // fragen Browser per ETag kurz nach (304). Nach einem Update genügt damit ein
  // normales Neuladen.
  app.use(
    express.static(staticDir, { extensions: ['html'], etag: true, lastModified: true, maxAge: 0 }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      casino: casino.name,
      tables: casino.tables.size,
      guests: casino.guests().length,
      uptime: Math.round(process.uptime()),
    });
  });

  // Alles Unbekannte auf die Startseite (Single-Page-Frontend).
  app.use((_req, res) => res.sendFile(path.join(staticDir, 'index.html')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', (socket) => hub.handleConnection(socket));

  // Tote Verbindungen erkennen (Handy im Standby, WLAN-Wechsel, …).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* egal */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  // Verwaiste Tische abräumen.
  const sweeper = setInterval(() => casino.sweep(), 5 * 60 * 1000);
  sweeper.unref?.();

  async function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    hub.dispose();
    casino.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { app, server, wss, hub, casino, db, close };
}
