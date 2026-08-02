/**
 * Der Tisch – gemeinsames Gerüst für **alle** Spiele.
 *
 * Diese Datei kümmert sich um alles, was an jedem Tisch gleich aussieht:
 * Sitzplätze im Rund, Namensschilder, Chipstapel, Dealer-Button, die
 * Bedenkzeit-Uhr und die Deal-Animation. Was auf dem Filz liegt und welche
 * Knöpfe unten stehen, liefert das jeweilige Spiel-Sichtmodul aus `js/games/`.
 *
 * Ein neues Spiel ergänzen heißt also auch im Frontend: eine Datei anlegen
 * und in `js/games/index.js` eintragen.
 */

import { $, chips, el, fill, show } from './dom.js';
import { renderCard } from './cards.js';
import { getView } from './games/index.js';

/** Merkt sich, welche Karten schon „hereingeflogen“ sind. */
let lastDealKey = null;

/** Läuft, solange irgendwo ein Countdown angezeigt wird. */
let countdownTimer = null;
/** Differenz zwischen Server- und Clientuhr, damit die Zeit wirklich stimmt. */
let clockOffset = 0;

/**
 * Hält alle Countdowns am Laufen.
 *
 * Ein Element mit `data-deadline="<Zeitpunkt>"` bekommt sekündlich die
 * Restzeit eingetragen. Ohne das würde die Anzeige nur bei Serverpaketen
 * aktualisiert – und bei einem 25-Sekunden-Setzfenster sieht ein
 * stehengebliebener Countdown so aus, als wäre das Spiel eingefroren.
 */
function tickCountdowns() {
  const nodes = document.querySelectorAll('[data-deadline]');
  if (!nodes.length) {
    clearInterval(countdownTimer);
    countdownTimer = null;
    return;
  }
  const now = Date.now() + clockOffset;
  for (const node of nodes) {
    const left = Number(node.dataset.deadline) - now;
    node.textContent = `${Math.max(0, Math.ceil(left / 1000))} s`;
    node.classList.toggle('is-urgent', left <= 5000);
  }
}

function startCountdowns() {
  if (countdownTimer) return;
  countdownTimer = setInterval(tickCountdowns, 250);
}

/** Ein Countdown-Feld, das von selbst weiterläuft. */
export function countdown(deadline, extraClass = '') {
  const node = el(`span.countdown${extraClass ? `.${extraClass}` : ''}`, {
    dataset: { deadline: String(deadline) },
  });
  node.textContent = `${Math.max(0, Math.ceil((deadline - Date.now() - clockOffset) / 1000))} s`;
  return node;
}

/**
 * Zeichnet den kompletten Tisch.
 * @param {object} ctx { state, meId, send, events }
 */
export function renderTable(ctx) {
  const { state } = ctx;
  const view = getView(state.game);

  $('table-title').textContent = state.name;
  $('table-code').textContent = state.code;
  // Uhrenabgleich: Der Server schickt seine Zeit mit, der Client rechnet um.
  clockOffset = state.serverTime - Date.now();

  renderSeats(ctx, view);
  fill($('felt-center'), view.renderCenter?.(ctx) ?? []);
  renderDock(ctx, view);
  renderSidePanel(ctx, view);
  runEvents(ctx, view);
  startCountdowns();
}

// --------------------------------------------------------------- Sitzplätze

/**
 * Verteilt die Plätze auf einer Ellipse. Der eigene Platz liegt immer unten –
 * so sitzt man auf jedem Gerät „vorne“ am Tisch.
 *
 * Auf schmalen Displays wird die Ellipse deutlich schmaler, sonst ragen die
 * Namensschilder der äußeren Plätze über den Bildschirmrand hinaus.
 */
