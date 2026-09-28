# Personal Radio – nächste Schritte

Stand: 28.09.2026. Das Programm läuft auf dem privaten Worker; gehört wird in der Android-App, Spotify-Übergaben funktionieren.

## Matthias

- [x] **Android-App einrichten** (Anleitung: [`docs/android.md`](docs/android.md)): Access-Service-Token erstellen, in der Access-Anwendung eine «Service Auth»-Regel dafür ergänzen, Client-ID als Worker-Secret `ACCESS_SERVICE_TOKEN_ID` setzen, APK aus «Actions → Android app» installieren und verbinden. Optional: Signierschlüssel als Repository-Secrets, damit Updates ohne Neuinstallation gehen.
- [x] **Gemini als Hauptanbieter:** `GEMINI_API_KEY` eines Google-Projekts mit aktivierter Abrechnung (bezahlter Tarif) als Worker-Secret setzen. ASK ist optional und prüft dann als unabhängiges zweites Modell.
- [x] **Vor dem nächsten Deploy (Meilenstein 1):** R2-Bucket `personal-radio-audio` und Queue `personal-radio-production` anlegen (im Cloudflare-Dashboard oder per Wrangler); Variablen und Secrets nur im Dashboard pflegen, `wrangler.toml` setzt keine `[vars]` mehr; den `CLOUDFLARE_API_TOKEN` um R2- und Queues-Rechte erweitern; Workers-Paid-Plan prüfen; `DAILY_GENERATIONS` an die gewünschte Hördauer anpassen (2-Minuten-Beiträge: ca. 30 pro Stunde). Danach in der App «Einstellungen dieses Geräts übernehmen».

- [x] **Cloudflare bereitstellen:** Cloudflare-Konto verwenden, D1-Datenbank anlegen und die zurückgegebene Datenbank-ID in `wrangler.toml` einsetzen. Anleitung: [`docs/cloudflare-deployment.md`](docs/cloudflare-deployment.md).
- [x] **GitHub-Deploy-Zugang einrichten:** Repository-Secrets `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID` hinterlegen. Der Token braucht Worker-Script- und D1-Rechte.
- [x] **Privaten Zugang festlegen:** Cloudflare Access für die Worker-Adresse aktivieren, nur die eigene E-Mail erlauben und Team-Domain sowie Application Audience bereithalten.
- [ ] **ASK erreichbar machen:** HTTPS-Basis-URL und API-Key für das gewünschte Modell bereitstellen und sicherstellen, dass Cloudflare Workers den ASK-Endpunkt erreichen darf.
- [ ] **Sprachausgabe freischalten:** Mistral-API-Key und eine für diesen Zweck autorisierte Stimme bereitstellen.
- [x] **Gemini aktivieren:** Gemini-API-Key bereitstellen und ein kleines Testbudget festlegen. Gemini wird nur für Dialogskript und Zwei-Stimmen-TTS im Podcast-Modus aufgerufen.
- [x] **Spotify-App konfigurieren:** Spotify Developer Client ID als GitHub-Repository-Variable `SPOTIFY_CLIENT_ID` setzen und die private Worker-URL exakt als Redirect URI in der Spotify-App erlauben. Nur die Client ID, kein Client Secret, in die private Frontend-Build-Variable geben.
- [ ] **Feeds auswählen:** Gewünschte RSS/Atom-Feeds in der App eintragen und deren Nutzungsbedingungen/Rechte prüfen.
- [x] **Android-Abnahme:** Nach dem privaten Deployment Screen-aus-Wiedergabe, Pause/Resume, Skip, Daumenfeedback, Netzwechsel und erneutes Öffnen getestet; Matthias bestätigt am 28.09.2026, dass alles soweit in Ordnung ist. Gerätedetails und Einzelbeobachtungen noch nicht dokumentiert.

> Schlüssel bitte ausschliesslich als Cloudflare Worker-Secrets bzw. GitHub Actions-Secrets erfassen, nie hier im Chat oder im Repository.

## Codex

- [x] **Änderungen in den Draft-PR übernehmen:** Implementierung, Dokumentation und TODO auf `feat/ai-segment-pipeline` aktualisiert; PR bleibt Draft.
- [x] **GitHub Actions abwarten und Fehler beheben:** TypeScript, 40 Unit-/Worker-Tests, 6 Browser-E2E-Tests, Build und Wrangler-Dry-Run sind für Commit `a39ab9c` erfolgreich.
- [x] **Nach Matthias' Cloudflare-Einrichtung deployen:** D1-Migrationen und privaten Worker über den Workflow ausrollen; Access-Schutz und API-Authentisierung prüfen.
- [ ] **Live-KI-Test durchführen:** Einen kurzen ASK/Mistral-Beitrag und einen Gemini-Zwei-Stimmen-Podcast mit echten Quellen testen; Audio, Latenz, Fehlerfälle und Kostenobergrenzen prüfen.
- [x] **Android-Test mit dem echten Backend begleiten:** Wiedergabe bei gesperrtem Bildschirm und Verhalten bei Verbindungsabbrüchen prüfen; nötige Korrekturen umsetzen.

