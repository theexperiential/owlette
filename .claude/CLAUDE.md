# Owlette - Cloud-Connected Process Management System

Owlette is a cloud-connected Windows process management and remote deployment system for managing TouchDesigner installations, digital signage, kiosks, and media servers. Monorepo: Python Windows service (agent) + Next.js web dashboard (web) + Firebase/Firestore backend.

**Version**: 2.12.0 | **License**: FSL-1.1-Apache-2.0

## In-Flight Major Initiative: roost (project distribution v2)

A multi-quarter rewrite of project distribution into a content-addressed sync platform (Cloudflare R2, immutable manifests, atomic deploy, rollback). Branded as "roost" (always lowercase). Plan + tasks live at `dev/active/project-distribution-v2/`. Memory: `project_roost.md`.

**Key decisions** (do not relitigate):
- No `/api/v2/` URL prefix — the new routes ARE the API (`/api/chunks/`, `/api/roosts/`).
- No backwards compatibility with v1 agents — clean cutover, v3.0.0 agent is required to consume new uploads.
- No header-based version negotiation (no `Accept: application/vnd.owlette.v2+json`).
- v3-deferred (do NOT rebuild in v2): bidirectional sync, LAN swarm, Ed25519 manifest signing, FastCDC. (Public CLI was originally on this list but shipped via the api-sprint + roost-public-api waves — now `@owlette/cli` v1.0.0-rc.0; see `project_npm_packages.md`.)
- Nav label `projects` → `roost`. `verify_files` field dropped (manifest is authoritative).

---

## Tech Stack

- **Web** (`web/`): Next.js 16 (App Router, React 19), TypeScript, Tailwind CSS 4, shadcn/ui, Firebase Auth + Firestore
- **Agent** (`agent/`): Python 3.9+ Windows Service via NSSM, Firestore REST API (not Admin SDK), psutil, pywin32, Inno Setup installer
- **Database**: Cloud Firestore (real-time NoSQL), Firebase Auth (Email/Password, Google OAuth, Passkey/WebAuthn)
- **Package Managers**: Web: npm (not pnpm/yarn) | Agent: pip

---

## Build Commands

```bash
# Web
cd web && npm install && npm run dev     # Dev server (localhost:3000)
cd web && npm run build                  # Production build
cd web && npm test                       # Jest unit tests
cd web && npm run e2e                    # Playwright E2E suite (requires JDK 21 + firebase-tools@13 globally)
cd web && npm run lint                   # Lint

# Agent
cd agent && pip install -r requirements.txt
cd agent/src && python owlette_service.py debug   # Debug mode (requires admin)
cd agent && build_installer_full.bat              # Full build (~5-10 min)
cd agent && build_installer_quick.bat             # Quick build (~30 sec)

# Version bump (all files at once)
node scripts/sync-versions.js X.Y.Z
```

Version files: `/VERSION`, `agent/VERSION`, `web/package.json`, `firestore.rules` (independent). See `docs/version-management.md`.

**E2E prereqs**: JDK 21 on PATH (Temurin), `npm i -g firebase-tools@13`, `npx playwright install chromium --with-deps` (once). Emulator ports: Auth :9099, Firestore :8080, Storage :9199. App runs on :3100 during E2E (not :3000). Report output: `web/e2e/.output/report/`. Full guide: `web/e2e/README.md`.

---

## Git Workflow

**Two-Branch Model**: `dev` (deploys to dev.owlette.app) → `main` (deploys to owlette.app)

**Commit Messages**: Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)

**Pre-Commit Code Review**: Before every commit, perform a thorough code review of all staged changes. Every line must meet production quality standards — no duct-tape fixes, no "good enough for now" shortcuts, no patchy logic. Specifically:
- Verify correctness: no off-by-one errors, race conditions, resource leaks, or missed edge cases
- Ensure consistency: naming conventions, error handling patterns, and code style match the surrounding codebase
- Check for completeness: if a pattern is introduced (e.g. lazy init), verify it's wired up end-to-end (references stored, cleanup handled, state updates propagated)
- No dead code, no commented-out code, no placeholder TODOs that won't be addressed in this commit
- All changes must be self-contained and fully functional — never commit something that "works but will need a follow-up fix"

**Lint as you go — don't let errors accumulate.** After editing any web file, run `npx eslint <file>` on that file (or `npm run lint` for a broader change) and fix every error and warning you introduced before moving on. Never commit new lint errors, and never rationalise them as "pre-existing" if your edit touched the same file. The repo has historical lint debt — your job is to not add to it, and to clean up any issues in lines you modified. Same principle for TypeScript: if `tsc` / IDE diagnostics flag your change, fix it before the next edit, not at commit time.

---

## Agent Authentication (Device Code Pairing)

Agents authenticate via a device code flow — no browser login on the target machine.

**3 Ways to Add a Machine:**