function seatPosition(index, total, mySeat) {
  const narrow = window.innerWidth < 620;
  const radiusX = narrow ? 30 : 44;
  const radiusY = narrow ? 39 : 41;

  const anchor = mySeat === null ? 0 : mySeat;
  const step = 360 / total;
  const angle = (index - anchor) * step + 90;
  const radians = (angle * Math.PI) / 180;
  return {
    left: `${50 + radiusX * Math.cos(radians)}%`,
    top: `${50 + radiusY * Math.sin(radians)}%`,
  };
}

function renderSeats(ctx, view) {
  const { state, meId, send } = ctx;
  const total = state.seats.length;
  const mySeat = state.seats.find((seat) => seat.playerId === meId)?.index ?? null;

  const nodes = state.seats.map((seat) => {
    const position = seatPosition(seat.index, total, mySeat);
    if (!seat.playerId) {
      return el(
        'button.seat.seat--free',
        {
          style: position,
          type: 'button',
          title: `Auf Platz ${seat.index + 1} setzen`,
          onClick: () => send({ type: 'sit', code: state.code, seat: seat.index }),
        },
        [el('span.seat-plus', { text: '+' }), el('span.seat-free-label', { text: 'Platz frei' })],
      );
    }

    const decor = view.seatDecor?.(seat, ctx) ?? {};
    const isMe = seat.playerId === meId;
    const isActor = state.actorId === seat.playerId;

    const classes = [
      'seat',
      isMe && 'seat--me',
      isActor && 'seat--active',
      seat.away && 'seat--away',
      seat.isBot && 'seat--bot',
      decor.className,
    ]
      .filter(Boolean)
      .join(' ');

    return el('div', { class: classes, style: position, dataset: { seat: seat.index } }, [
      decor.cards?.length ? el('div.seat-cards', {}, decor.cards) : null,
      el('div.seat-plate', {}, [
        el('div.seat-line', {}, [
          el('span.seat-name', { text: seat.name }),
          seat.isBot ? el('span.tag.tag--bot', { text: botTag(seat.difficulty) }) : null,
          seat.away ? el('span.tag.tag--away', { text: 'weg' }) : null,
        ]),
        el('span.seat-chips', { text: chips(seat.chips) }),
        decor.status ? el('span.seat-status', { text: decor.status }) : null,
      ]),
      isActor && state.deadline ? timerRing(state) : null,
      decor.badge ?? null,
      decor.bet ? betStack(decor.bet) : null,
    ]);
  });

  fill($('seat-ring'), nodes);
}

const botTag = (difficulty) =>
  ({ easy: 'Bot · leicht', medium: 'Bot', hard: 'Bot · schwer' })[difficulty] ?? 'Bot';

/**
 * Die Bedenkzeit als Ring. Die Animation wird per negativem `animation-delay`
 * auf die tatsächlich verbleibende Zeit geschoben – damit stimmt sie auch,
 * wenn man mitten im Zug dazukommt.
 */
function timerRing(state) {
  const total = state.turnMs ?? 30000;
  const elapsed = Math.max(0, total - (state.deadline - state.serverTime));
  const node = el('svg.timer-ring', {
    viewBox: '0 0 44 44',
    html: '<circle class="timer-track" cx="22" cy="22" r="20"/><circle class="timer-bar" cx="22" cy="22" r="20"/>',
  });
  const bar = node.querySelector('.timer-bar');
  bar.style.animationDuration = `${total}ms`;
  bar.style.animationDelay = `-${elapsed}ms`;
  return node;
}

/** Der Einsatz eines Spielers vor seinem Platz. */
function betStack(amount) {
  return el('div.bet-stack', {}, [
    el('span.bet-chip', { 'aria-hidden': 'true' }),
    el('span.bet-amount', { text: chips(amount) }),
  ]);
}

// --------------------------------------------------------------------- Dock

function renderDock(ctx, view) {
  fill($('dock-hand'), view.renderHand?.(ctx) ?? []);
  fill($('dock-actions'), view.renderActions?.(ctx) ?? []);
}

const PANEL_KEY = 'casino.panel';

