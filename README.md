# Dash Arena

Mini-Multiplayer im Browser: Schubs alle von der Eisfläche!

## Starten

```bash
npm install
npm start
```

Dann im Browser `http://localhost:3000` öffnen. Freunde im selben WLAN nutzen die Adresse, die der Server beim Start unter „WLAN“ ausgibt (Windows-Firewall-Abfrage beim ersten Start erlauben).

## Steuerung

- **PC:** WASD/Pfeile bewegen, Leertaste oder Maustaste halten = aufladen, loslassen = Dash (ohne Bewegung zielt der Dash zur Maus). `M` = Ton an/aus.
- **Handy:** linke Bildschirmhälfte = Joystick, rechte Hälfte halten = aufladen, loslassen = Dash.

## Regeln

- Wer dich in den letzten 3 Sekunden getroffen hat, bekommt den Punkt, wenn du runterfällst.
- Ab 3er-Serie gibt es +1 Bonus pro KO. Wer den Spieler mit der 👑 rauswirft, kassiert +3.
- **PERFEKT-Dash:** Lässt du genau dann los, wenn der Ring golden pulsiert (kurz nach Vollladung), fliegst du schneller und triffst härter.
- **Combos:** Ein Treffer setzt deinen Dash-Cooldown fast zurück, also gleich nachsetzen.
- **KNAPP!:** Rettest du dich nach einem Treffer von der Kante zurück, gibt's eine Ansage.
- Alle 40 Sekunden schrumpft die Plattform kurz.

## Sonstiges

- Hinter dem Menü läuft die echte Arena live, mit Anzeige, wie viele Spieler online sind.
- Neue Spieler bekommen ein kurzes Tutorial (Reset: `localStorage.removeItem('da_tut')` in der Browser-Konsole).
- Dein Punkte-Rekord und deine beste Serie werden im Browser gespeichert.

## Sounds

Alle Sounds liegen in `public/sfx/` (mit Higgsfield generiert: Effekte von Mirelo, Musik und Ansager von ElevenLabs). Beim Laden wird jedes Sample automatisch aufbereitet: Stille vorne und hinten wird abgeschnitten, die Lautstärke angeglichen. Fehlt eine Datei oder ist sie stumm, nimmt das Spiel automatisch einen synthetischen Ersatz-Sound. `hit`, `hit2` und `hit3` wechseln sich zufällig ab. Einfach eine Datei mit gleichem Namen ersetzen, um einen Sound auszutauschen. `N` = Musik an/aus.
- Bots füllen die Arena auf 6 Spieler auf.

## Feintuning

Alle Werte für das Spielgefühl (Reibung, Dash-Stärke, Cooldown, Knockback …) stehen oben in `server/game.js` im Objekt `C`.
