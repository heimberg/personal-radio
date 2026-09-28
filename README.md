# Personal Radio

A personal radio station: AI-hosted, researched spoken segments and music hours with Spotify, produced ahead of time on a private Cloudflare Worker and played in one Android app.

- **Program:** the Worker plans a timeline from the station configuration (host persona, shows, program clock) and produces it in the background: web research grounded in Google Search or your feeds, scripts written by Gemini (ASK optional), source verification, expressive Gemini voices that follow a speaking style (Mistral optional). Segments show their sources and search queries.
- **Music hours:** artist, genre and theme hours alternate AI moderation with songs. The AI picks the songs; Spotify only resolves them to tracks. Nothing from Spotify is sent to an AI provider.
- **Android app** ([docs/android.md](docs/android.md)): the only user-facing app for listening, program controls, feedback, configuration and immediate production. It plays spoken segments natively and hands over to Spotify for music hours.

## Develop

Node.js 24 or later.

```sh
npm ci
npm run dev        # local frontend development; the API needs the Worker
npm run check      # TypeScript
npm test           # unit and Worker tests (D1 via node:sqlite)
npx playwright test
npm run build
```

Android: `cd android && ./gradlew -p core test` for the program logic; CI builds and signs the APK.

## Deploy

Merges into `feat/ai-segment-pipeline` deploy the Worker (migrations included) through GitHub Actions. Account setup, Access, secrets and variables: [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md). CI details: [docs/deployment.md](docs/deployment.md). Architecture and roadmap: [docs/architecture.md](docs/architecture.md).

## Privacy

Keys live only in Worker secrets and GitHub Actions secrets. Do not commit keys, the signing keystore, exports or generated personal audio. Spotify audio and playback data never reach an AI provider; only the owner's top artists do, and only if the owner connects the listening profile. A voice supplied to Mistral must be authorized for that use.

No project license has been selected yet; public visibility alone does not grant an open-source license.
