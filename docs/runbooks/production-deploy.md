# production deploy runbook

This runbook is for maintainers shipping a normal Owlette production release after
the release content has already been reviewed. It is written as an at-any-hour
checklist for the web app, Cloud Functions, Firestore rules, storage rules, and
the docs site.

> **scope**: regular production release of web + functions + Firestore rules + storage rules + docs site. For agent installer releases see [agent-installer-release.md](agent-installer-release.md). For emergency fixes see [hotfix-rollback.md](hotfix-rollback.md).

## prerequisites

- Railway access for both web services:
  - dev branch service deploys to `https://dev.owlette.app`
  - main branch service deploys to `https://owlette.app`
- Firebase CLI installed and logged in with access to:
  - dev project `owlette-dev-3838a`
  - prod project `owlette-prod-90a12`
- Local checkout has the release branch or `dev` branch ready to promote.
- Local working tree is understood before starting; do not mix unrelated changes
  into the release commit.
- `OWLETTE_API_KEY` available in `.claude/.env.local` or equivalent local shell
  setup for smoke scripts that need an API key.
- A real site id and API key for the R2 round-trip smoke test.
- npm install behavior must match production:
  - Railway uses Nixpacks pinned to `nodejs_20` and `npm-10_x`
  - install command is `npm ci --legacy-peer-deps`
- Firebase deploy permissions for functions, Firestore, and storage.
- Access to Instatus if status-page component checks fail.
- Access to Cloudflare R2 credentials if R2 smoke checks fail.
- Awareness of whether this release changes any of these surfaces:
  - web app
  - Cloud Functions
  - Firestore rules
  - Firestore indexes
  - storage rules
  - docs
- The production Railway service should have `ROOST_ENV=prod` set explicitly.
- Confirm once before the first production deploy you run that the Railway prod
  service points at the production Firebase project, `owlette-prod-90a12`.
- Do not use this runbook for agent installer releases.
- Do not use this runbook for emergency hotfix rollback work.

## summary: what auto-deploys and what doesn't

| surface | trigger | automation | required action |
| --- | --- | --- | --- |
| web dev | push to `dev` | Railway auto-deploys dev service to `https://dev.owlette.app` | push release candidate to `dev`, then verify |
| web prod | push or merge to `main` | Railway auto-deploys prod service to `https://owlette.app` | merge `dev` to `main`, then verify |
| Cloud Functions | none | no CI workflow | run `firebase use prod && firebase deploy --only functions` if functions changed |
| Firestore rules and indexes | none | no CI workflow | run `firebase deploy --only firestore` if rules or indexes changed |
| storage rules | none | no CI workflow | run `firebase deploy --only storage` if storage rules changed |
| docs site | push to `main` touching `docs/**` or `mkdocs.yml` | `.github/workflows/deploy-docs.yml` publishes to `gh-pages` | merge docs changes to `main`; watch workflow |
| CLI npm package | tag push matching `cli-v[0-9]+.[0-9]+.[0-9]+` | `.github/workflows/cli-publish.yml` publishes to npm with provenance | out of scope here |
| agent installer | separate release process | separate runbook | use [agent-installer-release.md](agent-installer-release.md) |

## step-by-step: a normal release

1. Update `/docs/changelog.md`.

   Add the release notes before bumping versions or building release artifacts.
   The changelog should describe user-visible changes, operational changes, and
   any migration or deployment ordering requirements.

   Confirm this is a regular release before proceeding. If production is already
   degraded and the goal is to reverse or patch an incident, use
   [hotfix-rollback.md](hotfix-rollback.md).

2. Bump versions.

   Use the version sync script when this release should advance the app version:

   ```sh
   node scripts/sync-versions.js X.Y.Z
   ```

   The script updates these files together:

   - `/VERSION`
   - `/agent/VERSION`
   - `/web/package.json`

   It does not update `firestore.rules`. Firestore rules carry their own
   `security-schema` version and are versioned independently.

   If no version argument is supplied, the script defaults to a patch bump. Do
   not assume that every new feature is a minor release.

   If this production release is coordinated with a later agent installer
   release, the version bump and `/docs/changelog.md` update must happen before
   the installer is built. The installer bakes the version into the EXE
   filename.

