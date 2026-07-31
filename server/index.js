/**
 * Serverstart.
 *
 * Ein Port für alles – Frontend und WebSocket. Der Funnel muss nur diesen
 * einen Port nach außen reichen.
 */

import { createServer } from './app.js';
import { config } from './config.js';

const { server, wss, close } = createServer({
  log: (...args) => console.log(new Date().toISOString(), ...args),
});

server.listen(config.port, config.host, () => {
  console.log(
    `${config.casinoName} läuft auf http://${config.host}:${config.port} (WebSocket: /ws)`,
  );
  console.log(`Startguthaben: ${config.startChips} Chips · Bedenkzeit: ${config.turnMs / 1000}s`);
  console.log('Reines Spielgeld – kein Echtgeld, keine Auszahlung.');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} empfangen – fahre herunter …`);
  for (const socket of wss.clients) socket.close(1001, 'Server wird beendet');
  setTimeout(() => process.exit(0), 3000).unref();
  await close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
