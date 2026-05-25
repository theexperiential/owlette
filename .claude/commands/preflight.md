---
description: Pre-push gate — lint, typecheck, and run the playwright e2e suite locally before pushing web changes
---

Run the same checks CI runs, locally, *before* pushing — so a red "playwright e2e" run on dev/main becomes rare. The local e2e suite is the exact mirror of CI (same Playwright tests against the same Firebase emulators), so green here means green there for everything except cold-cache / ubuntu-vs-Windows quirks.

Run this before any `git push` that touches `web/**`, `firestore.rules`, or `firebase.json`.

## Process

### Step 1: Scope check
Determine whether the pending changes are in the e2e path filter (`web/**`, `firestore.rules`, `firebase.json`, `.github/workflows/e2e.yml`):
```bash
git status --porcelain
git diff --name-only @{u}..HEAD 2>/dev/null   # committed-but-unpushed, if upstream exists
```
- If **nothing** in scope touches web/firestore/firebase → e2e won't run in CI. Skip to Step 2 for lint/typecheck only, then report "no e2e needed".
- Otherwise continue through all steps.

### Step 2: Lint + typecheck (fast — always run)
```bash
cd web && npm run lint
```
```bash
cd web && npx tsc --noEmit
```
Fix every error/warning your changes introduced before proceeding (per CLAUDE.md "lint as you go").

### Step 3: Unit tests (fast)
```bash
cd web && npm test
```

### Step 4: E2E suite (the authoritative gate)
This does the production build, spins up the emulators, and runs Playwright (~45s steady-state after the first build; the first run pays for `npm run build`). Run in the BACKGROUND with a generous timeout — don't block the session synchronously:
```bash
cd web && npm run e2e
```
Prereqs (already set up on this machine): JDK 21 on PATH, `firebase-tools@13` global, `npx playwright install chromium` done once. If the emulator ports (Auth :9099, Firestore :8080, Storage :9199) are busy, a stale emulator is the usual culprit — kill it by PID (never by name) and retry.

### Step 5: Report + gate
```
## Preflight
- Scope:      [e2e-relevant / web-only-no-e2e / out-of-scope]
- Lint:       [PASS/FAIL]
- Typecheck:  [PASS/FAIL]
- Unit tests: [PASS/FAIL — X passed]
- E2E:        [PASS/FAIL — X passed, Y failed] (or "skipped — no e2e-relevant changes")

Verdict: [SAFE TO PUSH / DO NOT PUSH]
```
- **All green** → say it's safe to push (don't push unless the user asked).
- **Any red** → DO NOT push. Show the failing output, diagnose the root cause, and propose a fix. The whole point of preflight is to fix it here, where the loop is 45s, instead of after a 6+ min CI round-trip on a branch that auto-deploys.

On failure, the Playwright HTML report + traces land in `web/e2e/.output/` — open `web/e2e/.output/report/` for the post-mortem.
