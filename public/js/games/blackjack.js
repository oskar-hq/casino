/**
 * Sichtmodul Blackjack.
 *
 * In der Mitte steht der Dealer, an den Plätzen die Hände der Spieler. Unten
 * wechselt der Dock je nach Phase zwischen Einsatzwahl und Spielzügen.
 */

import { chips, el, toast } from '../dom.js';
import { renderCard } from '../cards.js';
import { countdown } from '../tableview.js';

const OUTCOME_LABEL = {
  win: 'Gewonnen',
  lose: 'Verloren',
  push: 'Push',
  bust: 'Überkauft',
  blackjack: 'Blackjack!',
};

const PHASE_LABEL = {
  idle: 'Gleich geht es los',
  betting: 'Einsätze bitte',
  dealing: 'Karten werden ausgeteilt',
  players: 'Die Spieler sind dran',
  dealer: 'Der Dealer zieht',
  settled: 'Abrechnung',
};

/** Zuletzt gewählter Einsatz – bleibt über die Runden hinweg stehen. */
let betAmount = null;

export default {
  id: 'blackjack',

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];

    const dealerCards = game.dealer.cards.length
      ? game.dealer.cards.map((card) => renderCard(card, { extra: 'card--board' }))
      : [renderCard(null, { extra: 'card--slot' })];

    return [
      el('div.dealer-box', {}, [
        el('span.dealer-label', { text: 'Dealer' }),
        el('div.dealer-cards', {}, dealerCards),
        game.dealer.cards.length
          ? el('span.hand-total', {
              text: game.dealer.done ? String(game.dealer.total) : `${game.dealer.total} + ?`,
              class: game.result?.dealer?.bust ? 'hand-total--bust' : '',
            })
          : null,
      ]),
      el('p.felt-phase', { text: `${PHASE_LABEL[game.phase] ?? game.phase} · Runde ${game.roundNumber}` }),
      game.phase === 'betting'
        ? el('div.bet-clock', {}, [
            el('span.bet-clock-label', { text: 'Einsätze bitte' }),
            countdown(ctx.state.deadline ?? 0, 'bet-clock-time'),
          ])
        : null,
      el('p.shoe-note', {
        text: `Schuh: noch ${game.shoe.remaining} von ${game.shoe.total} Karten`,
      }),
    ].filter(Boolean);
  },

  seatDecor(seat, ctx) {
    const game = ctx.state.public;
    const box = game?.boxes?.find((entry) => entry.playerId === seat.playerId);

    if (!box) {
      // In der Setzphase zeigt der Platz den bereits gesetzten Betrag.
      const bet = game?.bets?.find((entry) => entry.playerId === seat.playerId);
      return {
        bet: bet?.amount ?? null,
        status: game?.phase === 'betting' ? (bet ? 'gesetzt' : 'setzt noch nicht') : 'sitzt aus',
      };
    }

    // Bei mehreren Händen (Split) werden sie nebeneinander gezeigt.
    const cards = [];
    for (const [index, hand] of box.hands.entries()) {
      if (index > 0) cards.push(el('span.hand-divider', { 'aria-hidden': 'true' }));
      for (const card of hand.cards) {
        cards.push(
          renderCard(card, {
            small: true,
            extra: hand.active ? 'card--active-hand' : '',
          }),
        );
      }
    }

    const active = box.hands.find((hand) => hand.active) ?? box.hands[0];
    return {
      cards,
      bet: box.hands.reduce((sum, hand) => sum + hand.bet, 0),
      status: handStatus(box, active),
      className: box.active ? 'seat--playing' : '',
    };
  },

  renderHand(ctx) {
    const game = ctx.state.public;
    const box = game?.boxes?.find((entry) => entry.playerId === ctx.meId);
    if (!box) return [];
    // Beim Blackjack liegen alle eigenen Karten offen – es gibt nichts zu verbergen.
    return box.hands.map((hand, index) =>
      el(`div.own-hand${hand.active ? '.own-hand--active' : ''}`, {}, [
        el('div.own-hand-cards', {}, hand.cards.map((card) => renderCard(card))),
        el('div.own-hand-foot', {}, [
          el('span.own-hand-label', {
            text: box.hands.length > 1 ? `Hand ${index + 1}` : 'Deine Hand',
          }),
          el('span.hand-total', {
            text: hand.soft ? `${hand.total} (soft)` : String(hand.total),
            class: hand.total > 21 ? 'hand-total--bust' : '',
          }),
          hand.outcome
            ? el('span.outcome', {
                text: OUTCOME_LABEL[hand.outcome],
                class: `outcome--${hand.outcome}`,
              })
            : null,
        ]),
      ]),
    );
  },

  renderActions(ctx) {
    const { state, meId, send } = ctx;
    const game = state.public;
    if (!state.youSeated) {
      return [el('p.dock-note', { text: 'Setz dich an einen freien Platz, um mitzuspielen.' })];
    }
    const act = (action) => send({ type: 'action', code: state.code, action });

    // ------------------------------------------------------ Einsatz wählen
    if (game.phase === 'betting') {
      const balance = state.private?.balance ?? 0;
      const min = game.minBet;
      const max = Math.min(game.maxBet, balance);
      if (balance < min) {
        return [
          el('p.dock-note', {
            text: `Für den Mindesteinsatz von ${chips(min)} reicht dein Guthaben nicht.`,
          }),
        ];
      }
      if (betAmount === null || betAmount < min || betAmount > max) {
        betAmount = Math.min(max, Math.max(min, betAmount ?? min));
      }
      const placed = state.private?.bet ?? 0;
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
            el('span.raise-label', { text: placed ? `Gesetzt: ${chips(placed)}` : 'Einsatz' }),
            label,
          ]),
          slider,
          el(
            'div.quick-row',
            {},
            [min, 25, 50, 100].map((value) =>
              el('button.quick', {
                text: chips(value),
                onClick: () => {
                  betAmount = Math.min(max, Math.max(min, value));
                  slider.value = betAmount;
                  label.textContent = chips(betAmount);
                },
              }),
            ),
          ),
        ]),
        el('div.action-row', {}, [
          placed
            ? el('button.action.action--fold', {
                text: 'Einsatz zurück',
                onClick: () => act({ move: 'bet', amount: 0 }),
              })
            : null,
          el('button.action.action--raise', {
            text: placed ? 'Einsatz ändern' : `Setzen ${chips(betAmount)}`,
            onClick: () => act({ move: 'bet', amount: betAmount }),
          }),
        ].filter(Boolean)),
        // Startknopf: Sind alle bereit, werden sofort Karten gegeben.
        el('button.action.action--spin-now', {
          class: state.private?.youReady ? 'is-waiting' : '',
          disabled: !placed && !state.private?.youReady,
          onClick: () => act({ move: 'ready', value: !state.private?.youReady }),
        }, [
          el('span.spin-now-label', { text: readyLabel(game, placed, state.private?.youReady) }),
          el('span.spin-now-note', { text: 'Oder einfach den Countdown abwarten' }),
        ]),
      ];
    }

    // -------------------------------------------------------- Spielen
    const options = state.private?.options;
    if (!options || state.actorId !== meId) {
      return [el('p.dock-note', { text: waitingText(game, state, meId) })];
    }

    return [
      el('div.action-row', {}, [
        el('button.action.action--call', { text: 'Hit', onClick: () => act({ move: 'hit' }) }),
        el('button.action.action--fold', { text: 'Stand', onClick: () => act({ move: 'stand' }) }),
        options.canDouble
          ? el('button.action.action--raise', {
              text: 'Double',
              onClick: () => act({ move: 'double' }),
            })
          : null,
        options.canSplit
          ? el('button.action.action--raise', {
              text: 'Split',
              onClick: () => act({ move: 'split' }),
            })
          : null,
      ].filter(Boolean)),
    ];
  },

  info(ctx) {
    const config = ctx.state.config ?? {};
    return [
      el('h3', { text: 'Ziel' }),
      el('p', {
        text:
          'Näher an 21 kommen als der Dealer, ohne darüber zu gehen. Bildkarten zählen 10, ' +
          'ein Ass 11 oder 1 – je nachdem, was besser passt.',
      }),
      el('h3', { text: 'Der Dealer' }),
      el('p', {
        text:
          `Der Dealer zieht bis 17 und bleibt dann stehen – auch bei einer "weichen" 17 ` +
          `(Ass + 6). Gespielt wird aus einem Schuh mit ${config.decks} Decks, der an der ` +
          'Cut-Card neu gemischt wird.',
      }),
      el('h3', { text: 'Auszahlungen' }),
      el('p', {
        text:
          'Blackjack (Ass + Zehnerkarte als erste beide Karten) zahlt 3:2, ein normaler ' +
          'Gewinn 1:1. Bei Gleichstand bekommst du deinen Einsatz zurück (Push).',
      }),
      el('h3', { text: 'Aktionen' }),
      el('p', {
        text:
          'Hit (Karte nehmen), Stand (stehen bleiben), Double (Einsatz verdoppeln und genau ' +
          'eine Karte nehmen), Split (zwei gleiche Werte auf zwei Hände aufteilen). Geteilte ' +
          'Asse bekommen nur je eine Karte, und 21 nach einem Split zählt als normale 21.',
      }),
      el('h3', { text: 'Einsätze' }),
      el('p', {
        text: `Zwischen ${chips(config.minBet)} und ${chips(config.maxBet)} Chips pro Hand. ` +
          'Wer nicht setzt, sitzt die Runde aus.',
      }),
    ];
  },

  onEvent(event) {
    if (event.kind === 'shuffle') toast('Der Schuh wird neu gemischt', '', 2000);
    if (event.kind === 'result') {
      const mine = event.result.entries;
      const best = mine.find((entry) => entry.outcome === 'blackjack');
      if (best) toast(`${best.name}: Blackjack!`, 'good');
    }
  },
};

