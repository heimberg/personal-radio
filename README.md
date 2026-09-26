# Personal Radio

Mobile-first personal radio prototype with ASK/Mistral short segments and an optional Gemini two-host podcast pipeline.

**Status: feasibility prototype, not a working AI radio station.** The public Pages demo plays generated test tones or user-selected local audio and includes a local simulation of interest-based topic ranking and thumbs feedback. It calls no paid API and contains no live news. Screen-off playback was confirmed on the tested Android device; the broader device/headset/network acceptance matrix is not recorded. Spotify is deliberately not connected.

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
- Editable initial profile with custom interests and a user-controlled exploration rate.
- Public demo topic cards to try interest ranking and thumbs feedback locally; example cards are not news and make no network requests.
- Private app logic for thumbs/skip/completion learning and time-decayed weights; public test tones have no inferred topic and do not update those playback signals.
- Server-only ASK and Mistral adapters with mocked contract tests, timeouts and segment limits.
- Server-side segment orchestration foundation: required verifier port, source/script limits, per-process daily TTS character budget, concurrency bound and in-flight duplicate coalescing. Not exposed to the app; budget is not durable or cross-instance.
- Cloudflare Worker API foundation with Access JWT validation, ASK claim/evidence verification and atomic D1 daily request/TTS quotas. Requires account setup and provider secrets; not deployed or connected to the Pages demo.
- User-entered RSS/Atom feeds with bounded server retrieval; the app compares saved feeds, ranks entries against interests and learned preferences, and preselects a match.
- Optional Gemini dialog generation and two-speaker TTS, keeping source evidence verification in ASK and all API credentials in Worker secrets.
- PWA manifest, Android install icons and a service worker that caches only the static app shell.
- GitHub Actions type checks, tests, build and a downloadable web build artifact.

## Not included yet

Persistent jobs/audio cache, semantic feed classification, autonomous scheduled generation and native Android playback. The private Worker deployment is not set up; the GitHub Pages demo remains public and does not call this API. The feed loader requires the private Worker. Reloading loses the audio queue and playback position; local files must be selected again. Local blob audio does not test streaming/network resilience.

## Next decisions

1. Set up the private Cloudflare Worker and Access policy using [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).
2. Verify that the authorized ASK endpoint accepts outbound HTTPS from Cloudflare Workers; keep its key in Worker secrets.
3. Configure provider secrets, including Gemini for two-host podcasts, and run a short paid quality check after setting the daily usage caps.
4. Complete the remaining Android acceptance checks in [docs/android-test.md](docs/android-test.md).
5. Configure the private Spotify app: add the Spotify Client ID as the GitHub repository variable `SPOTIFY_CLIENT_ID`, register the private Worker URL as a redirect URI, then test PKCE login, playlist playback and screen-off behavior on Android. Spotify metadata and listening behavior are not sent to AI or used for profile learning in this first slice.

See [architecture and roadmap](docs/architecture.md) and [deployment](docs/deployment.md).
See [private Cloudflare deployment](docs/cloudflare-deployment.md) for account and secret setup.

## Privacy

Do not commit keys, private profiles, exports or generated personal audio. `.env.example` contains placeholders only. A voice supplied to Mistral must be authorized for that use. The prototype has no telemetry and no backend. Reset device preferences in “Mein Programm”. Close the tab to release selected audio; delete downloaded logs manually.

No project license has been selected yet; public visibility alone does not grant an open-source license.