3. Run preflight checks.

   Run the repo's normal local checks that apply to the surfaces being changed:

   - lint checks
   - TypeScript checks
   - Jest tests
   - e2e tests where appropriate
   - any surface-specific validation required by the change

   Do not skip TypeScript for function changes. The Firebase predeploy hook
   also runs the functions build, but catching failures before deploy keeps the
   production deploy step boring.

   If the release includes Firestore rule changes that depend on a data
   migration, the migration must run before Firestore rules are deployed.
   Deploying rules first can lock live admins out.

4. Commit and push to `dev`.

   Commit the changelog, version bump, and code changes together according to
   the repo's normal release practice. Do not include unrelated local edits.

   Railway auto-deploys the web service for `dev` to:

   ```text
   https://dev.owlette.app
   ```

   Watch the Railway build. The web build uses:

   - `web/railway.toml`
   - `web/nixpacks.toml`
   - Nixpacks pinned to `nodejs_20` and `npm-10_x`
   - `npm ci --legacy-peer-deps`

   A "multiple lockfiles" warning when running tools at the repo root is
   cosmetic. Do not add `turbopack.root` to `next.config.ts`; that caused a
   59 GB node fork-bomb on 2026-04-29.

5. Verify dev.

   Load the dev web app manually and check the main flows touched by the
   release. At minimum, confirm login, dashboard load, and any changed workflow.

   Run the status-page readiness smoke check against dev if the dev environment
   is expected to be fully wired for the release:

   ```sh
   /scripts/check-status-page-ready.mjs --base-url https://dev.owlette.app
   ```

   Run the R2 round-trip smoke check against dev when the release touches
   upload, manifest, content, API key, storage, or worker-adjacent behavior:

   ```sh
   /scripts/smoke-r2-roundtrip.mjs --base-url https://dev.owlette.app --site <id> --api-key owk_xxx
   ```

6. Merge `dev` to `main`.

   The current promotion pattern is manual merge commits, not squash commits.
   A typical merge commit message is:

    ```text
    chore: merge dev for vX.Y.Z production release
    ```

    This repo has historically had `dev` far ahead of `main`, and `main` has
   also had commits not present in `dev`. Treat the merge as a real promotion
   step, not a mechanical afterthought.

   Push `main`. Railway auto-deploys the production web service to:

   ```text
   https://owlette.app
   ```

   Watch the production Railway build through completion before running the
   production smoke checklist.

7. Deploy Cloud Functions if functions changed.

   Cloud Functions have no CI deployment workflow. Deploy them manually:

    ```sh
    firebase use prod && firebase deploy --only functions
    ```

    The Firebase predeploy hook runs the functions build:

   ```sh
   npm --prefix functions run build
   ```

8. Deploy Firestore rules and indexes if they changed.

   Use the production Firebase project and deploy Firestore:

    ```sh
    firebase deploy --only firestore
    ```

   This deploy covers both Firestore rules and indexes. If the rule change
   depends on a data migration, the migration must already be complete before
   this command runs.

9. Deploy storage rules if they changed.

   Storage rules have no CI deployment workflow. Deploy them manually:

   ```sh
   firebase deploy --only storage
   ```

10. Run production post-deploy smoke checks.

    Use the checklist in the next section. There is no automated post-deploy
    smoke job, so the maintainer running the release owns these checks.

    There is no `/api/health` endpoint. The closest "is prod alive" checks are
    loading the dashboard and running the smoke scripts.

    Confirm docs deployment if docs changed.

    The docs site publishes from `.github/workflows/deploy-docs.yml` when a
    push to `main` touches:

    - `docs/**`
    - `mkdocs.yml`

    The workflow publishes to `gh-pages`. Watch it if the release includes docs
    changes.

