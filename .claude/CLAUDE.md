# Owlette - Cloud-Connected Process Management System

## Overview

Owlette is a cloud-connected Windows process management and remote deployment system for managing TouchDesigner installations, digital signage, kiosks, and media servers. It consists of a Python Windows service (agent) and a Next.js web dashboard with Firebase/Firestore backend.

**Version**: 2.1.6 (see [docs/version-management.md](../docs/version-management.md))
**License**: GNU General Public License v3.0
**Repository Type**: Monorepo (web + agent)

---

## Tech Stack

**Frontend (web/)**: Next.js 16.0.1 (App Router, React 19), TypeScript 5.x, Tailwind CSS 4.x, shadcn/ui (Radix UI), Firebase Auth + Firestore

**Backend (agent/)**: Python 3.9+ Windows Service via NSSM, Firestore REST API (not Admin SDK), OAuth two-token auth, psutil, pywin32, Inno Setup installer (not PyInstaller)

**Database & Auth**: Cloud Firestore (real-time NoSQL), Firebase Authentication (Email/Password, Google OAuth), bidirectional sync (agent <-> Firestore <-> web)

**Package Managers**: Web: npm (not pnpm/yarn) | Agent: pip

---

## Build Commands

### Web Dashboard
```bash
cd web
npm install          # Install dependencies
npm run dev          # Dev server (http://localhost:3000)
npm run build        # Production build
npm start            # Production server
npm run lint         # Lint
npm test             # Run tests
```

### Python Agent
```bash
cd agent
pip install -r requirements.txt          # Install dependencies
cd src && python owlette_service.py debug  # Debug mode (requires admin)
cd agent && build_installer_full.bat     # Full build (~5-10 min, first time)
cd agent && build_installer_quick.bat    # Quick build (~30 sec, dev iteration)
```

### Version Management

Bump all versions with: `node scripts/sync-versions.js 2.1.0`

Version files: `/VERSION` (product), `agent/VERSION` (agent), `web/package.json` (web), `firestore.rules` (schema, independent)

See [docs/version-management.md](../docs/version-management.md) for full release workflow.

---

## Project Structure

```
Owlette/
├── .claude/                      # Claude Code configuration
│   ├── skills/                   # Auto-activating skill guidelines
│   │   ├── frontend-dev-guidelines.md
│   │   ├── backend-dev-guidelines.md
│   │   ├── firebase-integration.md
│   │   ├── testing-guidelines.md
│   │   └── resources/            # Detailed reference documents
│   │       ├── agent-architecture.md    # Agent internals & state machines
│   │       ├── installer-build-system.md # Build pipeline & Inno Setup
│   │       └── codebase-map.md          # Complete component/module inventory
│   ├── hooks/                    # Hooks (skill activation, build checker, file tracking)
│   ├── commands/                 # Slash commands
│   ├── agents/                   # Specialized subagents
│   └── CLAUDE.md                 # This file
│
├── web/                          # Next.js Web Dashboard
│   ├── app/                      # App Router pages (dashboard, deployments, admin, auth)
│   ├── components/               # React components (48 files across ui/, charts/, landing/)
│   ├── contexts/AuthContext.tsx   # Firebase auth context
│   ├── hooks/                    # Custom hooks (12 hooks: useFirestore, useDeployments, etc.)
│   ├── lib/                      # Utilities (22 files: firebase, errorHandler, validators, etc.)
│   └── __tests__/                # Jest tests (32 tests across errorHandler + validateEnv)
│
├── agent/                        # Python Windows Service
│   ├── src/                      # 21 Python modules (see backend-dev-guidelines for full map)
│   ├── tests/                    # pytest tests (shared_utils coverage)
│   ├── build_installer_full.bat  # Full build (embedded Python + NSSM + Inno Setup)
│   ├── build_installer_quick.bat # Quick build (copy + compile)
│   ├── owlette_installer.iss     # Inno Setup script
│   └── scripts/install.bat       # NSSM service installation
│
├── docs/                         # Documentation
├── dev/                          # Development task tracking (active/ + completed/)
├── scripts/                      # Version sync scripts
└── VERSION                       # Product version
```

