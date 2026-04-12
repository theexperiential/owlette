# Owlette - Cloud-Connected Process Management System

Owlette is a cloud-connected Windows process management and remote deployment system for managing TouchDesigner installations, digital signage, kiosks, and media servers. Monorepo: Python Windows service (agent) + Next.js web dashboard (web) + Firebase/Firestore backend.

**Version**: 2.6.5 | **License**: AGPL-3.0

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
cd web && npm test                       # Jest tests
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
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://dev.owlette.app"  # or https://owlette.app for prod

# Step 1: Get signed upload URL
curl -s -X POST "$BASE_URL/api/admin/installer/upload" \
  -H "Content-Type: application/json" -H "x-api-key: $API_KEY" \
  -d '{"version":"X.Y.Z","fileName":"Owlette-Installer-vX.Y.Z.exe","releaseNotes":"...","setAsLatest":true}'
# → returns uploadUrl, uploadId

# Step 2: Upload binary to signed URL
curl -X PUT "$UPLOAD_URL" -H "Content-Type: application/octet-stream" \
  --data-binary @agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# Step 3: Finalize (verifies file, writes installer_metadata, sets as latest)
curl -s -X PUT "$BASE_URL/api/admin/installer/upload" \
  -H "Content-Type: application/json" -H "x-api-key: $API_KEY" \
  -d '{"uploadId":"<from step 1>","checksum_sha256":"<from step 3>"}'
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

### Web Landmines
- **Never call Firestore directly from components** — use hooks in `web/hooks/`
- **Never hardcode colors** — use CSS variables / Tailwind theme tokens
- **Never add icon libraries** beyond `lucide-react`

### General
- **Don't push to `main` directly** — all work through `dev`, then PR
- **Don't create new `docs/*.md` files** without being asked
- **Don't install new npm/pip packages** without confirming first
- **Don't modify `.claude/hooks/` or `.claude/settings.json`** without explicit request

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

**Last Updated**: 2026-04-01
