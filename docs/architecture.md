# Architecture and implementation plan

## Decisions

Start with a modular monolith in TypeScript and one server-side worker, not independent microservices. Keep domain contracts independent of React and provider SDKs. UI and playback are separate: rerenders must never recreate the audio element. Text generation and TTS run on the server; browser controls playback and displays verified results.

Current directories: `src/domain` holds contracts/validation, `src/audio` holds playback, `src/main.tsx` is the initial UI, `server/providers.ts` holds server-only integrations, and `server/worker.ts` is the private Cloudflare Worker entry point. The Worker serves its own frontend assets and `/api/segments`; the separately hosted GitHub Pages prototype remains public and does not call it.

## Planned bounded modules

Profile, sources, editorial generation, verification, speech, program scheduling, playback, feedback and operations. Adapters implement `TextGenerator` and `SpeechSynthesizer`. The short format is ASK → ASK evidence review → Mistral speech. The two-host podcast format is Gemini text generation → ASK evidence review → Gemini multi-speaker TTS. Keep credentials server-side and provider selection behind those interfaces. Later add `SourceProvider`, `MusicProvider`, repository and job-store ports only when used.

## Editorial pipeline

Fetch allowlisted RSS/API sources → deduplicate/date → select diverse candidates → construct cited fact records → ASK drafts script → deterministic schema/citation checks and editorial verification → TTS → measure actual duration → publish prepared segment to queue.

Citation existence is NOT factual verification. `parseScript` checks structure/source IDs only. `AskEditorialVerifier` additionally asks ASK for per-claim supporting quotes and requires each quote to be an exact substring of a cited source excerpt. This catches invented quotations but cannot prove that the model listed every claim or that the source itself is true. Add stale-source rejection, contradiction handling, source-quality policy and a golden evaluation set before relying on live news. Sources are untrusted data and cannot authorize tool calls. Restrict network egress; validate redirects, private IP ranges and response sizes when source fetching is implemented. No arbitrary user-controlled fetch URLs or model-selected executable actions.

Store source provenance, retrieval time, prompt/model version, verification state, script revision, audio revision and measured costs. State transitions are explicit: queued → drafting → verifying → voicing → ready, or failed. Jobs need idempotency keys, leases, bounded retries/backoff and a dead-letter state. App budget must reserve estimated TTS costs before submission; a retry cannot create duplicate paid generation. Cache by script + voice + model + settings hash.

Prefetch only a bounded amount of audio. Expire news by freshness policy, not just cache age. If ASK/TTS fail, use still-valid prepared content with a clear status. Never invent replacement news. Each provider adapter makes one bounded request per call. `server/segment-pipeline.ts` orchestrates bounded source inputs, ASK script generation, structural citation checks, an editorial-verifier port, per-owner/day character reservation before TTS, output-size checks, concurrency bounds and in-flight idempotency. The mobile UI accepts a user-entered source or lets the user load and select one entry from an RSS/Atom feed. The verifier requires exact source quotes but cannot prove every claim is captured or that sources are truthful; automated scheduling, deduplication and preference-based feed selection remain out of scope for this slice.

The current in-flight coalescing is process-local. It resets on restart, does not coordinate across instances and only coalesces concurrent requests (not retries after completion). Treat this as a testable foundation, not an exactly-once guarantee. Persist budgets/jobs transactionally and authenticate owners before exposing a route. The private Worker can fetch a user-entered HTTPS RSS/Atom URL for a bounded list of entries: redirects are rejected, the response is capped at 500 KB, and the selected entry is only sent to ASK after an explicit generation action. Feed URL checks reject credentials, IP literals, localhost and common private hostnames; Cloudflare Worker outbound fetches are restricted to public internet services; provider terms and rights still need review per feed. D1 enforces a separate 60-feed-request daily quota per owner.

## Profile storage

Use a local-first profile. The PWA stores explicit interests, feedback events, learned weights, feed preferences and playback position in IndexedDB so that personalization works offline and remains on the user's device. The public demo remains client-only. Treat browser storage as persistent application storage, not a secure vault: do not put provider credentials or access tokens there.

Keep the profile model relational and explainable. Separate explicit interests from append-only feedback events (like, dislike, completion, skip, listening progress) and from derived topic weights. Store event timestamps and content/source identifiers so ranking changes can be replayed; allow the user to inspect, reset, export and delete this data. Keep only the minimum location-derived context needed for personalization; do not create a precise long-term location trail by default.

Add optional cross-device sync later through an authenticated Worker repository backed by D1. Sync only after the user enables an account/sync feature. Model core entities with SQL tables and use JSON only for provider-specific or evolving metadata. Do not add a graph database or vector database at MVP: use ordinary relational links for topic/place/source relationships. Reconsider graph storage only if multi-hop relationship queries become a core feature; reconsider vector search when semantic retrieval over a substantial content library is demonstrably useful. D1 is the planned low-cost managed SQL option, not a requirement for local-only use.

