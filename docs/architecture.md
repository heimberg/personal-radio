# Architecture and implementation plan

## Decisions

Start with a modular monolith in TypeScript and one server-side worker, not independent microservices. Keep domain contracts independent of React and provider SDKs. UI and playback are separate: rerenders must never recreate the audio element. Text generation and TTS run on the server; browser controls playback and displays verified results.

Current directories: `src/domain` holds contracts/validation, `src/audio` holds playback, `src/main.tsx` is the initial UI, and `server/providers.ts` holds server-only integrations. Split the small initial UI into feature components when real editorial/profile views arrive. No backend is exposed yet.

## Planned bounded modules

Profile, sources, editorial generation, verification, speech, program scheduling, playback, feedback and operations. Adapters implement `TextGenerator` and `SpeechSynthesizer`. Later add `SourceProvider`, `MusicProvider`, repository and job-store ports only when used.

## Editorial pipeline

Fetch allowlisted RSS/API sources → deduplicate/date → select diverse candidates → construct cited fact records → ASK drafts script → deterministic schema/citation checks and editorial verification → TTS → measure actual duration → publish prepared segment to queue.

Citation existence is NOT factual verification. `parseScript` currently checks structure/source IDs only. Before live news, add per-claim source excerpts, stale-source rejection, contradiction handling and a golden evaluation set. Unverified drafts must not automatically become spoken news. Sources are untrusted data and cannot authorize tool calls. Restrict network egress; validate redirects, private IP ranges and response sizes when source fetching is implemented. No arbitrary user-controlled fetch URLs or model-selected executable actions.

Store source provenance, retrieval time, prompt/model version, verification state, script revision, audio revision and measured costs. State transitions are explicit: queued → drafting → verifying → voicing → ready, or failed. Jobs need idempotency keys, leases, bounded retries/backoff and a dead-letter state. App budget must reserve estimated TTS costs before submission; a retry cannot create duplicate paid generation. Cache by script + voice + model + settings hash.

Prefetch only a bounded amount of audio. Expire news by freshness policy, not just cache age. If ASK/TTS fail, use still-valid prepared content with a clear status. Never invent replacement news. Provider adapters presently make one bounded request. `server/segment-pipeline.ts` now supplies the first orchestration layer: bounded source inputs, ASK script generation, structural citation checks, a mandatory injected editorial-verifier port, per-owner/day character reservation before TTS, output-size checks, concurrency bounds and in-flight idempotency. It has no HTTP route and is not called by the web app. The verifier is only an interface: citation IDs do not prove factual accuracy, and no live content may be spoken until a substantive verifier and source-ingestion controls exist.

The current budget and in-flight coalescing are process-local. They reset on restart, do not coordinate across instances and only coalesce concurrent requests (not retries after completion). Treat this as a testable foundation, not a production cost-control or exactly-once guarantee. Persist budgets/jobs transactionally and authenticate owners before exposing a route. Source records must come from a trusted ingestion layer; the pipeline validates HTTPS syntax but does not fetch URLs or enforce a domain allowlist.

## Learning

Keep explicit preferences separate from session intent and inferred preferences. Explicit settings win. Strong signals: “more/less like this”, “already known”. Weak signal: skipped own editorial segment; an interruption must not count as dislike. Decay old inferences, expose/reset/export the learned profile and retain a user-controlled exploration fraction. Do not infer sensitive traits. No model training at MVP stage. Do not feed Spotify data into ASK or infer profiles from Spotify listening.

## Android decision gate

PWA installation and a service worker do not guarantee uninterrupted background execution. Measure real screen-locked playback, transitions, external controls and interruptions. A failed mandatory Android test triggers a native playback decision: reuse the web UI but implement an actual Android Media3 foreground media service. A plain WebView wrapper is not the solution. Native Spotify App Remote would be a separate integration and does not remove Spotify policy constraints.

## Spotify blocker

Spotify's developer policy restricts mixing/segueing audio, integration with other services' content, news generation and ingestion of Spotify content into AI. Personal/noncommercial use does not waive this. No Spotify implementation until this use case is clarified. No music downloading, re-streaming, AI ingestion or covert workarounds. An independent spoken news app or suitably licensed own music is a different scope and must be agreed as such.

## Security and deployment

Public repository, private application. Use authenticated server sessions, least-privilege provider credentials, rate/cost limits and encrypted persisted tokens. Never add secrets to the frontend. ASK's organizational hosting is not automatically authorized for private use: confirm both authorization and connectivity. Log sanitized errors, not provider response bodies, secrets or full prompts. Define data retention, deletion and backups before persistent data is introduced.

## Milestones and acceptance

0. Feasibility: real Android 60-minute result; ASK endpoint/permission test; Mistral voice test; music policy decision.
1. Foundation: responsive UI, deterministic tests/CI, private deployment with no provider secrets in browser.
2. Vertical slice: one allowed feed → cited ASK draft → review/verification → Mistral audio → playback → feedback, with a cost ceiling.
3. Program: topics, variety, licensed music provider, persisted resume, buffering and job recovery.
4. Learning: explainable feedback weights, profile review/reset, replayable evaluation set.
5. PWA: installability, cache only authorized own audio, safe update during playback and offline messages; native fallback if required.

## References

- https://developer.spotify.com/policy
- https://developer.android.com/media/media3/session/background-playback
- https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation
- https://docs.mistral.ai/studio/audio/text_to_speech/speech

Plan checked 2026-09-25. ASK's actual deployment contract still needs verification.
