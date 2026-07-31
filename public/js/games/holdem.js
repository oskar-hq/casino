/**
 * Sichtmodul Texas Hold'em.
 *
 * Zeigt Board und Pot in der Mitte, pro Platz die Karten und den Einsatz und
 * unten die eigenen Hole Cards samt Aktionsleiste. Am Rand hängt die
 * Handrangfolge als Spickzettel.
 *
 * Der Client entscheidet hier nichts: Welche Knöpfe es gibt und in welchen
 * Grenzen erhöht werden darf, steht in `state.private.options` – berechnet und
 * geprüft wird das auf dem Server.
 */

import { chips, el, toast } from '../dom.js';
import { renderCard } from '../cards.js';
import { attachPeek } from '../tableview.js';

const PHASE_LABEL = {
  waiting: 'Warten auf Spieler',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  payout: 'Auszahlung',
};

const ACTION_LABEL = {
  fold: 'passt',
  check: 'checkt',
  call: 'geht mit',
  bet: 'setzt',
  raise: 'erhöht',
  allin: 'ALL IN',
};

const HAND_RANKINGS = [
  ['Royal Flush', 'A K D B 10 – eine Farbe'],
  ['Straight Flush', 'Fünf in Folge, eine Farbe'],
  ['Vierling', 'Vier gleiche Werte'],
  ['Full House', 'Drilling + Paar'],
  ['Flush', 'Fünf gleiche Farbe'],
  ['Straße', 'Fünf in Folge'],
  ['Drilling', 'Drei gleiche Werte'],
  ['Zwei Paare', 'Zwei mal zwei gleiche'],
  ['Ein Paar', 'Zwei gleiche Werte'],
  ['Höchste Karte', 'Sonst zählt die höchste'],
];

/** Merkt sich den zuletzt eingestellten Erhöhungsbetrag pro Zugsituation. */
let raiseValue = null;
let raiseKey = null;

