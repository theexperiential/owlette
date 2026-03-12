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
│       │   └── lastHeartbeat: timestamp
│       ├── status/                # Agent metrics every 60s
│       │   ├── cpu, memory, disk, gpu: number
│       │   └── processes: map
│       └── commands/
│           ├── pending/{commandId}   # Web → Agent
│           └── completed/{commandId} # Agent → Web (result + completedAt)
├── config/{siteId}/
│   └── machines/{machineId}/      # Process configuration (version, processes[])
├── users/{userId}/                # email, role, createdAt, sites[]
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

Command types: `restart_process`, `kill_process`, `toggle_autolaunch`, `update_config`, `install_software`, `distribute_project`

---

## Security Rules

Rules enforce site-scoped access via `hasSiteAccess(siteId)` — checks if `request.auth.uid` has the siteId in their `users/{userId}.sites[]` array. Deployments are user-scoped (only creator can update/delete).

Rules file: `firestore.rules` (version managed independently from product version).

---

## When This Skill Activates

Working on files with Firebase imports, Firestore operations, or auth flows.
