# Casino Floor

Ein selbstgehostetes Web-Casino zum Spaß. Man betritt mit einem Anzeigenamen
den Floor, sieht die offenen Tische, setzt sich dazu, wo man will – Poker,
Blackjack, Slots, Roulette oder Baccarat – und nimmt sein Guthaben überall hin
mit. Spielbar mit Freunden und gegen Bots.

> **Reines Spielgeld.** Es gibt keinen Kauf von Chips, keine Auszahlung und
> keinen Bezug zu echtem Geld. Wenn alle pleite sind, drückt der Host auf
> „Alle auffüllen“ und die Session beginnt von vorn.

## Was drin ist

| Spiel | Plätze | Kurz |
| --- | --- | --- |
| **Texas Hold'em** | bis 9 | No-Limit, feste Blinds, Side-Pots, Showdown |
| **Blackjack** | bis 7 | 6-Deck-Schuh, Dealer steht auf Soft 17, Blackjack 3:2 |
| **Slots** | 1 | 3 Walzen, feste Paytable, ~95 % Auszahlungsquote |
| **Roulette** | bis 8 | Europäisch (eine Null), volles Tableau |
| **Baccarat** | bis 8 | Punto Banco, 5 % Kommission auf Banker |

Dazu: gemeinsames Guthaben über alle Spiele, Bots in drei Schwierigkeiten,
Zug-Timer mit Auto-Fold/Check, Wiederverbinden nach Verbindungsabbruch und ein
Frontend, das auf dem Handy genauso funktioniert wie am Desktop.

## Schnellstart

```bash
npm install
npm start
# → http://localhost:3000
```

Mit Docker:

```bash
docker compose up -d --build
# → http://127.0.0.1:3000
```

Der Container hört auf **einem** Port; Frontend und WebSocket (`/ws`) laufen
beide darüber. Damit reicht ein Cloudflare- oder Tailscale-Funnel auf diesen
einen Port, ohne Extrakonfiguration.

Zum Testen:

```bash
npm test
```

## Wie man spielt

1. **Namen eingeben** → man betritt den Floor und bekommt 1000 Chips.
   Derselbe Name führt später wieder auf dasselbe Guthaben.
2. **Tisch eröffnen oder dazusetzen.** Jeder Tisch hat einen vierstelligen
   Code; wer den Code hat, kommt über „Beitreten“ direkt an den Tisch
   (auch per Link: `https://dein-casino/?t=ABCD`).
3. **Bots dazusetzen**, wenn Freunde fehlen: im Tisch auf „Tisch“ →
   Plus-Knopf, Schwierigkeit leicht/mittel/schwer.
4. **Der Host** (der erste Gast, oder wer den PIN kennt) hat oben rechts den
   Host-Bereich mit dem Reset-Knopf.

Ein paar Regeln, die bewusst so sind:

- **Kein Rebuy.** Wer bei 0 steht, kann nicht mehr setzen und sitzt aus.
  Nur der Reset-Knopf des Hosts füllt wieder auf.
- **Ein Tisch pro Person.** Man kann überall zuschauen, aber nur an einem
  Tisch *sitzen* – sonst ließe sich dasselbe Guthaben zweimal setzen.
- **Verdeckte Karten sind wirklich verdeckt.** Beim Poker verlassen fremde
  Hole Cards den Server nie, beim Blackjack bleibt die Karte des Dealers bis
  zu seinem Zug auf dem Server. Eigene Karten sieht man per **Hochwischen**
  (Handy) bzw. **Gedrückthalten** (Desktop).

## Umgebungsvariablen

Alles ist optional – ohne Angabe gelten die Vorgaben.

### Floor

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Port für Frontend **und** WebSocket |
| `HOST` | `0.0.0.0` | Bind-Adresse |
| `CASINO_NAME` | `Chip Palace` | Name im Kopf der Seite |
| `CASINO_START_CHIPS` | `1000` | Startguthaben und Ziel des Reset-Knopfes |
| `CASINO_TURN_MS` | `30000` | Bedenkzeit pro Zug, danach Auto-Fold/Check |
| `CASINO_BOT_MS` | `1100` | Bedenkzeit eines Bots |
| `CASINO_HOST_PIN` | – | Wer den PIN kennt, wird Host. Leer = erster Gast |
| `CASINO_DB` | `data/casino.db` | SQLite-Datei, `:memory:` für flüchtig |
| `CASINO_TABLE_TTL_MS` | `1800000` | Wie lange ein leerer Tisch stehen bleibt |
| `CASINO_SEAT_GRACE_MS` | `120000` | Frist, bis ein getrennter Spieler den Platz verliert |
| `CASINO_ALLOW_RENAME` | `true` | Darf der Host das Casino umbenennen? |

### Spiele

Diese überschreiben die Vorgaben im „Tisch eröffnen“-Dialog. Einzelne Tische
lassen sich dort weiterhin abweichend einstellen.

