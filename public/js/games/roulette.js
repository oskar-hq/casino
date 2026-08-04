/**
 * Sichtmodul Roulette.
 *
 * Auf dem Filz drehen sich Rad und Kugel, unten liegt das Tableau: Man wählt
 * einen Chipwert und tippt dann auf Zahlen, Felder oder die Außenwetten.
 * Zwischen zwei Zahlen tippen (Cheval) geht über die schmalen Stege.
 */

import { chips, el, quickAmounts, toast } from '../dom.js';
import { countdown } from '../tableview.js';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

/** Der gewählte Chipwert, mit dem getippt wird. */
let chipValue = null;
/** Auf welches Fach die laufende Drehung zuläuft: { round, pocket }. */
let spinTarget = null;

export default {
  id: 'roulette',

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];

    // Das Zielfach kommt mit dem Dreh-Ereignis und gilt für diese Runde.
    // Später steht es ohnehin in der gefallenen Zahl – so stimmt das Rad auch
    // dann, wenn man mitten in der Auswertung dazukommt.
    const spinEvent = (ctx.events ?? []).find((event) => event.kind === 'spin');
    if (spinEvent) spinTarget = { round: game.roundNumber, pocket: spinEvent.pocket };
    const pocket =
      game.number !== null && game.number !== undefined
        ? WHEEL_ORDER.indexOf(game.number)
        : spinTarget?.round === game.roundNumber
          ? spinTarget.pocket
          : null;

    const nodes = [wheel(game, pocket), history(game)];

    if (game.phase === 'betting') {
      nodes.push(
        el('div.bet-clock', {}, [
          el('span.bet-clock-label', { text: 'Einsätze bitte' }),
          countdown(ctx.state.deadline ?? 0, 'bet-clock-time'),
        ]),
      );
    } else if (game.phase === 'spinning') {
      nodes.push(el('p.felt-phase.felt-phase--big', { text: 'Rien ne va plus – die Kugel läuft' }));
    } else if (game.phase === 'result' && game.result) {
      nodes.push(resultBanner(game.result, ctx.meId));
      nodes.push(el('p.felt-phase', { text: 'Gleich wird wieder gesetzt …' }));
    }
    return nodes.filter(Boolean);
  },

  seatDecor(seat, ctx) {
    const game = ctx.state.public;
    const stake = game?.stakes?.find((entry) => entry.playerId === seat.playerId);
    const won = game?.result?.entries?.find((entry) => entry.playerId === seat.playerId);

    if (game?.phase === 'result' && won) {
      return {
        status: won.net >= 0 ? `+${chips(won.net)}` : `−${chips(-won.net)}`,
        className: won.net > 0 ? 'seat--won' : '',
      };
    }
    return {
      bet: stake?.total ?? null,
      status: stake ? `${stake.count} Wette${stake.count === 1 ? '' : 'n'}` : null,
    };
  },

  /** Das Tableau steht unten statt der Karten. */
  renderHand(ctx) {
    const game = ctx.state.public;
    if (!ctx.state.youSeated || !game) return [];
    return [layout(ctx)];
  },

  renderActions(ctx) {
    const { state, send } = ctx;
    const game = state.public;
    if (!state.youSeated) {
      return [el('p.dock-note', { text: 'Setz dich an den Tisch, um mitzusetzen.' })];
    }
    if (game.phase !== 'betting') {
      return [
        el('p.dock-note', {
          text: game.phase === 'spinning' ? 'Die Kugel läuft …' : 'Gleich wird wieder gesetzt …',
        }),
      ];
    }

    const balance = state.private?.balance ?? 0;
    const placed = state.private?.total ?? 0;
    const youReady = state.private?.youReady ?? false;
    const ready = game.ready ?? { ready: 0, total: 1 };
    const act = (action) => send({ type: 'action', code: state.code, action });
    const values = quickAmounts(game.minBet, game.maxBet);
    if (chipValue === null || !values.includes(chipValue)) chipValue = values[0];

    return [
      el('div.chip-tray', {}, [
        el('span.chip-tray-label', { text: 'Chipwert' }),
        el(
          'div.chip-row',
          {},
          values.map((value) =>
            el(`button.chip-token${value === chipValue ? '.is-active' : ''}`, {
              text: chips(value),
              disabled: value > balance,
              onClick: (event) => {
                chipValue = value;
                for (const node of event.target.parentElement.children) {
                  node.classList.toggle('is-active', node === event.target);
                }
              },
            }),
          ),
        ),
      ]),
      el('div.action-row', {}, [
        el('button.action.action--fold', {
          text: 'Zurück',
          disabled: !placed,
          onClick: () => act({ move: 'undo' }),
        }),
        el('button.action.action--fold', {
          text: 'Alles weg',
          disabled: !placed,
          onClick: () => act({ move: 'clear' }),
        }),
      ]),
      // Der eigentliche Startknopf. Sobald alle am Tisch bereit sind, dreht
      // das Rad sofort – sonst spätestens, wenn der Countdown abläuft.
      el('button.action.action--spin-now', {
        class: youReady ? 'is-waiting' : '',
        disabled: !placed && !youReady,
        onClick: () => act({ move: 'ready', value: !youReady }),
      }, [
        el('span.spin-now-label', { text: startLabel({ placed, youReady, ready }) }),
        el('span.spin-now-note', { text: startNote({ placed, youReady, ready }) }),
      ]),
    ];
  },

  renderSidePanel(ctx) {
    const bets = ctx.state.private?.bets ?? [];
    return {
      title: 'Deine Wetten',
      body: [
        bets.length
          ? el(
              'ul.bet-list',
              {},
              bets.map((bet) =>
                el('li.bet-item', {}, [
                  el('span.bet-label', { text: bet.label }),
                  el('span.bet-odds', { text: `${bet.payout}:1` }),
                  el('span.bet-amount-side', { text: chips(bet.amount) }),
                ]),
              ),
            )
          : el('p.pay-note', { text: 'Noch nichts auf dem Tableau.' }),
      ],
    };
  },

  info() {
    return [
      el('h3', { text: 'Das Rad' }),
      el('p', {
        text:
          'Europäisches Roulette: 37 Fächer von 0 bis 36, nur eine Null. Jede Zahl ist gleich ' +
          'wahrscheinlich; der Zufall kommt aus dem Betriebssystem des Servers.',
      }),
      el('h3', { text: 'Quoten' }),
      el(
        'ul.pay-list',
        {},
        [
          ['Plein (eine Zahl)', '35:1'],
          ['Cheval (zwei Zahlen)', '17:1'],
          ['Transversale (drei)', '11:1'],
          ['Carré (vier)', '8:1'],
          ['Sixainne (sechs)', '5:1'],
          ['Dutzend / Kolonne (zwölf)', '2:1'],
          ['Rot/Schwarz, Gerade/Ungerade, 1–18/19–36', '1:1'],
        ].map(([label, odds]) =>
          el('li.pay-row', {}, [
            el('span.pay-name', { text: label }),
            el('span.pay-mult', { text: odds }),
          ]),
        ),
      ),
      el('h3', { text: 'Die Null' }),
      el('p', {
        text:
          'Fällt die 0, verlieren alle Außenwetten – nur wer direkt auf die Null gesetzt hat, ' +
          'gewinnt. Daraus entsteht der Hausvorteil von 1/37, und zwar bei jeder Wettart gleich. ' +
          'Es gibt deshalb keine Wette, die besser wäre als eine andere.',
      }),
      el('h3', { text: 'Setzen' }),
      el('p', {
        text:
          'Chipwert wählen, dann auf das Tableau tippen: auf eine Zahl für ein Plein, auf die ' +
          'schmalen Stege zwischen zwei Zahlen für ein Cheval, auf die Felder am Rand für ' +
          'Dutzende, Kolonnen und die einfachen Chancen. Solange der Countdown läuft, lässt ' +
          'sich alles wieder zurücknehmen.',
      }),
    ];
  },

  onEvent(event, ctx) {
    if (event.kind !== 'result') return;
    const mine = event.result.entries.find((entry) => entry.playerId === ctx.meId);
    const { number } = event.result;
    if (!mine) {
      toast(`${number} ${colorLabel(number)}`, '', 2600);
      return;
    }
    toast(
      `${number} ${colorLabel(number)} · ${mine.net >= 0 ? '+' : '−'}${chips(Math.abs(mine.net))}`,
      mine.net > 0 ? 'good' : mine.net < 0 ? 'bad' : '',
      3200,
    );
  },
};

