# Private Cloudflare deployment

The hosted app uses one Cloudflare Worker for the built web app and its authenticated API endpoints, D1 for durable daily limits, and Cloudflare Access for the login gate. The public GitHub Pages demo remains a separate static demo and never receives provider credentials.

## Cost and limits

Workers and D1 have free plans. Access is free for small teams (currently up to 50 users). Free D1 has daily query/row limits; requests fail after those quotas are exhausted until reset. Cloudflare's paid Workers plan currently starts at USD 5/month. These platform limits do not include any charges from ASK or Mistral. The application independently caps one allowed email at 24 segment requests, 60 feed fetches and 12,000 TTS characters per UTC day. Tune these values in `wrangler.toml`; changes require a deploy. D1 limits are also enforced atomically in the database across Worker instances.

## One-time account setup

1. Create or use a Cloudflare account. Install Node 24, then authenticate Wrangler with `npx wrangler login`.
2. Create the persistent database with `npx wrangler d1 create personal-radio`. Copy the returned database ID into `wrangler.toml` in place of `REPLACE_WITH_D1_DATABASE_ID`.
3. In the GitHub repository settings, add Actions secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts and D1 edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
4. Run **Actions → Deploy private Worker → Run workflow**. The workflow builds the app, applies D1 migrations, then deploys the Worker. This first deployment has no provider credentials and rejects requests until Access and its identity settings are configured.
5. In Cloudflare, open the Worker `personal-radio-private` → **Settings → Domains & Routes**. Enable Cloudflare Access for the `workers.dev` URL. Create an allow policy for only your email. Cloudflare documents Access protection for Workers and JWT validation in the Worker itself.
6. From the Access application, copy the team-domain hostname (without `https://`) and the Application Audience (AUD) tag. Set Worker secrets:

   ```sh
   npx wrangler secret put ACCESS_TEAM_DOMAIN
   npx wrangler secret put ACCESS_AUD
   npx wrangler secret put ALLOWED_EMAIL
   npx wrangler secret put ASK_BASE_URL
   npx wrangler secret put ASK_API_KEY
   npx wrangler secret put MISTRAL_API_KEY
   npx wrangler secret put MISTRAL_VOICE_ID
   npx wrangler secret put GEMINI_API_KEY
   ```

   Use the ASK HTTPS API base URL, for example `https://ask.ict-tfbern.ch/api/v1`, and the authorized ASK model credentials. The ASK endpoint must allow outbound HTTPS from Cloudflare Workers; verify connectivity and organizational authorization before use. Mistral credentials and an authorized voice are also required. Keep all values out of `wrangler.toml`, GitHub source and frontend variables.

7. Run the deploy workflow again after setting secrets. Open the `workers.dev` URL and confirm Cloudflare Access requires sign-in. The app checks the Access JWT signature, issuer, audience and exact allowed email on every page and API request, even if the Access policy is accidentally bypassed.

## Test the route

The API is `POST /api/segments`, same-origin JSON. Send `Idempotency-Key` (12–100 characters) with `{ "profile": ..., "sources": [...], "mode": "brief" | "podcast" }`. `brief` keeps ASK generation, ASK source-quote verification and Mistral MP3 TTS. `podcast` uses Gemini 3.8 Flash to create the source-bound two-host dialog, ASK to check cited claims, then Gemini 3.8 Flash TTS for a two-voice WAV. Both Gemini models and the two voices are configurable as non-secret Worker vars; set the Gemini API key with `wrangler secret put`. A successful response includes audio plus title, cited source IDs and recognized interest tags in headers. Missing/invalid Access identity returns 401, cross-origin requests are rejected, a daily request limit returns 429, and a D1 outage fails closed with 503. Gemini receives source excerpts, explicit interests and learned topic weights only when a podcast is requested. Learning feedback and its raw history are stored only in the device's local storage.

The private app offers a mobile-friendly source form and lets the user save up to 20 RSS/Atom feed URLs in that device's local storage. Feed retrieval is limited to 60 requests per owner per UTC day. The Worker allows HTTPS only, rejects redirects and local/IP-literal targets, and caps a feed at 500 KB and 20 entries. Feed entries are ranked using explicit topics/interests, local feedback-derived weights and an exploration allowance; the best match is preselected. 👍/👎 are strong signals; completion is weak positive; an early skip is ignored and a later skip is weak negative. Weights decay over time and remain local. A selected entry is editable and is sent to the chosen provider only after the user submits generation. Review each feed's terms and rights before use; feed availability does not grant reuse rights. The verifier asks ASK to enumerate factual claims and supply direct supporting quotes; the Worker requires each quoted excerpt to match the supplied source text and each source ID to be cited by the script. This is an LLM-assisted check, not a guarantee of truth. The in-flight duplicate guard is isolate-local; persistent daily limits cap provider use, but completed-request audio is not durably cached.

For local work, `npx wrangler dev` uses local D1 data by default. Do not point local development at production D1. Use mocked provider tests (`npm test`) and the CI build before deployment.
