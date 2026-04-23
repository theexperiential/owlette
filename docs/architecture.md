---
hide:
  - navigation
---

# architecture

owlette uses a serverless, event-driven architecture where all communication flows through Cloud Firestore. There is no direct connection between agents and the dashboard — Firestore acts as the message bus.

---

## system overview

```mermaid
flowchart LR
    Agents["Desktop Services\n(Agents)"]
    FS[("Cloud Firestore\nReal-time NoSQL")]
    CF["Cloud Functions\n(event-driven)"]
    Dashboard["Web Dashboard\n(Next.js)"]
    Auth["Firebase Auth"]

    Agents -- "metrics & heartbeats" --> FS
    FS -- "commands" --> Agents
    FS -- "triggers" --> CF
    CF -- "history / status" --> FS
    FS <--> Dashboard
    Auth -. "token validation" .-> FS
```

---

## components

### python agent (windows service)

The agent runs as a Windows service managed by [NSSM](https://nssm.cc/) (Non-Sucking Service Manager). It:

- **Monitors processes** every 5 seconds — detects crashes, stalls, and exits
- **Auto-restarts** crashed applications using Task Scheduler or CreateProcessAsUser
- **Sends heartbeats & reports metrics** (CPU, memory, disk, GPU, network) at an adaptive interval — 5s when the system tray GUI is open, 30s when processes are running, 120s when idle
- **Executes commands** from the dashboard — restart process, install software, reboot, etc.
- **Syncs configuration** bidirectionally between local GUI and cloud
- **Runs offline** — continues monitoring even without internet, syncs when reconnected

The agent uses a **custom Firestore REST API client** (not the Firebase Admin SDK) with an OAuth two-token authentication system.

!!! info "Key directories"
    - **Installation**: `C:\ProgramData\Owlette\`
    - **Agent code**: `C:\ProgramData\Owlette\agent\src\`
    - **Logs**: `C:\ProgramData\Owlette\logs\`
    - **Config**: `C:\ProgramData\Owlette\agent\config\config.json`

### web dashboard (next.js)

The dashboard is a Next.js 16 application deployed to Railway. It:

- **Displays real-time data** using Firestore `onSnapshot` listeners
- **Manages processes** — add, edit, remove, start, stop, kill
- **Deploys software** — push installers to machines with progress tracking
- **Distributes projects** — sync ZIP files across the fleet
- **Manages users** — role-based access control with site-level permissions
- **Provides Cortex** — AI chat interface for machine interaction, plus autonomous cluster management (auto-investigates crashes)

### firebase backend

Firebase provides three services:

- **Cloud Firestore** — real-time NoSQL database for all data sync
- **Firebase Authentication** — user auth (email/password, Google OAuth) and agent auth (custom tokens)
- **Cloud Functions (2nd Gen)** — event-driven server-side logic (see below)

the web dashboard's Next.js API routes handle most server-side operations (token generation, email sending, API endpoints). Cloud Functions handle event-driven tasks that must run in response to Firestore writes or on a schedule.

### cloud functions

three Cloud Functions run on Firebase (2nd Gen, Node.js 20). source: `functions/src/`.

| function | trigger | purpose |
|----------|---------|---------|
| **onMetricsWrite** | Firestore `onDocumentWritten` on `sites/{siteId}/machines/{machineId}` | appends a compact sample to the daily `metrics_history/{YYYY-MM-DD}` bucket (per-CPU, per-disk usage, per-volume disk IO, per-GPU, per-NIC). also evaluates threshold alert rules and fires notifications when breached. rate-limited to one sample per 55 seconds. each numeric field is `Number.isFinite()`-guarded so a single poisoned reading can't reject the whole sample write. |
| **onCommandCompleted** | Firestore `onDocumentWritten` on `sites/{siteId}/machines/{machineId}/commands/completed` | when an agent finishes a command with a `deployment_id`, updates the deployment target's status, progress, and timestamps. recalculates overall deployment status across all targets. |
| **sweepStaleDeployments** | Cloud Scheduler, every 5 minutes | catches deployments stuck in non-terminal states (agent crash, network loss). marks pending targets as failed after 15 min, downloading/installing targets after 30 min. |
| **onRoostWritten** | Firestore `onDocumentWritten` on `sites/{siteId}/roosts/{roostId}` | roost fan-out. detects `currentManifestId` change, partitions targets into canary + fleet cohorts (stable hash, ≤10% / cap 50 canary), creates the rollout state doc, dispatches canary `roost_sync` commands. |
| **onTargetStateWritten** | Firestore `onDocumentWritten` on `sites/{siteId}/roosts/{roostId}/target_state/{machineId}` | roost rollout state machine. transactional canary→fleet promotion on ≥90% success, abort on >25% failure (mid-wave, not waiting for full settlement). |
| **verifyChunk** | HTTPS callable | roost integrity check. streams an R2 chunk, computes SHA-256, deletes + alerts on hash mismatch (planted-bytes defense). invoked via Cloudflare Worker webhook on every R2 PUT. |
| **chunkGcNightly** | Cloud Scheduler, 02:15 UTC | roost chunk garbage collection. two-phase mark-and-sweep with 30-day tombstone TTL, resurrection guard (a chunk re-referenced between mark and sweep has its tombstone cleared), pause-during-publish. `CHUNK_GC_MODE=dry-run` default. |
| **preUploadCheck** + **reconcileQuota** | HTTPS + Cloud Scheduler (03:45 UTC) | roost per-tenant quota. pre-upload admit reserves pending bytes atomically; daily reconcile re-reads authoritative usage, fires only newly-crossed 50/80/100% alarms. |
| **aggregateTelemetry** + **recordUsageEvent** + **getUsageSummaryHttp** | Cloud Scheduler (04:30 UTC) + HTTPS | roost telemetry. per-tenant cost attribution against R2 pricing ($0.015/GB-month, $4.50/M class-A, $0.36/M class-B, $0 egress). OTLP-shaped structured logs for downstream collector. |
| **recordAuditEvent** + **exportAuditDaily** + **verifyAuditChain** | HTTPS + Cloud Scheduler (05:15 UTC) | roost append-only audit log. SHA-256 hash-chained records (tamper-evident by deletion + mutation), 7-year retention, BigQuery cold-storage sink at 05:15 UTC. |
| **emitWebhook** + **processRetryQueue** | HTTPS + Cloud Scheduler (every 1 minute) | roost webhook dispatcher. 7 event types (`distribution.queued/started/succeeded/failed`, `chunk.uploaded`, `manifest.published`, `rollback.executed`), HMAC-SHA256 signed (`sha256=<hex>`), exponential backoff retry (5 s base × 3 × 1 h cap × ±20% jitter, 10-attempt cap). |

**deployment:**

```bash
# deploy all functions
cd functions && firebase deploy --only functions

# deploy a single function
firebase deploy --only functions:onMetricsWrite

# check which project is active
firebase use
# dev: owlette-dev-3838a | prod: owlette-prod-XXXXX
```

**environment:** `functions/.env` contains `CORTEX_INTERNAL_SECRET` (shared secret for internal API auth, must match `web/.env.local`). `API_BASE_URL` is auto-derived from the Firebase project ID.

---

## data flow

### heartbeat & metrics

```mermaid
flowchart LR
    Agent["Desktop Service\n(Agent)"]
    FS[("Firestore")]
    CF["Cloud Function\n(onMetricsWrite)"]
    Dashboard["Web Dashboard"]

    Agent -->|"metrics + heartbeat\n5s / 30s / 120s adaptive"| FS
    FS -->|"trigger"| CF
    CF -->|"append sample to\nmetrics_history bucket"| FS
    FS -->|"onSnapshot"| Dashboard
```

### command execution

```mermaid
flowchart LR
    Dashboard["Web Dashboard"]
    FS[("Firestore")]
    Agent["Desktop Service\n(Agent)"]
    CF["Cloud Function\n(onCommandCompleted)"]

    Dashboard -->|"1. write command\nto pending"| FS
    FS -->|"2. listener\ndetects"| Agent
    Agent -->|"3. write result\nto completed"| FS
    FS -->|"4. trigger"| CF
    CF -->|"5. update deployment\nstatus"| FS
    FS -->|"6. onSnapshot\nUI updates"| Dashboard
```

### configuration sync

```mermaid
flowchart LR
    GUI["Tray Icon /\nGUI (Agent)"] -->|"1. write"| FS[("Firestore")]
    FS -->|"2. onSnapshot"| Dashboard["Web Dashboard"]
    Dashboard -->|"3. write"| FS
    FS -->|"4. listener"| Agent["Desktop Service\n(Agent)"]
    Agent -->|"5. update\nconfig.json"| GUI
```

### per-volume disk IO

The disk subsystem reports two independent axes per logical volume, kept distinct in both the data path and the dashboard UI:

- **storage** — capacity used %, sourced from `psutil.disk_usage()`. Slow-moving, near-100 on long-running machines.
- **activity** — read/write throughput as a percentage of the volume's max bandwidth, sourced from WMI's `Win32_PerfFormattedData_PerfDisk_LogicalDisk`. Spiky, near-zero most of the time.

Each volume's `maxBps` is established at first call by querying `MSFT_PhysicalDisk` for its hardware class (NVMe ≈ 3.5 GB/s, SATA SSD ≈ 550 MB/s, HDD ≈ 150 MB/s, etc.) and ratcheted upward by observed peaks — without this estimate the chart Y-axis would have no meaningful upper bound.

Two operational quirks shape the implementation:

1. **WMI watchdog (10s)** — the perflib `LogicalDisk` provider stalls for several seconds when the BITS service flips state during Windows Update / Delivery Optimization polling. A 2s or 5s budget reproducibly skipped these stalls (~3.6 timeouts/hr); 10s captures them at zero observed timeouts. The disk IO collector runs in its own thread so the worst-case wait never blocks the main metrics loop. (A persistent-WMI-worker variant was tried first but reproducibly triggered `RPC_E_WRONG_THREAD` on every call after the first — the python `wmi` package binds proxies to the apartment that created them, incompatible with reusing a cached proxy from a long-lived thread. The per-call pattern stays.)

2. **Volume filter** — raw `HarddiskVolumeN` partitions (no drive-letter mapping) are dropped at the agent before they reach Firestore, keeping the dashboard's volume list to user-meaningful drive letters.

`onMetricsWrite` flattens per-volume readings into history samples under `sample.dios = [{i, rb, wb, mb}]` — volume id, read bytes/s, write bytes/s, and the `maxBps` in effect at that moment (preserved per-sample so historical scaling stays correct after the ratchet has moved).

---

## two firebase clients

This is the most important architectural distinction:

| | web dashboard | python agent |
|---|---|---|
| **SDK** | Firebase Client SDK (`firebase/firestore`) | Custom REST client (`firestore_rest_client.py`) |
| **Auth** | Firebase Auth (email/password, Google OAuth) | OAuth two-token system (custom token + refresh token) |
| **Real-time** | `onSnapshot` listeners | Polling + Firestore listener thread |
| **Timestamps** | `serverTimestamp()` | REST API `timestampValue` format |

The agent does **not** use the Firebase Admin SDK or any official Firebase Python library. It uses a hand-built REST client that communicates with the Firestore v1 REST API directly. This keeps the agent lightweight and avoids the heavy `google-cloud-firestore` dependency.

---

## authentication architecture

### user authentication

```mermaid
flowchart TD
    EP["Email/Password"] --> FA["Firebase Auth"]
    GO["Google OAuth"] --> FA
    FA -->|"ID Token"| Session["POST /api/auth/session"]
    Session -->|"sets"| Cookie["iron-session — HTTPOnly cookie"]
    Cookie -->|"authenticates"| Requests["subsequent requests"]
```

### agent authentication (oauth)

```mermaid
flowchart TD
    Installer -->|device code flow| Code["Registration Code (24h expiry)"]
    Code -->|"POST /api/agent/auth/exchange"| Exchange["token exchange"]
    Exchange --> AT["Custom Firebase Token (1h)"]
    Exchange --> RT["Refresh Token (long-lived, hashed in Firestore)"]
    AT --> Store["encrypted local storage"]
    RT --> Store
    Store -->|"on expiry: POST /api/agent/auth/refresh"| NewAT["New Custom Firebase Token (1h)"]
```

!!! info "More details"
    See [Authentication Reference](reference/authentication.md) for the complete flow including MFA.

---

## security model

### site-based access control

All data is scoped to **sites**. Users can only access sites they are assigned to.

| role | access |
|------|--------|
| **User** | Sites listed in their `users/{uid}/sites` array |
| **Admin** | All sites |
| **Agent** | Single site + single machine (from custom token claims) |

### firestore security rules

Rules enforce access at the database level — no client-side bypass is possible:

- Users must be authenticated
- Site access checked via `hasSiteAccess(siteId)`
- Agents scoped by `site_id` and `machine_id` claims in their custom token
- Token collections (`agent_tokens`, `agent_refresh_tokens`) are server-side only

---

## offline resilience

The agent is designed to operate without internet:

1. **No connection** — Agent uses last cached `config.json`, continues monitoring processes locally
2. **Connection restored** — Agent reconnects automatically via `ConnectionManager` with exponential backoff
3. **Metrics buffered** — Heartbeats and metrics resume immediately on reconnection
4. **Commands queued** — Pending commands in Firestore are picked up when the agent comes back online

The `ConnectionManager` implements a state machine with circuit breaker logic — after repeated failures, the agent backs off exponentially (up to 5 minutes) before retrying:

```mermaid
stateDiagram-v2
    [*] --> DISCONNECTED
    DISCONNECTED --> CONNECTING
    CONNECTING --> CONNECTED
    CONNECTED --> RECONNECTING : connection lost
    RECONNECTING --> BACKOFF : repeated failures
    BACKOFF --> CONNECTING : retry
```

---

## roost — content-addressed project distribution (v2)

roost replaces v1's single-URL-per-distribution model with a content-addressed sync layer. a *synced folder* maps to an immutable sequence of *manifests*; flipping a folder's `currentManifestId` pointer is what triggers a deploy or rollback.

### why the model changed

v1 distribution was a one-shot download of a ZIP at a host-supplied URL. a one-byte change re-uploaded the whole archive, there was no rollback, and agents re-verified by re-downloading. roost fixes all three: content-addressed dedup transfers only changed bytes, rollback is an atomic pointer flip, and the manifest is authoritative (chunks are validated by hash, no verify-files list).

### storage layout

chunks are stored in **Cloudflare R2** at a per-tenant prefix:

```
project-content/{siteId}/{hash[0:2]}/{hash}
```

- `siteId` scopes per-customer, preventing cross-tenant access via signed-URL guessing
- `hash[0:2]` shards within a tenant so R2 listings don't bottleneck on a single prefix
- `hash` is the lowercase 64-char SHA-256 of the 4 MiB chunk

manifests are stored at `project-manifests/{siteId}/{roostId}/{manifestId}.json`, immutable once written. a firestore pointer at `sites/{siteId}/roosts/{roostId}.currentManifestId` is the mutable head.

### manifest format

OCI image manifest v1.1 derivation, `application/vnd.owlette.manifest.v1+json`. canonical JSON. full schema at [`docs/internal/manifest-format.md`](internal/manifest-format.md). minimal shape:

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.owlette.manifest.v1+json",
  "config": { "name": "lobby-show", "siteId": "nyc", "createdAt": "...", "createdBy": "uid" },
  "files": [
    { "path": "project.toe", "size": 123456, "chunks": [
      { "hash": "a1b2...", "size": 4194304 }
    ]}
  ]
}
```

### upload pipeline (browser)

```mermaid
flowchart LR
    Drop["webkitdirectory drop"] --> Worker["web worker:\n4 MiB slice + SHA-256"]
    Worker --> Check["/api/chunks/check\n(missing-set)"]
    Check --> Upload["signed PUTs to R2\n(IndexedDB queue,\n4-way parallel)"]
    Upload --> Finalize["/api/roosts/{id}/manifests\n(CAS on currentManifestId)"]
    Finalize --> Trigger["onRoostWritten\ntriggers canary fan-out"]
```

- chunker + hasher off the main thread ([web/lib/chunking.ts](../web/lib/chunking.ts), worker at `web/lib/workers/manifestBuilder.worker.ts`)
- upload queue persists to IndexedDB ([web/lib/uploadQueue.ts](../web/lib/uploadQueue.ts)) — closing the tab at 50% and re-dropping the same folder resumes from 50%
- `admit` endpoint reserves `pendingBytes` atomically so concurrent uploads can't both fit when their sum would exceed quota
- finalize is a firestore transaction — compare-and-swap on `currentManifestId` means concurrent finalizes serialise safely

### agent sync pipeline

agents receive a `roost_sync` command on the fan-out trigger, then:

1. **manifest fetch** ([agent/src/sync_manifest.py](../agent/src/sync_manifest.py)) — pull from R2, cache at `~/Documents/Owlette/.owlette-sync/manifests/{manifestId}.json`, diff against previous to compute the chunk delta
2. **chunk download** ([agent/src/sync_downloader.py](../agent/src/sync_downloader.py)) — parallel workers (default 4) with `Range: bytes=<offset>-` resume, per-chunk SHA-256 verify, signed-URL refresh on 403
3. **atomic assembly** ([agent/src/sync_assembler.py](../agent/src/sync_assembler.py)) — write to `<path>.partial`, fsync, `os.replace` (atomic). post-rename realpath check guards against TOCTOU symlink-swap between the allowlist validation and the rename landing
4. **scrub** ([agent/src/sync_scrub.py](../agent/src/sync_scrub.py)) — periodic re-hashing of on-disk files against their manifest chunk hashes to catch silent bit rot

every write is gated by the **destination allowlist** ([agent/src/destination_allowlist.py](../agent/src/destination_allowlist.py)) — fail-closed: an empty or missing allowlist rejects all writes. symlinks, junctions, Windows reserved device names (NUL, CON, PRN…), alternate data streams, and paths outside the allowed roots are rejected with realpath resolution, not just string matching.

### rollout strategy (canary-first)

every manifest pointer flip goes through a **staged rollout** — never all-at-once. this is the standing cloudflare 2025-11-18 lesson in code form:

```mermaid
flowchart LR
    Pub["manifest published\n(currentManifestId change)"] --> Canary["canary wave\n≤10%, cap 50 machines"]
    Canary -->|"≥90% succeeded"| Fleet["fleet wave\nremaining machines"]
    Canary -->|">25% failed"| Abort["abort\n(no fleet wave)"]
    Fleet -->|"settled"| Complete["complete"]
```

canary cohort selection is deterministic (FNV-1a hash of `machineId + manifestId`) so trigger retries don't flap the chosen cohort. the abort threshold evaluates against `total`, not `settled`, so a rollout that's already past the 25% failure mark bails immediately without waiting for remaining machines.

### security floor

- **per-tenant signed-URL paths**: a signed URL issued for `site-a` cannot read `site-b`'s chunks — paths are scoped before signing
- **allowlist**: fail-closed at the agent; admin UI at `web/components/AllowlistEditor.tsx`
- **hash-chained audit log**: every `signed_url_issued` / `distribution_started` / `manifest_pointer_changed` / `api_key_used` / `gc_run` record embeds `hash(prev || canonicalPayload)` — tamper detection survives deletion + mutation
- **no-token-logs lint gate**: `scripts/check-no-token-logs.mjs` blocks any commit that logs auth tokens (CI + optional pre-commit)

### the clean-cutover decision

roost does **not** support v1 agents. there is no dual-write phase, no shadow-read, no `project_url` fallback. v3.0.0 agent is a hard requirement for consuming v2 manifests. operators upgrade their fleet before the feature flag flips; older agents stop receiving new deploys post-cutover. see [`docs/internal/v1-v2-migration.md`](internal/v1-v2-migration.md) for the historical migration-design notes (most of that document is superseded by the clean-cutover decision).

---

## technology stack

| layer | technology |
|-------|-----------|
| **Agent** | Python 3.9+, pywin32, psutil, CustomTkinter, NSSM |
| **Web** | Next.js 16, React 19, TypeScript 5, Tailwind CSS 4 |
| **UI Components** | shadcn/ui (Radix UI), Recharts, Lucide React |
| **Database** | Cloud Firestore (real-time NoSQL) |
| **Object storage (roost)** | Cloudflare R2 (S3-compatible, free egress) |
| **Auth** | Firebase Authentication, iron-session, TOTP (2FA) |
| **Email** | Resend API |
| **Cloud Functions** | Firebase Functions (2nd Gen, Node.js 20) |
| **Hosting** | Railway (web), Windows Service via NSSM (agent) |
| **Build** | Inno Setup (agent installer), Nixpacks (web) |
| **AI** | Vercel AI SDK, Anthropic Claude / OpenAI |