/** Ist das Randpanel dieses Spiels eingeklappt? */
const panelCollapsed = (gameId) => {
  try {
    return localStorage.getItem(`${PANEL_KEY}.${gameId}`) === 'zu';
  } catch {
    return false;
  }
};

const setPanelCollapsed = (gameId, collapsed) => {
  try {
    localStorage.setItem(`${PANEL_KEY}.${gameId}`, collapsed ? 'zu' : 'auf');
  } catch {
    /* Privater Modus – dann eben nur für diese Sitzung. */
  }
};

/**
 * Das Panel am Rand. Ein Modul liefert entweder `{ title, body }` – dann wird
 * es ein- und ausklappbar – oder einfach eine Liste von Knoten.
 */
function renderSidePanel(ctx, view) {
  const panel = $('side-panel');
  const content = view.renderSidePanel?.(ctx);
  show(panel, Boolean(content));
  if (!content) return;

  if (Array.isArray(content)) {
    panel.classList.remove('is-collapsed');
    fill(panel, content);
    return;
  }

  const gameId = ctx.state.game;
  const collapsed = panelCollapsed(gameId);
  panel.classList.toggle('is-collapsed', collapsed);

  const toggle = el(
    'button.panel-toggle',
    {
      type: 'button',
      'aria-expanded': String(!collapsed),
      title: collapsed ? 'Ausklappen' : 'Einklappen',
      onClick: () => {
        setPanelCollapsed(gameId, !panelCollapsed(gameId));
        renderSidePanel(ctx, view);
      },
    },
    [
      el('span.panel-title', { text: content.title }),
      el('span.panel-chevron', { text: collapsed ? '+' : '−', 'aria-hidden': 'true' }),
    ],
  );

  fill(panel, [toggle, collapsed ? null : el('div.panel-body', {}, content.body)]);
}

// ---------------------------------------------------------------- Animation

/** Ereignisse abarbeiten (Deal-Animation und was das Spiel sonst braucht). */
function runEvents(ctx, view) {
  for (const event of ctx.events ?? []) {
    if (event.kind === 'deal_hole') animateDeal(event, ctx);
    view.onEvent?.(event, ctx);
  }
}

/**
 * Karten „rollen“ aus der Tischmitte an die Plätze.
 *
 * Es werden Attrappen im `deal-layer` bewegt; der echte Kartenstapel am Platz
 * ist zu diesem Zeitpunkt schon da und wird kurz ausgeblendet.
 */
function animateDeal(event, ctx) {
  const key = `${ctx.state.code}:${ctx.state.public?.handNumber ?? 0}`;
  if (key === lastDealKey) return; // Nur einmal pro Hand, nicht bei jedem Zustand.
  lastDealKey = key;

  const layer = $('deal-layer');
  const felt = $('felt');
  if (!layer || !felt) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const feltBox = felt.getBoundingClientRect();
  const seatsToDeal = event.seats ?? [];

  seatsToDeal.forEach((seatIndex, order) => {
    const target = felt.querySelector(`[data-seat="${seatIndex}"] .seat-cards`);
    if (!target) return;
    const box = target.getBoundingClientRect();
    const ghost = renderCard(null, { extra: 'card--ghost' });
    ghost.style.left = `${feltBox.width / 2}px`;
    ghost.style.top = `${feltBox.height / 2}px`;
    layer.append(ghost);

    // Erst im nächsten Frame bewegen, damit der Startpunkt gerendert wurde.
    requestAnimationFrame(() => {
      ghost.style.transitionDelay = `${order * 70}ms`;
      ghost.style.left = `${box.left - feltBox.left + box.width / 2}px`;
      ghost.style.top = `${box.top - feltBox.top + box.height / 2}px`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), 900 + order * 70);
  });
}

/** Vor dem Verlassen eines Tisches den Animationszustand zurücksetzen. */
export function resetTableView() {
  lastDealKey = null;
  fill($('deal-layer'), []);
}
