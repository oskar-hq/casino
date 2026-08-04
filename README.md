# Casino Floor

Ein selbstgehostetes Web-Casino zum Spaß. Man betritt mit einem Anzeigenamen
den Floor, sieht die offenen Tische, setzt sich dazu, wo man will – Poker,
Blackjack, Slots, Plinko, Roulette oder Baccarat – und nimmt sein Guthaben überall hin
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
| **Plinko** | bis 5 | Kugel durch 12 Nagelreihen, drei Risikostufen, ~97 % |
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

1. **Namen eingeben** → man betritt den Floor und bekommt 100.000 Chips.
   Derselbe Name führt später wieder auf dasselbe Guthaben.
2. **Tisch eröffnen oder dazusetzen.** Jeder Tisch hat einen vierstelligen
   Code; wer den Code hat, kommt über „Beitreten“ direkt an den Tisch
   (auch per Link: `https://dein-casino/?t=ABCD`).
3. **Bots dazusetzen**, wenn Freunde fehlen: im Tisch auf „Tisch“ →
   Plus-Knopf, Schwierigkeit leicht/mittel/schwer.
4. **Der Host** (der erste Gast, oder wer den PIN kennt) hat oben rechts den
   Host-Bereich mit dem Reset-Knopf.

### Weggehen

Rausgehen geht **immer** – in jedem Spiel und in jeder Phase, auch mitten in
einer laufenden Runde:

- **„‹ Floor“** oben links am Tisch → zurück auf den Floor.
- **„Tisch“ → „Aufstehen, weiter zuschauen“** → Platz freigeben, aber
  weiter zusehen.
- **„Verlassen“** oben rechts auf dem Floor → zurück zum Eingang.

Was dabei mit den Chips passiert, hängt vom Spiel ab – und ist immer die
Regel, die auch am echten Tisch gilt:

| Situation | Chips |
| --- | --- |
| Roulette/Baccarat, Rad dreht noch nicht | Einsatz kommt zurück |
| Roulette/Baccarat, schon gedreht/gegeben | Wette läuft, Gewinn wird gutgeschrieben |
| Blackjack, noch in der Setzphase | Einsatz kommt zurück |
| Blackjack, Karten liegen | Hand bleibt stehen und wird normal abgerechnet |
| Slots, Walzen laufen | Dreh wird zu Ende gerechnet, Gewinn kommt an |
| Poker, mitten in der Hand | gilt als Fold; was im Pot liegt, bleibt im Pot |

Der Sitzplatz wird sofort frei, der Tisch spielt ohne Unterbrechung weiter.
Das Guthaben bleibt auf dem Server – mit demselben Namen kommt man jederzeit
mit dem gleichen Stand zurück.

Ein paar Regeln, die bewusst so sind:

- **Kein Rebuy mitten in der Session.** Wer bei 0 steht, kann nicht mehr
  setzen und sitzt aus. Wieder aufgefüllt wird nur über den Reset-Knopf des
  Hosts – oder automatisch nach 24 Stunden (siehe unten).
- **Tagesbonus nach 24 Stunden.** Wer unter dem Startguthaben liegt, wird
  höchstens einmal am Tag automatisch wieder auf 100.000 gesetzt – damit man
  am nächsten Tag weiterspielen kann, ohne sich einen neuen Namen auszudenken.
  Wer **über** dem Startguthaben liegt, behält seinen Gewinn; gutes Spiel soll
  ja etwas wert sein. Die Frist beginnt erst mit der Auffüllung neu, ein
  Reicher wird also nicht alle 24 Stunden heruntergesetzt.
  Abschaltbar über `CASINO_TOPUP_AFTER_MS=0`.
- **Ein Tisch pro Person.** Man kann überall zuschauen, aber nur an einem
  Tisch *sitzen* – sonst ließe sich dasselbe Guthaben zweimal setzen.
- **Verdeckte Karten sind wirklich verdeckt.** Beim Poker verlassen fremde
  Hole Cards den Server nie, beim Blackjack bleibt die Karte des Dealers bis
  zu seinem Zug auf dem Server. Die **eigenen** Karten liegen immer offen –
  man muss sie nicht erst aufdecken.
- **Es geht los, wenn alle so weit sind.** Bei Roulette, Baccarat und
  Blackjack läuft ein Countdown, aber niemand muss ihn abwarten: Ein Tippen
  auf den grünen Knopf heißt „ich bin fertig“, und sobald alle am Tisch so
  weit sind, geht es sofort los. Allein am Tisch startet man damit direkt.

## Umgebungsvariablen

Alles ist optional – ohne Angabe gelten die Vorgaben.

### Floor

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Port für Frontend **und** WebSocket |
| `HOST` | `0.0.0.0` | Bind-Adresse |
| `CASINO_NAME` | `Chip Palace` | Name im Kopf der Seite |
| `CASINO_START_CHIPS` | `100000` | Startguthaben und Ziel des Reset-Knopfes |
| `CASINO_TOPUP_AFTER_MS` | `86400000` | Frist der automatischen Auffüllung, `0` schaltet sie ab |
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
| `HOLDEM_SMALL_BLIND` / `HOLDEM_BIG_BLIND` | `500` / `1000` |
| `HOLDEM_TURN_MS` | `30000` |
| `BLACKJACK_DECKS` | `6` |
| `BLACKJACK_MIN_BET` / `BLACKJACK_MAX_BET` | `500` / `25000` |
| `BLACKJACK_BET_MS` | `15000` |
| `SLOTS_MIN_BET` / `SLOTS_MAX_BET` | `500` / `10000` |
| `ROULETTE_MIN_BET` / `ROULETTE_MAX_BET` | `500` / `25000` |
| `ROULETTE_BET_MS` | `25000` |
| `PLINKO_MIN_BET` / `PLINKO_MAX_BET` | `500` / `25000` |
| `BACCARAT_DECKS` | `8` |
| `BACCARAT_MIN_BET` / `BACCARAT_MAX_BET` | `1000` / `50000` |
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
  fremde Hole Cards und die Hole Card des Dealers verlassen den Server nie.
- **Ergebnisse, die schon feststehen, gehen mit der Animation raus.** Beim
  Roulette fährt die gefallene Zahl mit dem Dreh-Ereignis mit, bei Plinko der
  komplette Weg der Kugel. Nur so kann die Animation *wirklich* dort landen,
  wo abgerechnet wird – eine Kugel, die woanders liegen bleibt als das
  Ergebnis, wäre schlicht gelogen.

  Das ist kein Leck, sondern eine bewusste Abwägung: In dem Moment, in dem das
  Ergebnis herausgeht, ist das Setzfenster geschlossen bzw. der Einsatz längst
  abgebucht. Der Server weist ab da jede Wette ab (`test/roulette.test.js`
  nagelt genau das fest). Wer früher hinsieht, verdirbt sich höchstens selbst
  die Spannung – einen Vorteil hat er nicht. Im **öffentlichen Zustand** steht
  die Zahl weiterhin erst nach der Abrechnung, Zuschauer sehen also nichts.
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