## Learning

Keep explicit preferences separate from session intent and inferred preferences. Explicit choices seed the content model. Strong signals: thumbs up/down. Weak signals: completing a segment is slightly positive; skipping after 20% is weak negative; a skip before 20% is ignored as likely interruption. Use a neutral prior and 45-day half-life so sparse/old evidence moves back towards neutral. Rank feed items by interest match and learned weight; epsilon-greedy exploration keeps the user-selected exploration share for alternatives. Keep this one-user system content-based and explainable; collaborative filtering has no useful population signal in a private single-user installation. Feedback history and learned weights stay on-device and can be reset. Do not infer sensitive traits. No model training at MVP stage. Do not feed Spotify data into ASK or infer profiles from Spotify listening.

The feed matcher currently uses text overlap between explicit interests and each entry's title/excerpt. It then preselects the highest-ranked entry; it does not yet autonomously poll feeds or generate a continuous queue. Add semantic tagging, deduplication and freshness/diversity policy before unattended generation. Spotify and background location are separate permission-gated features.

## Android decision gate

PWA installation and a service worker do not guarantee uninterrupted background execution. Measure real screen-locked playback, transitions, external controls and interruptions. A failed mandatory Android test triggers a native playback decision: reuse the web UI but implement an actual Android Media3 foreground media service. A plain WebView wrapper is not the solution. Native Spotify App Remote would be a separate integration and does not remove Spotify policy constraints.

## Music integration

The user states that Spotify has granted permission for this private integrated use. Proceed with a single-user Spotify integration on that basis. Limit the initial implementation to playback from a user-selected Spotify playlist/context and its basic transport controls. Do not send Spotify audio, metadata, or listening behaviour to ASK, Mistral or Gemini or use it for profile learning; those uses are outside the scope currently established for the permission.

Use Spotify Authorization Code with PKCE in the browser (no client secret in the app), and the Web Playback SDK for the private PWA. Keep OAuth access/refresh tokens in memory; use session storage only for the short-lived PKCE verifier/state during redirect. The Client ID is public configuration and belongs only in the private build configuration. The public GitHub Pages demo must not load the Spotify SDK or expose a connect flow. Playback requires Spotify Premium, and Development Mode is limited to one Client ID and up to five authorized users. Test screen-locked playback on the target Android device; Web SDK support in mobile browsers does not guarantee reliable PWA background playback.

Keep the adapter behind a `MusicProvider` port so playlist playback, AI interludes, and future sources are not coupled to React or Spotify SDK types. Implement serialized transitions: pause Spotify before the radio audio element plays, then resume Spotify after the segment ends. Never overlap the two players. If Spotify's written permission has narrower conditions, configure the implementation to those conditions before enabling the affected feature. See the official policy, which prohibits mixing Spotify audio with other audio absent an applicable authorization: https://developer.spotify.com/policy.

## Security and deployment

Public repository, private application. The Worker validates Cloudflare Access JWT signature, issuer, audience and an exact email allowlist. D1 atomically enforces per-day request and TTS-character quotas across instances. The private application will only become reachable once Access is enabled; the Worker itself fails closed without a valid Access token. Never add secrets to the frontend. ASK's organizational hosting is not automatically authorized for private use: confirm both authorization and connectivity from Cloudflare Workers. Log sanitized errors, not provider response bodies, secrets or full prompts. Define data retention, deletion and backups before persistent personal data is introduced. See [Cloudflare deployment](cloudflare-deployment.md).

## Milestones and acceptance

0. Feasibility: real Android 60-minute result; ASK endpoint/permission test; Mistral voice test; music policy decision.
1. Foundation: responsive UI, deterministic tests/CI, private deployment with no provider secrets in browser.
2. Vertical slice: one allowed feed → cited ASK short draft or Gemini two-host podcast → ASK evidence review → provider-specific speech → playback → local feedback learning, with a cost ceiling.
3. Program: topics, variety, licensed music provider, persisted resume, buffering and job recovery.
4. Learning: explainable feedback weights, profile review/reset, replayable evaluation set.
5. PWA: installability, cache only authorized own audio, safe update during playback and offline messages; native fallback if required.

## References

- https://developer.spotify.com/policy
- https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- https://developer.spotify.com/documentation/web-playback-sdk
- https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- https://developer.android.com/media/media3/session/background-playback
- https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation
- https://docs.mistral.ai/studio/audio/text_to_speech/speech
- https://ai.google.dev/gemini-api/docs/text-generation
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/podcast-api (deprecated; not used)

Plan checked 2026-09-25. ASK's actual deployment contract still needs verification.
