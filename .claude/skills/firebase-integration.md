# Firebase Integration Guidelines

**Applies To**: Both web dashboard and Python agent

---

## Firestore Data Structure

This is the source of truth for all data paths:

```
firestore/
├── sites/{siteId}/
│   ├── name, createdAt
│   └── machines/{machineId}/
│       ├── presence/              # Agent heartbeat every 30s
│       │   ├── online: boolean
│       │   ├── lastHeartbeat: timestamp
│       │   ├── rebooting: boolean          # Set before remote reboot
│       │   ├── shuttingDown: boolean       # Set before remote shutdown
│       │   └── rebootPending: { active, processName, reason, timestamp }  # When relaunch limit exceeded
│       ├── status/                # Agent metrics every 60s
│       │   ├── cpu, memory, disk, gpu: number
│       │   └── processes: map
│       ├── lastScreenshot/           # Most recent screenshot (overwritten each capture)
│       │   ├── url: string           # Firebase Storage public URL (with cache-buster)
│       │   ├── timestamp: number     # Capture time (Date.now())
│       │   └── sizeKB: number        # Image size in KB
│       └── commands/
│           ├── pending/{commandId}   # Web → Agent
│           └── completed/{commandId} # Agent → Web (result + completedAt)
│   └── webhooks/{webhookId}/          # Webhook notification endpoints
│       ├── url: string                # Target URL (https required)
│       ├── name: string               # User-friendly label
│       ├── events: string[]           # ["machine.offline", "process.crashed", ...]
│       ├── enabled: boolean           # Can be toggled without deleting
│       ├── secret: string             # HMAC-SHA256 signing secret
│       ├── createdAt, createdBy, lastTriggered, lastStatus, failCount
│       └── (auto-disables after 10 consecutive failures)
├── config/{siteId}/
│   └── machines/{machineId}/      # Process configuration (version, processes[])
│       # Each process has: name, exe_path, launch_mode ("off"/"always"/"scheduled"),
│       #   schedules?: [{ days: string[], startTime: "HH:MM", endTime: "HH:MM" }],
│       #   autolaunch (derived, backward compat), check_responsive, relaunch_attempts, ...
├── users/{userId}/                # email, role, createdAt, sites[], preferences {healthAlerts, processAlerts, temperatureUnit}
│   └── apiKeys/{keyId}/          # API key metadata (name, keyHash, keyPrefix, createdAt, lastUsedAt)
├── apiKeys/{keyHash}/            # Top-level API key lookup (userId, keyId) — O(1) resolution
├── deployments/{deploymentId}/    # Remote installer deployments
│   ├── installerUrl, silentFlags, targetMachines[], status, createdBy
│   └── results: map
└── project_distributions/{distributionId}/
    ├── project_url, project_name, extract_path, verify_files[]
    ├── targets: [{machineId, status, progress}]
    └── status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial'
```

---

## Two Different Firebase Clients

This is the most important architectural distinction:

| | Web Dashboard | Python Agent |
|---|---|---|
| **SDK** | Firebase Client SDK (`firebase/firestore`) | Custom REST client (`firestore_rest_client.py`) |
| **Auth** | Firebase Auth (email/password, Google OAuth) | OAuth two-token system (`auth_manager.py`) |
| **Real-time** | `onSnapshot` listeners | Polling + Firestore listener thread |
| **Timestamps** | `serverTimestamp()` | `{"timestampValue": "..."}` REST format |

### Agent: Do NOT

- Do NOT import `firebase_admin` — the agent uses a custom REST client
- Do NOT use `google.cloud.firestore` client libraries
- Do NOT use `firestore.SERVER_TIMESTAMP` — REST API uses different format
- Do NOT bypass `ConnectionManager` for reconnection logic
- Do NOT log OAuth tokens, even in DEBUG mode

### Web: Key Patterns

- Firebase init is in `web/lib/firebase.ts` (singleton)
- Auth state lives in `web/contexts/AuthContext.tsx`
- All Firestore reads go through hooks in `web/hooks/` (not direct calls from components)
- Always scope queries to user's site: `sites/{siteId}/...`

---

## Command Flow (Web → Agent)

```
Web Dashboard writes to:  sites/{siteId}/machines/{machineId}/commands/pending/{commandId}
Agent listener picks up → executes → moves to commands/completed/{commandId}
Web listener sees completion → updates UI
```

Command types: `restart_process`, `kill_process`, `set_launch_mode`, `update_config`, `install_software`, `distribute_project`

---

## Alert Flow (Agent → Web API → Email)

```
Agent detects crash → firebase_client.send_process_alert()
  → daemon thread POSTs to /api/agent/alert with bearer token
  → API validates agent token, checks per-process rate limit (3/hr per machineId:processName)
  → queries users with processAlerts !== false for the site
  → sends email via Resend
```

Two alert types flow through `/api/agent/alert`:
- **Connection failure** (`eventType: 'connection_failure'`): existing health alerts, filtered by `healthAlerts` preference
- **Process events** (`eventType: 'process_crash' | 'process_start_failed'`): filtered by `processAlerts` preference

User preferences (`users/{userId}/preferences`):
- `healthAlerts` (default: true) — machine offline email alerts
- `processAlerts` (default: true) — process crash/start failure email alerts
- `temperatureUnit` ('C' | 'F') — dashboard display preference

---

## Webhook Flow (Agent/Cron → Web API → External URLs)

```
Alert endpoint or cron detects event
  → calls fireWebhooks(siteId, siteName, eventType, data) (fire-and-forget)
  → queries sites/{siteId}/webhooks where enabled==true AND events array-contains eventType
  → POSTs JSON payload to each webhook URL with HMAC-SHA256 signature
  → updates lastTriggered, lastStatus, failCount on each webhook doc
  → auto-disables webhook after 10 consecutive failures
```

Supported event types: `machine.offline`, `process.crashed`, `process.restarted`, `machine.online`, `deployment.completed`, `deployment.failed`

Currently integrated: `machine.offline` (health-check cron + agent alert), `process.crashed` / `process.restarted` (agent alert), plus the simulate endpoint.

Webhook payloads always include: `{ event, timestamp, site: { id, name }, data: { machine, process?, ... } }`

Headers: `X-Owlette-Signature: sha256=<hmac>`, `X-Owlette-Event: <type>`, `User-Agent: Owlette-Webhooks/1.0`

---

## Security Rules

Rules enforce site-scoped access via `hasSiteAccess(siteId)` — checks if `request.auth.uid` has the siteId in their `users/{userId}.sites[]` array. Deployments are user-scoped (only creator can update/delete).

Rules file: `firestore.rules` (version managed independently from product version).

---

## When This Skill Activates

Working on files with Firebase imports, Firestore operations, or auth flows.