export default {
  id: 'holdem',

  // ------------------------------------------------------------ Tischmitte

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];

    const board = game.board ?? [];
    const slots = Array.from({ length: 5 }, (_, index) =>
      board[index]
        ? renderCard(board[index], { extra: 'card--board' })
        : el('div.card.card--slot', { 'aria-hidden': 'true' }),
    );

    return [
      el('div.board', {}, slots),
      el('div.pot', {}, [
        el('span.pot-label', { text: 'Pot' }),
        el('span.pot-amount', { text: chips(game.pot ?? 0) }),
      ]),
      el('p.felt-phase', { text: phaseText(ctx) }),
      game.result ? resultBanner(game.result) : null,
    ].filter(Boolean);
  },

  // --------------------------------------------------------------- Plätze

  seatDecor(seat, ctx) {
    const game = ctx.state.public;
    const player = game?.players?.find((entry) => entry.playerId === seat.playerId);
    if (!player) {
      return { status: game?.phase === 'waiting' ? null : 'sitzt aus' };
    }

    // Am Tisch liegen alle Karten verdeckt – auch die eigenen. Seine eigenen
    // sieht man unten im Dock (hochwischen), fremde erst beim Showdown.
    const cards = Array.from({ length: player.cardCount }, (_, index) =>
      renderCard(player.cards?.[index] ?? null, {
        small: true,
        extra: player.folded ? 'card--folded' : '',
      }),
    );

    return {
      cards,
      bet: player.committed || null,
      status: statusText(player),
      className: [
        player.folded && 'seat--folded',
        player.allIn && 'seat--allin',
        game.buttonSeat === seat.index && 'seat--button',
      ]
        .filter(Boolean)
        .join(' '),
      badge: game.buttonSeat === seat.index ? el('span.dealer-button', { text: 'D', title: 'Dealer' }) : null,
    };
  },

  // ----------------------------------------------------------- Eigene Hand

  renderHand(ctx) {
    const cards = ctx.state.private?.cards;
    if (!cards?.length) return [];

    const stack = el(
      'div.peek-hand',
      { title: 'Hochwischen oder gedrückt halten zum Ansehen' },
      cards.map((card, index) =>
        el('div.peek-card', { style: { '--i': index } }, [
          renderCard(card, { extra: 'peek-face' }),
          renderCard(null, { extra: 'peek-back' }),
        ]),
      ),
    );
    attachPeek(stack, {});

    return [stack, el('p.peek-hint', { text: 'Hochwischen bzw. gedrückt halten' })];
  },

  // ------------------------------------------------------------- Aktionen

  renderActions(ctx) {
    const { state, meId, send } = ctx;
    const game = state.public;
    if (!state.youSeated) {
      return [el('p.dock-note', { text: 'Setz dich an einen freien Platz, um mitzuspielen.' })];
    }
    const options = state.private?.options;
    if (!options || state.actorId !== meId) {
      return [el('p.dock-note', { text: waitingText(game, state) })];
    }

    const act = (action) => send({ type: 'action', code: state.code, action });

    // Der Schieberegler merkt sich seinen Wert nur innerhalb derselben Situation.
    const key = `${game.handNumber}:${game.phase}:${options.currentBet}:${options.committed}`;
    if (key !== raiseKey) {
      raiseKey = key;
      raiseValue = null;
    }
    const min = options.minRaiseTo;
    const max = options.maxRaiseTo;
    if (raiseValue === null || raiseValue < min || raiseValue > max) {
      raiseValue = Math.min(max, Math.max(min, suggestRaise(options)));
    }

    const buttons = el('div.action-row', {}, [
      el('button.action.action--fold', { text: 'Fold', onClick: () => act({ move: 'fold' }) }),
      options.canCheck
        ? el('button.action.action--check', { text: 'Check', onClick: () => act({ move: 'check' }) })
        : el('button.action.action--call', {
            text: `Call ${chips(options.callAmount)}`,
            onClick: () => act({ move: 'call' }),
          }),
      options.canRaise
        ? el('button.action.action--raise', {
            text: `${options.isRaise ? 'Raise' : 'Bet'} ${chips(raiseValue)}`,
            onClick: () => act({ move: 'raise', amount: raiseValue }),
          })
        : null,
    ].filter(Boolean));

    if (!options.canRaise) return [buttons];

    const amountLabel = el('span.raise-amount', { text: chips(raiseValue) });
    const slider = el('input.slider.slider--raise', {
      type: 'range',
      min,
      max,
      step: 1,
      value: raiseValue,
      'aria-label': 'Einsatz wählen',
      onInput: (event) => {
        raiseValue = Number(event.target.value);
        amountLabel.textContent = chips(raiseValue);
        buttons.querySelector('.action--raise').textContent =
          `${options.isRaise ? 'Raise' : 'Bet'} ${chips(raiseValue)}`;
      },
    });

    const quick = el(
      'div.quick-row',
      {},
      [
        ['½ Pot', Math.round(options.pot * 0.5)],
        ['¾ Pot', Math.round(options.pot * 0.75)],
        ['Pot', options.pot],
        ['All in', max],
      ].map(([label, target]) =>
        el('button.quick', {
          text: label,
          onClick: () => {
            const value = label === 'All in' ? max : options.currentBet + target;
            raiseValue = Math.min(max, Math.max(min, value));
            slider.value = raiseValue;
            amountLabel.textContent = chips(raiseValue);
            buttons.querySelector('.action--raise').textContent =
              `${options.isRaise ? 'Raise' : 'Bet'} ${chips(raiseValue)}`;
          },
        }),
      ),
    );

    return [
      el('div.raise-box', {}, [
        el('div.raise-head', {}, [el('span.raise-label', { text: 'Einsatz' }), amountLabel]),
        slider,
        quick,
      ]),
      buttons,
    ];
  },

  // ------------------------------------------------------- Handrangfolge

  renderSidePanel() {
    return [
      el('h3.panel-title', { text: 'Handrangfolge' }),
      el(
        'ol.ranking-list',
        {},
        HAND_RANKINGS.map(([name, note]) =>
          el('li.ranking-item', {}, [
            el('span.ranking-name', { text: name }),
            el('span.ranking-note', { text: note }),
          ]),
        ),
      ),
    ];
  },

  info(ctx) {
    const config = ctx.state.config ?? {};
    return [
      el('h3', { text: 'Ablauf' }),
      el('p', {
        text:
          `Blinds ${config.smallBlind}/${config.bigBlind}. Jeder bekommt zwei verdeckte Karten, ` +
          'danach kommen Flop (3), Turn (1) und River (1) offen in die Mitte. Vor und nach jeder ' +
          'Gemeinschaftskarte wird gesetzt. Es gewinnt die beste Hand aus fünf der sieben Karten.',
      }),
      el('h3', { text: 'Aktionen' }),
      el('p', {
        text:
          'Check (nichts setzen), Call (mitgehen), Bet/Raise (erhöhen, mindestens um die letzte ' +
          'Erhöhung), Fold (aussteigen). Wer nicht genug Chips hat, geht all-in – dann entsteht ' +
          'ein Side-Pot für die anderen.',
      }),
      el('h3', { text: 'Bedenkzeit' }),
      el('p', {
        text: `Pro Zug ${Math.round((config.turnMs ?? 30000) / 1000)} Sekunden. Danach wird automatisch gecheckt bzw. gefoldet.`,
      }),
      el('h3', { text: 'Dein Guthaben' }),
      el('p', {
        text:
          'Dein Stack am Tisch ist dein Guthaben auf dem Floor. Einsätze werden sofort abgebucht, ' +
          'Gewinne sofort gutgeschrieben. Deshalb kannst du immer nur an einem Tisch sitzen.',
      }),
    ];
  },

  // ------------------------------------------------------------ Ereignisse

  onEvent(event, ctx) {
    if (event.kind === 'result' && event.result?.showdown) {
      const best = event.result.winners[0];
      if (best?.hand) toast(`${best.name}: ${best.hand}`, 'good');
    }
    if (event.kind === 'action' && event.action?.timeout) {
      toast(`${event.name} hat die Zeit überschritten`, '', 1800);
    }
    void ctx;
  },
};

