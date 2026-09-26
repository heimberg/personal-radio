# CI and private deployment

CI runs on pull requests and main pushes. It installs the lockfile, checks TypeScript, runs offline unit/provider tests and builds `dist/`. The seven-day `personal-radio-web` artifact contains only the frontend. No real provider calls or secrets are needed. Actions are pinned to commit SHAs, workflow permissions are read-only, and Dependabot proposes updates.

The user authorized public GitHub Pages hosting for the mobile audio prototype and a local interest-learning simulation. After successful tests and build, CI deploys Pages from `main` or the explicitly selected `feat/ai-segment-pipeline` demo branch. Pull-request events never deploy. The demo branch build hides feed and AI generation controls; it contains no live news, provider credentials or private backend, and stores its test profile and feedback only in browser storage. Deployment has job-scoped pages/id-token permissions and uses the github-pages environment; no personal token is required.

One-time repository setting: Settings → Pages → Build and deployment → Source: GitHub Actions. If not enabled, the deployment job will fail; enable this setting, then rerun the failed job. Expected address: https://heimberg.github.io/personal-radio/ (only live after successful deployment).

The public demo uses generated test tones, visitor-selected local audio and illustrative sample topics. It does not fetch feeds, generate AI content, upload local audio or send profile/feedback data to a server. The later personalized application and paid backend still require private access control.

## Target once hosting is selected

1. Private/authenticated preview environment with HTTPS.
2. Deploy exactly the tested build artifact to staging, run HTTP and mobile smoke tests.
3. Promote the same version to production through a protected GitHub Environment.
4. Use short-lived workload identity where supported; otherwise restrict deployment credentials to their environment.
5. Run the editorial API/worker separately from the static frontend. Set ASK and Mistral credentials in server secrets; no VITE_ secrets.
6. Apply API authentication, rate limits and actual generation budget enforcement before enabling paid operations.

The private Worker target is now Cloudflare Workers + D1 + Cloudflare Access; see [cloudflare-deployment.md](cloudflare-deployment.md). It is not provisioned or deployed yet. The Pages app remains a public local-only prototype. PWA installability, caching and update behavior come later.

Before merging, inspect CI. GitHub may require a repository owner's approval or workflow permission changes for initial runs. Branch protection is not set by this commit; configure required CI checks and review once the workflow exists. Never bypass failed checks to deploy.
