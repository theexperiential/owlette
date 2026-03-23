# Workstream 0: Admin API

**Priority:** 0 (prerequisite for all other workstreams) | **Effort:** Low-Medium | **Round:** 0 | **Branch:** `dev`

## Goal
Create admin-only REST API routes that allow programmatic interaction with Owlette — sending commands to machines, reading status, simulating events for testing. This enables Claude Code agents to verify their work and becomes the foundation for a future public API.

## Status
- [x] `POST /api/admin/commands/send` — Send any command to a machine
- [x] `GET /api/admin/machines` — List machines for a site
- [x] `GET /api/admin/machines/status` — Get machine status + metrics
- [x] `GET /api/admin/logs` — Read activity logs with filters
- [x] `POST /api/admin/events/simulate` — Simulate events (for testing alerts/webhooks)
- [x] Testing: curl commands work for all endpoints
- [x] Documentation: curl examples in this doc
- [x] API key auth (`owk_` prefix, SHA-256 hashed, stored in Firestore)
- [x] API key management routes (`POST /keys/create`, `GET /keys`, `DELETE /keys/revoke`)
- [x] API key management UI in Settings → API section
- [x] Three auth methods: API key (`api_key` param / `x-api-key` header), Bearer ID token, session cookie

## Context

### What Already Exists
All auth, rate limiting, and Firestore patterns are established. Follow them exactly.

**Auth pattern:** `requireAdmin(request)` from `web/lib/apiAuth.server.ts` — returns userId, throws 403 if not admin.

**Site access:** `assertUserHasSiteAccess(userId, siteId)` — verifies user can access the site.

**Rate limiting:** `withRateLimit()` HOF from `web/lib/withRateLimit.ts` — wraps route handlers.

**Firestore:** `getAdminDb()` from `web/lib/firebase-admin.ts` — lazy singleton admin SDK instance.

**Command send + poll pattern:** Already implemented in `web/app/api/cortex/route.ts`:
1. Write command to `sites/{siteId}/machines/{machineId}/commands/pending` doc
2. Poll `commands/completed` doc every 1.5s for up to 30s
3. Clean up completed command entry
4. Return result or timeout error

**Error handling:**
```typescript
try {
  // route logic
} catch (error: any) {
  if (error instanceof ApiAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('Context:', error);
  return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
}
```

**Standard imports:**
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdmin, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
```

### Files Created
| File | Purpose |
|------|---------|
| `web/app/api/admin/commands/send/route.ts` | Send command to a machine |
| `web/app/api/admin/machines/route.ts` | List machines for a site |
| `web/app/api/admin/machines/status/route.ts` | Get machine status + metrics |
| `web/app/api/admin/logs/route.ts` | Read activity logs |
| `web/app/api/admin/events/simulate/route.ts` | Simulate events for testing |
| `web/app/api/admin/keys/create/route.ts` | Generate new API key |
| `web/app/api/admin/keys/route.ts` | List active API keys (metadata only) |
| `web/app/api/admin/keys/revoke/route.ts` | Revoke an API key |

### Files Modified
| File | Change |
|------|--------|
| `web/lib/apiAuth.server.ts` | Added `requireAdminOrIdToken` (session + Bearer + API key) and `resolveApiKey` |
| `web/components/AccountSettingsDialog.tsx` | Added "API" section for key management UI |
| `web/lib/rateLimit.ts` | Bumped user rate limit to 60/hr |

---

## Implementation Details

### 1. `POST /api/admin/commands/send`

Send any command to a machine and optionally wait for the result.

```typescript
/**
 * POST /api/admin/commands/send
 *
 * Send a command to a machine via Firestore command queue.
 *
 * Request body:
 *   siteId: string          — Target site
 *   machineId: string       — Target machine
 *   command: string         — Command type (restart_process, kill_process, reboot_machine, etc.)
 *   data?: object           — Command-specific data (e.g., { process_name: "MyApp.exe" })
 *   wait?: boolean          — If true, poll for completion (default: false)
 *   timeout?: number        — Poll timeout in seconds (default: 30, max: 120)
 *
 * Response:
 *   { success: true, commandId: string }                          — if wait=false
 *   { success: true, commandId: string, result: object }          — if wait=true and completed
 *   { success: true, commandId: string, status: "timeout" }       — if wait=true and timed out
 */
