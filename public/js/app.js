/**
 * Anwendungslogik des Clients: verbindet Netzwerk, Zustand und Ansichten.
 *
 * Der Client rendert ausschließlich, was der Server schickt. Er kennt weder
 * fremde Karten noch entscheidet er über Regeln oder Guthaben – das macht
 * alles der Server.
 */

import { $, chips, el, fill, show, toast } from './dom.js';
import { Net } from './net.js';
import { lastName, session } from './store.js';
import { renderCard } from './cards.js';
import { renderConfigFields, renderFloor, renderGuests } from './floor.js';
import { getView } from './games/index.js';
import { renderTable, resetTableView } from './tableview.js';

const net = new Net();

const app = {
  meId: null,
  you: null,
  floor: null,
  table: null,
  events: [],
  screen: 'entry',
  /** Tisch, den wir nach dem Eintreten direkt ansteuern (Beitritt per Code). */
  pendingCode: null,
  createGame: null,
  createValues: null,
  /**
   * Hat der Gast das Casino bewusst verlassen? Dann darf ihn ein
   * Wiederverbinden des Sockets nicht ungefragt zurückholen.
   */
  hasLeft: false,
};

const SCREENS = { entry: 'screen-entry', floor: 'screen-floor', table: 'screen-table' };

function showScreen(name) {
  app.screen = name;
  for (const [key, id] of Object.entries(SCREENS)) show($(id), key === name);
  document.body.dataset.screen = name;
}

const send = (payload) => net.send(payload);

// ---------------------------------------------------------------- Rendern

function render() {
  if (!app.you) {
    showScreen('entry');
    return;
  }
  if (app.table) {
    showScreen('table');
    // Am Tisch zählt der Stand aus dem Tischzustand – er ist bei jedem Einsatz
    // aktuell, während die Floor-Übersicht nur bei größeren Änderungen kommt.
    app.you.chips = app.table.yourChips ?? app.you.chips;
    $('table-chips').textContent = chips(app.you.chips);
    renderTable({
      state: app.table,
      meId: app.meId,
      you: app.you,
      send,
      events: app.events,
    });
    app.events = [];
    return;
  }

  showScreen('floor');
  if (!app.floor) return;
  $('floor-title').textContent = app.floor.name;
  $('wallet-amount').textContent = chips(app.you.chips);
  show($('btn-host'), true);
  renderFloor($('floor-list'), app.floor, app.you, {
    onCreate: openCreateDialog,
    onJoin: (table) => send({ type: 'view_table', code: table.code }),
  });
}

// ------------------------------------------------------------ Netznachrichten

net.on('status', ({ online }) => {
  const badge = $('connection');
  show(badge, !online);
  $('connection-text').textContent = online ? 'Verbunden' : 'Verbindung weg – versuche erneut …';
});

net.on('entered', (message) => {
  app.hasLeft = false;
  app.meId = message.playerId;
  app.you = {
    playerId: message.playerId,
    name: message.name,
    chips: message.chips,
    isHost: message.isHost,
    seatedAt: null,
    viewing: null,
  };
  session.save({ playerId: message.playerId, token: message.token, name: message.name });
  lastName.set(message.name);
  if (app.pendingCode) {
    send({ type: 'view_table', code: app.pendingCode });
    app.pendingCode = null;
  }
  render();
});

net.on('floor_state', (message) => {
  app.floor = message.floor;
  if (message.you) app.you = { ...app.you, ...message.you };
  // Nicht mehr an diesem Tisch? Dann zurück auf den Floor.
  if (app.table && message.you && message.you.viewing !== app.table.code) {
    app.table = null;
    resetTableView();
  }
  render();
});

net.on('table_state', (message) => {
  app.table = message.state;
  app.events = [...app.events, ...(message.events ?? [])];
  render();
});

net.on('table_created', (message) => {
  toast(`Tisch ${message.code} steht bereit`, 'good');
});

net.on('table_left', () => {
  app.table = null;
  resetTableView();
  render();
});

net.on('table_closed', () => {
  app.table = null;
  resetTableView();
  toast('Tisch geschlossen');
  render();
});

net.on('left_casino', () => {
  // Zurück auf Anfang. Das Guthaben bleibt auf dem Server; wer denselben Namen
  // wieder eingibt, sitzt mit demselben Stand wieder drin.
  const name = app.you?.name ?? '';
  app.hasLeft = true;
  app.meId = null;
  app.you = null;
  app.floor = null;
  app.table = null;
  app.events = [];
  resetTableView();
  session.clear();
  $('input-name').value = name;
  render();
  toast('Bis zum nächsten Mal', 'good');
});

net.on('chips_reset', (message) => {
  toast(`${message.by} hat alle auf ${chips(message.amount)} Chips zurückgesetzt`, 'good', 4000);
});

net.on('host_changed', () => {
  toast('Du bist jetzt Host', 'good');
  closeOverlay('overlay-host');
});

net.on('error', (message) => {
  toast(message.message ?? 'Etwas ging schief', 'bad');
});

