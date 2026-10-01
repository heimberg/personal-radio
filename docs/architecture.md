# Architecture and implementation plan

Decisions revised 2026-09-28. This replaces the earlier local-first, browser-player plan.

## Goal

A private, single-user radio: tune in and hear a continuous program of AI-generated spoken segments and music that match one person's niche interests. Everything that shapes the program — shows, prompts, sources, voices, schedule, music rules and verification strictness — is user-editable configuration, not code.

## Non-negotiable requirements

These two requirements override every other decision in this document:

1. **One app on Android.** Tuning in, listening, feedback, the program and configuration happen in a single Android app; the settings are the web studio shown in its «Studio» tab, so the owner never switches apps. The Spotify app must be installed and logged in, because the App Remote SDK plays through it, but our app controls it in the background.
2. **AI-generated speech in every program.** Generated spoken segments are the reason the station exists; music alone is not a program. The configuration is rejected without at least one enabled speech show (`parseStationConfig`), and music blocks always carry generated moderation.

## Decisions

1. **AI-generated content is the core.** Short briefs, two-host dialogs, explainers and music moderation are all generated. Existing content (feeds, articles) is source material for generation.
2. **Conductor, not mixer.** Spotify audio cannot be mixed into our own stream: it is DRM-protected and only plays in Spotify's own players. The backend therefore plans and produces a *timeline*; a player on the device executes it, alternating strictly between our segments and Spotify tracks. Never overlap, crossfade or overlay the two.
3. **One native Android app.** Kotlin, Media3 `MediaSessionService` for our segments (reliable screen-off playback) and the Spotify App Remote SDK to control the installed Spotify app. Playback never runs in the web studio. The Spotify Web Playback SDK is not part of the product.
4. **Everyday settings are native, the rest lives in the web studio.** Station and host, voice (with samples), place, interests, music and station sound are native in the app's «Studio» tab, and so is the day plan; shows, sources, the editorial team and usage are forms in the web studio, opened from the app or used on a computer; YAML is optional for bulk edits. Arranging the program is native in the app. See [Division of work](#division-of-work-app-and-web-studio).
5. **Server-side configuration.** The backend stores configuration, sources, schedule, feedback, production state and memory in D1 so it can produce without the app being open. The device keeps UI preferences and a playback cache. Export and delete remain available.
6. **Gemini writes, providers stay replaceable.** Gemini is the default text provider for briefs and dialogs and does the web research (Google Search grounding). ASK stays available per show (`textProvider: ask`, OpenAI-compatible) and, when configured, is the independent second model that verifies; without ASK, Gemini verifies. TTS through Mistral (single voice) or Gemini (multi-speaker). Model IDs and voices are configuration; none are hard-coded. Use the paid Gemini tier: on the free tier Google may use prompts and responses to improve its products.
7. **Verification strictness per show.** `strict`: the current ASK quote verifier, every claim needs a verbatim source quote (news). `light`: source-grounded prompt, no second pass (explainers, dialogs). `off`: creative formats without factual claims (moderation, stories), marked as such. The strict verifier rejects explanatory content often, and a rejected draft is already paid for; so a rejected script gets one repair (the final editor drops or narrows exactly the claims the check could not find, `repairScript`) and one second check before it fails. The «Hintergrund» block (a five-minute dialog) uses `light`.
8. **Audio lives in R2, Google Drive is an archive.** Playout needs a few hundred MB at most (a 2-minute MP3 is about 2 MB; 7-day retention), well inside R2's free allowance with free egress. Google Drive would need a stored OAuth token (refresh tokens of Google apps in "testing" status expire after 7 days), would route every stream through the Worker and adds latency and quotas. The owner's 2 TB are used later for an archive: liked segments and artist hours are copied to a Drive folder with script and sources.
9. **Stay on Cloudflare**, on the Workers Paid plan (USD 5/month at time of writing), because audio decoding in the Worker can exceed the Free plan's CPU limit. Provider costs (ASK, Mistral, Gemini) are separate and capped by D1 quotas.

## Editorial team for music hours (beta)

Per show, `production: agents` hands a music hour to a team of registered agents instead of a single writer: director, per-song researchers, lyric analyst, optional specialists, segment editor, fact checker and continuity editor, run as a validated plan with durable D1 checkpoints. Details, roles and costs: [agentic-workflow-spike.md](agentic-workflow-spike.md).

## Division of work: app and web studio

Decided by the owner on 28.09.2026; on 29.09.2026 the browser player and the web program view were dropped, the web is the studio only; on 30.09.2026 the everyday settings moved into the app (native «Studio»), the web studio keeps shows, feeds, the editorial team and usage.

| | Android app (native, Jetpack Compose) | Web studio (Worker page, behind Access) |
|---|---|---|
| Role | The product for listening and steering the program | The workbench for settings |
| Contents | Playback (screen off, lock screen, Bluetooth, offline cache), Spotify hand-over and «Spotify verbinden», feedback (👍/👎, skips), the program («Jetzt · Gleich · Später»: move, remove, «Anders», shuffle, add songs, plan, retry), building blocks, archive, text and sources | Persona and voices, shows of every format, day plan and surprise level, music and playlist groups, feeds, the editorial team, quality and usage, YAML, Spotify listening profile |
| Where | Phone | The app's «Studio» tab; a browser on a computer |
| Changes ship | With a new APK | With every Worker deploy, no reinstall |