| Variable | Vorgabe |
| --- | --- |
| `HOLDEM_SMALL_BLIND` / `HOLDEM_BIG_BLIND` | `5` / `10` |
| `HOLDEM_TURN_MS` | `30000` |
| `BLACKJACK_DECKS` | `6` |
| `BLACKJACK_MIN_BET` / `BLACKJACK_MAX_BET` | `10` / `500` |
| `BLACKJACK_BET_MS` | `15000` |
| `SLOTS_MIN_BET` / `SLOTS_MAX_BET` | `5` / `100` |
| `ROULETTE_MIN_BET` / `ROULETTE_MAX_BET` | `5` / `500` |
| `ROULETTE_BET_MS` | `25000` |
| `BACCARAT_DECKS` | `8` |
| `BACCARAT_MIN_BET` / `BACCARAT_MAX_BET` | `10` / `1000` |
| `BACCARAT_BET_MS` | `20000` |

## Betrieb

- **Daten.** SQLite unter `CASINO_DB` speichert Guthaben pro Spielername,
  die Tischdefinitionen und ein kurzes Buchungsprotokoll. Im Compose-Setup
  liegt das im Volume `casino-data`. Laufende Hände werden bewusst *nicht*
  gespeichert – nach einem Neustart stehen die Tische wieder da, offene
  Einsätze sind zurückgebucht.
- **Gesundheitsprüfung.** `GET /healthz` liefert Tischanzahl und Gästezahl.
- **Beim Start steht `ExperimentalWarning: SQLite …` im Log.** Das ist normal:
  Node bringt SQLite selbst mit (`node:sqlite`), markiert es unter Node 22 aber
  noch als experimentell. Dafür muss nichts nativ kompiliert werden – das Image
  bleibt klein und der Build braucht keine Toolchain.
- **Hinter dem Funnel.** Der Server vertraut `X-Forwarded-*` (`trust proxy`)
  und braucht sonst nichts. WebSocket-Upgrades müssen durchgereicht werden –
  bei Cloudflare Tunnel und Tailscale Funnel ist das die Voreinstellung.

## Aufbau

```
core/     Bausteine ohne Spielbezug: RNG, Karten, Tisch, Engine-Vertrag
games/    ein Ordner pro Spiel (Engine + Bot + Modulbeschreibung)
server/   Casino-Floor, SQLite, WebSocket-Protokoll, HTTP
public/   Frontend (kein Build-Step) – js/games/ spiegelt games/
test/     node:test
```

Der Kern ist die Trennung in **Tisch** und **Spielmodul**. `core/table.js`
kennt kein einziges Spiel: Es verwaltet Sitzplätze, Zuschauer, Bedenkzeit und
Bots und ruft ansonsten nur die Methoden aus `core/engine.js` auf. Umgekehrt
kennt ein Spielmodul weder WebSockets noch die Datenbank – es bekommt einen
Kontext mit RNG, Wallet und Timern und liefert Zustand zurück.

### Ein neues Spiel ergänzen

Bestehende Spiele müssen dafür nicht angefasst werden:

1. `games/<name>/index.js` anlegen (Modulbeschreibung + `createEngine`) und
   `games/<name>/engine.js` mit der Logik. Die Engine erbt von `GameEngine`
   und überschreibt, was sie braucht – meist `tick`, `act`, `publicState`
   und `privateState`.
2. Das Modul in `games/index.js` in `MODULES` eintragen.
3. Fürs Frontend `public/js/games/<name>.js` anlegen (was auf dem Filz liegt,
   was unten steht) und in `public/js/games/index.js` eintragen.

Das war es – Floor, Sitzverwaltung, Wallet, Bots, Timer und Reconnect gelten
automatisch. `test/foundation.test.js` prüft das Fundament bewusst gegen ein
Fantasie-Spielmodul, das es im Casino gar nicht gibt.

### Server-Autorität

Der gesamte Zufall und die gesamte Spiellogik laufen auf dem Server; der
Client rendert nur, was er geschickt bekommt. Konkret:

- **Zufall** kommt aus `node:crypto` (`core/rng.js`), nie aus dem Browser.
- **Verdeckte Informationen** stehen ausschließlich in `privateState(playerId)`
  und werden pro Empfänger einzeln erzeugt. `publicState()` enthält sie nicht –
  fremde Hole Cards, die Hole Card des Dealers, die Roulettezahl vor dem Dreh
  und das Slots-Ergebnis während der Animation verlassen den Server nicht.
- **Jede Aktion** wird serverseitig geprüft: Ist der Spieler am Zug, ist der
  Zug regelkonform, reicht das Guthaben. Der Client schickt nur Absichten.
- **Einsätze** werden sofort vom Wallet abgebucht. Es gibt keinen Weg, Chips
  zu setzen, die man nicht hat.

## Später (noch nicht gebaut)

- Video Poker (Jacks or Better)
- Three Card Poker
- Vom Host wählbare Deck-Skins
- Turniere mit steigenden Blinds

## Lizenz

MIT. Generisches Branding, keine Nachahmung eines echten Anbieters.
