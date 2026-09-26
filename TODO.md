# Personal Radio – nächste Schritte

Stand: 26.09.2026. Die öffentliche GitHub-Pages-Demo ist weiterhin nur ein Audio-Prototyp. Die folgenden KI- und Personalisierungsfunktionen sind vorbereitet und lokal geprüft, aber noch nicht live verfügbar.

## Matthias

- [ ] **Cloudflare bereitstellen:** Cloudflare-Konto verwenden, D1-Datenbank anlegen und die zurückgegebene Datenbank-ID in `wrangler.toml` einsetzen. Anleitung: [`docs/cloudflare-deployment.md`](docs/cloudflare-deployment.md).
- [ ] **GitHub-Deploy-Zugang einrichten:** Repository-Secrets `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID` hinterlegen. Der Token braucht Worker-Script- und D1-Rechte.
- [ ] **Privaten Zugang festlegen:** Cloudflare Access für die Worker-Adresse aktivieren, nur die eigene E-Mail erlauben und Team-Domain sowie Application Audience bereithalten.
- [ ] **ASK erreichbar machen:** HTTPS-Basis-URL und API-Key für das gewünschte Modell bereitstellen und sicherstellen, dass Cloudflare Workers den ASK-Endpunkt erreichen darf.
- [ ] **Sprachausgabe freischalten:** Mistral-API-Key und eine für diesen Zweck autorisierte Stimme bereitstellen.
- [ ] **Gemini aktivieren:** Gemini-API-Key bereitstellen und ein kleines Testbudget festlegen. Gemini wird nur für Dialogskript und Zwei-Stimmen-TTS im Podcast-Modus aufgerufen.
- [ ] **Spotify-App konfigurieren:** Spotify Developer Client ID als GitHub-Repository-Variable `SPOTIFY_CLIENT_ID` setzen und die private Worker-URL exakt als Redirect URI in der Spotify-App erlauben. Nur die Client ID, kein Client Secret, in die private Frontend-Build-Variable geben.
- [ ] **Feeds auswählen:** Gewünschte RSS/Atom-Feeds in der App eintragen und deren Nutzungsbedingungen/Rechte prüfen.
- [ ] **Android-Abnahme:** Nach dem privaten Deployment Screen-aus-Wiedergabe, Pause/Resume, Skip, Daumenfeedback, Netzwechsel und erneutes Öffnen testen. Die bisherige Bestätigung gilt nur für den Audio-Prototyp mit lokalem Audio.

> Schlüssel bitte ausschliesslich als Cloudflare Worker-Secrets bzw. GitHub Actions-Secrets erfassen, nie hier im Chat oder im Repository.

## Codex

- [x] **Änderungen in den Draft-PR übernehmen:** Implementierung, Dokumentation und TODO auf `feat/ai-segment-pipeline` aktualisiert; PR bleibt Draft.
- [x] **GitHub Actions abwarten und Fehler beheben:** TypeScript, 40 Unit-/Worker-Tests, 6 Browser-E2E-Tests, Build und Wrangler-Dry-Run sind für Commit `a39ab9c` erfolgreich.
- [ ] **Nach Matthias' Cloudflare-Einrichtung deployen:** D1-Migrationen und privaten Worker über den Workflow ausrollen; Access-Schutz und API-Authentisierung prüfen.
- [ ] **Live-KI-Test durchführen:** Einen kurzen ASK/Mistral-Beitrag und einen Gemini-Zwei-Stimmen-Podcast mit echten Quellen testen; Audio, Latenz, Fehlerfälle und Kostenobergrenzen prüfen.
- [ ] **Android-Test mit dem echten Backend begleiten:** Wiedergabe bei gesperrtem Bildschirm und Verhalten bei Verbindungsabbrüchen prüfen; nötige Korrekturen umsetzen.

## Später gemeinsam entscheiden

- [ ] Profilpersistenz implementieren: IndexedDB als lokale Quelle der Wahrheit; Interessen, Feedback-Ereignisse und berechnete Gewichte getrennt speichern; Profil prüfen, zurücksetzen, exportieren und löschen können.
- [ ] Optionalen Konten-/Sync-Bedarf entscheiden. Falls gewünscht: authentifizierter Worker + D1, nur mit aktivierter Synchronisierung. Graph- und Vektordatenbank bleiben bis zu einem belegten Bedarf ausserhalb des MVP.
- [ ] Spotify-Verbindung für das private PWA implementieren: Authorization Code mit PKCE, Spotify Web Playback SDK, vom Nutzer gewählter Playlist-/Kontext und sichere Token-Lebensdauer.
- [ ] Spotify-Wiedergabe mit KI-Sprechbeiträgen auf Android erproben: Spotify vor dem Sprachbeitrag pausieren, danach fortsetzen; nie Audio überlappen. Die öffentliche Pages-Demo darf den Spotify-SDK nicht laden.
- [ ] Spotify-Berechtigungsumfang laut Nutzer: private integrierte Nutzung ist freigegeben. Spotify-Audio, Metadaten und Hörverhalten zunächst nicht an KI-Anbieter senden und nicht fürs Profil-Lernen verwenden.
- [ ] Dauerhafte Audio-/Job-Warteschlange und automatische, zeitgesteuerte Beitragsproduktion planen.
- [ ] PWA-Installation und Offline-Verhalten auf dem echten privaten Deployment abnehmen.

## Architekturentscheidungen übernommen

- Profil lokal zuerst in IndexedDB; Feedback-Rohereignisse getrennt von erklärbaren, daraus berechneten Themengewichten.
- D1 als mögliche spätere SQL-Synchronisierung, nicht als Voraussetzung für lokalen Betrieb.
- Keine Graph- oder Vektordatenbank zum Start.
- Spotify ist die vorgesehene Musikquelle für den privaten integrierten Prototyp; Integration bleibt auf den vom Nutzer bestätigten Freigabeumfang begrenzt.

## Bereits geprüft

- [x] Mobile-first Audio-Prototyp; Bildschirm-aus-Wiedergabe wurde auf dem Android-Gerät des Nutzers bestätigt.
- [x] Lokal: `npm test` (40 Tests), `npm run build` und `npx wrangler deploy --dry-run` erfolgreich.
- [x] PR #10: GitHub Actions für die Erweiterung erfolgreich; der mehrdeutige Feed-Testselektor wurde korrigiert.
