# Architecture and implementation plan

Decisions revised 2026-09-27. This replaces the earlier local-first, browser-player plan.

## Goal

A private, single-user radio: tune in and hear a continuous program of AI-generated spoken segments and music that match one person's niche interests. Everything that shapes the program — shows, prompts, sources, voices, schedule, music rules and verification strictness — is user-editable configuration, not code.

## Non-negotiable requirements

These two requirements override every other decision in this document:

1. **One app on Android.** Tuning in, listening, feedback and configuration happen in a single Android app. The user never operates a second app. The Spotify app must be installed and logged in, because the App Remote SDK plays through it, but our app controls it in the background.
2. **AI-generated speech in every program.** Generated spoken segments are the reason the station exists; music alone is not a program. The configuration is rejected without at least one enabled speech show (`parseStationConfig`), and music blocks always carry generated moderation.

## Decisions

1. **AI-generated content is the core.** Short briefs, two-host dialogs, explainers and music moderation are all generated. Existing content (feeds, articles) is source material for generation.
2. **Conductor, not mixer.** Spotify audio cannot be mixed into our own stream: it is DRM-protected and only plays in Spotify's own players. The backend therefore plans and produces a *timeline*; a player on the device executes it, alternating strictly between our segments and Spotify tracks. Never overlap, crossfade or overlay the two.
3. **One native Android app.** Kotlin, Media3 `MediaSessionService` for our segments (reliable screen-off playback) and the Spotify App Remote SDK to control the installed Spotify app. The configuration screens (the cockpit) are embedded in the same app as a WebView of the private Worker, so there is one app and one code base for the settings. Playback never runs in the WebView. The Spotify Web Playback SDK does not support mobile browsers; it stays a desktop-only option.
4. **The web cockpit is the settings surface.** Shows, persona, sources, schedule and music rules are edited as YAML, the timeline shows sources per segment. It runs inside the Android app and, for convenience, in a desktop browser.
5. **Server-side configuration.** A backend that produces without an open browser must know the configuration, so shows, sources, schedule, feedback and memory move from `localStorage` to D1. The device keeps only UI preferences and a playback cache. Export and delete remain available.
6. **Gemini writes, providers stay replaceable.** Gemini is the default text provider for briefs and dialogs and does the web research (Google Search grounding). ASK stays available per show (`textProvider: ask`, OpenAI-compatible) and, when configured, is the independent second model that verifies; without ASK, Gemini verifies. TTS through Mistral (single voice) or Gemini (multi-speaker). Model IDs and voices are configuration; none are hard-coded. Use the paid Gemini tier: on the free tier Google may use prompts and responses to improve its products.
7. **Verification strictness per show.** `strict`: the current ASK quote verifier, every claim needs a verbatim source quote (news). `light`: source-grounded prompt, no second pass (explainers, dialogs). `off`: creative formats without factual claims (moderation, stories), marked as such. The strict verifier rejects explanatory content often, and a rejected draft is already paid for.
8. **Audio lives in R2, Google Drive is an archive.** Playout needs a few hundred MB at most (a 2-minute MP3 is about 2 MB; 7-day retention), well inside R2's free allowance with free egress. Google Drive would need a stored OAuth token (refresh tokens of Google apps in "testing" status expire after 7 days), would route every stream through the Worker and adds latency and quotas. The owner's 2 TB are used later for an archive: liked segments and artist hours are copied to a Drive folder with script and sources.
9. **Stay on Cloudflare**, on the Workers Paid plan (USD 5/month at time of writing), because audio decoding in the Worker can exceed the Free plan's CPU limit. Provider costs (ASK, Mistral, Gemini) are separate and capped by D1 quotas.

## System overview

```
Cloudflare
  Cron Trigger (every 10 min) ── while the owner listens, keeps the timeline filled up to the horizon (default 20 min)
        │
        ▼
  Planner (Worker) ── reads schedule, shows, music rules, memory, feedback from D1
        │ creates timeline items (planned)
        ▼
  Queue consumer (one item per message, one at a time; the item's D1 state drives retries)
        segment:     collect sources → draft (ASK/Gemini) → verify per show policy
                     → store script (state voicing) → reserve budget → TTS → R2 → ready
        music block: LLM picks tracks → resolve via Spotify search (code, no AI)
                     → moderation for resolved tracks only → TTS → R2 → ready
        │
        ▼
  D1: configuration, timeline, jobs, usage, feedback, memory      R2: audio segments
        │
        ▼  Timeline API (Access: service token for the app, login for the cockpit)
        │
Android app (the single app)
· Media3 plays our segments, lock screen and Bluetooth controls
· App Remote plays Spotify URIs, hands over at track end
· prefetches ready segments, reports played/skipped/feedback
· embedded cockpit (WebView): persona, shows, sources, schedule as YAML, timeline
  (the same cockpit also opens in a desktop browser)
```

