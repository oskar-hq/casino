/**
 * Sichtmodul Slots.
 *
 * Die Walzen laufen als CSS-Animation los und halten der Reihe nach an. Das
 * Ergebnis steht dabei längst fest – der Server hat es beim Drücken gezogen.
 * Die Animation zeigt es nur.
 */

import { chips, el, toast } from '../dom.js';

const SYMBOL_ICONS = {
  cherry: '🍒',
  lemon: '🍋',
  bell: '🔔',
  clover: '🍀',
  diamond: '💎',
  seven: '7️⃣',
};

const SYMBOL_LABELS = {
  cherry: 'Kirsche',
  lemon: 'Zitrone',
  bell: 'Glocke',
  clover: 'Kleeblatt',
  diamond: 'Diamant',
  seven: 'Sieben',
};

/** Zuletzt gewählter Einsatz. */
let betAmount = null;
/** Verhindert, dass dieselbe Drehung mehrfach animiert wird. */
let lastSpinToken = null;

export default {
  id: 'slots',

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];

    const reels = game.reels.map((symbol, index) =>
      el(`div.reel${game.spinning ? '.reel--spinning' : ''}`, { style: { '--reel': index } }, [
        el('span.reel-symbol', {
          text: SYMBOL_ICONS[symbol] ?? '?',
          title: SYMBOL_LABELS[symbol] ?? symbol,
        }),
      ]),
    );

    const result = game.result;
    return [
      el('div.slot-machine', {}, [
        el('div.slot-window', {}, reels),
        el('div.slot-line', { 'aria-hidden': 'true' }),
      ]),
      result && !game.spinning
        ? el(`div.slot-result${result.amount > 0 ? '.slot-result--win' : ''}`, {
            text:
              result.amount > 0
                ? `${SYMBOL_LABELS[result.symbol]} ×${result.multiplier} → +${chips(result.amount)}`
                : 'Kein Treffer',
          })
        : null,
      el('p.felt-phase', {
        text: game.spinning ? 'Die Walzen laufen …' : `${game.stats.spins} Drehs an diesem Automaten`,
      }),
    ].filter(Boolean);
  },

  seatDecor(seat, ctx) {
    const game = ctx.state.public;
    const result = game?.result;
    if (!result || result.playerId !== seat.playerId) return {};
    return {
      status: result.amount > 0 ? `+${chips(result.net)}` : `−${chips(-result.net)}`,
      className: result.amount > 0 ? 'seat--won' : '',
    };
  },

  renderActions(ctx) {
    const { state, meId, send } = ctx;
    const game = state.public;
    if (!state.youSeated) {
      return [
        el('p.dock-note', {
          text: 'Setz dich an den Automaten – hier spielt immer nur eine Person.',
        }),
      ];
    }

    const balance = state.private?.balance ?? 0;
    const min = game.minBet;
    const max = Math.min(game.maxBet, balance);
    if (balance < min) {
      return [
        el('p.dock-note', {
          text: `Für den Mindesteinsatz von ${chips(min)} Chips reicht dein Guthaben nicht.`,
        }),
      ];
    }
    if (betAmount === null || betAmount < min || betAmount > max) {
      betAmount = Math.min(max, Math.max(min, betAmount ?? min));
    }

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
        el('div.raise-head', {}, [el('span.raise-label', { text: 'Einsatz' }), label]),
        slider,
        el(
          'div.quick-row',
          {},
          [min, 10, 25, max].map((value) =>
            el('button.quick', {
              text: value === max ? 'Max' : chips(value),
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
        el('button.action.action--raise.action--spin', {
          text: game.spinning ? 'Läuft …' : `Drehen ${chips(betAmount)}`,
          ...(game.spinning ? { disabled: true } : {}),
          onClick: () => send({ type: 'action', code: state.code, action: { move: 'spin', amount: betAmount } }),
        }),
      ]),
      void meId,
    ].filter(Boolean);
  },

  /** Die Auszahlungstabelle steht dauerhaft am Rand. */
  renderSidePanel(ctx) {
    const paytable = ctx.state.public?.paytable;
    if (!paytable) return null;
    const rows = Object.keys(paytable.three).map((symbol) =>
      el('li.pay-row', {}, [
        el('span.pay-symbol', { text: SYMBOL_ICONS[symbol].repeat(3) }),
        el('span.pay-mult', { text: `${paytable.three[symbol]}×` }),
        el('span.pay-two', {
          text: paytable.two[symbol] ? `2× = ${paytable.two[symbol]}×` : '–',
        }),
      ]),
    );
    return [
      el('h3.panel-title', { text: 'Auszahlungen' }),
      el('ul.pay-list', {}, rows),
      el('p.pay-note', { text: 'Vielfaches des Einsatzes. Zwei gleiche zahlen nur oben.' }),
    ];
  },

  info(ctx) {
    const game = ctx.state.public;
    const paytable = game?.paytable;
    return [
      el('h3', { text: 'So läuft es' }),
      el('p', {
        text:
          'Einsatz wählen, drehen, fertig. Drei gleiche Symbole zahlen groß, zwei gleiche nur ' +
          'bei den selteneren Symbolen. Häufige Symbole wie Kirsche und Zitrone zahlen nur als Drilling.',
      }),
      el('h3', { text: 'Auszahlungstabelle' }),
      paytable
        ? el(
            'ul.pay-list',
            {},
            Object.keys(paytable.three).map((symbol) =>
              el('li.pay-row', {}, [
                el('span.pay-symbol', { text: SYMBOL_ICONS[symbol].repeat(3) }),
                el('span.pay-name', { text: SYMBOL_LABELS[symbol] }),
                el('span.pay-mult', { text: `${paytable.three[symbol]}×` }),
                el('span.pay-two', {
                  text: paytable.two[symbol] ? `zwei: ${paytable.two[symbol]}×` : 'zwei: –',
                }),
              ]),
            ),
          )
        : null,
      el('h3', { text: 'Zufall' }),
      el('p', {
        text:
          'Jede Walze wird unabhängig gezogen, jede Position gleich wahrscheinlich – der Zufall ' +
          'kommt aus dem Betriebssystem des Servers. Das Ergebnis steht in dem Moment fest, in ' +
          'dem du drückst; die Animation zeigt es danach nur noch. Über viele Drehs kommen rund ' +
          '95 % der Einsätze wieder zurück.',
      }),
    ].filter(Boolean);
  },

  onEvent(event) {
    if (event.kind === 'spin') {
      // Nur ein Marker – die eigentliche Animation hängt an `game.spinning`.
      lastSpinToken = event.duration;
    }
    if (event.kind === 'spin_result' && event.result.amount > 0) {
      const { symbol, multiplier, amount } = event.result;
      toast(`${SYMBOL_LABELS[symbol]} ×${multiplier}: +${chips(amount)} Chips`, 'good');
    }
    void lastSpinToken;
  },
};
