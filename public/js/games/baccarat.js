/**
 * Sichtmodul Baccarat (Punto Banco).
 *
 * In der Mitte liegen die beiden Hände nebeneinander, unten stehen die drei
 * Setzfelder. Es gibt nichts zu entscheiden – nur zu setzen und zuzusehen.
 */

import { chips, el, seconds, toast } from '../dom.js';
import { renderCard } from '../cards.js';

const SIDE_LABELS = { player: 'Player', banker: 'Banker', tie: 'Tie' };
const SIDE_ODDS = { player: '1:1', banker: '1:1 − 5 %', tie: '8:1' };

/** Zuletzt gewählter Einsatz. */
let betAmount = null;

export default {
  id: 'baccarat',

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];

    const hand = (side, data) =>
      el(`div.bac-hand.bac-hand--${side}`, {}, [
        el('span.bac-label', { text: SIDE_LABELS[side] }),
        el(
          'div.bac-cards',
          {},
          data.cards.length
            ? data.cards.map((card) => renderCard(card, { small: true, extra: 'card--board' }))
            : [renderCard(null, { small: true, extra: 'card--slot' })],
        ),
        el('span.hand-total', {
          text: data.total === null ? '–' : String(data.total),
          class: winnerClass(game, side),
        }),
      ]);

    const nodes = [
      el('div.bac-table', {}, [hand('player', game.player), hand('banker', game.banker)]),
    ];

    if (game.phase === 'betting') {
      const left = Math.max(0, (ctx.state.deadline ?? 0) - ctx.state.serverTime);
      nodes.push(
        el('div.bet-clock', {}, [
          el('span.bet-clock-label', { text: 'Einsätze bitte' }),
          el('span.bet-clock-time', { text: `${seconds(left)} s` }),
        ]),
      );
    } else if (game.phase === 'result' && game.result) {
      nodes.push(
        el('div.result-banner', {
          text: resultText(game.result, ctx.meId),
        }),
      );
    } else if (game.phase === 'dealing') {
      nodes.push(el('p.felt-phase', { text: 'Karten werden gegeben …' }));
    }

    nodes.push(roadmap(game));
    nodes.push(
      el('p.shoe-note', { text: `Schuh: noch ${game.shoe.remaining} von ${game.shoe.total} Karten` }),
    );
    return nodes.filter(Boolean);
  },

  seatDecor(seat, ctx) {
    const game = ctx.state.public;
    const stake = game?.stakes?.find((entry) => entry.playerId === seat.playerId);
    const entry = game?.result?.entries?.find((item) => item.playerId === seat.playerId);

    if (game?.phase === 'result' && entry) {
      return {
        bet: entry.amount,
        status: `${SIDE_LABELS[entry.side]} · ${entry.net >= 0 ? '+' : '−'}${chips(Math.abs(entry.net))}`,
        className: entry.net > 0 ? 'seat--won' : '',
      };
    }
    return {
      bet: stake?.amount ?? null,
      status: stake ? SIDE_LABELS[stake.side] : null,
    };
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
          text: game.phase === 'dealing' ? 'Die Karten kommen …' : 'Gleich wird wieder gesetzt …',
        }),
      ];
    }

    const balance = state.private?.balance ?? 0;
    const current = state.private?.bet ?? null;
    const min = game.minBet;
    const max = Math.min(game.maxBet, balance + (current?.amount ?? 0));
    if (balance < min && !current) {
      return [
        el('p.dock-note', {
          text: `Für den Mindesteinsatz von ${chips(min)} Chips reicht dein Guthaben nicht.`,
        }),
      ];
    }
    if (betAmount === null || betAmount < min || betAmount > max) {
      betAmount = Math.min(max, Math.max(min, current?.amount ?? min));
    }

    const act = (action) => send({ type: 'action', code: state.code, action });
    const label = el('span.raise-amount', { text: chips(betAmount) });
    const slider = el('input.slider', {
      type: 'range',
      min,
      max,
      step: 1,
      value: betAmount,
      'aria-label': 'Einsatz',
      onInput: (event) => {
        betAmount = Number(event.target.value);
        label.textContent = chips(betAmount);
      },
    });

    return [
      el('div.raise-box', {}, [
        el('div.raise-head', {}, [
          el('span.raise-label', {
            text: current ? `Gesetzt: ${SIDE_LABELS[current.side]} ${chips(current.amount)}` : 'Einsatz',
          }),
          label,
        ]),
        slider,
      ]),
      el(
        'div.bac-sides',
        {},
        ['player', 'banker', 'tie'].map((side) =>
          el(`button.bac-side.bac-side--${side}${current?.side === side ? '.is-active' : ''}`, {
            onClick: () => act({ move: 'bet', side, amount: betAmount }),
          }, [
            el('span.bac-side-name', { text: SIDE_LABELS[side] }),
            el('span.bac-side-odds', { text: SIDE_ODDS[side] }),
            game.totals[side]
              ? el('span.bac-side-total', { text: chips(game.totals[side]) })
              : null,
          ].filter(Boolean)),
        ),
      ),
      current
        ? el('div.action-row', {}, [
            el('button.action.action--fold', {
              text: 'Einsatz zurück',
              onClick: () => act({ move: 'clear' }),
            }),
          ])
        : null,
    ].filter(Boolean);
  },

  info() {
    return [
      el('h3', { text: 'Worum es geht' }),
      el('p', {
        text:
          'Es gibt zwei Hände: Player und Banker. Du setzt darauf, welche näher an 9 landet – ' +
          'oder auf Unentschieden. Mitspielen im Sinne von Entscheidungen gibt es nicht, alles ' +
          'folgt festen Regeln.',
      }),
      el('h3', { text: 'Kartenwerte' }),
      el('p', {
        text:
          'Zehn und Bilder zählen 0, das Ass 1, alle anderen ihren Aufdruck. Gezählt wird die ' +
          'Summe modulo 10: Aus 7 + 8 = 15 wird also 5.',
      }),
      el('h3', { text: 'Die dritte Karte' }),
      el('p', {
        text:
          'Hat eine Seite aus den ersten beiden Karten 8 oder 9 (ein "Natural"), ist sofort ' +
          'Schluss. Sonst zieht der Player bei 0 bis 5. Ob die Bank zieht, hängt von ihrem Wert ' +
          'und der dritten Karte des Players ab – nach der Standardtabelle.',
      }),
      el('h3', { text: 'Auszahlungen' }),
      el('p', {
        text:
          'Player zahlt 1:1. Banker zahlt ebenfalls 1:1, davon gehen aber 5 % Kommission ab – ' +
          'aus 100 Einsatz werden also 95 Gewinn. Tie zahlt 8:1; bei Unentschieden bekommen ' +
          'Player- und Banker-Wetten ihren Einsatz zurück.',
      }),
      el('h3', { text: 'Welche Wette ist die beste?' }),
      el('p', {
        text:
          'Banker – die Bank gewinnt etwas häufiger, genau deshalb gibt es die Kommission. Tie ' +
          'ist trotz der 8:1 die mit Abstand schlechteste Wette. Eine Strategie, die daran etwas ' +
          'ändert, gibt es nicht.',
      }),
    ];
  },

  onEvent(event, ctx) {
    if (event.kind === 'shuffle') toast('Der Schuh wird neu gemischt', '', 2000);
    if (event.kind !== 'result') return;
    const mine = event.result.entries.find((entry) => entry.playerId === ctx.meId);
    if (!mine) return;
    toast(
      `${SIDE_LABELS[event.result.outcome]} gewinnt · ${mine.net >= 0 ? '+' : '−'}${chips(Math.abs(mine.net))}`,
      mine.net > 0 ? 'good' : mine.net < 0 ? 'bad' : '',
      3000,
    );
  },
};

function winnerClass(game, side) {
  if (game.phase !== 'result' || !game.result) return '';
  return game.result.outcome === side ? 'hand-total--winner' : '';
}

function resultText(result, meId) {
  const mine = result.entries.find((entry) => entry.playerId === meId);
  const base =
    result.outcome === 'tie'
      ? `Unentschieden mit ${result.playerTotal}`
      : `${SIDE_LABELS[result.outcome]} gewinnt ${result.playerTotal}:${result.bankerTotal}`;
  if (!mine) return base;
  return `${base} · ${mine.net >= 0 ? '+' : '−'}${chips(Math.abs(mine.net))}`;
}

/** Die Verlaufsanzeige, wie sie an jedem Baccarat-Tisch hängt. */
function roadmap(game) {
  if (!game.history?.length) return null;
  return el(
    'div.roadmap',
    {},
    game.history
      .slice(0, 14)
      .map((entry) =>
        el(`span.road-dot.road-dot--${entry.outcome}`, {
          text: entry.outcome === 'player' ? 'P' : entry.outcome === 'banker' ? 'B' : 'T',
          title: `${entry.playerTotal}:${entry.bankerTotal}`,
        }),
      ),
  );
}
