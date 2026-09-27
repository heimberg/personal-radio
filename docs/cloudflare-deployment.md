# Private Cloudflare deployment

The hosted app uses one Cloudflare Worker for the built web app and its authenticated API endpoints, D1 for durable daily limits, and Cloudflare Access for the login gate. It serves the web cockpit and the program API behind Access.

## Cost and limits

Workers and D1 have free plans. Access is free for small teams (currently up to 50 users). Free D1 has daily query/row limits; requests fail after those quotas are exhausted until reset. Cloudflare's paid Workers plan currently starts at USD 5/month. These platform limits do not include any charges from ASK or Mistral. The application independently caps one allowed email at 24 segment requests, 60 feed fetches and 12,000 TTS characters per UTC day. Tune these values as Worker variables in the Cloudflare dashboard (Worker → Settings → Variables and Secrets); they take effect without a deploy. `wrangler.toml` deliberately sets no `[vars]`, because values there would overwrite the dashboard on every deploy; its comment lists all optional variables with their defaults. D1 limits are also enforced atomically in the database across Worker instances.

## One-time account setup

1. Create or use a Cloudflare account. Install Node 24, then authenticate Wrangler with `npx wrangler login`.
2. Create the persistent database with `npx wrangler d1 create personal-radio`. Copy the returned database ID into `wrangler.toml` in place of `REPLACE_WITH_D1_DATABASE_ID`.
3. Create the audio bucket and the production queue, either in the dashboard (R2 → Create bucket; Queues → Create queue) or with Wrangler. The names must match `wrangler.toml`:

   ```sh
   npx wrangler r2 bucket create personal-radio-audio
   npx wrangler queues create personal-radio-production
   ```

   The deploy fails until both exist. These are bindings, not variables, so they stay in `wrangler.toml`. The cron trigger (every 10 minutes) is registered by the deploy itself.
4. In the GitHub repository settings, add Actions secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, Workers R2 Storage and Queues edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
5. Run **Actions → Deploy private Worker → Run workflow**. The workflow builds the app, applies D1 migrations, then deploys the Worker. This first deployment has no provider credentials and rejects requests until Access and its identity settings are configured.
6. In Cloudflare, open the Worker `personal-radio-private` → **Settings → Domains & Routes**. Enable Cloudflare Access for the `workers.dev` URL. Create an allow policy for only your email. Cloudflare documents Access protection for Workers and JWT validation in the Worker itself.
7. From the Access application, copy the team-domain hostname (without `https://`) and the Application Audience (AUD) tag. Set the Worker secrets, either in the dashboard (Worker → Settings → Variables and Secrets, type *Secret*) or with Wrangler:

   ```sh
   npx wrangler secret put ACCESS_TEAM_DOMAIN
   npx wrangler secret put ACCESS_AUD
   npx wrangler secret put ALLOWED_EMAIL
   npx wrangler secret put ASK_BASE_URL
   npx wrangler secret put ASK_API_KEY
   npx wrangler secret put MISTRAL_API_KEY
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put ACCESS_SERVICE_TOKEN_ID   # Client ID of the Android app's service token, see android.md
   ```

   Use the ASK HTTPS API base URL, for example `https://ask.ict-tfbern.ch/api/v1`, and the authorized ASK model credentials. The ASK endpoint must allow outbound HTTPS from Cloudflare Workers; verify connectivity and organizational authorization before use. Keep all credentials out of `wrangler.toml`, GitHub source and frontend variables. After setting `MISTRAL_API_KEY`, deploy the Worker and open the private app while signed in through Cloudflare Access. The brief-segment form loads available voices from the authenticated `/api/mistral-voices` route. Choose one there; the selection is stored on that device and sent to the Worker for each brief. No `MISTRAL_VOICE_ID` secret is needed unless you want a server-side fallback. Voxtral supports German, though the available preset voice language and accent can affect pronunciation.