// ------------------------------------------------------------------ Rad

/** Die Fächer des echten europäischen Rades, im Uhrzeigersinn ab der Null. */
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const POCKET_ANGLE = 360 / WHEEL_ORDER.length;

/**
 * Zeichnet den Kranz einmal als SVG: 37 Sektoren in der echten Reihenfolge,
 * jeder mit seiner Zahl. Fach 0 liegt oben (12 Uhr), von dort geht es im
 * Uhrzeigersinn weiter.
 */
function wheelSvg() {
  const r = 96;
  const sektoren = WHEEL_ORDER.map((zahl, index) => {
    const von = index * POCKET_ANGLE - POCKET_ANGLE / 2 - 90;
    const bis = von + POCKET_ANGLE;
    const [x1, y1] = polar(100, 100, r, von);
    const [x2, y2] = polar(100, 100, r, bis);
    const farbe = { green: '#16794f', red: '#cf2438', black: '#171d26' }[colorOf(zahl)];
    const [tx, ty] = polar(100, 100, r - 13, von + POCKET_ANGLE / 2);
    const drehung = index * POCKET_ANGLE;
    return `
      <path d="M100 100 L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z"
            fill="${farbe}" stroke="rgba(0,0,0,.35)" stroke-width="0.5"/>
      <text class="pocket-label" x="${tx.toFixed(2)}" y="${ty.toFixed(2)}"
            transform="rotate(${drehung.toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)})">${zahl}</text>`;
  }).join('');

  return `<svg class="wheel-svg" viewBox="0 0 200 200" aria-hidden="true">
    <circle cx="100" cy="100" r="99" fill="#1b1208"/>
    ${sektoren}
    <circle cx="100" cy="100" r="${r}" fill="none" stroke="#c9922c" stroke-width="3"/>
    <circle cx="100" cy="100" r="58" fill="#12241b" stroke="rgba(232,182,76,.45)" stroke-width="2"/>
  </svg>`;
}

