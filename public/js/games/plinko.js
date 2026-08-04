/**
 * Sichtmodul Plinko.
 *
 * Das Nagelfeld wird als SVG gezeichnet, die Kugeln laufen als absolut
 * positionierte Punkte darüber. Der Weg jeder Kugel kommt vom Server – die
 * Animation läuft ihn Nagel für Nagel nach und endet exakt über dem Fach,
 * das auch abgerechnet wird.
 */

import { chips, el, quickAmounts, toast } from '../dom.js';

const RISK_LABELS = { low: 'vorsichtig', medium: 'normal', high: 'riskant' };
const RISK_ORDER = ['low', 'medium', 'high'];

/** Zuletzt gewählter Einsatz und Risikostufe. */
let betAmount = null;
let risk = null;
/** Welche Kugeln schon animiert werden – sonst starten sie bei jedem Paket neu. */
const laufende = new Map();

export default {
  id: 'plinko',
  layout: 'machine',

  renderCenter(ctx) {
    const game = ctx.state.public;
    if (!game) return [];
    if (risk === null) risk = game.defaultRisk;

    const board = el('div.plinko-board', {}, [
      el('div.plinko-pegs', { html: pegSvg(game.rows) }),
      el('div.plinko-balls'),
      el(
        'div.plinko-slots',
        {},
        game.multipliers[risk].map((mult, index) =>
          el(`div.plinko-slot.plinko-slot--${heat(index, game.rows)}`, {
            text: `${mult}×`,
            dataset: { slot: String(index) },
          }),
        ),
      ),
    ]);

    // Die fallenden Kugeln nach dem Rendern einhängen.
    queueMicrotask(() => animateDrops(board, game));

    return [
      board,
      el('p.felt-phase', {
        text: game.drops.length
          ? `${game.drops.length} Kugel${game.drops.length === 1 ? '' : 'n'} unterwegs`
          : `${game.stats.drops} Kugeln an diesem Gerät`,
      }),
      recentHits(game, ctx.meId),
    ].filter(Boolean);
  },

  seatDecor(seat, ctx) {
    const letzte = ctx.state.public?.history?.find((entry) => entry.playerId === seat.playerId);
    if (!letzte) return {};
    return {
      status: `${letzte.multiplier}× · ${letzte.net >= 0 ? '+' : '−'}${chips(Math.abs(letzte.net))}`,
      className: letzte.net > 0 ? 'seat--won' : '',
    };
  },

  renderActions(ctx) {
    const { state, send } = ctx;
    const game = state.public;

    if (!state.youSeated) {
      const frei = state.seats.some((seat) => !seat.playerId);
      return [
        el('p.dock-note', {
          text: frei ? 'Stell dich dazu und lass Kugeln fallen.' : 'Hier ist gerade kein Platz frei.',
        }),
        frei
          ? el('button.action.action--raise', {
              text: 'Platz nehmen',
              onClick: () => send({ type: 'sit', code: state.code }),
            })
          : null,
      ].filter(Boolean);
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

    const zuViele = (state.private?.active ?? 0) >= (state.private?.maxActive ?? 3);

    return [
      // Risikostufe: verändert die Multiplikatoren an den Fächern.
      el('div.settings-block', {}, [
        el('div.settings-row', {}, [
          el('p.eyebrow', { text: 'Risiko' }),
          el('span.settings-value', { text: RISK_LABELS[risk] }),
        ]),
        el(
          'div.segmented',
          {},
          RISK_ORDER.map((stufe) =>
            el(`button.segment${stufe === risk ? '.is-active' : ''}`, {
              text: RISK_LABELS[stufe],
              type: 'button',
              onClick: () => {
                risk = stufe;
                // Neu zeichnen lassen: Der Zustand kommt gleich wieder rein.
                send({ type: 'view_table', code: state.code });
              },
            }),
          ),
        ),
      ]),
      el('div.raise-box', {}, [
        el('div.raise-head', {}, [el('span.raise-label', { text: 'Einsatz' }), label]),
        slider,
        el(
          'div.quick-row',
          {},
          quickAmounts(min, max).map((value) =>
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
        el('button.action.action--raise.action--drop', {
          text: zuViele ? 'Kugeln unterwegs …' : `Fallen lassen ${chips(betAmount)}`,
          disabled: zuViele,
          onClick: () =>
            send({
              type: 'action',
              code: state.code,
              action: { move: 'drop', amount: betAmount, risk },
            }),
        }),
      ]),
    ];
  },

  renderSidePanel(ctx) {
    const game = ctx.state.public;
    if (!game) return null;
    const tabelle = game.multipliers[risk ?? game.defaultRisk];
    return {
      title: `Auszahlungen · ${RISK_LABELS[risk ?? game.defaultRisk]}`,
      body: [
        el(
          'ul.pay-list',
          {},
          tabelle.map((mult, index) =>
            el('li.pay-row', {}, [
              el('span.pay-name', { text: `Fach ${index + 1}` }),
              el('span.pay-mult', { text: `${mult}×` }),
            ]),
          ),
        ),
        el('p.pay-note', {
          text: 'Außen zahlt am meisten, wird aber am seltensten getroffen.',
        }),
      ],
    };
  },

  info(ctx) {
    const game = ctx.state.public;
    return [
      el('h3', { text: 'So läuft es' }),
      el('p', {
        text:
          `Die Kugel fällt durch ${game?.rows ?? 12} Nagelreihen. An jedem Nagel wird sie mit ` +
          'genau 50 % Wahrscheinlichkeit nach links oder rechts abgelenkt – unten landet sie in ' +
          'einem Fach, dessen Multiplikator deinen Einsatz malnimmt.',
      }),
      el('h3', { text: 'Warum die Mitte so oft trifft' }),
      el('p', {
        text:
          'Es gibt nur einen einzigen Weg ganz nach links (zwölfmal links) – aber sehr viele Wege ' +
          'in die Mitte. Deshalb landet die Kugel in rund 22 % der Fälle im mittleren Fach und nur ' +
          'in etwa 0,02 % ganz außen. Genau dafür stehen dort die großen Multiplikatoren.',
      }),
      el('h3', { text: 'Risikostufen' }),
      el('p', {
        text:
          '„vorsichtig“ zahlt außen 4×, dafür verliert man in der Mitte weniger. „riskant“ zahlt ' +
          'außen 50×, dafür bleibt in der Mitte nur ein Fünftel des Einsatzes übrig. Auf lange ' +
          'Sicht kommen bei allen drei Stufen rund 97 % der Einsätze zurück – die Stufe ändert ' +
          'nur, wie wild es zugeht.',
      }),
      el('h3', { text: 'Zufall' }),
      el('p', {
        text:
          'Der Weg der Kugel wird beim Drücken auf dem Server ausgewürfelt und dann an deinen ' +
          'Browser geschickt. Die Animation läuft genau diesen Weg nach – die Kugel landet auf ' +
          'dem Bildschirm also wirklich dort, wo auch abgerechnet wird.',
      }),
    ];
  },

  onEvent(event, ctx) {
    if (event.kind !== 'landed') return;
    const { result } = event;
    if (result.playerId !== ctx.meId) return;
    toast(
      `${result.multiplier}× · ${result.net >= 0 ? '+' : '−'}${chips(Math.abs(result.net))}`,
      result.net > 0 ? 'good' : result.net < 0 ? 'bad' : '',
      2600,
    );
  },
};

// ------------------------------------------------------------- Nagelfeld

/** Wie „heiß“ ein Fach ist – die Ränder werden kräftiger eingefärbt. */
function heat(index, rows) {
  const abstand = Math.abs(index - rows / 2) / (rows / 2);
  if (abstand > 0.75) return 'hot';
  if (abstand > 0.4) return 'warm';
  return 'cool';
}

/**
 * Die Nägel als SVG. Reihe `r` hat `r + 1` Nägel, mittig ausgerichtet –
 * genau das Dreieck, durch das die Kugel fällt.
 */
function pegSvg(rows) {
  const breite = 100;
  const höhe = 100;
  const punkte = [];
  for (let reihe = 0; reihe < rows; reihe++) {
    const anzahl = reihe + 2;
    const y = ((reihe + 1) / (rows + 1)) * höhe;
    for (let i = 0; i < anzahl; i++) {
      const x = breite / 2 + (i - (anzahl - 1) / 2) * (breite / (rows + 2));
      punkte.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.9"/>`);
    }
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="plinko-peg-svg" aria-hidden="true">
    <g fill="rgba(255,255,255,.55)">${punkte.join('')}</g>
  </svg>`;
}

/**
 * Setzt für jede fallende Kugel ein Element und lässt es den Weg ablaufen.
 *
 * Die waagerechte Position ergibt sich aus dem Weg: Nach `n` Nägeln liegt die
 * Kugel bei `(Anzahl Rechts) - n/2` Halbschritten von der Mitte. Am Ende steht
 * sie genau über ihrem Fach.
 */
function animateDrops(board, game) {
  const schicht = board.querySelector('.plinko-balls');
  if (!schicht) return;

  for (const drop of game.drops) {
    if (schicht.querySelector(`[data-drop="${drop.id}"]`)) continue;

    const kugel = el('span.plinko-ball', { dataset: { drop: drop.id } });
    schicht.append(kugel);

    const schritte = drop.path.length;
    // Bereits verstrichene Zeit berücksichtigen (z. B. beim Dazukommen).
    const start = laufende.get(drop.id) ?? Date.now();
    laufende.set(drop.id, start);

    const keyframes = [{ left: '50%', top: '0%', offset: 0 }];
    let rechts = 0;
    for (let i = 0; i < schritte; i++) {
      rechts += drop.path[i];
      const versatz = rechts - (i + 1) / 2;
      const x = 50 + (versatz * 100) / (schritte + 2);
      const y = ((i + 1) / (schritte + 1)) * 100;
      keyframes.push({ left: `${x.toFixed(2)}%`, top: `${y.toFixed(2)}%`, offset: (i + 1) / (schritte + 1) });
    }
    // Letztes Stück ins Fach.
    const endeX = 50 + ((drop.slot - schritte / 2) * 100) / (schritte + 2);
    keyframes.push({ left: `${endeX.toFixed(2)}%`, top: '100%', offset: 1 });

    const verstrichen = Date.now() - drop.startedAt;
    const animation = kugel.animate(keyframes, {
      duration: game.dropMs,
      easing: 'cubic-bezier(.45,.05,.7,.6)',
      fill: 'forwards',
    });
    if (verstrichen > 0) animation.currentTime = Math.min(verstrichen, game.dropMs);

    animation.onfinish = () => {
      kugel.classList.add('is-landed');
      const fach = board.querySelector(`.plinko-slot[data-slot="${drop.slot}"]`);
      fach?.classList.add('is-hit');
      setTimeout(() => {
        kugel.remove();
        fach?.classList.remove('is-hit');
        laufende.delete(drop.id);
      }, 500);
    };
  }
}

/** Die letzten Treffer als Streifen unter dem Feld. */
function recentHits(game, meId) {
  if (!game.history?.length) return null;
  return el(
    'div.plinko-history',
    {},
    game.history.slice(0, 8).map((entry) =>
      el(
        `span.plinko-chip${entry.net > 0 ? '.plinko-chip--win' : ''}${entry.playerId === meId ? '.plinko-chip--mine' : ''}`,
        { text: `${entry.multiplier}×`, title: `${entry.name}: ${entry.net >= 0 ? '+' : ''}${entry.net}` },
      ),
    ),
  );
}
