# Architecture and implementation plan

Decisions revised 2026-09-27. This replaces the earlier local-first, browser-player plan.

## Goal

A private, single-user radio: tune in and hear a continuous program of AI-generated spoken segments and music that match one person's niche interests. Everything that shapes the program — shows, prompts, sources, voices, schedule, music rules and verification strictness — is user-editable configuration, not code.

## Decisions

1. **AI-generated content is the core.** Short briefs, two-host dialogs, explainers and music moderation are all generated. Existing content (feeds, articles) is source material for generation.
2. **Conductor, not mixer.** Spotify audio cannot be mixed into our own stream: it is DRM-protected and only plays in Spotify's own players. The backend therefore plans and produces a *timeline*; a player on the device executes it, alternating strictly between our segments and Spotify tracks. Never overlap, crossfade or overlay the two.
3. **Native Android app as the primary player.** Kotlin, Media3 `MediaSessionService` for our segments (reliable screen-off playback) and the Spotify App Remote SDK to control the installed Spotify app. The Spotify Web Playback SDK does not support mobile browsers; it stays a desktop-only option in the web app.
4. **Web app becomes the cockpit.** Configure shows, sources, schedule and music rules, inspect the timeline and sources per segment, and preview segments on desktop.
5. **Server-side configuration.** A backend that produces without an open browser must know the configuration, so shows, sources, schedule, feedback and memory move from `localStorage` to D1. The device keeps only UI preferences and a playback cache. Export and delete remain available.
6. **Providers are replaceable adapters.** Text through an OpenAI-compatible chat API (ASK by default, owner-controlled; model per show) and Gemini for dialogs. TTS through Mistral (single voice) or Gemini (multi-speaker). Model IDs and voices are configuration; none are hard-coded.
7. **Verification strictness per show.** `strict`: the current ASK quote verifier, every claim needs a verbatim source quote (news). `light`: source-grounded prompt, no second pass (explainers, dialogs). `off`: creative formats without factual claims (moderation, stories), marked as such. The strict verifier rejects explanatory content often, and a rejected draft is already paid for.
8. **Stay on Cloudflare**, on the Workers Paid plan (USD 5/month at time of writing), because audio decoding in the Worker can exceed the Free plan's CPU limit. Provider costs (ASK, Mistral, Gemini) are separate and capped by D1 quotas.

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
        ▼  Timeline API (Access: browser login or service token)
┌───────────────────────────────┬───────────────────────────────┐
Android app (primary)             Web cockpit (desktop)
· Media3 plays our segments       · edit shows, prompts, sources,
· App Remote plays Spotify URIs     schedule, music rules
· hands over at track end         · timeline with sources per segment
· prefetches ready segments       · desktop preview (Web Playback SDK optional)
· reports played/skipped/feedback
```

## Domain model

| Entity | Purpose |
| --- | --- |
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

- **Configuration** is one validated JSON document per owner in D1 (`station_config`): profile, feeds, shows, schedule, time zone and horizon. The cockpit imports it once from the device and edits it as JSON until the dedicated editors exist. `parseStationConfig` rejects unknown references, out-of-range lengths (brief 1–2 min because of the TTS cap, dialog 2–10 min), invalid times and time zones.
- **Planning** (`server/station.ts`, `planTimeline`) runs on every cron tick and on "Jetzt planen". It rotates the enabled shows of the schedule slot that is active at each planned time, stops at the horizon and at 12 new items per tick, and plans nothing outside an active slot.
- **Listener gate:** the cron only plans new content if the owner opened the program or gave feedback within the last 3 hours. Unplayed items expire after 12 hours, so without this gate the station would pay for content nobody hears.
- **Production** runs in a queue consumer, not in the browser request. Each item moves `planned → voicing → ready` (or `failed` / `expired`); a lease in D1 prevents concurrent production. The approved script is stored before speech synthesis, so a TTS retry never pays for a second draft. Transient provider errors back off (10, 20 min) and give up after 3 attempts; rejections and invalid drafts fail permanently; an exhausted daily budget defers the item to the next UTC day. Three failures within an hour pause planning.
- **Sources** come from the show's feeds: articles older than 30 days or already covered are skipped, the rest is ranked with explicit interests and learned weights (ties: newest first). Used articles are recorded in `covered_sources` so they are not retold.
- **Queues instead of Workflows:** the D1 state machine already provides durable steps, and a plain queue handler stays testable with the Node test runner (Workflows require the `cloudflare:workers` runtime module).
- **Audio** lives in R2 under `segments/<item>.mp3|wav`, is served with HTTP range support and is deleted 7 days after playback or on expiry.
- **Feedback** from the player (`complete`, `skip`, thumbs) is stored in D1; server-side learned weights feed the next drafts.

## Music curation (AI → Spotify only)

No Spotify audio, metadata, search results or listening behaviour are ever sent to an AI provider or used for learning. The data flow goes one way:

1. The LLM picks tracks (artist, title, short reason) from its own knowledge, guided by `MusicRule` and the recent playlist memory (our own records of the LLM's earlier picks).
2. The backend resolves each pick through the Spotify Search API with an app token (client credentials) and accepts it only if a normalized artist/title comparison matches. This comparison is deterministic code. Unmatched picks are dropped.
3. Only then does the LLM write moderation, for resolved picks only, based solely on its own selection. The only information passed forward is which picks resolved.

The planner stores the Spotify URI in the timeline; the app plays it through App Remote.

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

Public repository, private application. Cloudflare Access protects the Worker. Browsers authenticate with an Access login (existing JWT check with email allowlist). The Android app authenticates with an Access service token; the Worker's JWT check must additionally accept that token's identity. Provider keys and the Spotify client secret for app-token search live only in Worker secrets. Log sanitized errors, not provider response bodies, secrets or full prompts. Define retention for audio in R2 (e.g. delete played segments after 7 days).

## Current state and gaps

Built in PR #10: Worker with Access, D1 quotas, feed retrieval and ranking, ASK brief and Gemini dialog pipelines, ASK quote verifier, Mistral voices, Spotify PKCE with the Web Playback SDK, local feedback learning. Milestone 1 adds the server-side program described above.

Remaining gaps:

- The one-off `POST /api/segments` flow still produces synchronously in the browser request; it stays as a manual single-segment tool.
- Topics are still a fixed list of three next to free interests; shows now carry the real editorial direction.
- Access accepts browser logins only; the Android app needs service-token support.
- Frontend error messages for `/api/segments` are derived from substring matches on provider error details; return stable error codes.

## Milestones

1. **Program on the server** (done): D1 configuration, timeline, feedback and memory; import of device settings; queue production with R2 audio; cron horizon with listener gate; timeline API; cockpit timeline with continuous browser playback.
2. **Android player with our segments:** Media3 service, timeline sync, prefetch, feedback, service-token auth, 60-minute screen-off test.
3. **Spotify in the app:** App Remote, music-block workflow (AI → Spotify), handoff test.
4. **Full customization:** show editor with prompt templates and voices, program-clock editor, music rules, verification policy per show.
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