## Domain model

| Entity | Purpose |
| --- | --- |
| `Station` | Station name and host persona: name, tone, style, own instructions and a co-host name for dialogs. Applies to every generated segment. |
| `Show` | A format: name, prompt template (editable), source selection, text provider/model, voice(s), target length, language/style, verification policy, enabled flag. |
| `Source` | Feed URL, web page or manual note/topic list; weight, blocked terms, fetch interval, owner's rights check. |
| `Schedule` | The program clock: per weekday and time window an ordered list of slots — a show, a music block (n tracks + music rule) or a moderation — plus a speech/music ratio. |
| `MusicRule` | Free-text taste description, genres, eras, seed artists, exclusions, no-repeat window, discovery share. |
| `TimelineItem` | Position, kind (`segment`, `spotify-track`, `moderation`), references, planned time, state `planned → producing → ready → played / skipped / failed / expired`. |
| `Segment` | Script, cited sources, R2 audio key, measured duration, cost, provider/model/prompt versions, verification result. |
| `FeedbackEvent` | like, dislike, skip (with listened ratio), complete, "already known", "go deeper". |
| `Memory` | What was played, covered-story fingerprints for deduplication, series state ("part 3 of …"). |

Explicit configuration always wins over learned weights. The existing learning rules stay: thumbs are strong signals, completion is weakly positive, a skip before 20 % is ignored and a later skip is weakly negative, with a 45-day half-life.

## Program production (implemented, milestone 1)

- **Configuration** is one validated document per owner in D1 (`station_config`): station name, host persona, profile, feeds, shows, schedule, time zone and horizon. The cockpit imports it once from the device and edits it as YAML (multi-line prompts stay readable); the API stores JSON. Documents saved before the persona existed get a default host.
- **Persona** (`host`): every draft is written in the host's voice and tone; in two-host dialogs `host-a` is the host and `host-b` the co-host. Persona and show instructions are owner-written and go into the system prompt; source text never does. `parseStationConfig` rejects unknown references, out-of-range lengths (brief 1–2 min because of the TTS cap, dialog 2–10 min), invalid times and time zones.
- **Planning** (`server/station.ts`, `planTimeline`) runs on every cron tick and on "Jetzt planen". It rotates the enabled shows of the schedule slot that is active at each planned time, stops at the horizon and at 12 new items per tick, and plans nothing outside an active slot.
- **Listener gate:** the cron only plans new content if the owner opened the program or gave feedback within the last 3 hours. Unplayed items expire after 12 hours, so without this gate the station would pay for content nobody hears.
- **Production** runs in a queue consumer, not in the browser request. Each item moves `planned → voicing → ready` (or `failed` / `expired`); a lease in D1 prevents concurrent production. The approved script is stored before speech synthesis, so a TTS retry never pays for a second draft. Transient provider errors back off (10, 20 min) and give up after 3 attempts; rejections and invalid drafts fail permanently; an exhausted daily budget defers the item to the next UTC day. Three failures within an hour pause planning.
- **Sources** come from the show's feeds: articles older than 30 days or already covered are skipped, the rest is ranked with explicit interests and learned weights (ties: newest first). Used articles are recorded in `covered_sources` so they are not retold.
- **Queues instead of Workflows:** the D1 state machine already provides durable steps, and a plain queue handler stays testable with the Node test runner (Workflows require the `cloudflare:workers` runtime module).
- **Audio** lives in R2 under `segments/<item>.mp3|wav`, is served with HTTP range support and is deleted 7 days after playback or on expiry.
- **Feedback** from the player (`complete`, `skip`, thumbs) is stored in D1; server-side learned weights feed the next drafts.

## Web research (implemented)

Shows with `sourceMode: web` need no feed. Production runs two steps:

1. **Research** (`GeminiResearcher`): one Gemini call with the `google_search` tool, the show's `researchPrompt`, the listener's interests, today's date and the recent topics. From the grounding metadata only sentences that Gemini attributes to a search result are kept, grouped by that result; each result becomes a source (`w1`…`w8`, at most 24,000 characters in total). Ungrounded text is discarded. The search queries are stored with the item (`research_json`) and shown in the cockpit as Google search links.
2. **Script** from these sources exactly like from feed articles, followed by the show's verification policy. With `strict`, every claim must quote a grounded sentence.