## Pflicht-Anforderungen

- **Eine App auf Android:** Hören, Feedback und Einstellungen in einer einzigen App. Spotify muss installiert und angemeldet sein, wird aber von unserer App im Hintergrund gesteuert.
- **KI-generierter Sprechanteil in jedem Programm:** Ohne mindestens eine aktive Sprechsendung wird die Konfiguration abgelehnt; Musikblöcke bekommen immer eine generierte Moderation.

## Nächste Meilensteine

- [x] Meilenstein 1 – Programm auf dem Server: Konfiguration, Timeline, Feedback und Gedächtnis in D1; Produktion über Cloudflare Queue mit Audio in R2; Cron plant nur, solange du zuhörst; Timeline-API und Programm-Panel mit durchgehender Wiedergabe im Browser. Dazu Moderations-Persona (Name, Ton, Stil, eigene Anweisungen, Co-Host für Dialoge) und YAML-Editor für die ganze Konfiguration.
- [x] Meilenstein 2 (gebaut, Abnahmetest auf dem Gerät offen) – Die eine Android-App (Kotlin, Media3) spielt die Timeline mit eigenen Segmenten; Einstellungen als eingebettetes Cockpit (WebView, Login per Access-Einmal-PIN); Zugang zur API per Service Token; 60-Minuten-Test bei gesperrtem Bildschirm.
- [x] Meilenstein 3 – Spotify in der App über App Remote SDK; Musikblöcke mit Moderations-Triggern (Blockstart/-ende, vor/nach jedem N-ten Titel, alle X Minuten, Gruppenwechsel); KI-Titelwahl mit Anmoderation nur für KI-gewählte Titel; eigene Playlists als rotierende Gruppen mit allgemeinen Überleitungen; harte Übergaben ohne Überlappung, kein Abschneiden von Titeln.
- [ ] Meilenstein 4 – Tools pro Sendung (Wetter über Open-Meteo, Schlagzeilen, MCP-Server) mit Platzhaltern im Prompt; Themen-Gedächtnis der letzten Beiträge; ElevenLabs als weitere Stimme; Formular-Editoren neben YAML; Musikregeln.
- [x] Gemini als Standard-Textanbieter (ASK optional pro Sendung und als Prüfinstanz), Web-Recherche mit Google-Suche (`sourceMode: web`), Suchanfragen und Quellen im Cockpit, Themen-Gedächtnis.
- [x] **Künstler-Stunde aktivieren:** im Cloudflare-Dashboard `SPOTIFY_CLIENT_ID` (Variable) und `SPOTIFY_CLIENT_SECRET` (Secret) der Spotify-Developer-App setzen; im Cockpit «Künstler-Stunde» wählen und «Jetzt produzieren».
- [x] **Spotify-Developer-App für die Android-App:** (Signierschlüssel ist hinterlegt, SHA1 im CI-Log) in der Spotify-Developer-App unter «Android packages» den Paketnamen `ch.heimberg.radio` mit dem SHA1-Fingerprint des Schlüssels eintragen und die Redirect-URI `personal-radio://spotify-callback` ergänzen.
- [x] Musik zwischen den Beiträgen: KI wählt nach Musikgeschmack und 👍/👎, Spotify spielt, kurze Ansage; mindestens N Songs nach jedem Wortbeitrag.
- [ ] **Musik einschalten:** Einstellungen → Musik → Songs zwischen Beiträgen (1–3) und Musikgeschmack setzen, speichern. Tageslimit `DAILY_TTS_CHARACTERS` bei Bedarf erhöhen (Ansagen kosten Zeichen).
- [ ] **Spotify-Hörprofil verbinden:** im Spotify-Dashboard die Redirect-URI `https://<worker-adresse>/api/spotify/callback` ergänzen; im Cockpit Einstellungen → Musik → «Mit Spotify verbinden».
- [x] Visuelle Timeline: Punkte verschieben (↑/↓, am Desktop ziehen), entfernen, «Mischen» (mindestens ein Song zwischen Beiträgen, fehlende Songs werden ergänzt), «+ Song»; die App übernimmt die Reihenfolge beim nächsten Abgleich.
- [x] Lebendige Stimme: Gemini-Stimmen (z. B. Laomedeia, Puck, Fenrir) mit Sprechstil der Persona; Texte werden fürs Ohr geschrieben.
- [ ] **Stimme umstellen:** Einstellungen → Sender und Moderation → Stimme (z. B. «Laomedeia · aufgestellt (Gemini)») und Sprechstil wählen, speichern.
- [x] Webseite aufgeräumt: Test-, Demo- und Einzelbeitrags-Oberflächen entfernt; Programm, grafische Einstellungen und YAML.
- [x] GitHub Pages im Repository ausschalten (Settings → Pages), die öffentliche Demo gibt es nicht mehr.
- [x] Genre- und Themenstunden (`genre_hour`, `theme_hour`): Genre-Geschichte in Songs; Themen in Kapiteln mit passenden Songs dazwischen.
- [x] Spotify in der App (Schritt B): App Remote, Übergabe zwischen Moderation und Song, «Spotify verbinden».
- [x] **Übergabe testen:** Künstler-Stunde produzieren, in der App «Spotify verbinden», eine Stunde mit gesperrtem Bildschirm hören (Übergaben, Pause/Weiter auf dem Sperrbildschirm, Anruf).
- [x] Künstler-Stunde auf dem Server (Schritt A): Dossier, KI-Songauswahl, Spotify-Suche, Moderationen, stückweise Vertonung, Songliste im Cockpit, «Jetzt produzieren».
- [x] Künstler-Stunde in der App hören (Schritt B): Spotify App Remote in der Android-App, Übergabe zwischen Moderation und Song ohne Überlappung.
- [ ] Google-Drive-Archiv für 👍-Beiträge und Künstler-Stunden (Audio, Skript, Quellen). Wiedergabe bleibt auf R2.
- [x] Musikblöcke (Format «Musikblock»): Gruppen aus eigenen Spotify-Playlists oder KI-Auswahl nach Geschmack, Wechsel nach X Songs/Minuten, Moderation zu Blockbeginn/-ende, vor/nach jedem N-ten KI-Song, alle X Minuten und beim Gruppenwechsel. Playlist-Titel gehen nie an die KI.
- [ ] **Musikblock ausprobieren:** Einstellungen → Sendungen → «Musikblock» hinzufügen, Playlist-Links einfügen, in ein Zeitfenster nehmen oder im Programm «Jetzt produzieren». Für private Playlists im Cockpit Spotify einmal neu verbinden (Einstellungen → Musik), damit die Playlist-Berechtigung dazukommt; ohne das liest der Worker nur öffentliche Playlists.
- [ ] Später: durchgehender Stream-Modus ohne Spotify (Auto, Lautsprecher).