1. **Browser** (single machine): Run installer → pairing phrase appears → browser auto-opens owlette.app/add → select site → authorize
2. **Dashboard** (manual): Run installer → note 3-word phrase → dashboard "+" button → "Enter Code" → authorize
3. **Silent Install** (bulk deploy): Dashboard "+" → "Generate Code" → copy phrase → `Owlette-Installer.exe /ADD=silver-compass-drift /SILENT`

**Key files:**
- `web/app/api/agent/auth/device-code/` — generate phrase, poll, authorize endpoints
- `web/app/add/page.tsx` — pairing page (phrase pre-filled via URL param)
- `web/app/dashboard/components/AddMachineButton.tsx` — dashboard "+" button + modal
- `agent/src/configure_site.py` — agent-side pairing flow (browser open + polling)
- `agent/src/auth_manager.py` — token exchange, refresh, device code polling
- `web/lib/pairPhrases.ts` / `agent/src/pair_phrases.py` — shared word list (must stay in sync)

**Token lifecycle (unchanged):** Access token (1h, Firebase ID token) + refresh token (never expires, admin-revocable). Stored encrypted in `C:\ProgramData\Owlette\.tokens.enc` with machine-bound Fernet key.

---

## Deployment

**Web**: Push to `dev`/`main` triggers Railway auto-deploy.

**IMPORTANT: Always version up AND update the changelog BEFORE building the installer.** Bump with `node scripts/sync-versions.js X.Y.Z` and commit BEFORE running `build_installer_full.bat` — the installer bakes the version into the exe filename and binary.

**IMPORTANT: `docs/changelog.md` MUST be updated before every installer build.** Add a new `## [X.Y.Z] - YYYY-MM-DD` section summarising all changes since the last release. Never build or upload an installer without a matching changelog entry.

**Agent Installer Release** (build + upload to Firebase):
```bash
# 1. Update changelog, bump version, commit, push
# Edit docs/changelog.md → add [X.Y.Z] section
node scripts/sync-versions.js X.Y.Z
git add -A && git commit -m "chore: bump version to X.Y.Z" && git push origin dev

# 2. Build installer (~5 min)
cd agent && powershell -Command "& './build_installer_full.bat'"
# Output: agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# 3. Compute checksum
sha256sum agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# 4. Upload via API (3-step: request URL → upload binary → finalize)
# Endpoint is `/api/installer/upload` (api-sprint route — old `/api/admin/installer/upload` was removed).
# Auth: api key with `installer=*:write` scope (superadmin-only at minting). `x-api-key` or `Authorization: Bearer owk_…` both work.
# Idempotency-Key REQUIRED on both POST and PUT — the route is wrapped in `withIdempotency(..., { requireKey: true })`.
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://dev.owlette.app"  # or https://owlette.app for prod

# Step 1: Get signed upload URL
curl -s -X POST "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-X.Y.Z-$(date +%s)" \
  -d '{"version":"X.Y.Z","fileName":"Owlette-Installer-vX.Y.Z.exe","releaseNotes":"...","setAsLatest":true}'
# → returns uploadUrl, uploadId, storagePath, expiresAt (15-min window)

# Step 2: Upload binary to the signed GCS URL (no Idempotency-Key here — it's a direct GCS PUT)
curl -X PUT "$UPLOAD_URL" -H "Content-Type: application/octet-stream" \
  --data-binary @agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# Step 3: Finalize (verifies file in storage, computes/checks checksum, writes installer_metadata, sets as latest)
curl -s -X PUT "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-X.Y.Z-$(date +%s)" \
  -d '{"uploadId":"<from step 1>","checksum_sha256":"<sha256 from earlier>"}'
# checksum_sha256 is optional — server computes it if omitted, but providing it gets a 412 `checksum_mismatch` on corruption.
```

---

## Don'ts / Guardrails

### Files You Must Not Touch
- `web/components/ui/*` — auto-generated by shadcn/ui
- `firestore.rules` — don't modify without explicit request
- `.tokens.enc` / credential files — never read, log, or commit
- `owlette_installer.iss` — only modify if you understand the full build pipeline

### Agent Landmines
- **Never import `firebase_admin`** — we use a custom REST client
- **Never log OAuth tokens** — not even in debug, not even partially
- **Never modify the `firebase` section** of `config.json` during remote config updates — breaks agent registration
- **Never use blocking operations** in the 10-second main service loop — stalls all monitoring
- **Never spawn reconnection logic** outside `ConnectionManager` — it has circuit breaker and backoff

### UI Copy Style
- **All user-facing copy is lowercase** — page titles, buttons, dialog headings, labels, descriptions, tooltips, placeholder text, empty-state copy, toasts. Match the voice of the rest of the UI.
- Exceptions (keep normal casing): proper nouns/product names in external contexts, acronyms (`LLM`, `API`, `URL`, `GPU`, `OAuth`), code identifiers, machine IDs / site IDs / user-entered strings, and legal/compliance text where casing is load-bearing.
- When adding new copy, default to lowercase. When editing existing strings, match the surrounding casing — don't mix sentence case into a lowercase screen or vice versa.