11. Tag the release and record completion.

    Tag discipline has lapsed. Only `v2.0.43`, `v2.0.46`, and `v2.0.47` exist,
    while releases `2.6.0` through `2.11.0` are not tagged. Resume tagging for
    production releases so rollback, audit, and release comparison work are
    easier later.

    Do not use the CLI package tag pattern unless releasing the CLI package.
    Tags matching `cli-v[0-9]+.[0-9]+.[0-9]+` trigger the npm publish workflow.

    Update the release thread, issue, or maintainer notes with:

    - production web deploy status
    - functions deploy status, if applicable
    - Firestore deploy status, if applicable
    - storage deploy status, if applicable
    - docs deploy status, if applicable
    - smoke script results
    - any follow-up rollback risk

    If `main` received release-only or hotfix commits that are not present in
    `dev`, plan the back-merge deliberately. Do not let release bookkeeping hide
    drift between branches.

## post-deploy smoke checklist

- [ ] Railway production deploy completed for `https://owlette.app`.
- [ ] If functions changed, `firebase use prod && firebase deploy --only functions`
  completed successfully.
- [ ] If Firestore rules or indexes changed, `firebase deploy --only firestore`
  completed successfully after any required migration.
- [ ] If storage rules changed, `firebase deploy --only storage` completed
  successfully.
- [ ] If docs changed, the docs deploy workflow completed and published to
  `gh-pages`.
- [ ] Status-page readiness script passed:

  ```sh
  /scripts/check-status-page-ready.mjs --base-url https://owlette.app
  ```

- [ ] R2 round-trip script passed with a real site id and API key:

  ```sh
  /scripts/smoke-r2-roundtrip.mjs --base-url https://owlette.app --site <id> --api-key owk_xxx
  ```

- [ ] Login works on `https://owlette.app`.
- [ ] Dashboard loads without server or client errors.
- [ ] Real-time updates work for a representative production workflow.
- [ ] Any release-specific changed workflow has been exercised.
- [ ] No smoke check used `/api/health`; that route does not exist.
- [ ] No smoke check used `/api/cron/health-check` as a free liveness probe; it
  is a write-side cron endpoint requiring `X-Cron-Secret`.
- [ ] If Instatus checks fail, verify the required component ids and optional
  status-page environment variables in Railway.
- [ ] If R2 checks fail, verify the production R2 endpoint, access key, secret
  key, and bucket routing.
- [ ] If Firebase auth or data checks fail, verify the production Firebase
  project id in the Railway service environment.
- [ ] Release notes or maintainer notes include the final smoke result.

## rollback (per surface)

### web

Rollback is a revert of the offending commit on the deployed branch, followed by
a push. Railway auto-redeploys after the push.

For dev:

```sh
git revert <offending-sha>
git push origin dev
```

For production:

```sh
git revert <offending-sha>
git push origin main
```

Use the branch that owns the broken deployment. If both dev and production are
affected, handle production first, then clean up branch drift deliberately.

### functions

The Firebase CLI does not directly support per-function rollback by version.
Redeploying previous source is the rollback.

```sh
git checkout <prev-sha> functions/
firebase use prod && firebase deploy --only functions
```

After rollback, restore the working tree intentionally so the previous source
checkout does not get mixed into unrelated follow-up work.

### firestore rules and indexes

Preferred console rollback for rules:

```text
Firebase Console > Firestore > Rules > History > Restore
```

Command-line rollback for rules:

```sh
git checkout HEAD~1 firestore.rules
firebase deploy --only firestore:rules
```

If the rollback reverses a rule change that depended on a data migration, review
the reverse ordering carefully. The same migration ordering trap can apply when
rolling backward.

For indexes, use the same Firestore deploy surface only when the checked-out
source reflects the intended index state:

```sh
firebase deploy --only firestore
```

### storage rules

Storage rules can be restored from console history or by redeploying previous
source.

```sh
git checkout HEAD~1 storage.rules
firebase deploy --only storage
```

Console history is also available for storage rules. Use it when it is the
fastest clear rollback path.

### docs

Docs rollback is a revert of the docs commit on `main`. The docs deploy workflow
reruns and republishes to `gh-pages`.

