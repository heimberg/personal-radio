# CI and private deployment

CI runs on pull requests and main pushes. It installs the lockfile, checks TypeScript, runs offline unit/provider tests and builds `dist/`. The seven-day `personal-radio-web` artifact contains only the frontend. No real provider calls or secrets are needed. Actions are pinned to commit SHAs, workflow permissions are read-only, and Dependabot proposes updates.

The user authorized public GitHub Pages hosting for the audio-only prototype. After successful tests and build on main, CI packages the same dist/ directory and deploys it to Pages. Pull requests never deploy. Deployment has job-scoped pages/id-token permissions and uses the github-pages environment; no personal token is required. No Azure resources, billing, provider endpoints or credentials are exposed.

One-time repository setting: Settings → Pages → Build and deployment → Source: GitHub Actions. If not enabled, the deployment job will fail; enable this setting, then rerun the failed job. Expected address: https://heimberg.github.io/personal-radio/ (only live after successful deployment).

This authorization covers the local audio demo only. The later personalized application and paid backend still require private access control. The demo stores preferences on the visitor's device and does not upload local audio files.

## Target once hosting is selected

1. Private/authenticated preview environment with HTTPS.
2. Deploy exactly the tested build artifact to staging, run HTTP and mobile smoke tests.
3. Promote the same version to production through a protected GitHub Environment.
4. Use short-lived workload identity where supported; otherwise restrict deployment credentials to their environment.
5. Run the editorial API/worker separately from the static frontend. Set ASK and Mistral credentials in server secrets; no VITE_ secrets.
6. Apply API authentication, rate limits and actual generation budget enforcement before enabling paid operations.

The private Worker target is now Cloudflare Workers + D1 + Cloudflare Access; see [cloudflare-deployment.md](cloudflare-deployment.md). It is not provisioned or deployed yet. The Pages app remains the approved public audio-only demo. PWA installability, caching and update behavior come later.

Before merging, inspect CI. GitHub may require a repository owner's approval or workflow permission changes for initial runs. Branch protection is not set by this commit; configure required CI checks and review once the workflow exists. Never bypass failed checks to deploy.
