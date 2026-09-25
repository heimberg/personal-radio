# Private Cloudflare deployment

The hosted app uses one Cloudflare Worker for the built web app and `/api/segments`, D1 for durable daily limits, and Cloudflare Access for the login gate. The public GitHub Pages demo remains a separate static demo and never receives provider credentials.

## Cost and limits

Workers and D1 have free plans. Access is free for small teams (currently up to 50 users). Free D1 has daily query/row limits; requests fail after those quotas are exhausted until reset. Cloudflare's paid Workers plan currently starts at USD 5/month. These platform limits do not include any charges from ASK or Mistral. The application independently caps one allowed email at 24 segment requests and 12,000 TTS characters per UTC day. Tune these values in `wrangler.toml`; changes require a deploy. D1 limits are also enforced atomically in the database across Worker instances.

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
   ```

   Use the ASK HTTPS API base URL, for example `https://ask.ict-tfbern.ch/api/v1`, and the authorized ASK model credentials. The ASK endpoint must allow outbound HTTPS from Cloudflare Workers; verify connectivity and organizational authorization before use. Mistral credentials and an authorized voice are also required. Keep all values out of `wrangler.toml`, GitHub source and frontend variables.

7. Run the deploy workflow again after setting secrets. Open the `workers.dev` URL and confirm Cloudflare Access requires sign-in. The app checks the Access JWT signature, issuer, audience and exact allowed email on every page and API request, even if the Access policy is accidentally bypassed.

## Test the route

The API is `POST /api/segments`, same-origin JSON. Send `Idempotency-Key` (12–100 characters) with `{ "profile": ..., "sources": [...] }`. A successful response is MP3 audio; title and cited source IDs are returned in response headers. Missing/invalid Access identity returns 401, cross-origin requests are rejected, a daily request limit returns 429, and a D1 outage fails closed with 503.

The verifier asks ASK to enumerate factual claims and supply direct supporting quotes; the Worker requires each quoted excerpt to match the supplied source text and each source ID to be cited by the script. This is an LLM-assisted check, not a guarantee of truth or a substitute for a curated source-ingestion service. The endpoint is an internal vertical slice: it accepts a bounded set of source records but does not yet fetch feeds or integrate generated audio into the player. The in-flight duplicate guard is isolate-local; the persistent request and character limits prevent runaway provider use, but completed-request audio is not yet durably cached.

For local work, `npx wrangler dev` uses local D1 data by default. Do not point local development at production D1. Use mocked provider tests (`npm test`) and the CI build before deployment.