```sh
git revert <offending-docs-sha>
git push origin main
```

Watch `.github/workflows/deploy-docs.yml` after the push if the reverted commit
touches `docs/**` or `mkdocs.yml`.

## env vars maintained per environment

`/docs/setup/environment-variables.md` is the authoritative environment variable
reference. This section is only a release-time reminder of the categories that
must be maintained separately per environment.

| category | examples |
| --- | --- |
| Firebase public web config | `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` |
| Firebase server credentials | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` |
| session and encryption secrets | `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `LLM_ENCRYPTION_KEY` |
| R2 S3 access | `R2_S3_ENDPOINT`, `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY` |
| Redis | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| app base URL and cron | `NEXT_PUBLIC_BASE_URL`, `CRON_SECRET` |
| email | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `ADMIN_EMAIL_DEV`, `ADMIN_EMAIL_PROD` |
| status page | `INSTATUS_API_KEY`, `INSTATUS_PAGE_ID`, `INSTATUS_COMPONENT_*_ID` |
| internal services | `CORTEX_INTERNAL_SECRET` |
| environment override | `ROOST_ENV` |

Required production reminders:

- `SESSION_SECRET` must be at least 32 characters.
- `ROOST_ENV=prod` is recommended explicitly on the production Railway service.
- The production Firebase variables should point at `owlette-prod-90a12`.
- The production R2 variables should point at production buckets, not dev
  buckets.
- `INSTATUS_*` variables are optional, but the status-page readiness check needs
  the relevant values when status integration is expected to work.
- `CORTEX_INTERNAL_SECRET` is optional.
- Keep dev and prod Railway service variables separate; do not copy blindly
  between services.

## known caveats

- There is no `/api/health` endpoint. Use the dashboard and smoke scripts as the
  closest production liveness checks.
- `/api/cron/health-check` is not a free liveness probe. It is a cron write-side
  endpoint and requires `X-Cron-Secret`.
- Cloud Functions deploys are 100% manual. Railway web deploys do not deploy
  functions.
- Firestore rules and indexes deploys are 100% manual.
- Storage rules deploys are 100% manual.
- There is no automated post-deploy smoke job. The maintainer running the
  release must run smoke scripts manually.
- Tag discipline has lapsed. Resume production release tags to make future
  rollback and audit work easier.
- The mapping from Railway production service environment variables to
  `owlette-prod-90a12` is not pinned in the repo. Verify it directly in Railway,
  especially before your first production deploy.
- A dev-service-points-at-prod-Firebase footgun has not been ruled out by repo
  configuration alone.
- `npm ci` must use `--legacy-peer-deps` because `@ai-sdk/react@3.0.136` has a
  peer range that excludes the pinned `react@19.2.0`.
- Do not add `turbopack.root` to `next.config.ts` to silence the root lockfile
  warning. That previously caused a 59 GB node fork-bomb on 2026-04-29.
- Firestore rules are versioned independently from `/VERSION`, `/agent/VERSION`,
  and `/web/package.json`.
- R2 buckets are separate per environment and are provisioned through
  `scripts/provision-r2.mjs`.
- `web/lib/r2Client.server.ts` defaults to `dev` if no production signal is
  detected.
- If Railway's injected `RAILWAY_PUBLIC_DOMAIN` differs from `owlette.app`, the
  domain string match will not select prod. `ROOST_ENV=prod` avoids that class
  of mistake.
- Docs deploys only run for pushes to `main` touching `docs/**` or `mkdocs.yml`.
- CLI package publishing is tag-triggered and out of scope for this runbook.

## further reading

- [hotfix-rollback.md](hotfix-rollback.md)
- [agent-installer-release.md](agent-installer-release.md)
- [dev-to-prod-workflow.md](dev-to-prod-workflow.md)
- [web deployment setup](../setup/web-deployment.md)
- [firestore rules setup](../setup/firestore-rules.md)
- [environment variables](../setup/environment-variables.md)
- [version management](../internal/version-management.md)
- [changelog](../changelog.md)