Rules for new features: anything used while listening or often on the phone goes native; settings and anything with larger forms go into the web studio. Both use the same Worker API, so a feature can move between them without duplicating server logic.

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
        ▼  Authenticated API (Access service token for the app)
        │
Android app (the single app)
· Media3 plays our segments, lock screen and Bluetooth controls
· App Remote plays Spotify URIs, hands over at track end
· prefetches ready segments, reports played/skipped/feedback
· in-app screens: persona, shows, sources, schedule, timeline and production controls
```

## Domain model

| Entity | Purpose |
| --- | --- |
| `Station` | Station name and host persona: name, tone, style, own instructions and a co-host name for dialogs. Applies to every generated segment. |
| `Show` | A format: name, prompt template (editable), source selection, text provider/model, voice(s), target length, language/style, verification policy, enabled flag. |
| `Source` | Feed URL, web page or manual note/topic list; weight, blocked terms, fetch interval, owner's rights check. |
| `Schedule` | The program clock: per weekday and time window an ordered list of slots — a show, a music block (n tracks + music rule) or a moderation — plus a speech/music ratio. |
| `MusicRule` | Free-text taste description, genres, eras, seed artists, exclusions, no-repeat window, discovery share. |
| `TimelineItem` | Position, kind (`segment`, `spotify-track`, `moderation`), references, planned time, state `planned → producing → ready → played / skipped / archived / failed / expired`. |
| `Segment` | Script, cited sources, R2 audio key, measured duration, cost, provider/model/prompt versions, verification result. |
| `FeedbackEvent` | like, dislike, skip (with listened ratio), complete, "already known", "go deeper". |
| `Memory` | What was played, covered-story fingerprints for deduplication, series state ("part 3 of …"). |

Explicit configuration always wins over learned weights. The existing learning rules stay: thumbs are strong signals, completion is weakly positive, a skip before 20 % is ignored and a later skip is weakly negative, with a 45-day half-life.

## Program production (implemented, milestone 1)

- **Configuration** is one validated document per owner in D1 (`station_config`): station name, host persona, profile, feeds, shows, schedule, time zone and horizon. The Android app edits configuration through native screens; the API stores validated JSON. Documents saved before the persona existed get a default host.
- **Persona** (`host`): every draft is written in the host's voice and tone; in two-host dialogs `host-a` is the host and `host-b` the co-host. Persona and show instructions are owner-written and go into the system prompt; source text never does. `parseStationConfig` rejects unknown references, out-of-range lengths (brief 1–2 min because of the TTS cap, dialog 2–10 min), invalid times and time zones.
- **Planning** (`server/station.ts`, `planTimeline`) runs on every cron tick and on "Jetzt planen" from the app. It rotates the enabled shows of the schedule slot that is active at each planned time, stops at the horizon and at 12 new items per tick, and plans nothing outside an active slot.
- **Listener gate:** the cron only plans new content if the owner opened the program or gave feedback within the last 3 hours. Unplayed items expire after 12 hours, so without this gate the station would pay for content nobody hears.
- **Production** runs in a queue consumer, not in the browser request. Each item moves `planned → voicing → ready` (or `failed` / `expired`); a lease in D1 prevents concurrent production. The approved script is stored before speech synthesis, so a TTS retry never pays for a second draft. Transient provider errors back off (10, 20 min) and give up after 3 attempts; rejections (after the one repair) and invalid drafts fail; an exhausted daily budget defers the item to the next UTC day. Three failures within an hour pause planning. «Erneut versuchen» (`POST /api/timeline/retry`) produces items that failed within the last day again from scratch (a chosen subject is kept), retires older failures and restarts waiting items.
- **Sources** come from the show's feeds: articles older than 30 days or already covered are skipped, the rest is ranked with explicit interests and learned weights (ties: newest first). Used articles are recorded in `covered_sources` so they are not retold.
- **Current execution:** a Cloudflare Queue consumer and D1 state machine produce each timeline item. The approved script and per-part voice progress are persisted, so transient failures resume without repeating completed work. This remains the active production path.
- **Workflow framework decision:** [the agentic workflow spike](agentic-workflow-spike.md) adds a framework-neutral agent registry and tests a `step.do`-compatible checkpoint adapter. It does not yet register a Cloudflare Workflow or route production through one. Cloudflare Workflows are the candidate durable execution layer for a future multi-agent producer; keep the existing queue path until an end-to-end shadow run demonstrates quality, recovery, latency and cost. Mastra remains an alternative to evaluate, not a dependency.
- **Audio** lives in R2 under `segments/<item>.mp3|wav`, is served with HTTP range support and is deleted 7 days after playback or on expiry.
- **Feedback** from the player (`complete`, `skip`, thumbs) is stored in D1; server-side learned weights feed the next drafts.

## Web research (implemented)

Shows with `sourceMode: web` need no feed. Production runs two steps:

1. **Research** (`GeminiResearcher`): one Gemini call with the `google_search` tool, the show's `researchPrompt`, the listener's interests, today's date and the recent topics. From the grounding metadata only sentences that Gemini attributes to a search result are kept, grouped by that result; each result becomes a source (`w1`…`w8`, at most 24,000 characters in total). Ungrounded text is discarded. The search queries are stored with the item (`research_json`) and shown in the Android app as Google search links.
2. **Script** from these sources exactly like from feed articles, followed by the show's verification policy. With `strict`, every claim must quote a grounded sentence.

The two steps keep the script call independent of whether a model supports search and structured output in one request. Grounded requests are billed separately beyond a free daily allowance. Google's terms for grounding with Google Search require showing the search suggestions where grounded results are shown; the app lists the queries as links, which must be checked against the current terms before wider use. Grounding result URLs can be Google redirect links; their titles name the site.

**Topic memory:** every draft and every research request receive the titles of the last 15 produced segments with the instruction not to repeat them.

## Agentic production model

A music hour benefits from specialist roles, but not from agents that can call tools or spawn other agents without bounds. Keep one deterministic conductor in `produceMusicHour`; it owns the queue state, budgets, retries and handoffs. Each specialist makes a bounded request and returns structured data that the next step can inspect:

1. **Director / producer:** choose or accept the subject, set the editorial arc and song count, assign work, watch the whole block and check that every stage is complete.
2. **Music researcher:** build a broad dossier, then research the exact Spotify tracks. Each selected recording gets its own source-backed context.
3. **Lyric analyst:** identify themes relevant to each song from permitted evidence and return short notes without reproducing lyrics.
4. **Music programmer:** select a varied sequence; Spotify search resolves exact tracks in deterministic code. Spotify metadata never goes back to a model.
5. **Segment editor:** establish the hour's red thread and write a distinct, evidence-linked moderation for every selected song.
6. **Fact checker and continuity editor:** check claims against sources and review pacing, transitions, repetition and the arc of the complete hour.
7. **Voice producer:** synthesize each approved speech part and persist progress so retries do not pay for completed parts again.

This is the target controlled agentic workflow: roles have narrow prompts and typed outputs, while a deterministic conductor decides what runs next. There is no open-ended tool loop. It makes the work auditable, keeps Spotify and secrets away from the language model, and gives each song a chance to carry its own story. The code prototype is documented in the linked spike; these roles are not yet separately registered or orchestrated in production. The first production version should research each confirmed song individually (parallel where safe), then write and verify its moderation against that song's evidence.

### Extensible agent registry

Agent identity and workflow are separate. Register each role once with a stable ID, version, capability description, input/output schema and explicitly allowed tools. A workflow plan may compose only registered roles allowed by the run's policy. Agents return structured artifacts and do not spawn agents or grant tools to one another. Domain specialists (geologist, biologist, historian, music researcher, lyric analyst) can be added as registrations without adding a new execution engine.

| Agent role | Responsibility |
| --- | --- |
| Director / producer | Own the block-level plan, assign research, track stage completion, manage bounded revisions and assemble the rundown |
| Research agents | Gather and cite evidence; specialized versions cover songs, lyrics, geology, biology, history and other topics |
| Editors | Shape evidence into spoken segments, preserve the red thread and target length |
| Fact checker | Match factual claims to sources and flag conflicts or weak evidence |
| Continuity editor | Review the whole block for order, transitions, repetition, pacing and missing pieces |
| Voice producer | Generate audio only from approved scripts and resume completed parts |

The director's plan is untrusted input until deterministic validation checks allowed agents and tools, task and output limits, declared dependencies and cycles. Store compact JSON artifacts between durable steps; put audio and large source documents in R2. App progress should come from a run status API and show the stage and useful failure reason, without exposing framework details.

## Music hours: artist, genre, theme

Three show formats share one production: spoken parts with Spotify tracks in between, grounded in web search.

- `artist_hour` — one artist or band: tracks across the career, background on the artist and the songs.
- `genre_hour` — one genre or scene: its history from the origins to today, told through songs by different artists.
- `theme_hour` — any topic (science, history, culture, nature, not only music): the topic is the content, told in chapters; after each chapter a song by any artist that fits the topic in its lyrics, title, origin or mood. Defaults: 8 tracks, 120 seconds of speech per chapter.

```yaml
- id: thema
  name: Themen-Stunde
  format: theme_hour
  theme: Der Mond          # artist: … / genre: … for the other formats; leave empty and the AI picks from your interests
  tracks: 8                # 3–15
  talkSeconds: 120         # 20–180 per moderation
  instructions: Erzähle das Thema in Kapiteln.
  verification: light
