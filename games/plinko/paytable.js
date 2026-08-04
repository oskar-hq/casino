/**
 * Plinko – die Auszahlungstabellen.
 *
 * Die Kugel fällt durch ein Nagelfeld und wird an jedem Nagel mit 50 %
 * nach links oder rechts abgelenkt. Bei `rows` Nagelreihen landet sie in
 * einem von `rows + 1` Fächern; wie oft sie nach rechts abgelenkt wurde,
 * bestimmt das Fach. Die Verteilung ist damit binomial: die Mitte ist sehr
 * wahrscheinlich, die Ränder sind selten.
 *
 * Genau deshalb stehen außen die großen Multiplikatoren. Die Tabellen sind
 * so gewählt, dass die Auszahlungsquote spürbar unter 100 % bleibt – sonst
 * würde das Spiel Chips aus dem Nichts erzeugen. Nachgerechnet wird das in
 * `test/plinko.test.js`.
 */

/** Multiplikatoren je Risikostufe, von links nach rechts (13 Fächer). */
export const PAYTABLES = {
  low: [4, 2, 1.5, 1.2, 1.05, 0.95, 0.7, 0.95, 1.05, 1.2, 1.5, 2, 4],
  medium: [10, 3, 1.6, 1.4, 1.1, 1, 0.4, 1, 1.1, 1.4, 1.6, 3, 10],
  high: [50, 12, 4, 2, 1.1, 0.6, 0.2, 0.6, 1.1, 2, 4, 12, 50],
};

export const RISKS = Object.keys(PAYTABLES);

export const RISK_LABELS = {
  low: 'vorsichtig',
  medium: 'normal',
  high: 'riskant',
};

/** Alle Tabellen sind für dieses Nagelfeld gebaut. */
export const ROWS = 12;

export function normalizeRisk(value) {
  return RISKS.includes(value) ? value : 'medium';
}

export function multipliersFor(risk) {
  return PAYTABLES[normalizeRisk(risk)];
}

/** Binomialkoeffizient „n über k“. */
export function binomial(n, k) {
  let ergebnis = 1;
  for (let i = 0; i < k; i++) ergebnis = (ergebnis * (n - i)) / (i + 1);
  return Math.round(ergebnis);
}

/** Wahrscheinlichkeit, dass die Kugel in Fach `slot` landet. */
export function slotProbability(slot, rows = ROWS) {
  return binomial(rows, slot) / 2 ** rows;
}

/**
 * Die rechnerische Auszahlungsquote einer Risikostufe.
 * Muss unter 1 liegen, sonst zahlt das Spiel mehr aus, als hereinkommt.
 */
export function returnToPlayer(risk, rows = ROWS) {
  const tabelle = multipliersFor(risk);
  let summe = 0;
  for (let slot = 0; slot <= rows; slot++) {
    summe += slotProbability(slot, rows) * tabelle[slot];
  }
  return summe;
}

/** Auszahlung eines Treffers – abgerundet, weil Chips ganzzahlig sind. */
export function payoutFor(risk, slot, bet) {
  return Math.floor(bet * multipliersFor(risk)[slot]);
}