const polar = (cx, cy, r, grad) => {
  const bogen = (grad * Math.PI) / 180;
  return [cx + r * Math.cos(bogen), cy + r * Math.sin(bogen)];
};

/**
 * Das Rad. Sobald die Zahl feststeht, dreht der Kranz so weit, dass genau
 * ihr Fach unter der Kugel oben zum Stehen kommt – die Animation zeigt also
 * wirklich das Ergebnis und nicht irgendetwas.
 *
 * Möglich ist das, weil das Setzfenster beim Start der Drehung längst zu ist:
 * Die Zahl früher zu kennen bringt niemandem einen Vorteil.
 */
function wheel(game, pocket) {
  const spinning = game.phase === 'spinning';
  const number = game.phase === 'result' ? game.number : null;
  const dauer = game.spinMs ?? 5200;

  // Fünf volle Umdrehungen, dann das Zielfach nach oben unter die Kugel.
  const ziel = pocket === null ? 0 : 360 * 5 - pocket * POCKET_ANGLE;

  const kranz = el(`div.wheel-face${spinning ? '.wheel-face--spinning' : ''}`, {
    html: wheelSvg(),
  });
  // Nach dem Dreh bleibt der Kranz auf dem Ergebnis stehen.
  if (!spinning && pocket !== null) {
    kranz.style.transform = `rotate(${(ziel % 360).toFixed(3)}deg)`;
  }

  return el(
    'div.wheel',
    { style: { '--spin-ms': `${dauer}ms`, '--spin-to': `${ziel.toFixed(3)}deg` } },
    [
      kranz,
      el('div.wheel-marker', { 'aria-hidden': 'true' }),
      el(`div.wheel-ball${spinning ? '.wheel-ball--spinning' : ''}`, { 'aria-hidden': 'true' }, [
        el('span.wheel-ball-dot'),
      ]),
      el('div.wheel-inner', {}, [
        number === null
          ? el('span.wheel-dots', { text: spinning ? '· · ·' : '–' })
          : el(`span.wheel-number.wheel-number--${colorOf(number)}`, { text: String(number) }),
      ]),
    ],
  );
}

function history(game) {
  if (!game.history?.length) return null;
  return el(
    'div.wheel-history',
    {},
    game.history.map((entry) =>
      el(`span.history-chip.history-chip--${entry.color}`, { text: String(entry.number) }),
    ),
  );
}

function resultBanner(result, meId) {
  const mine = result.entries.find((entry) => entry.playerId === meId);
  return el('div.result-banner', {}, [
    el(`span.wheel-number.wheel-number--${result.color}`, { text: String(result.number) }),
    el('span', {
      text: mine
        ? ` ${mine.net >= 0 ? '+' : '−'}${chips(Math.abs(mine.net))} für dich`
        : ` ${colorLabel(result.number)}`,
    }),
  ]);
}