8. Run the deploy workflow again after setting secrets. Open the `workers.dev` URL and confirm Cloudflare Access requires sign-in. The app checks the Access JWT signature, issuer, audience and exact allowed email on every page and API request, even if the Access policy is accidentally bypassed.

## Program production

**Providers:** `GEMINI_API_KEY` is the main key: Gemini writes briefs and dialogs, researches web shows with Google Search and verifies when ASK is absent. Use a billed Gemini project (paid tier). `ASK_API_KEY` is optional; when set, ASK verifies `strict` shows as an independent second model and shows with `textProvider: ask` write with it. `GEMINI_RESEARCH_MODEL` optionally overrides the research model (default `GEMINI_TEXT_MODEL`). Grounded research requests are billed separately beyond Google's free daily allowance. Migration `0003_research.sql` stores the search queries. Artist hours additionally need `SPOTIFY_CLIENT_ID` (variable) and `SPOTIFY_CLIENT_SECRET` (secret) from the Spotify developer app for track search; `SPOTIFY_MARKET` (default `CH`) selects the catalogue.


Once the station is configured in the app ("Einstellungen dieses Geräts übernehmen"), the Worker plans and produces the program on its own: the cron trigger tops up the timeline while you listen, the queue consumer produces one segment at a time, and audio is stored in R2. D1 migration `0002_station.sql` adds the tables; the deploy workflow applies it. Production counts against the same daily limits as manual segments (`DAILY_GENERATIONS`, `DAILY_FEED_REQUESTS`, `DAILY_TTS_CHARACTERS`); with 2-minute segments, one hour of listening needs about 30 generations, so raise `DAILY_GENERATIONS` deliberately. The Workers Paid plan is recommended because decoding provider audio can exceed the Free plan's CPU time per invocation.

## Test the route

The API is `POST /api/segments`, same-origin JSON. Send `Idempotency-Key` (12–100 characters) with `{ "profile": ..., "sources": [...], "mode": "brief" | "podcast" }`. `brief` keeps ASK generation, ASK source-quote verification and Mistral MP3 TTS. `podcast` uses Gemini 3.8 Flash to create the source-bound two-host dialog, ASK to check cited claims, then Gemini 3.8 Flash TTS for a two-voice WAV. Both Gemini models and the two voices are configurable as non-secret Worker vars; set the Gemini API key with `wrangler secret put`. A successful response includes audio plus title, cited source IDs and recognized interest tags in headers. Missing/invalid Access identity returns 401, cross-origin requests are rejected, a daily request limit returns 429, and a D1 outage fails closed with 503. Gemini receives source excerpts, explicit interests and learned topic weights only when a podcast is requested. Learning feedback and its raw history are stored only in the device's local storage.

The private app offers a mobile-friendly source form and lets the user save up to 20 RSS/Atom feed URLs in that device's local storage. Feed retrieval is limited to 60 requests per owner per UTC day. The Worker allows HTTPS only, rejects redirects and local/IP-literal targets, and caps a feed at 500 KB and 20 entries. Feed entries are ranked using explicit topics/interests, local feedback-derived weights and an exploration allowance; the best match is preselected. 👍/👎 are strong signals; completion is weak positive; an early skip is ignored and a later skip is weak negative. Weights decay over time and remain local. A selected entry is editable and is sent to the chosen provider only after the user submits generation. Review each feed's terms and rights before use; feed availability does not grant reuse rights. The verifier asks ASK to enumerate factual claims and supply direct supporting quotes; the Worker requires each quoted excerpt to match the supplied source text and each source ID to be cited by the script. This is an LLM-assisted check, not a guarantee of truth. The in-flight duplicate guard is isolate-local; persistent daily limits cap provider use, but completed-request audio is not durably cached.

For local work, `npx wrangler dev` uses local D1 data by default. Do not point local development at production D1. Use mocked provider tests (`npm test`) and the CI build before deployment.