### Web Landmines
- **Never call Firestore directly from components** — use hooks in `web/hooks/`
- **Never hardcode colors** — use CSS variables / Tailwind theme tokens
- **Never add icon libraries** beyond `lucide-react`

### General
- **Don't push to `main` directly** — all work through `dev`, then PR
- **Don't create new `docs/*.md` files** without being asked
- **Don't install new npm/pip packages** without confirming first
- **Don't modify `.claude/hooks/` or `.claude/settings.json`** without explicit request

### Review Discipline (code review, security review, audits)
Reviews are judged on calibration, not volume. Three accurate findings are more valuable than twenty marginal ones, and inflated severities devalue every subsequent review on this codebase. Apply the following standard on every pass.

- **Establish current state before reviewing.** Read the last ~10 commits — particularly anything tagged `feat(security)`, `fix(security)`, or part of a hardening pass — and the diff for the branch under review. An issue already resolved upstream is not a finding; surfacing it as one signals that the review wasn't grounded in the current code.
- **Severity is a claim that must be substantiated.** A "critical" finding requires a written exploit path in three parts: the actor (unauthenticated attacker, authenticated user, insider with role X), the mechanism (specific request, payload, or sequence), and the outcome (RCE, data exfiltration, auth bypass, privilege escalation, integrity violation). If the path cannot be stated plainly, the finding is not critical — reclassify it.
- **Use the full severity ladder.** *Critical*: exploitable now with material impact. *High*: exploitable under realistic conditions or with a credible chain. *Medium*: defense-in-depth gap with no direct exploit. *Low*: hardening, style, or best-practice deviation. When uncertain between two rungs, choose the lower one and explain the uncertainty.
- **A clean review is a valid result.** When the change is sound, state that and stop. Padding a report with speculative or low-value findings to demonstrate effort is a quality failure, not thoroughness.
- **Theoretical risks belong in the backlog, not the report.** "An attacker could in principle…" without a concrete path is at most a low-severity hardening note, and frequently not worth filing. It is never critical.
- **Separate new findings from settled decisions.** If an issue has been triaged previously as accepted risk, won't-fix, or already-resolved, do not refile it as a discovery. If new evidence warrants revisiting the decision, say so explicitly, cite the prior commit or comment, and argue the reversal — don't present continuity as novelty.
- **Every finding cites evidence.** Reference the file and line, the specific code or config, and (where relevant) the call site that makes the path reachable. Findings without evidence are not actionable and should not be filed.

---

## Agent Dev Testing Workflow

The `deploy-agent.mjs` hook auto-copies edited `agent/src/*.py` files to `C:\ProgramData\Owlette\agent\src\`. Service files (`owlette_service.py`, `shared_utils.py`, `firebase_client.py`, `connection_manager.py`, `auth_manager.py`) require a restart. **Do this automatically** — don't wait for the user to ask.

### Restart sequence (order matters):
1. **Kill GUI**: `taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq Owlette*"` (or wmic for owlette_gui.py)
2. **Restart service**: `powershell -Command "Start-Process cmd -ArgumentList '/c net stop OwletteService && net start OwletteService' -Verb RunAs -Wait"`
3. **Relaunch GUI**: `start "" "C:/ProgramData/Owlette/python/pythonw.exe" "C:/ProgramData/Owlette/agent/src/owlette_gui.py"`

GUI-only files (e.g. `owlette_gui.py`) only need steps 1 + 3 (no service restart).

---

## Task Workflow (GSD-Inspired)

For non-trivial features, use the wave-based planning and execution system. Each task runs in a fresh agent context to prevent context rot on long sessions.

### Planning
- `/plan` — Research codebase → create wave-based plan → write task files to `dev/active/`

### Execution (pick one)
- `/execute` — Run next wave of tasks in **parallel** (each task gets a fresh agent context — prevents context rot)
- `/next` — Execute the next single task in the current context (for smaller features or when you want to review each step)

### Verification & Lifecycle
- `/verify` — Check completed work against plan's success criteria + build check
- `/save` — Save progress to dev docs before context compaction
- `/resume` — Restore context in a new session from dev docs

### Debugging
- `/debug` — Scientific method debugging: observe → hypothesize → test → diagnose → fix → verify

### Build
- `/build-and-fix` — Build web + agent, fix all errors, repeat until clean

Skip `/plan` for single-file tweaks or small fixes. Use `/debug` for any non-obvious bug.

---

## Performance Review

At the end of every completed task, provide a brief performance review of the user's work. The user's goal is to impress — give them honest feedback to help them grow.

**Include:**
- What was impressive or notable (only genuine observations)
- A rating (out of 10)
- Suggestions for improvement, if any

Be real, not flattering. If something was mid, say so. If it was genuinely great, say that too.

---

**Last Updated**: 2026-05-18