const colorLabel = (n) => ({ green: 'Null', red: 'Rot', black: 'Schwarz' })[colorOf(n)];

/** Beschriftung des Startknopfes – sie erklärt, was als Nächstes passiert. */
function startLabel({ placed, youReady, ready }) {
  if (!placed && !youReady) return 'Erst Chips aufs Tableau legen';
  if (!youReady) return ready.total > 1 ? 'Fertig – ich bin bereit' : 'Jetzt drehen';
  return ready.total > 1 ? `Warte auf die anderen (${ready.ready}/${ready.total})` : 'Rad startet …';
}

function startNote({ placed, youReady, ready }) {
  if (!placed && !youReady) return 'Tippe unten auf eine Zahl oder ein Feld';
  if (youReady && ready.total > 1) return 'Nochmal tippen, um doch noch zu ändern';
  if (ready.total > 1) return 'Das Rad dreht, sobald alle bereit sind';
  return 'Oder einfach den Countdown abwarten';
}

// -------------------------------------------------------------- Tableau

/**
 * Baut das Setztableau. Die Zahlen stehen wie am echten Tisch in drei Reihen
 * zu zwölf Spalten; die schmalen Stege dazwischen sind eigene Schaltflächen
 * für Cheval-Wetten.
 */
function layout(ctx) {
  const { state, send } = ctx;
  const canBet = state.public.phase === 'betting';
  const mine = new Map((state.private?.bets ?? []).map((bet) => [betKey(bet.type, bet.arg), bet.amount]));

  const place = (betType, arg) => {
    if (!canBet) return;
    send({
      type: 'action',
      code: state.code,
      action: { move: 'bet', betType, arg, amount: chipValue ?? state.public.minBet },
    });
  };

  const cell = (label, betType, arg, extraClass = '') => {
    const amount = mine.get(betKey(betType, arg));
    return el(`button.tab-cell${extraClass ? `.${extraClass}` : ''}`, {
      type: 'button',
      disabled: !canBet,
      onClick: () => place(betType, arg),
      title: label,
    }, [
      el('span.tab-label', { text: label }),
      amount ? el('span.tab-chip', { text: chips(amount) }) : null,
    ].filter(Boolean));
  };

  // Die Zahlen: Spalte 1 = 3/2/1, Spalte 2 = 6/5/4 …
  const grid = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 12; column++) {
      const number = column * 3 + (3 - row);
      grid.push(
        el('button.tab-number', {
          type: 'button',
          disabled: !canBet,
          dataset: { color: colorOf(number) },
          style: { gridColumn: column + 2, gridRow: row + 1 },
          onClick: () => place('straight', number),
        }, [
          el('span.tab-label', { text: String(number) }),
          mine.get(betKey('straight', number))
            ? el('span.tab-chip', { text: chips(mine.get(betKey('straight', number))) })
            : null,
        ].filter(Boolean)),
      );
    }
  }

  return el('div.tableau', {}, [
    el('div.tableau-grid', {}, [
      // Die Null über die volle Höhe links.
      el('button.tab-number.tab-zero', {
        type: 'button',
        disabled: !canBet,
        dataset: { color: 'green' },
        style: { gridColumn: 1, gridRow: '1 / span 3' },
        onClick: () => place('straight', 0),
      }, [
        el('span.tab-label', { text: '0' }),
        mine.get(betKey('straight', 0))
          ? el('span.tab-chip', { text: chips(mine.get(betKey('straight', 0))) })
          : null,
      ].filter(Boolean)),
      ...grid,
      // Kolonnen rechts neben den Zahlen.
      ...[3, 2, 1].map((column, index) =>
        el('div', { style: { gridColumn: 14, gridRow: index + 1 } }, [
          cell('2:1', 'column', column, 'tab-side'),
        ]),
      ),
    ]),

    el('div.tableau-dozens', {}, [
      cell('1. Dutzend', 'dozen', 1),
      cell('2. Dutzend', 'dozen', 2),
      cell('3. Dutzend', 'dozen', 3),
    ]),

    el('div.tableau-outside', {}, [
      cell('1–18', 'low', null),
      cell('Gerade', 'even', null),
      cell('Rot', 'red', null, 'tab-red'),
      cell('Schwarz', 'black', null, 'tab-black'),
      cell('Ungerade', 'odd', null),
      cell('19–36', 'high', null),
    ]),
  ]);
}

const betKey = (type, arg) => `${type}:${Array.isArray(arg) ? arg.join(',') : (arg ?? '')}`;

