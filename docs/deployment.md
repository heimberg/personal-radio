# CI and private deployment

CI runs on pull requests and main pushes. It installs the lockfile, checks TypeScript, runs offline unit/provider tests and builds `dist/`. The seven-day `personal-radio-web` artifact contains only the frontend. No real provider calls or secrets are needed. Actions are pinned to commit SHAs, workflow permissions are read-only, and Dependabot proposes updates.

No public deployment is enabled. Repository visibility does not authorize exposing personal profiles, paid provider endpoints or ASK. No Azure resources, billing or accounts are created by this prototype.

## Target once hosting is selected

1. Private/authenticated preview environment with HTTPS.
2. Deploy exactly the tested build artifact to staging, run HTTP and mobile smoke tests.
3. Promote the same version to production through a protected GitHub Environment.
4. Use short-lived workload identity where supported; otherwise restrict deployment credentials to their environment.
5. Run the editorial API/worker separately from the static frontend. Set ASK and Mistral credentials in server secrets; no VITE_ secrets.
6. Apply API authentication, rate limits and actual generation budget enforcement before enabling paid operations.

Azure Static Web Apps is an option, not yet a provisioned dependency. Choose its authentication/access-control plan and worker hosting after checking ASK reachability. If public hosting is chosen for this audio-only demo, explicitly agree that separately from private production. PWA installability, caching and update behavior come later.

Before merging, inspect CI. GitHub may require a repository owner's approval or workflow permission changes for initial runs. Branch protection is not set by this commit; configure required CI checks and review once the workflow exists. Never bypass failed checks to deploy.
