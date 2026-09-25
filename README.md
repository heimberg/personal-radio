# Personal Radio

Mobile-first personal audio application with a planned ASK editorial pipeline and Mistral speech synthesis.

**Status: feasibility prototype, not a working AI radio station.** The Pages demo plays generated test tones or user-selected local audio and calls no paid API. The user has confirmed screen-off playback works on the tested Android device; the broader device/headset/network acceptance matrix is not recorded. Spotify is deliberately not connected.

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
- Cloudflare Worker API foundation with Access JWT validation, ASK claim/evidence verification and atomic D1 daily request/TTS quotas. Requires account setup and provider secrets; not deployed or connected to the Pages demo.
- GitHub Actions type checks, tests, build and a downloadable web build artifact.

## Not included yet

Source ingestion, persistent jobs/audio cache, adaptive learning, PWA/service worker and native Android playback. The private Worker deployment is not set up; the GitHub Pages demo remains public and does not call this API. Reloading loses the audio queue and playback position; local files must be selected again. Local blob audio does not test streaming/network resilience.

## Next decisions

1. Set up the private Cloudflare Worker and Access policy using [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).
2. Verify that the authorized ASK endpoint accepts outbound HTTPS from Cloudflare Workers; keep its key in Worker secrets.
3. Choose a Mistral voice and run a short paid, explicitly enabled quality check.
4. Complete the remaining Android acceptance checks in [docs/android-test.md](docs/android-test.md).
5. Resolve Spotify terms before building integrated music/moderation playback. Use suitable licensed/self-owned audio for the feasibility test.

See [architecture and roadmap](docs/architecture.md) and [deployment](docs/deployment.md).
See [private Cloudflare deployment](docs/cloudflare-deployment.md) for account and secret setup.

## Privacy

Do not commit keys, private profiles, exports or generated personal audio. `.env.example` contains placeholders only. A voice supplied to Mistral must be authorized for that use. The prototype has no telemetry and no backend. Reset device preferences in “Mein Programm”. Close the tab to release selected audio; delete downloaded logs manually.

No project license has been selected yet; public visibility alone does not grant an open-source license.