```

**Implementation notes:**
- Reuse the exact command write + poll pattern from `/api/cortex/route.ts`
- Generate `commandId` with `crypto.randomUUID()`
- Write to `sites/{siteId}/machines/{machineId}/commands/pending` as a field on the document (not a subcollection doc — match existing pattern)
- Command structure: `{ type: command, ...data, timestamp: Date.now(), status: 'pending' }`
- If `wait=true`, poll `commands/completed` every 1.5s up to timeout
- Clean up completed entry after reading
- Rate limit: `user` strategy, `ip` identifier

**Supported commands (for reference — the agent handles these):**
- `restart_process` — requires `data.process_name`
- `kill_process` — requires `data.process_name`
- `toggle_autolaunch` — requires `data.process_name`
- `update_config` — requires `data.config`
- `install_software` — requires `data.installer_url`, `data.silent_flags`, etc.
- `update_owlette` — requires `data.installer_url`
- Future: `reboot_machine`, `shutdown_machine`, `capture_screenshot` (from other workstreams)

### 2. `GET /api/admin/machines`

List all machines for a site with their online status.

```typescript
/**
 * GET /api/admin/machines?siteId=xxx
 *
 * Response:
 *   {
 *     success: true,
 *     machines: [
 *       {
 *         id: string,
 *         name: string,
 *         online: boolean,
 *         lastHeartbeat: string (ISO),
 *         agentVersion: string,
 *         os: string
 *       }
 *     ]
 *   }
 */
```

**Implementation:**
- Query `sites/{siteId}/machines` collection
- For each machine doc, read the presence/status fields
- Return array sorted by name
- Rate limit: `user` strategy, `ip` identifier

### 3. `GET /api/admin/machines/status`

Get detailed status for a specific machine.

```typescript
/**
 * GET /api/admin/machines/status?siteId=xxx&machineId=yyy
 *
 * Response:
 *   {
 *     success: true,
 *     machine: {
 *       id, name, online, lastHeartbeat,
 *       metrics: { cpu, memory, disk, gpu },
 *       processes: [ { name, status, pid, autolaunch, uptime } ],
 *       health: { status, error_code?, error_message? },
 *       agentVersion, os
 *     }
 *   }
 */
```

**Implementation:**
- Read `sites/{siteId}/machines/{machineId}` document (presence + status fields)
- Read `config/{siteId}/machines/{machineId}` for process config
- Merge into a single response object
- Rate limit: `user` strategy, `ip` identifier

### 4. `GET /api/admin/logs`

Read activity logs with optional filters.

```typescript
/**
 * GET /api/admin/logs?siteId=xxx&limit=50&action=process_crash&level=error&machineId=yyy
 *
 * Query params:
 *   siteId: string       — Required
 *   limit?: number       — Max results (default: 50, max: 200)
 *   action?: string      — Filter by action type
 *   level?: string       — Filter by level (info, warning, error)
 *   machineId?: string   — Filter by machine
 *   since?: string       — ISO timestamp, only logs after this time
 *
 * Response:
 *   {
 *     success: true,
 *     logs: [
 *       { id, timestamp, action, level, machineId, processName, details }
 *     ]
 *   }
 */
```

**Implementation:**
- Query `sites/{siteId}/logs` collection (same collection the web logs page reads)
- Apply Firestore `where()` filters for action, level, machineId
- Apply `orderBy('timestamp', 'desc')` and `limit()`
- If `since` provided, add `where('timestamp', '>', since)`
- Rate limit: `user` strategy, `ip` identifier

### 5. `POST /api/admin/events/simulate`

Simulate events for testing alerts and webhooks without needing a real agent.

```typescript
/**
 * POST /api/admin/events/simulate
 *
 * Simulate an event as if it came from an agent. Triggers the same alert/webhook
 * pipeline without requiring a real machine. For testing only.
 *
 * Request body:
 *   siteId: string
 *   event: string           — Event type: "process_crash", "machine_offline", "connection_failure"
 *   data?: {
 *     machineId?: string    — Machine ID (default: "test-machine")
 *     machineName?: string  — Display name (default: "Test Machine")
 *     processName?: string  — For process events
 *     errorMessage?: string — Error details
 *   }
 *
 * Response:
 *   { success: true, event, emailSent: boolean, webhooksFired: number }
 */
