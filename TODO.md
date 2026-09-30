# Personal Radio – Stand und nächste Schritte

Stand: 29.09.2026. Das Programm läuft auf dem privaten Worker, gehört wird in der Android-App, Musik kommt über Spotify. Jeder Merge nach `main` deployt den Worker und veröffentlicht die App als In-App-Update. Einrichtung von Grund auf: [README](README.md#run-your-own-station).

> Schlüssel ausschliesslich als Cloudflare-Worker-Secrets bzw. GitHub-Actions-Secrets erfassen, nie im Chat oder im Repository.

## Für Matthias

- [ ] **Sender für die Tochter:** Service-Token anlegen, in die Access-Regel aufnehmen, `LISTENERS` setzen, App auf ihrem Handy einrichten (README, Schritt 11).

- [ ] **Neue App ausprobieren:** Tabs Hören · Programm · Archiv · Studio, Mini-Player, «Anders», Wischen und langes Drücken im Programm; 1–2 Screenshots schicken, damit nachgeschärft werden kann.
- [ ] **Stimmen ausprobieren:** im Studio unter «Stimme» eine Stimme entwerfen («✨ Entwerfen») oder die eigene klonen («🎤 Meine Stimme»); auf Lachen, Pausen und Zwischenrufe in Dialogen hören.
- [ ] **Neues Studio ausprobieren:** Sender, Stimme mit Hörprobe, Ort, Interessen, Musik und Stationssound direkt in der App; Sendungen, Feeds und Redaktion über «Mehr» im Web-Studio.
- [ ] **Hinhören:** Live-Übergänge der Moderation, Jingle-Varianten, Nachrichten-Opener; was stört, lässt sich im Studio unter «Stationssound» einzeln abschalten.
- [ ] **Ausprobieren:** Redaktionsteam für eine Musikstunde («Produktion → Redaktionsteam (Beta)») mit einer Standard-Stunde vergleichen; Musikblock mit eigenen Playlists; Überraschungsregler im Tagesplan.
- [ ] **Feeds auswählen** (optional): RSS/Atom-Feeds eintragen und deren Nutzungsbedingungen prüfen.
- [ ] **ASK / Mistral** (optional): ASK als unabhängige Prüfinstanz, Mistral als zusätzliche Stimmen – nur falls gewünscht.

## Nächste Ausbauschritte

- [ ] **App, Schritt 4:** mitlaufendes Transkript, Widget auf dem Startbildschirm (Play und «Anders»), übersichtlichere Android-Auto-Ansicht.
- [ ] **Überraschungen, Schritt 2:** Zeitfenster ohne Zufall, «heute ohne Überraschungen», Lernen pro Überraschungsart aus 👍/👎.
- [ ] **Offline-Puffer ausbauen:** statt der nächsten vier Beiträge 30–60 Minuten Sprache inklusive Stationssound vorladen.
- [ ] Google-Drive-Archiv für 👍-Beiträge und Musikstunden.
- [ ] Später: durchgehender Stream-Modus ohne Spotify (Auto, Lautsprecher) – braucht einen Dienst mit Audio-Werkzeugen, keinen Worker.

## Umgesetzt (Überblick)

- **Programm auf dem Server:** Konfiguration, Timeline, Gedächtnis und Feedback in D1; Produktion über Queue mit Audio in R2; Cron plant nur, solange gehört wird.
- **Inhalte:** Web-Recherche mit Google-Suche oder Feeds; Kurzbeitrag, Dialog, Künstler-/Genre-/Themenstunde, Musikblock; Schlussredaktion, Qualitäts-Jury, Faktencheck; Wetter, Schlagzeilen, Datum; keine Uhrzeiten in vorproduzierten Texten.
- **Bausteine und Tagesplan:** ein Tipp fügt einen Baustein ein; Tagesplan mit Zeitfenstern; Songs zwischen Beiträgen; 🎲 Überraschungen mit Regler; «Mehr dazu»; «Neu von deinen Künstlern».
- **Redaktion:** alle Agenten konfigurierbar (Anweisungen, Freiheit, An/Aus, Stil-Vorlagen, Probeläufe), Qualitätsverlauf, Hinweise aus 👎-Gründen, Verbrauchsübersicht.
- **Android-App (Compose):** Tabs Hören · Programm · Archiv · Studio, Mini-Player, «Jetzt · Gleich · Später», «Anders», Stimmung «Heute», Tagesplan und Studio (mit Hörproben) nativ in der App; Media3-Wiedergabe, Sperrbildschirm, Bluetooth, Android Auto, Spotify-Übergabe, Archiv, Schlafmodus, Transkript, Benachrichtigungen, Stationssound (Jingle-Varianten, Nachrichten-Opener, Klangteppich optional), Live-Übergänge der Moderation kurz vor der Sendung, In-App-Updates, Farbe und Symbol pro Inhaltsart.
- **Spotify:** KI wählt, Spotify sucht; Hörprofil (Top-Künstler, private Playlists) optional verbunden; an die KI gehen davon nur die Namen der Top-Künstler und der Neuerscheinungen.

## Architekturentscheidungen

- KI-generierte Beiträge sind der Kern; jedes Programm hat einen gesprochenen Anteil.
- Dirigent statt Mischpult: Der Server plant und produziert vor, das Gerät spielt eigene Sprache und Spotify strikt abwechselnd, ohne Sprache über Musik.
- Die Android-App ist das Produkt zum Hören und Steuern des Programms; das Studio ist nativ für die Alltagseinstellungen, das Web-Studio (über «Mehr») bleibt die Werkbank für Sendungen, Feeds und Redaktion (30.09.2026). Kein Player und keine Programmansicht mehr im Web (29.09.2026).
- Konfiguration serverseitig in D1, weil der Server ohne offenen Browser produziert.
- Neuerscheinungen (29.09.2026): Die Moderation von «Neu von deinen Künstlern» nennt Künstler und Titel jeder Neuerscheinung; diese Spotify-Metadaten gehen dafür an die KI und die Sprachausgabe. Playlist-Titel bleiben weiterhin bei Spotify.
- Kein Radiowecker (verworfen am 29.09.2026).
- Mehrere Hörer (30.09.2026): jede weitere Person bekommt ein eigenes Access-Token und einen eigenen Sender (`LISTENERS`); ein Kinder-Sender (`:kids`) folgt festen Regeln für 11-Jährige und spielt keine Songs mit expliziten Texten.
- Keine Sendeuhr mit festen Zeitfenstern pro Stunde: das Programm spielt frei (29.09.2026). Übergänge entstehen live kurz vor der Sendung; vorproduzierte Texte bleiben ohne Uhrzeit.
- Hosting auf Cloudflare (Worker, D1, R2, Queues, Cron, Access); keine Graph- oder Vektordatenbank.
- Details: [docs/architecture.md](docs/architecture.md).