The two steps keep the script call independent of whether a model supports search and structured output in one request. Grounded requests are billed separately beyond a free daily allowance. Google's terms for grounding with Google Search require showing the search suggestions where grounded results are shown; the cockpit lists the queries as links, which must be checked against the current terms before wider use. Grounding result URLs can be Google redirect links; their titles name the site.

**Topic memory:** every draft and every research request receive the titles of the last 15 produced segments with the instruction not to repeat them.

## Artist hour (next)

A show format `artist_hour` for one hour about one artist or band: individual tracks, and between them generated background on the artist, the band and the songs, grounded in web search.

```yaml
- id: kuenstler-sonntag
  name: Künstler-Stunde
  format: artist_hour
  artist: Portishead          # or pick: interests — the AI chooses from the listener's interests
  tracks: 11
  talkSecondsPerTrack: 60
  instructions: Frühwerk und Einflüsse betonen, keine Chart-Statistiken.
  verification: strict
```

Production, entirely ahead of time:

1. **Dossier:** web research (as above) on biography, periods, albums, the story of individual songs and anecdotes.
2. **Track selection:** the LLM picks about 11 songs across the career with a reason each; the backend resolves them with Spotify search and keeps unambiguous matches only (AI → Spotify; facts come from the web, never from Spotify).
3. **Script:** opening, a 45–90 second moderation before each resolved track, closing — in the host persona, optionally as a dialog with the co-host. Moderation only for tracks that resolved.
4. **Check and voice:** claims are checked against the dossier sources; unsupported sentences are rewritten or dropped. Moderations are voiced to R2.
5. **Timeline:** opening → moderation → Spotify track → moderation → … → closing. About 45 minutes of music and 12–15 minutes of AI speech per hour, which satisfies the speech requirement by construction. One hour needs roughly 10,000–12,000 TTS characters; raise `DAILY_TTS_CHARACTERS` accordingly.

Timeline items gain the kind `spotify-track`. Spotify tracks play on the phone only with the Android app (milestone 3); the hour can be produced and inspected in the cockpit before, and previewed on desktop with the Web Playback SDK.

## Music curation (AI → Spotify only)

No Spotify audio, metadata, search results or listening behaviour are ever sent to an AI provider or used for learning. The data flow goes one way:

1. The LLM picks tracks (artist, title, short reason) from its own knowledge, guided by `MusicRule` and the recent playlist memory (our own records of the LLM's earlier picks).
2. The backend resolves each pick through the Spotify Search API with an app token (client credentials) and accepts it only if a normalized artist/title comparison matches. This comparison is deterministic code. Unmatched picks are dropped.
3. Only then does the LLM write moderation, for resolved picks only, based solely on its own selection. The only information passed forward is which picks resolved.

The planner stores the Spotify URI in the timeline; the app plays it through App Remote.

## Music blocks and moderation triggers (milestone 3)

Adopted from [ai-radio-station](https://github.com/BetaHuhn/ai-radio-station) (MIT), adapted to our constraints. A schedule slot can contain music blocks; moderation segments inside them fire on triggers:

| Trigger | Fires | Context available to the prompt |
| --- | --- | --- |
| `block_start` / `block_end` | when a music block begins or ends | block name, next block name |
| `before_track` / `after_track` | every N tracks | only for AI-picked tracks: the LLM's own pick (artist, title, reason) |
| `interval_minutes` | every X minutes of listening | local time |
| `group_transition` | between playlist groups | group names |

- **Two music sources.** AI picks (resolved as described above) can be introduced by name. The owner's own Spotify playlists can be used as pools in rotating groups (switch after X minutes or Y tracks), but their tracks are never sent to an AI provider, so their moderation stays generic: transitions, time, weather, the next speech show.
- **No ducking.** ai-radio-station lowers the music and speaks over it; we never overlay speech on Spotify audio. Moderation plays between tracks.
- **Never cut a track.** Hand over when Spotify reports the track change, not a few seconds before the end.
- **Pre-produced.** Moderation is produced with the rest of the timeline, not live, so the handoff has no generation latency.

## Playback handoff (Android)

- Our segment ends → start the Spotify URI via App Remote → subscribe to player state.
- The Spotify track ends or changes → pause Spotify immediately → play the next segment through Media3.
- Spotify may briefly start the following track or autoplay before the pause takes effect; measure this and minimize it (single-track playback, pause on track change).
- Our segments are prefetched from R2, so short network loss does not stop the program. News items carry an expiry and are skipped when stale.
- Acceptance test: 60 minutes screen-off with at least 10 handoffs, lock-screen/Bluetooth controls, an incoming call and a network change. The existing [Android test](android-test.md) covers our own audio only.

## Content quality and safety

- Sources are untrusted data, never instructions. Feed fetching keeps its limits: HTTPS only, no redirects, no IP literals or local hosts, 500 KB, 20 entries.
- Each segment exposes its sources in the cockpit. Segments without `strict` verification are never presented as verified news.
- Deduplicate against memory so the same story is not retold. Never invent replacement news when production fails; play prepared content or music instead.
- Cost control: D1 quotas per day (requests, TTS characters, feed fetches), budget reserved before TTS, horizon capped, audio cached by script + voice + model + settings hash.

## Security

Public repository, private application. Cloudflare Access protects the Worker. Browsers authenticate with an Access login (JWT check with email allowlist). The Android app authenticates with an Access service token; the Worker accepts a JWT whose `common_name` equals `ACCESS_SERVICE_TOKEN_ID` as the owner. The app sends the token only to the configured origin; audio URLs that would leave it are rejected. Provider keys and the Spotify client secret for app-token search live only in Worker secrets. Log sanitized errors, not provider response bodies, secrets or full prompts. Define retention for audio in R2 (e.g. delete played segments after 7 days).

## Adopted from ai-radio-station

[ai-radio-station](https://github.com/BetaHuhn/ai-radio-station) is a local macOS command-line DJ for Spotify playlists. It confirms the conductor approach (pause Spotify, speak, play the next track). Adopted: segment triggers and playlist groups (milestone 3), host persona and YAML configuration (done), per-show tools with template values — weather via Open-Meteo, headlines, MCP servers — and a topic memory of recent segments (milestone 4), ElevenLabs as an additional TTS adapter (milestone 4). Not adopted: speech plays on the computer's speakers rather than on the listening device, Spotify metadata goes to the LLM, speech is overlaid on music (ducking), librespot (an unofficial Spotify client), no persistence, learning or pre-production, and news limited to headline titles without sources.

## Current state and gaps

Built in PR #10: Worker with Access, D1 quotas, feed retrieval and ranking, ASK brief and Gemini dialog pipelines, ASK quote verifier, Mistral voices, Spotify PKCE with the Web Playback SDK, local feedback learning. Milestone 1 adds the server-side program described above, plus the host persona, the YAML editor, Gemini as default writer, web research with Google Search grounding and the topic memory.

Remaining gaps:

- The one-off `POST /api/segments` flow still produces synchronously in the browser request; it stays as a manual single-segment tool.
- Topics are still a fixed list of three next to free interests; shows now carry the real editorial direction.
- The Android app (milestone 2, see [Android app](android.md)) plays our segments; Spotify handoff follows in milestone 3. The embedded cockpit needs a login that works inside a WebView when the service token alone is not enough: Access one-time PIN by email works, Google sign-in is blocked in WebViews.
- Frontend error messages for `/api/segments` are derived from substring matches on provider error details; return stable error codes.

## Milestones

1. **Program on the server** (done): D1 configuration, timeline, feedback and memory; import of device settings; queue production with R2 audio; cron horizon with listener gate; timeline API; cockpit timeline with continuous browser playback.
2. **The Android app with our segments** (built; acceptance test on a device pending): Kotlin app with Media3 service, timeline sync, prefetch, feedback, service-token auth and the embedded cockpit; 60-minute screen-off test. From here on the app is the only way to listen on the phone.
3. **Spotify in the app:** App Remote, the artist hour as the first music format, music blocks with moderation triggers, AI picks (AI → Spotify) and playlist groups, handoff test.
4. **Full customization:** per-show tools (weather, headlines, MCP) with template values, ElevenLabs as TTS option, form editors next to YAML, music rules, Google Drive archive for liked segments and artist hours.
5. **Learning and memory:** feedback weights in the planner, deduplication, series.
6. **Later:** continuous stream mode without Spotify (Icecast/HLS) for car and speakers. It needs a long-running process with audio tooling (for example a container), not a Worker.

## References

- https://developer.spotify.com/policy
- https://developer.spotify.com/documentation/android (App Remote SDK)
- https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow
- https://developer.spotify.com/documentation/web-playback-sdk
- https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- https://developer.android.com/media/media3/session/background-playback
- https://developers.cloudflare.com/queues/
- https://developers.cloudflare.com/r2/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- https://docs.mistral.ai/studio/audio/text_to_speech/speech
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/gemini-api/docs/google-search