```

**Implementation:**
- This does NOT write to Firestore or affect real machines
- It calls the same email-sending logic as `/api/agent/alert` and the health-check cron
- For `process_crash`: call `getSiteAlertRecipients()`, send process crash email template, fire webhooks (when WS2 is done)
- For `machine_offline`: same but with offline email template
- For `connection_failure`: same but with existing connection failure template
- Rate limit: `agentAlert` strategy (reuse existing — prevents spam)
- **Admin-only** — this can trigger real emails, so gate it tightly

**Important:** This endpoint is the key testing tool. After WS1 adds process crash emails and WS2 adds webhooks, agents can test their work by calling:
```bash
curl -X POST http://localhost:3000/api/admin/events/simulate \
  -H "Cookie: __session=..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"abc","event":"process_crash","data":{"processName":"MyApp.exe","errorMessage":"Exited with code 1"}}'
```

---

## curl Examples (for agent testing)

All examples assume the dev server is running on `localhost:3000`. Use an API key generated from Settings → API.

### Authentication

Three methods supported (in order of convenience for scripts):

```bash
# 1. API key as query param (simplest)
curl "http://localhost:3000/api/admin/machines?siteId=SITE_ID&api_key=owk_..."

# 2. API key as header
curl "http://localhost:3000/api/admin/machines?siteId=SITE_ID" \
  -H "x-api-key: owk_..."

# 3. Session cookie (from browser)
curl "http://localhost:3000/api/admin/machines?siteId=SITE_ID" \
  -H "Cookie: __session=SESSION"
```

### List machines
```bash
curl -s "http://localhost:3000/api/admin/machines?siteId=SITE_ID&api_key=owk_..."
```

### Get machine status
```bash
curl -s "http://localhost:3000/api/admin/machines/status?siteId=SITE_ID&machineId=MACHINE_ID&api_key=owk_..."
```

### Send a command (fire and forget)
```bash
curl -X POST "http://localhost:3000/api/admin/commands/send?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","machineId":"MACHINE_ID","command":"restart_process","data":{"process_name":"notepad.exe"}}'
```

### Send a command (wait for result)
```bash
curl -X POST "http://localhost:3000/api/admin/commands/send?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","machineId":"MACHINE_ID","command":"kill_process","data":{"process_name":"notepad.exe"},"wait":true,"timeout":15}'
```

### Read logs
```bash
curl -s "http://localhost:3000/api/admin/logs?siteId=SITE_ID&limit=10&action=process_crash&api_key=owk_..."
```

### Simulate a process crash (test alerts — sends real email!)
```bash
curl -X POST "http://localhost:3000/api/admin/events/simulate?api_key=owk_..." \
  -H "Content-Type: application/json" \
  -d '{"siteId":"SITE_ID","event":"process_crash","data":{"processName":"MyApp.exe","errorMessage":"Segfault"}}'
```

---

## Key Considerations

- **Admin-only for all routes.** Use `requireAdmin(request)` — not `requireSession()`.
- **Site access check on every route.** Even admins should go through `assertUserHasSiteAccess()` for consistency and future role changes.
- **Follow existing patterns exactly.** Import from the same libs, use the same error handling, same response shapes.
- **Don't modify existing routes.** This workstream only creates new files under `web/app/api/admin/`.
- **The simulate endpoint triggers real emails.** Rate limit it and log usage. In production, consider gating it behind an environment check (`NODE_ENV !== 'production'`) — but for now, admin-only is sufficient.
- **The command send endpoint is the most important one.** It lets agents programmatically control machines — restart processes, kill processes, trigger reboots (after WS4), capture screenshots (after WS3), etc.
- **No Firestore rules changes needed.** All server-side routes use the Admin SDK, which bypasses Firestore security rules.

## API Key Architecture

- Keys are prefixed with `owk_` (44 chars total, base64url-encoded)
- Only the SHA-256 hash is stored — raw key is shown once on creation
- **Firestore structure:**
  - `users/{userId}/apiKeys/{keyId}` — metadata (name, prefix, createdAt, lastUsedAt) for listing/management
  - `apiKeys/{keyHash}` — top-level lookup doc (`{ userId, keyId }`) for O(1) auth resolution
- Both docs are written/deleted atomically via batched writes
- `lastUsedAt` is updated on each API call (fire-and-forget)
- Management UI in AccountSettingsDialog → "api" section

## Testing Plan
1. Start dev server (`npm run dev`)
2. Create API key from Settings → API
3. Test each endpoint with curl commands above using `api_key=owk_...`
4. Verify auth: call without key → 401, call as non-admin → 403
5. Verify rate limiting: spam an endpoint → 429
6. Verify machines list returns real data from Firestore
7. Verify command send writes to Firestore pending commands
8. Verify logs endpoint returns real log entries
9. Verify simulate endpoint sends an actual email (check Resend dashboard)
10. Verify key revocation: revoke key in UI, confirm it returns 401 on next use