// ------------------------------------------------------------------ Eintritt

function enterCasino(code = null) {
  const name = $('input-name').value.trim();
  if (name.length < 2) {
    toast('Bitte einen Namen mit mindestens 2 Zeichen', 'bad');
    $('input-name').focus();
    return;
  }
  app.pendingCode = code;
  const stored = session.load();
  send({
    type: 'enter',
    name,
    playerId: stored?.playerId ?? null,
    token: stored?.token ?? null,
  });
}

$('btn-enter').addEventListener('click', () => enterCasino());
$('btn-enter-code').addEventListener('click', () => {
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Ein Tisch-Code hat vier Zeichen', 'bad');
    return;
  }
  enterCasino(code);
});
$('input-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') enterCasino();
});
$('input-code').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
});

// -------------------------------------------------------------------- Floor

$('btn-back').addEventListener('click', () => {
  send({ type: 'leave_table' });
  app.table = null;
  resetTableView();
  render();
});

$('btn-guests').addEventListener('click', () => {
  renderGuests($('guest-list'), app.floor?.guests ?? [], app.meId);
  openOverlay('overlay-guests');
});
$('btn-guests-close').addEventListener('click', () => closeOverlay('overlay-guests'));

// ------------------------------------------------------------- Weggehen

/**
 * Das Casino verlassen. Geht in jeder Lage – auch mitten in einer Runde.
 * Der Server steht dafür vom Tisch auf, gibt noch nicht gedrehte Einsätze
 * zurück und gibt den Platz sofort frei.
 */
$('btn-leave-casino').addEventListener('click', () => {
  const seated = app.you?.seatedAt;
  $('leave-note').textContent = seated
    ? 'Du stehst von deinem Tisch auf und landest wieder am Eingang. Läuft gerade eine Runde, ' +
      'giltst du als ausgestiegen. Dein Guthaben bleibt erhalten – mit demselben Namen kommst ' +
      'du jederzeit zurück.'
    : 'Du landest wieder am Eingang. Dein Guthaben bleibt erhalten – mit demselben Namen ' +
      'kommst du jederzeit zurück.';
  openOverlay('overlay-leave');
});
$('btn-leave-cancel').addEventListener('click', () => closeOverlay('overlay-leave'));
$('btn-leave-confirm').addEventListener('click', () => {
  closeOverlay('overlay-leave');
  send({ type: 'leave_casino' });
  // Notausgang: Sollte die Antwort ausbleiben (Verbindung weg), trotzdem raus.
  setTimeout(() => {
    if (app.you) net.emit('left_casino', {});
  }, 1500);
});

// --------------------------------------------------------- Tisch eröffnen

function openCreateDialog(game) {
  app.createGame = game;
  $('create-title').textContent = `${game.name} – Tisch eröffnen`;
  $('create-name').value = suggestTableName(game);
  app.createValues = renderConfigFields($('create-fields'), game);
  openOverlay('overlay-create');
}

function suggestTableName(game) {
  const existing = (app.floor?.tables ?? []).filter((table) => table.game === game.id).length;
  return existing ? `${game.name} ${existing + 1}` : game.name;
}

$('btn-create-confirm').addEventListener('click', () => {
  if (!app.createGame) return;
  send({
    type: 'create_table',
    game: app.createGame.id,
    name: $('create-name').value,
    config: app.createValues,
  });
  closeOverlay('overlay-create');
});
$('btn-create-cancel').addEventListener('click', () => closeOverlay('overlay-create'));

// -------------------------------------------------------- Tisch einrichten

$('btn-table-settings').addEventListener('click', () => {
  if (!app.table) return;
  updateSettingsDialog();
  openOverlay('overlay-table-settings');
});
$('btn-settings-done').addEventListener('click', () => closeOverlay('overlay-table-settings'));

function updateSettingsDialog() {
  const table = app.table;
  if (!table) return;
  // Aufstehen bietet sich nur an, wenn man auch sitzt.
  show($('btn-stand'), Boolean(table.youSeated));
  const bots = table.seats.filter((seat) => seat.isBot);
  $('bot-count').textContent = String(bots.length);
  const level = bots[0]?.difficulty ?? 'medium';
  for (const button of document.querySelectorAll('#difficulty-group .segment')) {
    button.classList.toggle('is-active', button.dataset.difficulty === level);
  }
}

$('btn-bot-add').addEventListener('click', () => {
  if (!app.table) return;
  const level =
    document.querySelector('#difficulty-group .segment.is-active')?.dataset.difficulty ?? 'medium';
  send({ type: 'add_bot', code: app.table.code, difficulty: level });
});
$('btn-bot-remove').addEventListener('click', () => {
  if (app.table) send({ type: 'remove_bot', code: app.table.code });
});

for (const button of document.querySelectorAll('#difficulty-group .segment')) {
  button.addEventListener('click', () => {
    if (!app.table) return;
    send({ type: 'set_bot_difficulty', code: app.table.code, difficulty: button.dataset.difficulty });
    for (const other of document.querySelectorAll('#difficulty-group .segment')) {
      other.classList.toggle('is-active', other === button);
    }
  });
}