```

Without a fixed subject the AI picks one from the listener's interests and avoids the subjects of recent hours of the same kind.

Production, entirely ahead of time:

1. **Dossier:** web research (as above) on biography, periods, albums, the story of individual songs and anecdotes.
2. **Track selection:** the LLM picks about 11 songs across the career with a reason each; the backend resolves them with Spotify search and keeps unambiguous matches only (AI → Spotify; facts come from the web, never from Spotify).
3. **Script:** opening, a 45–90 second moderation before each resolved track, closing — in the host persona, optionally as a dialog with the co-host. Moderation only for tracks that resolved.
4. **Check and voice:** claims are checked against the dossier sources; unsupported sentences are rewritten or dropped. Moderations are voiced to R2.
5. **Timeline:** opening → moderation → Spotify track → moderation → … → closing. About 45 minutes of music and 12–15 minutes of AI speech per hour, which satisfies the speech requirement by construction. One hour needs roughly 10,000–12,000 TTS characters; raise `DAILY_TTS_CHARACTERS` accordingly.

Implementation: a music hour is one timeline item whose `script_json` holds the parts in playing order — spoken parts (each voiced to its own R2 file, `GET /api/timeline/{id}/audio?part=n`) and Spotify tracks (URI, the AI's title and artist, duration). Voicing stores progress after every part, so a retry never pays twice; moderations longer than about 250 words are split into consecutive parts. Track search uses the Spotify Web API with an app token (client credentials, `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`), deterministic title/artist matching and `SPOTIFY_MARKET` (default `CH`); an hour with fewer than three matches fails with `TOO_FEW_TRACKS`. The whole script is verified once against the dossier (default policy `light`). `POST /api/shows/{id}/produce` produces any show immediately, outside the program clock, from the Android app. The app lists the hour's tracks and plays it with the App Remote handoff described below.

## Songs between spoken items

`music` in the station configuration: `between` (0–3 songs after every spoken item; music hours bring their own music), `announce` (a short spoken intro) and `taste` (the owner's own description). The planner inserts song items (reserved show ID `_musik`, about 4 minutes) after every brief or dialog. A song item asks Gemini for three candidates that fit the taste, avoiding recent songs and taking the owner's 👍/👎 and early skips on earlier songs into account (these are songs the AI picked, not Spotify data). Spotify resolves the first one it knows; the host voices a short announcement. The item has the same `parts` as a music hour, so the Android app plays it without changes. Song picks do not count towards `DAILY_GENERATIONS`; announcements count towards `DAILY_TTS_CHARACTERS`.

## Arranging the program

The Android app arranges the open items (planned, being voiced, ready): `POST /api/timeline/arrange` with the full new order (a stale order is refused with 409), `POST /api/timeline/{id}/remove` (expires the item and releases its audio), `POST /api/timeline/shuffle` (shuffles and spreads songs so that at least `max(1, music.between)` sit between two spoken items, adding and producing missing songs) and `POST /api/shows/_musik/produce` (one more song). Arranging gives the items fresh sequence numbers after all existing ones, so the planner continues after the new tail. The app rebuilds its playlist after the current item whenever the server order differs; the item that is playing is never interrupted.

## «Heute»: a mood for the rest of the day

The owner can lean the rest of the day with one tap in the app (`POST /api/mood`, stored as `StationConfig.mood` with `until` = next midnight in the station's time zone). The planner applies it to a copy of the configuration (`applyMood` in `src/domain/mood.ts`): *Eher ruhig* drops headline blocks, adds a song between items and turns surprises off; *Mehr Wissen* adds discovery and background blocks to every window; *Mehr Musik* raises the songs between items to at least two and adds music blocks; *Was läuft?* adds headlines; *Überrasch mich* raises the surprise level to at least 80. The saved day plan stays as it is. `GET /api/timeline` reports an active mood; saving the settings keeps it.

## Archive: listening freely

Finished productions do not disappear when they leave the program. A ready item that nobody heard within 12 hours becomes `archived` instead of `expired` and keeps its audio; heard (`played`, `skipped`) and archived items keep their audio for 7 days after they left the program, then it is released from R2 and the item drops out of the archive. `GET /api/library` lists the productions that can still be heard (newest first, single songs left out) with `retentionDays`. The app plays any of them on request (a custom Media3 session command), after the current step; the program continues afterwards. Feedback on an item that is neither `ready` nor `archived` records only ratings, so listening again does not skew learning.

## Tools for shows (milestone 4, first step)

A show's instructions and research brief may contain placeholders that are filled in when the item is produced: `{datum}`, `{wochentag}`, `{uhrzeit}` (in the station's time zone), `{ort}` and `{wetter}`. The station's `location` (name, latitude, longitude; found by name in the studio through `GET /api/places`, Open-Meteo geocoding) feeds `{ort}` and `{wetter}`. The weather comes from Open-Meteo (no key, nothing about the listener leaves the Worker except the coordinates) and is also handed to the writer as a source with the ID `wetter`, so strict verification accepts weather statements like any other evidence. A show can live on tools alone: a brief with `{wetter}` and no feeds is a weather report. Without a location such a show fails with `NO_LOCATION`. Next tools: headlines, MCP servers.

## Building blocks

Ready-made blocks replace typing prompts for everyday use: each block (`src/domain/blocks.ts`) is a show template – format, length, verification, instructions and tools – that the owner adds with one tap, at most with one word (topic, artist, genre, theme). Timeline items of a block carry the show ID `_block:<id>` and are produced with the template; the owner's own shows appear as blocks too (`show:<id>`). Shows switch on tools instead of placeholders: `clock` (date and time), `weather` (Open-Meteo, a source), `headlines` (the newest items of the owner's feeds within 36 hours, or a web search, as sources `h1`…). Placeholders remain available in YAML for power users. The day plan ("Tagesplan", formerly the program clock) takes blocks as well: a schedule slot may list `_block:<id>` next to show IDs, the planner rotates them like shows (songs in between when music is on), and a plan of blocks alone satisfies the rule that every program has AI speech. The editor offers ready-made windows (Morgen, Mittag, Nachmittag, Abend), day sets (Täglich, Werktags, Wochenende) and "+ Baustein" per window.

## Final desk: style book, bridges, quality jury, loudness

Every spoken item (briefs, dialogs, blocks) goes through a final desk after the draft (`server/editing.ts`): an editor rewrites it for the ear by a radio style book (one thought per sentence, rounded numbers, abbreviations spelled out, people introduced with their role, a concrete hook, the key point repeated at the end) and connects it to the program: a one-sentence bridge from the item before, the station ident after music or at the start, no announcement of what comes next (the owner may reorder). With live transitions on (default), the script instead starts straight with its subject: the bridge and the station name come from the live transition. A jury then scores hook, clarity, facts, novelty and length from 1 to 5; below its bar (default 3.5, see Redaktion) the script goes back once with the jury's notes and the better version is kept. A rewrite that changes the format, cites unknown sources or grows or shrinks by more than half is discarded in favour of the draft, and the evidence check runs on the final text. The marks are shown in the studio (★) and in the app's text view. Voiced WAV audio (Gemini voices) is brought to one speech level (about −19 dBFS RMS of the voiced parts, soft limiter below full scale) and silent edges are trimmed to 120 ms (`server/audio.ts`); Mistral MP3 passes unchanged.

## Redaktion: configurable agents

Settings → Redaktion lists every editorial agent (`src/domain/agents.ts`): research, writer, dialog, final editor, jury, fact check, music desk, the standard music hour and the six roles of the music-hour team. For each the owner can rewrite the editable part of its prompt (style, emphasis, criteria), set how free it writes (temperature, «genau ↔ frei»), switch off the optional ones (final editor, jury) and set the jury's bar. Only differences from the shipped defaults are stored in `StationConfig.agents`, so improved defaults still arrive. The fixed contract (source rules, output format, fact-check rules) stays in code and is shown read-only; the fact check accepts extra hints that are appended after its rules and can only sharpen it. A trial run (`POST /api/agents/trial`, writer, editor, jury) applies the unsaved settings to the last produced spoken item and shows before/after with marks; nothing is stored.

### Learning from listening, quality trend, usage

- **Reasons with 👎.** After a down-rating the app offers one optional tap: too long, boring, wrong tone, known already, wrong. A reason that came up at least twice in 30 days becomes a note for the writer, the dialog, the final editor, the jury (which scores that point more strictly) and the music-hour writers (`src/domain/listener-notes.ts`). The owner can reset the collected reasons in Redaktion.
- **Style presets.** One tap sets instructions and freedom of several agents (news, chatty, science magazine, morning show; `src/domain/agent-presets.ts`); «Standard» resets all.
- **Quality trend.** Every jury mark is kept in `quality_log` (it survives the timeline cleanup); saving changed agents writes `agent_changes`. Redaktion shows the daily average of the last 30 days per show with a marker on each change.
- **Usage.** Requests to Gemini, Mistral and ASK go through a counting fetch (`server/usage.ts`) that records calls and the tokens the providers report per UTC day and model (`model_usage`). Settings → Verbrauch shows them next to the daily productions and speech characters and their limits.
- **More trials.** The music desk proposes the next songs (nothing is searched or planned); the music hour is moderated anew from the last hour's songs and sources.

### Series

A series tells one subject over several episodes (`src/domain/series.ts`, table `series`, migration 0010). The palette offers two entries that take one word: **Wissensserie** (`serie`) and **Fortsetzungsgeschichte** (`geschichte`).

- **Start.** `POST /api/blocks/{serie|geschichte}/add` plans the series in one model call (counted like a production): a title and five episodes, each with a title and one sentence. A child's station adds its rules to that plan. The first episode goes to the end of the program.
- **Episodes** are timeline items with the show ID `_series:<id>`; their `research_json` says which episode of how many, so the program shows «Titel · Folge 2/5» without a lookup.
  - A knowledge episode is a dialog: research for its step, then the usual final edit, jury and a `light` fact check. Without dialog voices the host tells it alone.
  - A story chapter is written from the plan, which is its one source `serie` (not listed as a source). It is checked with `off`, because it is fiction: the writer gets a story prompt instead of the news prompt (`EditorialDirection.story`).
  - Every episode after the first opens with «Was bisher geschah» from short recaps of the episodes before, kept with the series. Every episode but the last ends with a look ahead.
- **Next episode.** While someone listens, the planner adds the next episode right behind the coming item once the previous one left the program heard (played, skipped or archived). An episode removed or expired unheard comes again; a failed one waits for its retry. After the last episode the series is `done`.
- **Ending.** `GET /api/series` lists the series; `POST /api/series/{id}/stop` ends one and takes its open episode out of the program. In the app, «Programm» lists running series with «Beenden». Series are not offered in the day plan.

### Family

Everyone on one Worker – the owner and the listeners in `LISTENERS` – forms the family (`server/family.ts`, migration 0011). The API names members by `owner` or their listener name and shows names only, never the owner's email. The owner's name is `OWNER_NAME`, default «Papa».

- **Chat:** `family_messages` keeps the last thousand messages. `family_reads` keeps each member's last read message. `GET /api/timeline` carries `family: { unread, latest }` for the badge and the notification.
- **Sharing** (`POST /api/family/share`): copies a produced item (script, sources, every audio object under a new key) into the recipient's program, right behind the item that plays next there. It is marked with `sharedBy`, and nothing is produced again. A chat message records it.
- **Listening along** (`POST /api/family/listen`): the same copy, of what another member hears now. «What they hear» is reported by the app once per item (`POST /api/family/presence`) and lasts as long as the item.
- **Greetings** (`POST /api/family/greet`) are read in the recipient's next live transition: the linker adds them to its facts, skips the cache and marks them aired. Without live transitions they stay in the chat.
- **Profile pictures:**
  - `PUT`/`DELETE /api/family/avatar` stores or removes a member's own picture in R2 (`avatars/<member key>`); only JPEG or PNG is accepted, about 300 KB at most, and the app sends a 256-px square.
  - The version is kept in `family_avatars` (migration 0012), and `GET /api/family/avatar/<key>?v=…` serves the picture with a long cache.
  - Pictures never go to an AI.
- **Kids:** a child's station only takes what the owner shares, and a child cannot listen along to others (`mayCopyInto`). Only members' own messages and greeting texts reach the AI, in the live transition.

### New releases, «Mehr dazu», station sound

- **«Neu von deinen Künstlern».** A music-block group can take the new albums and singles (last 60 days) of the owner's top artists from the listening profile: the Worker finds each artist on Spotify by exact name, lists their releases and plays the first track of each, newest first (`SpotifyCatalog.newReleases`). The moderation announces each release by artist and title as new (the owner's decision, 29.09.2026: these release names go to the AI and to speech synthesis); release dates and other metadata stay on the Worker.
- **«Mehr dazu».** In the app, one tap puts a *Vertiefung* right after the playing spoken item (`POST /api/timeline/{id}/more`). It starts from that item's sources (`p1`…), researches more on the web, is told what was already said and is checked strictly like any item. The hidden block `vertiefung` is not offered in the palette or the day plan.
- **Station sound.** The Worker synthesises a short ident jingle and a time signal (three pips and a long one) as WAV (`server/sounds.ts`, no third-party audio). The host speaks the hour announcement («Es ist 8 Uhr. Du hörst …») once per hour, voice and station name and keeps it in R2 (`sounds/hour-…`). The app plays the ident before a spoken item that follows music and, at the first change of item in the first 20 minutes of a new hour, the time signal and the spoken hour. Both can be switched off (`sounds.ident`, `sounds.hourChange`; default on).
- **Sound package.** Four ident variants share one bell voice and key family (`/api/sounds/ident/{0-3}.wav`, the app keeps one per item); news items (Morgen, Schlagzeilen) get a news opener (`/api/sounds/news.wav`: ticking pulse, rising low tone, firm chord) instead of the ident. Short spoken WAV audio (up to 75 s, Gemini voices) gets a soft synthesised bed (an F major seventh pad about 15 dB below the voice, starting 0.6 s before it and fading out 1.6 s after; `withBed` in `server/audio.ts`); longer items and Mistral MP3 stay dry. It is off by default since 30.09.2026 (it disturbed); `sounds.musicBed` switches it on (the earlier key `bed` is ignored). The ident setting covers the news opener.
- **Voices (Gemini 3.8 TTS).** Speech goes through the Interactions API (`POST /v1beta/interactions`): the voice in `speech_config`, the delivery as a `speech_metadata` style; a prebuilt voice falls back to `generateContent` if the Interactions API answers 404/400. Live transitions and the hour announcement use `gemini-3.8-flash-lite-tts` (`GEMINI_TTS_LITE_MODEL`) with prebuilt voices; own voices always use the full model they were made with. Scripts may carry vocal tags (`<laugh>`, `<sigh>`, `<short pause>`, backchannel `|mhm|`), which the final editor adds sparingly; they reach only Gemini voices: Mistral, the transcript and the fact check get the text without them (`withoutVoiceTags`). Own voices live in the owner's Gemini project (`GeminiVoiceCatalog`, 200 at most, one year): `GET /api/voices` lists own, prebuilt, German library (`de-DE`, `de-CH`, with search) and Mistral voices; `POST /api/voices/design` designs one from a description (`type: prompted`), `POST /api/voices/clone` clones one from a speech sample and the spoken German consent sentence (`type: replicated`, both WAV, only from the app), `DELETE /api/voices/{id}` removes one. Designing and cloning count towards `DAILY_GENERATIONS`; the recordings are not stored by the Worker. Station voice IDs are `gemini_<voice>` (`gemini_Kore`, `gemini_voice_…`). Dialogs speak with the host's voice (host-a) and the co-host's (`host.cohostVoiceId`, host-b); non-Gemini choices fall back to `GEMINI_VOICE_A`/`GEMINI_VOICE_B`. Two prebuilt voices go in one conversational call; with an own voice every turn is spoken alone and joined with 0.35 s pauses. Speech edges are trimmed only below −60 dBFS with 250 ms kept, so soft onsets survive.
- **Live transitions.** Before every spoken item the app plays `GET /api/linker?after=<item before>&next=<item>`. The Worker writes one or two sentences in the host persona from a few facts (`server/linker.ts`: station, host, weekday and time of day in words, the next item's title and show, the item before: its title, whether it was music and, only for songs the AI picked or new releases, artist and title; playlist tracks are never named), voices them with the host voice (with bed) and keeps them in R2 under `linkers/<UTC day>/…`, so replays cost nothing; the cron removes them after two days. Like every script, a transition never names a clock time; the exact time is only spoken by the hour announcement. Transitions are capped per day (`DAILY_LINKERS`, default 40, table `daily_linker_requests`) and do not count towards `DAILY_TTS_CHARACTERS`, so they never starve production; whatever fails (no Gemini, limit reached, provider error) answers with a quarter second of silence and the program goes on. `sounds.linker` switches them off (default on).

### Pre-produced, but never wrong about the time

Items are produced ahead of their air time, so no script names a clock time: the writers are told the item is pre-produced, date, weekday and time of day come from the *expected air time* (the item's planned time, or now when that has passed), and the `{uhrzeit}` placeholder becomes the time of day («Morgen», «Abend»). The exact time is only spoken live: the app's time signal at the full hour. Time-bound items (weather, headlines, date, music blocks with time-of-day moderation) that are still unplayed two hours after their planned time leave the program (finished ones into the archive), and the planner produces fresh ones.

### Surprises (🎲)

`surprise` (0–100, default 25) sets how often the planner turns a spoken turn into a surprise: the chance per spoken turn is `surprise/100 × 0.45`, so 25 gives about one an hour; the rotation of the day plan continues after it. Surprises are hidden blocks with weights (`src/domain/blocks.ts`): Zufallsfund, Heute vor … Jahren, Um die Ecke (only with a location), Wort des Tages, Frage des Tages, Musik-Wildcard (a taste drawn from a list of scenes and decades) and, from level 50, an Überraschungsstunde whose theme the AI picks. The same kind never comes twice in a row. They are researched and checked like every item. «Überraschung» in the block palette draws one right after the playing item; in the program a surprise is marked 🎲 and can be swapped for another kind at the same place (`POST /api/timeline/{id}/swap`) or removed. The level also tells the music desk how far song picks may stray from the taste.

## Music curation (AI → Spotify only)

No Spotify audio, playback data, search results or track metadata are sent to an AI provider. **One exception, decided by the owner (27.09.2026):** when the owner connects the *listening profile* (OAuth, scopes `user-top-read` and, for music blocks, `playlist-read-private` and `playlist-read-collaborative`), the names of the owner's top artists (at most 40, refreshed at most every 12 hours) go into the song picks and into the subject picks of artist and genre hours. **A second exception (29.09.2026):** the artist and title of each new release in the «Neu von deinen Künstlern» block go into its moderation (and into the live transition after it). Spotify's developer policy restricts feeding Spotify content into AI models; the owner accepted that risk for this private station and can disconnect at any time (the stored token and list are deleted). Otherwise the data flow goes one way:

1. The LLM picks tracks (artist, title, short reason) from its own knowledge, guided by `MusicRule` and the recent playlist memory (our own records of the LLM's earlier picks).
2. The backend resolves each pick through the Spotify Search API with an app token (client credentials) and accepts it only if a normalized artist/title comparison matches. This comparison is deterministic code. Unmatched picks are dropped.
3. Only then does the LLM write moderation, for resolved picks only, based solely on its own selection. The only information passed forward is which picks resolved.

The planner stores the Spotify URI in the timeline; the app plays it through App Remote.

## Music blocks and moderation triggers (milestone 3)

Adopted from [ai-radio-station](https://github.com/BetaHuhn/ai-radio-station) (MIT), adapted to our constraints. A music block is a show (`format: music_block`, 10–120 minutes) that the schedule rotates like any other show; no songs are planned after it because it brings its own music.

```yaml
- id: morgenmusik
  name: Morgenmusik
  format: music_block
  targetMinutes: 30
  groups:                      # rotate; at most 6
    - name: Kaffee
      playlists:               # links, spotify:playlist: URIs or IDs; at most 5
        - https://open.spotify.com/playlist/37i9dQZF1DX4sWSpwq3LiO
    - name: Entdeckungen       # no playlists: the AI picks from the group's taste
      taste: Krautrock und frühe Elektronik
  switchAfterTracks: 3         # 0 = off
  switchAfterMinutes: 0        # 0 = off
  talkSeconds: 20              # 10–120 per moderation
  triggers:
    blockStart: true
    blockEnd: true             # hands over to the next show of the schedule slot
    beforeTrack: 1             # before every Nth AI-picked song; 0 = off
    afterTrack: 0              # after every Nth AI-picked song; 0 = off
    everyMinutes: 0            # after X minutes of music without speech; 0 = off
    groupTransition: true
