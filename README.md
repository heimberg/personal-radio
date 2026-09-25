# Personal Radio

Mobile-first personal audio application with a planned ASK editorial pipeline and Mistral speech synthesis.

**Status: feasibility prototype, not a working AI radio station.** The browser plays generated test tones or user-selected local audio. No paid API is called. Spotify is deliberately not connected. Android lock-screen reliability has not been established.

## Run

Use Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open the Vite URL. On a phone in the same network, use the displayed network address for a basic playback check. Use HTTPS for the definitive mobile/platform test (Media Session availability can differ). Do not expose the development server publicly.

```sh
npm run check
npm test
npm run build
```

## Included

- Responsive React/TypeScript UI in German with radio, preferences and test views.
- One persistent HTML audio player, queue, repeat, seek, previous/next and Media Session handlers.
- Local, low-volume generated 30-second WAV test segments; local file selection with no upload.
- Bounded playback event log; downloadable JSON with browser information but no filenames/profile.
- Device-local preference storage with corrupt-storage fallback; not yet connected to content selection.
- Server-only ASK and Mistral adapters with mocked contract tests, timeouts and segment limits.
- Server-side segment orchestration foundation: required verifier port, source/script limits, per-process daily TTS character budget, concurrency bound and in-flight duplicate coalescing. Not exposed to the app; budget is not durable or cross-instance.
- GitHub Actions type checks, tests, build and a downloadable web build artifact.

## Not included yet

Server routes, private app login, source ingestion, a substantive editorial verifier, persistent budgets/jobs/database, live provider calls, adaptive learning, hosted deployment, PWA/service worker and native Android playback. Reloading loses the audio queue and playback position; local files must be selected again. Local blob audio does not test streaming/network resilience.

## Next decisions

1. Run the Android test in [docs/android-test.md](docs/android-test.md).
2. Confirm an authorized, HTTPS-accessible ASK endpoint, model and API contract from the intended backend host. Keys belong in server secrets, never browser/VITE variables.
3. Choose a Mistral voice and run a short paid, explicitly enabled contract/quality check.
4. Choose private hosting/access control before deployment. Public source code does not imply a public application.
5. Resolve Spotify terms before building integrated music/moderation playback. Use suitable licensed/self-owned audio for the feasibility test.

See [architecture and roadmap](docs/architecture.md) and [deployment](docs/deployment.md).

## Privacy

Do not commit keys, private profiles, exports or generated personal audio. `.env.example` contains placeholders only. A voice supplied to Mistral must be authorized for that use. The prototype has no telemetry and no backend. Reset device preferences in “Mein Programm”. Close the tab to release selected audio; delete downloaded logs manually.

No project license has been selected yet; public visibility alone does not grant an open-source license.