---

## Architecture Overview

```
Agent (Machine A) → Firestore REST API → Web Dashboard (Next.js)
                                                ↓
Agent (Machine B) ← Firestore Listener  ← Commands from Web
```

**Web Dashboard** (`web/`): React UI with real-time Firestore listeners, Firebase Auth, deployed to Railway

**Python Agent** (`agent/`): Windows service (NSSM) monitoring processes every 10s, syncing to Firestore via REST API with OAuth tokens, GUI for local configuration

**Firebase Backend**: Cloud Firestore for real-time data sync, Firebase Auth for users, serverless architecture

### Firestore Data Structure
```
sites/{siteId}/machines/{machineId}/presence  # Heartbeat (30s)
sites/{siteId}/machines/{machineId}/status    # Metrics (60s)
sites/{siteId}/machines/{machineId}/commands/ # pending/ + completed/
config/{siteId}/machines/{machineId}          # Process configuration
users/{userId}                                 # Email, role, sites
deployments/{deploymentId}                     # Remote installer deployments
```

---

## Resource Documents

For deeper understanding beyond this file:

| Document | Purpose |
|----------|---------|
| `skills/resources/agent-architecture.md` | Agent service lifecycle, process state machine, ConnectionManager states, OAuth flow, command handling, IPC |
| `skills/resources/installer-build-system.md` | Full vs quick build, Inno Setup steps, OAuth registration, NSSM config, self-update, file system layout |
| `skills/resources/codebase-map.md` | Complete inventory of all web components, hooks, lib files, API routes, agent modules |
| `skills/backend-dev-guidelines.md` | Agent module map, development patterns, critical do's/don'ts, file paths |
| `skills/frontend-dev-guidelines.md` | Owlette-specific web patterns, auth/data flow, gotchas |
| `skills/firebase-integration.md` | Firestore data structure, two-client architecture, command flow |
| `skills/testing-guidelines.md` | Jest + pytest config, Firebase mocks, test coverage gaps |
| `skills/build-system.md` | Build pipeline, Inno Setup, NSSM, self-update, version management |

---

## Development Workflow

### Dev Docs (for large tasks)

When starting multi-file features or complex work:
1. Use `/dev-docs` in plan mode to create strategic plan
2. Use `/create-dev-docs` to generate task tracking files in `dev/active/`
3. Use `/update-dev-docs` before context compaction to preserve progress
4. Use `/resume-dev-docs` in a new session to restore context and continue
5. Move to `dev/completed/` when done

Skip for single-file tweaks, docs updates, or small bug fixes.

### Hooks (configured in `.claude/settings.json`)

