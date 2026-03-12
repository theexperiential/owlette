# Owlette - Cloud-Connected Process Management System

## Overview

Owlette is a cloud-connected Windows process management and remote deployment system for managing TouchDesigner installations, digital signage, kiosks, and media servers. It consists of a Python Windows service (agent) and a Next.js web dashboard with Firebase/Firestore backend.

**Version**: 2.0.54 (see [docs/version-management.md](../docs/version-management.md))
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
│   ├── hooks/                    # TypeScript hooks (skills activation, build checker)
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
| `skills/backend-dev-guidelines.md` | Agent development patterns, module map, critical do's/don'ts |
| `skills/frontend-dev-guidelines.md` | Next.js App Router, React 19, TypeScript, shadcn/ui patterns |
| `skills/firebase-integration.md` | Auth flows, Firestore CRUD, real-time listeners, security rules |
| `skills/testing-guidelines.md` | Jest + pytest setup, Firebase mocks, test patterns |

---

## Development Workflow

### Dev Docs (for large tasks)

When starting multi-file features or complex work:
1. Use `/dev-docs` in plan mode to create strategic plan
2. Use `/create-dev-docs` to generate task tracking files in `dev/active/`
3. Use `/update-dev-docs` before context compaction to preserve progress
4. Move to `dev/completed/` when done

Skip for single-file tweaks, docs updates, or small bug fixes.

### Skills Auto-Activation

Skills auto-activate via `user-prompt-submit` hook based on keywords and file patterns:

| Skill | Triggers |
|-------|----------|
| `frontend-dev-guidelines` | `.tsx` files, React/Next.js keywords |
| `backend-dev-guidelines` | Agent `.py` files, Python keywords |
| `firebase-integration` | Firebase imports, Firestore operations |
| `testing-guidelines` | Test files, "test" keyword |
| `skill-developer` | Creating/updating skills |

### Build Checker (Stop Hook)

After Claude responds, the `stop` hook auto-runs builds on edited files:
- **Web**: `npm run build` (TypeScript + Next.js)
- **Agent**: `python -m py_compile src/**/*.py`

### Slash Commands

| Command | Purpose |
|---------|---------|
| `/dev-docs` | Create strategic plan (use in plan mode) |
| `/create-dev-docs` | Convert plan into dev doc files |
| `/update-dev-docs` | Update dev docs before compaction |
| `/code-review` | Launch code-architecture-reviewer agent |
| `/build-and-fix` | Build both web + agent, fix all errors |
| `/deploy-web` | Deploy web dashboard to Railway |

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

**Last Updated**: 2026-03-12