$('btn-copy-code').addEventListener('click', async () => {
  if (!app.table) return;
  try {
    await navigator.clipboard.writeText(app.table.code);
    toast('Tisch-Code kopiert', 'good');
  } catch {
    toast(`Tisch-Code: ${app.table.code}`);
  }
});

// Aufstehen: Platz freigeben, aber weiter zuschauen.
$('btn-stand').addEventListener('click', () => {
  if (!app.table) return;
  send({ type: 'stand' });
  closeOverlay('overlay-table-settings');
});

// Ganz weg vom Tisch, zurück auf den Floor.
$('btn-leave-table').addEventListener('click', () => {
  send({ type: 'leave_table' });
  app.table = null;
  resetTableView();
  closeOverlay('overlay-table-settings');
  render();
});

$('btn-close-table').addEventListener('click', () => {
  if (!app.table) return;
  send({ type: 'close_table', code: app.table.code });
  closeOverlay('overlay-table-settings');
});

// ---------------------------------------------------------------- Spielinfo

$('btn-info').addEventListener('click', () => {
  if (!app.table) return;
  const view = getView(app.table.game);
  $('info-title').textContent = app.table.gameName;
  fill($('info-body'), view.info?.({ state: app.table, meId: app.meId }) ?? [
    el('p', { text: 'Zu diesem Spiel gibt es (noch) keine Kurzanleitung.' }),
  ]);
  openOverlay('overlay-info');
});
$('btn-info-close').addEventListener('click', () => closeOverlay('overlay-info'));

// --------------------------------------------------------------------- Host

$('btn-host').addEventListener('click', () => {
  const floor = app.floor;
  if (!floor) return;
  const isHost = app.you?.isHost;
  $('host-status').textContent = isHost
    ? 'Du bist Host dieses Casinos.'
    : floor.hostName
      ? `Host ist gerade ${floor.hostName}.`
      : 'Dieses Casino hat noch keinen Host.';
  show($('host-claim'), !isHost);
  show($('host-tools'), isHost);
  show($('host-name-field'), Boolean(floor.allowRename));
  $('host-casino-name').value = floor.name;
  $('reset-note').innerHTML =
    `Setzt das Guthaben <strong>aller</strong> Gäste auf ${chips(floor.startChips)} Chips zurück und bricht laufende Runden ab.`;
  openOverlay('overlay-host');
});
$('btn-host-close').addEventListener('click', () => closeOverlay('overlay-host'));

$('btn-claim-host').addEventListener('click', () => {
  send({ type: 'claim_host', pin: $('host-pin').value });
});

$('btn-rename-casino').addEventListener('click', () => {
  send({ type: 'set_casino_name', name: $('host-casino-name').value });
  toast('Name übernommen', 'good');
});

$('btn-reset-chips').addEventListener('click', () => {
  send({ type: 'reset_chips' });
  closeOverlay('overlay-host');
});

// ------------------------------------------------------------------ Dialoge

function openOverlay(id) {
  show($(id), true);
}
function closeOverlay(id) {
  show($(id), false);
}

// Klick auf den dunklen Hintergrund schließt den Dialog.
for (const overlay of document.querySelectorAll('.overlay')) {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) show(overlay, false);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const overlay of document.querySelectorAll('.overlay')) show(overlay, false);
});

// ------------------------------------------------------------------- Start

/** Ein paar Karten als Deko auf der Startseite. */
function decorateHero() {
  const demo = [
    { rank: 'A', suit: 's', code: 'As' },
    { rank: 'K', suit: 'h', code: 'Kh' },
    { rank: 'Q', suit: 'd', code: 'Qd' },
    { rank: 'J', suit: 'c', code: 'Jc' },
  ];
  fill(
    $('hero-cards'),
    demo.map((card, index) =>
      renderCard(card, { extra: `hero-card hero-card--${index}` }),
    ),
  );
}

function boot() {
  decorateHero();

  // Die Sitzplätze hängen von der Fensterbreite ab (Hochkant/Querformat).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  const stored = session.load();
  $('input-name').value = stored?.name ?? lastName.get();

  // Beim (Wieder-)Verbinden automatisch zurück ins Casino.
  net.resume = () => {
    // Wer bewusst gegangen ist, wird nicht durch einen Reconnect zurückgeholt.
    if (app.hasLeft) return null;
    const saved = session.load();
    const name = saved?.name ?? $('input-name').value.trim();
    if (!saved || name.length < 2) return null;
    return { type: 'enter', name, playerId: saved.playerId, token: saved.token };
  };
  net.connect();

  // Tisch-Code direkt aus der Adresse: /?t=ABCD
  const codeFromUrl = new URLSearchParams(location.search).get('t');
  if (codeFromUrl) $('input-code').value = codeFromUrl.toUpperCase().slice(0, 4);

  showScreen('entry');
}

boot();
