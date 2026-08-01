/**
 * Die Floor-Ansicht: Man steht im Raum und sieht, an welchen Tischen was
 * läuft und wo noch Platz ist.
 *
 * Pro Spiel eine Reihe; darin die offenen Tische und ein Knopf, um einen
 * neuen aufzumachen. Die Liste der Spiele kommt vom Server – die Ansicht
 * kennt kein einziges Spiel namentlich.
 */

import { chips, el, fill } from './dom.js';

const DIFFICULTY_LABEL = { easy: 'leicht', medium: 'mittel', hard: 'schwer' };

/**
 * @param {HTMLElement} container
 * @param {object} floor Serverzustand des Floors
 * @param {object} you Dein Spielerzustand
 * @param {object} handlers { onCreate, onJoin }
 */
export function renderFloor(container, floor, you, { onCreate, onJoin }) {
  const byGame = new Map(floor.games.map((game) => [game.id, []]));
  for (const table of floor.tables) {
    if (byGame.has(table.game)) byGame.get(table.game).push(table);
  }

  const sections = floor.games.map((game) => {
    const tables = byGame.get(game.id) ?? [];
    return el('section.game-row', {}, [
      el('div.game-head', {}, [
        el('div.game-head-main', {}, [
          el('span.game-icon', { text: game.icon, 'aria-hidden': 'true' }),
          el('div', {}, [
            el('h2.game-name', { text: game.name }),
            el('p.game-tagline', { text: game.tagline }),
          ]),
        ]),
        el('button.button.button--small', {
          text: 'Tisch eröffnen',
          onClick: () => onCreate(game),
        }),
      ]),
      tables.length
        ? el(
            'div.table-strip',
            {},
            tables.map((table) => tableCard(table, game, you, onJoin)),
          )
        : el('p.game-empty', {
            text: 'Hier steht noch kein Tisch. Mach einen auf.',
          }),
    ]);
  });

  fill(container, sections);
}

/** Eine Tischkarte auf dem Floor. */
function tableCard(table, game, you, onJoin) {
  const free = table.seats - table.occupied;
  const seatedHere = you?.seatedAt === table.code;

  const occupants = table.players.length
    ? el(
        'div.table-people',
        {},
        table.players.map((player) =>
          el(`span.person${player.isBot ? '.person--bot' : ''}${player.away ? '.person--away' : ''}`, {
            text: player.name,
            title: player.isBot ? 'Bot' : player.away ? 'gerade nicht da' : player.name,
          }),
        ),
      )
    : el('p.table-empty', { text: 'Noch niemand hier' });

  return el(
    `button.table-card${seatedHere ? '.table-card--mine' : ''}`,
    { onClick: () => onJoin(table), type: 'button' },
    [
      el('div.table-card-head', {}, [
        el('span.table-card-name', { text: table.name }),
        el('span.table-card-code', { text: table.code }),
      ]),
      table.stakes
        ? el('span.table-stakes', { text: `${table.stakesLabel ?? 'Einsatz'} ${table.stakes}` })
        : null,
      occupants,
      el('div.table-card-foot', {}, [
        el('span.seat-badge', {
          text: free > 0 ? `${free} von ${table.seats} frei` : 'voll besetzt',
          class: free > 0 ? 'seat-badge--free' : 'seat-badge--full',
        }),
        table.spectators
          ? el('span.spectator-badge', { text: `${table.spectators} schaut${table.spectators > 1 ? 'en' : ''} zu` })
          : null,
        seatedHere ? el('span.seat-badge.seat-badge--mine', { text: 'Du sitzt hier' }) : null,
      ]),
    ],
  );
}

/** Die Gästeliste (Guthaben-Rangliste). */
export function renderGuests(container, guests, youId) {
  fill(
    container,
    guests.map((guest, index) =>
      el(`li.guest${guest.id === youId ? '.guest--me' : ''}`, {}, [
        el('span.guest-rank', { text: `${index + 1}.` }),
        el('span.guest-name', { text: guest.name }),
        guest.isHost ? el('span.tag.tag--host', { text: 'Host' }) : null,
        guest.table ? el('span.tag', { text: `Tisch ${guest.table}` }) : null,
        el('span.guest-chips', { text: chips(guest.chips) }),
      ]),
    ),
  );
}

/**
 * Baut die Einstellungsfelder eines Spiels für den „Tisch eröffnen“-Dialog.
 * Die Feldbeschreibungen kommen vom Modul – neue Spiele funktionieren hier
 * ohne Änderung.
 */
export function renderConfigFields(container, game) {
  const values = { ...game.defaultConfig };
  const nodes = (game.configFields ?? []).map((field) => {
    const valueLabel = el('span.settings-value', {
      text: formatFieldValue(field, values[field.key]),
    });

    if (field.type === 'bool') {
      const input = el('input', {
        type: 'checkbox',
        id: `cfg-${field.key}`,
        ...(values[field.key] ? { checked: true } : {}),
        onChange: (event) => {
          values[field.key] = event.target.checked;
        },
      });
      return el('label.settings-toggle', {}, [input, el('span', { text: field.label })]);
    }

    if (field.type === 'select') {
      const select = el(
        'select.input',
        {
          onChange: (event) => {
            values[field.key] = event.target.value;
          },
        },
        (field.options ?? []).map((option) =>
          el('option', {
            value: option.value,
            text: option.label,
            ...(option.value === values[field.key] ? { selected: true } : {}),
          }),
        ),
      );
      return el('label.field', {}, [el('span.field-label', { text: field.label }), select]);
    }

    const slider = el('input.slider', {
      type: 'range',
      min: field.min,
      max: field.max,
      step: field.step ?? 1,
      value: values[field.key],
      onInput: (event) => {
        values[field.key] = Number(event.target.value);
        valueLabel.textContent = formatFieldValue(field, values[field.key]);
      },
    });
    return el('div.settings-block', {}, [
      el('div.settings-row', {}, [el('p.eyebrow', { text: field.label }), valueLabel]),
      slider,
    ]);
  });

  fill(container, nodes);
  return values;
}

function formatFieldValue(field, value) {
  if (field.display === 'seconds') return `${Math.round(value / 1000)} s`;
  if (field.suffix === 'Chips') return `${chips(value)} Chips`;
  return String(value);
}

export { DIFFICULTY_LABEL };