/** Beschriftung des Startknopfes in der Setzphase. */
function readyLabel(game, placed, youReady) {
  const ready = game.ready ?? { ready: 0, total: 1 };
  if (!placed && !youReady) return 'Erst einen Einsatz setzen';
  if (!youReady) return ready.total > 1 ? 'Fertig – ich bin bereit' : 'Karten geben';
  return ready.total > 1 ? `Warte auf die anderen (${ready.ready}/${ready.total})` : 'Geht los …';
}

function handStatus(box, hand) {
  if (!hand) return null;
  if (hand.outcome) return OUTCOME_LABEL[hand.outcome];
  if (hand.total > 21) return 'Überkauft';
  if (hand.blackjack) return 'Blackjack!';
  const totals = box.hands.map((entry) => entry.total).join(' / ');
  return totals;
}

function waitingText(game, state, meId) {
  if (game.phase === 'idle') return 'Gleich wird wieder gesetzt …';
  if (game.phase === 'settled') return 'Abrechnung läuft …';
  if (game.phase === 'dealer') return 'Der Dealer zieht …';
  const hasBox = game.boxes?.some((box) => box.playerId === meId);
  if (!hasBox) return 'Du sitzt diese Runde aus.';
  const actor = state.seats.find((seat) => seat.playerId === state.actorId);
  return actor ? `${actor.name} ist am Zug …` : 'Es läuft …';
}