| Hook | Event | Purpose |
|------|-------|---------|
| `track-edits.mjs` | PostToolUse | Logs Edit/Write operations to `session-edits.json` |
| `deploy-agent.mjs` | PostToolUse | Copies edited `agent/src/*.py` files to `C:\ProgramData\Owlette\agent\src\`, restarts service + GUI |
| `activate-skills.mjs` | UserPromptSubmit | Matches prompt keywords + recent files → activates relevant skills |
| `pre-commit-check.mjs` | PreToolUse (Bash) | Blocks `git commit`/`push` if TypeScript or Python errors exist |
| `check-builds.mjs` | Stop | Runs `tsc --noEmit` (web) / `py_compile` (agent) on edited files |

Skills (in `skills/`) auto-activate based on keywords and recently edited file patterns (rules in `hooks/skill-rules.json`):

| Skill | Triggers |
|-------|----------|
| `frontend-dev-guidelines` | `.tsx` files, React/Next.js keywords |
| `backend-dev-guidelines` | Agent `.py` files, Python keywords |
| `firebase-integration` | Firebase imports, Firestore operations |
| `testing-guidelines` | Test files, "test" keyword |
| `build-system` | Build scripts, `.iss`/`.bat` files, installer/release keywords |

### Slash Commands

| Command | Purpose |
|---------|---------|
| `/dev-docs` | Create strategic plan (use in plan mode) |
| `/create-dev-docs` | Convert plan into dev doc files |
| `/update-dev-docs` | Update dev docs before compaction |
| `/resume-dev-docs` | Resume work from dev docs in new session |
| `/build-and-fix` | Build both web + agent, fix all errors |

---

## Git Workflow

**Two-Branch Model**: `dev` (development, deploys to dev.owlette.app) + `main` (production, deploys to owlette.app)

All feature work on `dev`. Merge to `main` for production releases. Both auto-deploy via Railway.

**Commit Messages**: Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)

**PRs**: Feature branches from `dev` for team collaboration. `dev` → `main` PRs for production releases.

---

## Deployment

**Web (Railway)**: Push to `dev`/`main` triggers auto-deploy. Required env vars: `NEXT_PUBLIC_*` (client) + `FIREBASE_*` (server Admin SDK for OAuth token generation).

**Agent (Windows)**: Build installer via `build_installer_full.bat`, deploy via web dashboard remote deployment or manual installation.

---

## Don'ts / Guardrails

### Files You Must Not Touch
- `web/components/ui/*` — auto-generated by shadcn/ui, never edit directly
- `firestore.rules` — version managed independently, don't modify without explicit request
- `.tokens.enc` / any credential files — never read, log, or commit these
- `owlette_installer.iss` — Inno Setup script, only modify if you understand the full build pipeline

### Agent-Specific Landmines
- **Never import `firebase_admin`** in agent code — we use a custom REST client, not the Admin SDK
- **Never log OAuth tokens** — not even in debug mode, not even partially
- **Never modify the `firebase` section** of `config.json` during remote config updates — this breaks agent registration
- **Never use blocking operations** in the 10-second main service loop — it stalls all process monitoring
- **Never spawn reconnection logic** outside `ConnectionManager` — it has circuit breaker and backoff built in

### Web-Specific
- **Never call Firestore directly from components** — always go through hooks in `web/hooks/`
- **Never hardcode colors** — use CSS variables / Tailwind theme tokens for dark mode compatibility
- **Never add icon libraries** beyond `lucide-react`

### General
- **Don't push to `main` directly** — all work goes through `dev`, then PR to `main`
- **Don't create new `docs/*.md` files** without being asked — we have enough docs
- **Don't install new npm/pip packages** without confirming with the user first
- **Don't modify `.claude/hooks/` or `.claude/settings.json`** without explicit request — these are infrastructure

---

## Agent Dev Testing Workflow

When editing `agent/src/*.py` files, the `deploy-agent.mjs` hook auto-copies them to `C:\ProgramData\Owlette\agent\src\`. However, changes to **service** files (e.g. `owlette_service.py`, `shared_utils.py`, `firebase_client.py`, `connection_manager.py`, `auth_manager.py`) require a service restart to take effect. **You must do this automatically** — don't wait for the user to ask.

### Restart sequence (order matters):
1. **Kill GUI** if running: `taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq Owlette*"` (or check via wmic for owlette_gui.py)
2. **Restart service**: `powershell -Command "Start-Process cmd -ArgumentList '/c net stop OwletteService && net start OwletteService' -Verb RunAs -Wait"`
3. **Relaunch GUI**: `start "" "C:/ProgramData/Owlette/python/pythonw.exe" "C:/ProgramData/Owlette/agent/src/owlette_gui.py"`

GUI-only files (e.g. `owlette_gui.py`) only need steps 1 + 3 (no service restart).

---

**Last Updated**: 2026-03-15
