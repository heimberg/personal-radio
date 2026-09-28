# CI and deployment

**CI** (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main` and `feat/ai-segment-pipeline`: lockfile install, TypeScript check, unit and Worker tests, Playwright tests for the frontend/API, build, and `wrangler deploy --dry-run`. The seven-day `personal-radio-web` artifact contains the built frontend assets. They are the web cockpit, which the Worker serves and the Android app embeds. No provider calls or secrets are needed. Actions are pinned to commit SHAs and workflow permissions are read-only.

**Worker deploy** (`.github/workflows/deploy-worker.yml`) runs after a green CI on pushes to `feat/ai-segment-pipeline`: build, D1 migrations, `wrangler deploy`. It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Worker variables and secrets are kept in the Cloudflare dashboard (`keep_vars = true`); see [cloudflare-deployment.md](cloudflare-deployment.md).

**Android** (`.github/workflows/android.yml`) runs on changes under `android/`: Kotlin core tests, then a signed release APK as the artifact `personal-radio-android` (30 days); see [android.md](android.md).

The former public GitHub Pages demo (test tones and a local learning simulation) has been removed. If it was enabled, turn off Settings → Pages in the repository.

Never bypass failed checks to deploy.
