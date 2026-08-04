/** Winzige DOM-Helfer – kein Framework, kein Build-Step. */

export const $ = (id) => document.getElementById(id);

/**
 * Erzeugt ein Element.
 * @param {string} tag z. B. 'div.seat.is-active'
 * @param {object} [props] Attribute; `text` setzt textContent, `html` innerHTML
 * @param {Array<Node|string>} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Ersetzt den Inhalt eines Containers. */
export function fill(container, children) {
  container.replaceChildren(...[].concat(children).filter(Boolean));
}

export const show = (node, visible = true) => {
  if (node) node.hidden = !visible;
};

/** Kurze Einblendung oben am Bildschirm (höchstens drei gleichzeitig). */
export function toast(message, variant = '', duration = 2800) {
  const host = $('toast-host');
  if (!host) return;
  const node = el(`div.toast${variant ? `.toast--${variant}` : ''}`, { text: message });
  host.append(node);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  }, duration);
}

/**
 * Maskiert Text für die Verwendung in `innerHTML`.
 * Spielernamen kommen von anderen Leuten – sie werden nie roh eingesetzt.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/** Chips hübsch schreiben: 1234 → "1.234". */
export function chips(value) {
  return new Intl.NumberFormat('de-DE').format(Math.round(value ?? 0));
}

/** Sekunden aus Millisekunden, aufgerundet und nie negativ. */
export const seconds = (ms) => Math.max(0, Math.ceil(ms / 1000));

/**
 * Vier runde Schnellwahl-Beträge zwischen Mindest- und Höchsteinsatz.
 *
 * Bewusst abgeleitet statt fest verdrahtet: Sonst stünden an einem Tisch mit
 * 1.000er-Mindesteinsatz immer noch Knöpfe für 5 und 10 Chips.
 */
export function quickAmounts(min, max) {
  const stufen = [min, min * 2, min * 5, min * 10, min * 25, min * 50, min * 100];
  const gerundet = stufen.map((wert) => roundNice(wert)).filter((wert) => wert >= min && wert <= max);
  const eindeutig = [...new Set([min, ...gerundet, max])].sort((a, b) => a - b);
  if (eindeutig.length <= 4) return eindeutig;
  // Erster, letzter und zwei dazwischen – gleichmäßig verteilt.
  const mitte = eindeutig.slice(1, -1);
  return [
    eindeutig[0],
    mitte[Math.floor(mitte.length / 3)],
    mitte[Math.floor((2 * mitte.length) / 3)],
    eindeutig.at(-1),
  ];
}

/** Auf eine „schöne“ Zahl runden (100, 250, 500, 1.000 …). */
function roundNice(value) {
  if (value <= 0) return 0;
  const größenordnung = 10 ** Math.floor(Math.log10(value));
  const rest = value / größenordnung;
  const stufe = rest <= 1.5 ? 1 : rest <= 3.5 ? 2.5 : rest <= 7.5 ? 5 : 10;
  return Math.round(stufe * größenordnung);
}