```

| Trigger | Fires | Context available to the prompt |
| --- | --- | --- |
| `blockStart` / `blockEnd` | when the block begins or ends | block name, group names, next show, time of day |
| `beforeTrack` / `afterTrack` | every N AI-picked songs | only the AI's own pick (artist, title) |
| `everyMinutes` | after X minutes of music without speech | time of day (not the clock: the block is produced ahead of time) |
| `groupTransition` | between groups | group names |

- **Two music sources.** AI groups: Gemini proposes songs from the group's taste (or the station's taste), the owner's 👍/👎 on songs and, if connected, the listening profile; Spotify search resolves them (AI → Spotify). Playlist groups: the Worker reads the owner's playlists (with the owner's token when the listening profile is connected, which also covers private playlists; otherwise the app token, public playlists only), shuffles them in code and prefers tracks that did not play recently. Playlist tracks are never sent to an AI provider, not even in the avoid list, so their moderation stays generic: transitions, time of day, the next show.
- Several triggers at the same place become one moderation. If no configured trigger fires (for example only `beforeTrack` with playlist groups), the block still opens with a moderation: every block has generated speech. At least one trigger must be on.
- The rotation continues across blocks: the next block of the show starts with the group after the last one played.
- The block is one timeline item with the same `parts` as a music hour, so the Android app plays it without changes. Verification is `off` (the moderations carry no researched claims). A block counts once towards `DAILY_GENERATIONS`; its moderations count towards `DAILY_TTS_CHARACTERS`.
- **No ducking.** ai-radio-station lowers the music and speaks over it; we never overlay speech on Spotify audio. Moderation plays between tracks.
- **Never cut a track.** Hand over when Spotify reports the track change, not a few seconds before the end.
- **Pre-produced.** Moderation is produced with the rest of the timeline, not live, so the handoff has no generation latency.

## Playback handoff (Android)

- Our segment ends → start the Spotify URI via App Remote → subscribe to player state.
- The Spotify track ends or changes → pause Spotify immediately → play the next segment through Media3.
- Spotify may briefly start the following track or autoplay before the pause takes effect; measure this and minimize it (single-track playback, pause on track change).
- Implementation: each track is a silent placeholder in the Media3 playlist (track title, duration plus one minute), so the media session covers music and speech alike. On a placeholder the player stops handling audio focus and App Remote plays the URI; `TrackWatch` (core, tested) decides the end from Spotify's player state; the playlist then moves to the next spoken part and the player takes focus back. The Worker hands the public client ID to the app with the timeline.
- Our segments are prefetched from R2, so short network loss does not stop the program. News items carry an expiry and are skipped when stale.
- Acceptance test: 60 minutes screen-off with at least 10 handoffs, lock-screen/Bluetooth controls, an incoming call and a network change. The existing [Android test](android-test.md) covers our own audio only.

## Content quality and safety

- Sources are untrusted data, never instructions. Feed fetching keeps its limits: HTTPS only, no redirects, no IP literals or local hosts, 500 KB, 20 entries.
- Each segment exposes its sources in the Android app. Segments without `strict` verification are never presented as verified news.
- Deduplicate against memory so the same story is not retold. Never invent replacement news when production fails; play prepared content or music instead.
- Cost control: D1 quotas per day (requests, TTS characters, feed fetches), budget reserved before TTS, horizon capped, audio cached by script + voice + model + settings hash.

## Security

Public repository, private application. Cloudflare Access protects the Worker API. The Android app authenticates with an Access service token; the Worker accepts a JWT whose `common_name` equals `ACCESS_SERVICE_TOKEN_ID` as the owner. Further listeners (`LISTENERS`, `server/listeners.ts`) each have their own service token and act as their own owner ID (`listener:<name>`): every table and bucket key is already per owner, the cron and the queue serve every station, and a `:kids` station reads its settings through `forKids` (fixed child-safety rules in front of the host, every show and every agent, production only) and uses a Spotify catalog that skips explicit tracks. The app sends the token only to the configured origin; audio URLs that would leave it are rejected. Provider keys and the Spotify client secret for app-token search live only in Worker secrets. Log sanitized errors, not provider response bodies, secrets or full prompts. Define retention for audio in R2 (e.g. delete played segments after 7 days).

## Adopted from ai-radio-station

[ai-radio-station](https://github.com/BetaHuhn/ai-radio-station) is a local macOS command-line DJ for Spotify playlists. It confirms the conductor approach (pause Spotify, speak, play the next track). Adopted: segment triggers and playlist groups (milestone 3), host persona and YAML configuration (done), per-show tools with template values — weather via Open-Meteo, headlines, MCP servers — and a topic memory of recent segments (milestone 4), ElevenLabs as an additional TTS adapter (milestone 4). Not adopted: speech plays on the computer's speakers rather than on the listening device, Spotify metadata goes to the LLM, speech is overlaid on music (ducking), librespot (an unofficial Spotify client), no persistence, learning or pre-production, and news limited to headline titles without sources.

## Current state and gaps

Built and in daily use: the Worker with Access, D1, R2, Queue and cron; research, writing, final edit, jury and fact check; the building blocks, day plan, surprises and follow-ups; music hours, music blocks and songs through Spotify; configurable agents with trials, quality trend and usage; the Android app (Compose: Hören, Programm, Archiv, Studio) with Media3 playback, Spotify handoff, station sound and in-app updates; the web studio for settings.

Remaining gaps:

- The one-off `POST /api/segments` flow still produces synchronously in the browser request; it stays as a manual single-segment tool, and its frontend error messages are derived from provider error text rather than stable codes.
- Topics are still a fixed list of three next to free interests; shows carry the real editorial direction.
- The app prefetches the next four segments; a longer offline buffer (30–60 minutes) is planned.

## Milestones

1. **Program on the server** (done): D1 configuration, timeline, feedback and memory; queue production with R2 audio; cron horizon with listener gate; authenticated timeline API.
2. **Android app** (done): Media3 service, timeline sync, prefetch, feedback, service-token auth, embedded studio, in-app updates, Compose screens with a mini player.
3. **Spotify in the app** (done): App Remote, music hours, music blocks with moderation triggers, AI picks and playlist groups, listening profile.
4. **Customization** (done): tools (date, weather, headlines), building blocks, day plan, configurable agents, station sound, surprises. Open: ElevenLabs as TTS option, MCP tools.
5. **Learning and memory** (in progress): feedback weights, 👎 reasons as listener notes, quality trend. Open: per-kind learning for surprises, series.
6. **Next:** surprises step 2, longer offline buffer, Google Drive archive for liked items.
7. **Later:** continuous stream mode without Spotify (Icecast/HLS) for car and speakers. It needs a long-running process with audio tooling (for example a container), not a Worker.
8. **Agentic production** (beta): the music-hour editorial team runs on the agent registry with durable steps; see [agentic workflow spike](agentic-workflow-spike.md).

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
