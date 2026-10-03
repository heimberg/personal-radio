# Personal Radio – Stand und nächste Schritte

Stand: 03.10.2026. Das Programm läuft auf dem privaten Worker, gehört wird in der Android-App, Musik kommt über Spotify. Jeder Merge nach `main` deployt den Worker und veröffentlicht die App als In-App-Update. Einrichtung von Grund auf: [README](README.md#run-your-own-station).

> Schlüssel ausschliesslich als Cloudflare-Worker-Secrets bzw. GitHub-Actions-Secrets erfassen, nie im Chat oder im Repository.

## Für Matthias

- [ ] **Sender für die Tochter:** Service-Token anlegen, in die Access-Regel aufnehmen, `LISTENERS` setzen, App auf ihrem Handy einrichten (README, Schritt 11).

- [ ] **Neues Design «Magazin» ansehen:** helles Theme, fünf Rubrik-Farben, ein einziger Knopf «＋ Einfügen» unten rechts im Programm («Für dich», Song, Thema verfolgen, Suche, Rubriken, ⭐ Favoriten), der grosse farbige Player auf «Hören». 1–2 Screenshots schicken, was noch nicht sitzt.
- [ ] **Neue App ausprobieren:** Tabs Hören · Programm · Archiv · Studio, Mini-Player, «Anders», Wischen und langes Drücken im Programm; 1–2 Screenshots schicken, damit nachgeschärft werden kann.
- [ ] **Stimmen ausprobieren:** im Studio unter «Stimme» eine Stimme entwerfen («✨ Entwerfen») oder die eigene klonen («🎤 Meine Stimme»); auf Lachen, Pausen und Zwischenrufe in Dialogen hören.
- [ ] **Neues Studio ausprobieren:** alles in der App – Sender, Stimme, Ort, Interessen, Musik, Stationssound, dazu jetzt auch Sendungen, Feeds, Redaktion (mit Probelauf), Qualität, Verbrauch und das Spotify-Hörprofil. Das Web-Studio gibt es nicht mehr.
- [ ] **Familie ausprobieren:** Sobald Leas Token in `LISTENERS` steht, erscheint der Tab «Familie»: Chat, «Teilen mit Lea» im Beitragsmenü, «💌 Gruss» (liest die Moderation bei ihr vor), «🎧 Auch hören». Optional `OWNER_NAME` setzen (Standard «Papa»).
- [ ] **Funktionen aufräumen:** Studio → «Funktionen»: ausschalten, was du nicht brauchst, und Bausteine ausblenden. Ortsgeschichten einschalten (fragt nach dem Standort) und mit offener App unterwegs testen.
- [ ] **Nachfragen und Dranbleiben ausprobieren:** im Player «Nachfragen»; lange drücken auf einen Beitrag → «Dranbleiben» (Themen im Programm); «Merken» füllt die Leseliste im Archiv. Konzerte kommen freitags, wenn Spotify verbunden ist.
- [ ] **Wochenrückblick prüfen:** Sonntagmorgen kommt er von selbst ins Programm; vorher im Programm «Wochenrückblick» antippen.
- [ ] **Mitmachen mit Nina ausprobieren:** im Programm «Mitmach-Geschichte» antippen, Bildkarten wählen; am Ende jeder Folge auf «Hören» wählen, wie es weitergeht. «❓ Frag das Radio» (Tippen oder 🎤) – die Antwort kommt im nächsten Übergang. Quizfragen nach Wissensbeiträgen und das Sticker-Album unter «Hören».
- [ ] **Serien ausprobieren:** im Programm «Wissensserie» (z. B. «Geschichte des Internets») oder «Fortsetzungsgeschichte» antippen; die nächste Folge kommt, sobald die vorige gehört ist. Für die Tochter: eine Gutenachtgeschichte als Fortsetzungsgeschichte.
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
- **Familie:** Tab mit allen Hörern des Workers, «hört gerade», Chat mit Benachrichtigung, Beiträge teilen (Kopie mit Audio ins Programm der anderen), «Auch hören», Grüsse, die die Moderation im nächsten Übergang vorliest; Kinder-Sender nehmen nur, was der Besitzer teilt.
- **Funktionen und neue Formate:** Studio-Karte «Funktionen» (alle Automatiken mit Kosten an/aus, Bausteine ein-/ausblenden); Streitgespräch (Pro/Contra mit Quellen), Weltpresse, Ortsgeschichten unterwegs (Standort nur bei offener App, aus per Standard).
- **Nachfragen, Dranbleiben, Merken, Konzerte:** Frage zum laufenden Beitrag (Antwort direkt danach, aus seinen Quellen), bis zu fünf Themen täglich geprüft (nur bei Neuem ein Beitrag), Leseliste im Archiv zum Teilen, freitags Konzerte der Spotify-Top-Künstler in der Schweiz.
- **Wochenrückblick:** sonntags ab 8 Uhr automatisch (mind. drei gehörte Wortbeiträge), sonst als Baustein; aus Gehörtem, Fragen ans Radio, Mitmach-Entscheidungen und Stickern, ohne Musikdaten.
- **Mitmachen:** Mitmach-Geschichte mit Wahl am Ende jeder Folge (Bildkarten zum Start, nach 3 h wählt die Erzählerin), Quiz nach Wissensbeiträgen im Kinder-Sender, Sticker-Album (50 Sticker), «Frag das Radio» mit Antwort im nächsten Übergang.
- **Serien:** Wissensserie (Dialog mit Recherche) und Fortsetzungsgeschichte (erfunden, nach Plan) in fünf Folgen, mit «Was bisher geschah» und Ausblick; die nächste Folge kommt, sobald die vorige gehört ist; «Beenden» im Programm.
- **Bausteine und Tagesplan:** ein Tipp fügt einen Baustein ein; Tagesplan mit Zeitfenstern; Songs zwischen Beiträgen; 🎲 Überraschungen mit Regler; «Mehr dazu»; «Neu von deinen Künstlern».
- **Redaktion:** alle Agenten konfigurierbar (Anweisungen, Freiheit, An/Aus, Stil-Vorlagen, Probeläufe), Qualitätsverlauf, Hinweise aus 👎-Gründen, Verbrauchsübersicht.
- **Android-App (Compose):** Tabs Hören · Programm · Archiv · Studio, Mini-Player, «Jetzt · Gleich · Später», «Anders», Stimmung «Heute», Tagesplan und Studio (mit Hörproben) nativ in der App; Media3-Wiedergabe, Sperrbildschirm, Bluetooth, Android Auto, Spotify-Übergabe, Archiv, Schlafmodus, Transkript, Benachrichtigungen, Stationssound (Jingle-Varianten, Nachrichten-Opener, Klangteppich optional), Live-Übergänge der Moderation kurz vor der Sendung, In-App-Updates, Farbe und Symbol pro Inhaltsart.
- **Spotify:** KI wählt, Spotify sucht; Hörprofil (Top-Künstler, private Playlists) optional verbunden; an die KI gehen davon nur die Namen der Top-Künstler und der Neuerscheinungen.

## Architekturentscheidungen

- KI-generierte Beiträge sind der Kern; jedes Programm hat einen gesprochenen Anteil.
- Dirigent statt Mischpult: Der Server plant und produziert vor, das Gerät spielt eigene Sprache und Spotify strikt abwechselnd, ohne Sprache über Musik.
- Nur die Android-App (03.10.2026): Hören, Programm und alle Einstellungen – auch Sendungen, Feeds und Redaktion – sind nativ; das Web-Studio ist entfernt, der Worker bedient nur die API.
- Konfiguration serverseitig in D1, weil der Server ohne offene App produziert.
- Neuerscheinungen (29.09.2026): Die Moderation von «Neu von deinen Künstlern» nennt Künstler und Titel jeder Neuerscheinung; diese Spotify-Metadaten gehen dafür an die KI und die Sprachausgabe. Playlist-Titel bleiben weiterhin bei Spotify.
- Kein Radiowecker (verworfen am 29.09.2026).
- Familie (01.10.2026): alles bleibt auf dem privaten Worker; die Familie sieht nur Namen. Geteilt wird eine Kopie mit Audio, nicht neu produziert. In einen Kinder-Sender teilt nur der Besitzer.
- Mitmachen (01.10.2026): Fragen gehen mit dem Vornamen an die KI und stehen im Familien-Chat; Quiz nur im Kinder-Sender; Sticker sind reine Emoji, keine Bilder von der KI.
- Serien (01.10.2026): Folgen ohne feste Sendezeit; die nächste kommt, sobald die vorige gehört ist. Geschichten sind als Fiktion gekennzeichnet und ohne Faktencheck (`off`), Wissensfolgen werden wie Hintergrund geprüft (`light`).
- Mehrere Hörer (30.09.2026): jede weitere Person bekommt ein eigenes Access-Token und einen eigenen Sender (`LISTENERS`); ein Kinder-Sender (`:kids`) folgt festen Regeln für 11-Jährige und spielt keine Songs mit expliziten Texten.
- Keine Sendeuhr mit festen Zeitfenstern pro Stunde: das Programm spielt frei (29.09.2026). Übergänge entstehen live kurz vor der Sendung; vorproduzierte Texte bleiben ohne Uhrzeit.
- Hosting auf Cloudflare (Worker, D1, R2, Queues, Cron, Access); keine Graph- oder Vektordatenbank.
- Details: [docs/architecture.md](docs/architecture.md).
