# Personal Radio – nächste Schritte

Stand: 26.09.2026. Die öffentliche GitHub-Pages-Demo ist weiterhin nur ein Audio-Prototyp. Die folgenden KI- und Personalisierungsfunktionen sind vorbereitet und lokal geprüft, aber noch nicht live verfügbar.

## Matthias

- [ ] **Cloudflare bereitstellen:** Cloudflare-Konto verwenden, D1-Datenbank anlegen und die zurückgegebene Datenbank-ID in `wrangler.toml` einsetzen. Anleitung: [`docs/cloudflare-deployment.md`](docs/cloudflare-deployment.md).
- [ ] **GitHub-Deploy-Zugang einrichten:** Repository-Secrets `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID` hinterlegen. Der Token braucht Worker-Script- und D1-Rechte.
- [ ] **Privaten Zugang festlegen:** Cloudflare Access für die Worker-Adresse aktivieren, nur die eigene E-Mail erlauben und Team-Domain sowie Application Audience bereithalten.
- [ ] **ASK erreichbar machen:** HTTPS-Basis-URL und API-Key für das gewünschte Modell bereitstellen und sicherstellen, dass Cloudflare Workers den ASK-Endpunkt erreichen darf.
- [ ] **Sprachausgabe freischalten:** Mistral-API-Key und eine für diesen Zweck autorisierte Stimme bereitstellen.
- [ ] **Gemini aktivieren:** Gemini-API-Key bereitstellen und ein kleines Testbudget festlegen. Gemini wird nur für Dialogskript und Zwei-Stimmen-TTS im Podcast-Modus aufgerufen.
- [ ] **Feeds auswählen:** Gewünschte RSS/Atom-Feeds in der App eintragen und deren Nutzungsbedingungen/Rechte prüfen.
- [ ] **Android-Abnahme:** Nach dem privaten Deployment Screen-aus-Wiedergabe, Pause/Resume, Skip, Daumenfeedback, Netzwechsel und erneutes Öffnen testen. Die bisherige Bestätigung gilt nur für den Audio-Prototyp mit lokalem Audio.

> Schlüssel bitte ausschliesslich als Cloudflare Worker-Secrets bzw. GitHub Actions-Secrets erfassen, nie hier im Chat oder im Repository.

## Codex

- [ ] **Änderungen in den Draft-PR übernehmen:** Implementierung, Dokumentation und 40 Unit-/Worker-Tests auf `feat/ai-segment-pipeline` aktualisieren; PR bleibt Draft.
- [ ] **GitHub Actions abwarten und Fehler beheben:** Browser-E2E, TypeScript, Unit-Tests, Build und Wrangler-Dry-Run müssen grün sein.
- [ ] **Nach Matthias' Cloudflare-Einrichtung deployen:** D1-Migrationen und privaten Worker über den Workflow ausrollen; Access-Schutz und API-Authentisierung prüfen.
- [ ] **Live-KI-Test durchführen:** Einen kurzen ASK/Mistral-Beitrag und einen Gemini-Zwei-Stimmen-Podcast mit echten Quellen testen; Audio, Latenz, Fehlerfälle und Kostenobergrenzen prüfen.
- [ ] **Android-Test mit dem echten Backend begleiten:** Wiedergabe bei gesperrtem Bildschirm und Verhalten bei Verbindungsabbrüchen prüfen; nötige Korrekturen umsetzen.

## Später gemeinsam entscheiden

- [ ] Spotify-Integration und zulässige Wiedergabe-/Nutzungsbedingungen klären, bevor Musik eingebunden wird.
- [ ] Dauerhafte Audio-/Job-Warteschlange und automatische, zeitgesteuerte Beitragsproduktion planen.
- [ ] PWA-Installation und Offline-Verhalten auf dem echten privaten Deployment abnehmen.

## Bereits geprüft

- [x] Mobile-first Audio-Prototyp; Bildschirm-aus-Wiedergabe wurde auf dem Android-Gerät des Nutzers bestätigt.
- [x] Lokal: `npm test` (40 Tests), `npm run build` und `npx wrangler deploy --dry-run` erfolgreich.
- [x] PR #10: GitHub Actions für den bisherigen PR-Stand erfolgreich. Die aktuelle lokale Erweiterung ist darin noch nicht enthalten.