// ----------------------------------------------------------------- Helfer

function phaseText(ctx) {
  const game = ctx.state.public;
  if (game.phase === 'waiting') {
    const seated = ctx.state.seats.filter((seat) => seat.playerId).length;
    return seated < 2 ? 'Es fehlt noch ein Mitspieler' : 'Nächste Hand gleich …';
  }
  return `${PHASE_LABEL[game.phase] ?? game.phase} · Hand ${game.handNumber}`;
}

function statusText(player) {
  if (player.folded) return 'raus';
  if (player.allIn) return 'All in';
  const move = player.lastAction?.move;
  if (!move) return null;
  const label = ACTION_LABEL[move] ?? move;
  return move === 'raise' || move === 'bet' ? `${label} ${chips(player.lastAction.amount)}` : label;
}

function waitingText(game, state) {
  if (!game || game.phase === 'waiting') return 'Warte auf die nächste Hand …';
  if (state.private?.folded) return 'Du bist aus dieser Hand raus.';
  if (state.private?.allIn) return 'Du bist all-in – zurücklehnen.';
  const actor = state.seats.find((seat) => seat.playerId === state.actorId);
  return actor ? `${actor.name} ist am Zug …` : 'Es läuft …';
}

/** Ein sinnvoller Startwert für den Schieberegler: etwa zwei Drittel Pot. */
function suggestRaise(options) {
  const wanted = options.currentBet + Math.round(Math.max(options.bigBlind, options.pot) * 0.66);
  return Math.max(options.minRaiseTo, wanted);
}

function resultBanner(result) {
  const text = result.winners
    .map((winner) => `${winner.name} +${chips(winner.amount)}${winner.hand ? ` (${winner.hand})` : ''}`)
    .join(' · ');
  return el('div.result-banner', { text });
}
