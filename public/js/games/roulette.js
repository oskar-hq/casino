/**
 * Sichtmodul Roulette.
 *
 * Auf dem Filz drehen sich Rad und Kugel, unten liegt das Tableau: Man wählt
 * einen Chipwert und tippt dann auf Zahlen, Felder oder die Außenwetten.
 * Zwischen zwei Zahlen tippen (Cheval) geht über die schmalen Stege.
 */

import { chips, el, seconds, toast } from '../dom.js';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

/** Der gewählte Chipwert, mit dem getippt wird. */
let chipValue = null;

export default {
  id: 'roulette',

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];

    const nodes = [wheel(game), history(game)];

    if (game.phase === 'betting') {
      const left = Math.max(0, (ctx.state.deadline ?? 0) - ctx.state.serverTime);
      nodes.push(
        el('div.bet-clock', {}, [
          el('span.bet-clock-label', { text: 'Einsätze bitte' }),
          el('span.bet-clock-time', { text: `${seconds(left)} s` }),
        ]),
      );
    } else if (game.phase === 'spinning') {
      el('p.felt-phase', { text: 'Rien ne va plus' });
      nodes.push(el('p.felt-phase', { text: 'Rien ne va plus – die Kugel läuft' }));
    } else if (game.phase === 'result' && game.result) {
      nodes.push(resultBanner(game.result, ctx.meId));
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
    const act = (action) => send({ type: 'action', code: state.code, action });
    const values = chipValues(game.minBet, game.maxBet);
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
        el('button.action.action--check', {
          text: placed ? `Liegt: ${chips(placed)}` : 'Nichts gesetzt',
          disabled: true,
        }),
      ]),
    ];
  },

  renderSidePanel(ctx) {
    const bets = ctx.state.private?.bets ?? [];
    return [
      el('h3.panel-title', { text: 'Deine Wetten' }),
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
    ];
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

function wheel(game) {
  const number = game.phase === 'result' ? game.number : null;
  return el('div.wheel', {}, [
    el(`div.wheel-face${game.phase === 'spinning' ? '.wheel-face--spinning' : ''}`, {}, [
      el('div.wheel-inner', {}, [
        number === null
          ? el('span.wheel-dots', { text: '· · ·' })
          : el(`span.wheel-number.wheel-number--${colorOf(number)}`, { text: String(number) }),
      ]),
    ]),
  ]);
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

/** Sinnvolle Chipwerte zwischen Mindest- und Höchsteinsatz. */
function chipValues(min, max) {
  const candidates = [min, 5, 10, 25, 50, 100, 250, 500];
  const values = [...new Set(candidates.filter((value) => value >= min && value <= max))];
  return values.length ? values.slice(0, 5) : [min];
}