## Architekturentscheidungen übernommen (Stand 27.09.2026, Details in docs/architecture.md)

- KI-generierte Beiträge sind der Kern; volle Personalisierung über editierbare Sendungen, Sendeuhr und Musikregeln.
- Dirigent statt Mischpult: Backend plant und produziert eine Timeline, das Gerät spielt eigene Segmente und Spotify strikt abwechselnd.
- Eine native Android-App mit eingebettetem Cockpit; das Spotify Web Playback SDK läuft nicht in mobilen Browsern und bleibt Desktop-Option.
- Übernommen aus ai-radio-station (MIT): Segment-Trigger, Playlist-Gruppen, Persona, YAML, Tools/MCP, Themen-Gedächtnis. Nicht übernommen: Ducking (Sprache über Musik), Spotify-Metadaten an die KI, librespot, Wiedergabe über Rechner-Lautsprecher.
- Konfiguration serverseitig in D1 statt local-first, weil das Backend ohne offenen Browser produziert.
- Spotify-Daten fliessen nie zur KI: KI → Spotify-Suche, nicht umgekehrt.
- Prüfstrenge pro Sendung: streng (Zitatprüfung), leicht oder aus.
- Hosting bleibt Cloudflare (Worker, D1, R2, Queues, Cron, Access). Keine Graph- oder Vektordatenbank zum Start.

## Bereits geprüft

- [x] Mobile-first Audio-Prototyp; Bildschirm-aus-Wiedergabe wurde auf dem Android-Gerät des Nutzers bestätigt.
- [x] Lokal: `npm test` (40 Tests), `npm run build` und `npx wrangler deploy --dry-run` erfolgreich.
- [x] PR #10: GitHub Actions für die Erweiterung erfolgreich; der mehrdeutige Feed-Testselektor wurde korrigiert.
