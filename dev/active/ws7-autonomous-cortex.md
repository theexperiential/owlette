# Workstream 7: Autonomous Cortex — Event-Driven Cluster Management

**Priority:** 1 (highest) | **Effort:** High | **Round:** 5 (after WS2) | **Branch:** `dev`

## Goal

Transform Cortex from a user-initiated chat assistant into an **autonomous cluster manager**. When a process crashes or fails to start, Cortex automatically investigates (reads logs, checks system state) and attempts remediation (restarts the process). If it can't resolve the issue, it escalates to site admins via email.

**The Directive**: Cortex's core mission is to keep all machines and processes online and operational.

## Status

- [ ] Phase 1: Extract shared utilities from cortex route
- [ ] Phase 2: Add autonomous system prompt builder
- [ ] Phase 3: Create `/api/cortex/autonomous` endpoint
- [ ] Phase 4: Wire alert route to trigger autonomous Cortex
- [ ] Phase 5: Add Firestore collections, indexes, and guardrails
- [ ] Phase 6: Create escalation system
- [ ] Phase 7: Add autonomous chat badge in Cortex sidebar
- [ ] Testing: Simulated crash triggers autonomous investigation
- [ ] Testing: Dedup/cooldown prevents duplicate investigations
- [ ] Testing: Escalation email sent when Cortex can't resolve
- [ ] Testing: Build passes (`npm run build`)

## Architecture

```
Agent detects crash/error
       |
POST /api/agent/alert  (existing)
       |
  +----+------------------------+
  | Email + Webhooks            |  (existing, unchanged)
  | (non-blocking)              |
  +-----------------------------+
       | (new: fire-and-forget internal call, process events only)
POST /api/cortex/autonomous  (new endpoint)
       |
  +---------------------------------------------+
  |  1. Check: autonomous enabled for site?      |
  |  2. Check: dedup/cooldown/concurrency        |
  |  3. Create cortex-event record               |
  |  4. Resolve site-level LLM config            |
  |  5. generateText() with maxSteps=15          |
  |     +-- Tools: Tier 1 + 2 (configurable)    |
  |     +-- System prompt with DIRECTIVE         |
  |     +-- Event context injected               |
  |  6. Save conversation to chats/{chatId}      |
  |  7. Update event: resolved/escalated         |
  |  8. If escalated -> email admins             |
  +---------------------------------------------+
```

## Event Scope

**Process events only** for this iteration:
- `process_crash` — process stopped unexpectedly
- `process_start_failed` — process failed to launch

Connection failures and machine offline events are excluded — the machine is unreachable, so Cortex can't use tools to investigate.

## Prerequisites

- WS0 (Admin API) — for testing via `/api/admin/events/simulate`
- WS1 (Crash Alerts) — the alert endpoint that triggers autonomous Cortex
- WS2 (Webhooks) — webhook firing in alert route (already wired)
- Existing Cortex MVP — chat UI, tool system, LLM config

Read the current state of these files before starting:
- `web/app/api/cortex/route.ts` — the existing chat endpoint to extract utilities from
- `web/app/api/agent/alert/route.ts` — where to add the autonomous trigger
- `web/lib/llm.ts` — where to add the autonomous system prompt
- `web/lib/mcp-tools.ts` — tool tier system
- `web/hooks/useCortex.ts` — chat conversation management (for understanding chat data model)

---

## Phase 1: Extract Shared Utilities

**New file:** `web/lib/cortex-utils.server.ts`
**Modify:** `web/app/api/cortex/route.ts`

Extract these functions from the cortex route into the shared module:

### `resolveLlmConfig(db, userId, siteId, options?)`

Move the existing function. Add an `autonomous` mode option:

```typescript
interface ResolveLlmConfigOptions {
  autonomous?: boolean;  // If true, only read site-level key + use autonomousModel
}
```

When `autonomous: true`:
- Skip user-level key lookup (no userId in autonomous mode)
- Read `sites/{siteId}/settings/llm` only
- Check for `autonomousModel` field — if set, override the model
- Accept `userId` as optional (pass `null` for autonomous)

### `isMachineOnline(db, siteId, machineId)`

Move unchanged.

### `executeToolOnAgent(db, siteId, machineId, toolName, toolParams, chatId)`

Move unchanged.

### `executeExistingCommand(db, siteId, machineId, commandType, processName)`

Move unchanged.

### `buildExecutableTools(db, siteId, machineId, chatId, toolDefs)`

Move unchanged. The `maxTier` filtering happens before this function is called (via `getToolsByTier()`).

### Update existing cortex route

Replace inline function definitions with imports from `cortex-utils.server.ts`. No behavior change — verify by running `npm run build`.

---

## Phase 2: Autonomous System Prompt

**Modify:** `web/lib/llm.ts`

Add a new function:

```typescript
export const DEFAULT_AUTONOMOUS_DIRECTIVE =
  'Keep all configured processes running and machines operational. When a process crashes, check agent logs and system event logs for errors, restart the process. If a restart fails twice, escalate to site admins.';

export function buildAutonomousSystemPrompt(
  machineName: string,
  directive: string,
  eventContext: string
): string {
  return `You are Owlette Cortex operating in AUTONOMOUS mode. You have been triggered by a system alert — no human initiated this conversation.

YOUR DIRECTIVE: ${directive || DEFAULT_AUTONOMOUS_DIRECTIVE}

CURRENT EVENT:
${eventContext}

You are connected to machine "${machineName}". Your job is to investigate the issue using your tools, attempt remediation, and report your findings.

RULES:
1. INVESTIGATE FIRST — always check agent logs and process status before taking action
2. RESTART LIMIT — do not restart the same process more than 2 times in this session
3. ESCALATE — if you cannot resolve the issue after investigation and restart attempts, say "ESCALATION NEEDED" and explain why
4. BE EFFICIENT — minimize unnecessary tool calls, focus on the specific issue
5. ALWAYS SUMMARIZE — end your response with a structured summary:
   - ISSUE: what happened
   - INVESTIGATION: what you found
   - ACTION: what you did
   - OUTCOME: resolved / escalated / needs attention`;
}
```

---

## Phase 3: Autonomous Endpoint

**New file:** `web/app/api/cortex/autonomous/route.ts`

### Auth

Internal-only. Validate `CORTEX_INTERNAL_SECRET` env var against request header:

```typescript
const secret = request.headers.get('x-cortex-secret');
if (secret !== process.env.CORTEX_INTERNAL_SECRET) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

### Request Body

```typescript
interface AutonomousRequest {
  siteId: string;
  machineId: string;
  machineName: string;
  eventType: 'process_crash' | 'process_start_failed';
  processName: string;
  errorMessage: string;
  agentVersion?: string;
}
```

### Logic (step by step)

```typescript
export async function POST(request: NextRequest) {
  // 1. Validate internal secret
  // 2. Parse & validate body

  const db = getAdminDb();

  // 3. Read directive config
  const cortexSettingsDoc = await db.doc(`sites/${siteId}/settings/cortex`).get();
  const settings = cortexSettingsDoc.data() ?? {};
  if (!settings.autonomousEnabled) {
    return NextResponse.json({ accepted: false, reason: 'autonomous_disabled' });
  }

  // 4. Dedup check — same machine+process within cooldown window
  const cooldownMs = (settings.cooldownMinutes ?? 15) * 60 * 1000;
  const recentEvents = await db.collection(`sites/${siteId}/cortex-events`)
    .where('machineId', '==', machineId)
    .where('processName', '==', processName)
    .where('timestamp', '>', Timestamp.fromMillis(Date.now() - cooldownMs))
    .limit(1)
    .get();

  if (!recentEvents.empty) {
    return NextResponse.json({ accepted: false, reason: 'cooldown_active' });
  }

  // 5. Concurrency check — max 3 active sessions per site
  const lockRef = db.doc(`sites/${siteId}/cortex-state/lock`);
  // Use transaction to atomically check and increment
  const canProceed = await db.runTransaction(async (tx) => {
    const lockDoc = await tx.get(lockRef);
    const active = lockDoc.data()?.activeSessions ?? 0;
    if (active >= 3) return false;
    tx.set(lockRef, { activeSessions: active + 1, lastUpdated: Timestamp.now() }, { merge: true });
    return true;
  });

  if (!canProceed) {
    return NextResponse.json({ accepted: false, reason: 'concurrency_limit' });
  }

  // 6. Create event record
  const eventId = `evt_${Date.now()}_${machineId}`;
  const chatId = `auto_${Date.now()}_${machineId}`;
  const eventRef = db.doc(`sites/${siteId}/cortex-events/${eventId}`);
  await eventRef.set({
    machineId, machineName, processName, eventType, errorMessage,
    timestamp: Timestamp.now(),
    chatId,
    status: 'investigating',
    actions: [],
  });

  // 7. Return immediately — run LLM work in background
  //    Use a detached promise (fire-and-forget)
  const responsePromise = NextResponse.json({
    accepted: true, eventId, chatId
  });

  // Fire and forget the autonomous investigation
  runAutonomousInvestigation(db, {
    siteId, machineId, machineName, eventType, processName,
    errorMessage, eventId, chatId, settings
  }).catch(err => {
    console.error(`[cortex/autonomous] Investigation failed for ${eventId}:`, err);
  });

  return responsePromise;
}
```

### `runAutonomousInvestigation()` — the core LLM loop

```typescript
async function runAutonomousInvestigation(db, params) {
  const { siteId, machineId, machineName, eventType, processName,
          errorMessage, eventId, chatId, settings } = params;

  const eventRef = db.doc(`sites/${siteId}/cortex-events/${eventId}`);
  const lockRef = db.doc(`sites/${siteId}/cortex-state/lock`);
  const startTime = Date.now();

  try {
    // Check machine online
    const online = await isMachineOnline(db, siteId, machineId);
    if (!online) {
      await eventRef.update({ status: 'escalated', summary: 'Machine offline — cannot investigate' });
      await escalate(db, siteId, eventId, machineName, processName, 'Machine is offline');
      return;
    }

    // Resolve LLM config (site-level only)
    const llmConfig = await resolveLlmConfig(db, null, siteId, { autonomous: true });

    // Build tools (tier-capped)
    const maxTier = settings.maxTier ?? 2;
    const toolDefs = getToolsByTier(maxTier);
    const tools = buildExecutableTools(db, siteId, machineId, chatId, toolDefs);

    // Build event context string
    const eventLabel = eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
    const eventContext = [
      `Process "${processName}" ${eventLabel} on machine "${machineName}".`,
      errorMessage ? `Error: ${errorMessage}` : '',
    ].filter(Boolean).join('\n');

    // Build system prompt
    const systemPrompt = buildAutonomousSystemPrompt(
      machineName,
      settings.directive || '',
      eventContext
    );

    // Run LLM with tools
    const model = createModel(llmConfig);
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: eventContext }],
      tools,
      maxSteps: 15,
    });

    // Extract final text
    const finalText = result.text || '';

    // Determine outcome
    const escalated = finalText.includes('ESCALATION NEEDED');
    const status = escalated ? 'escalated' : 'resolved';

    // Extract summary (look for OUTCOME line)
    const summaryMatch = finalText.match(/OUTCOME:\s*(.+)/i);
    const summary = summaryMatch?.[1]?.trim() || (escalated ? 'Escalated to admins' : 'Issue investigated and addressed');

    // Extract actions from tool calls in steps
    const actions = result.steps?.flatMap(step =>
      (step.toolCalls || []).map(tc => ({
        tool: tc.toolName,
        params: tc.args,
        timestamp: Timestamp.now(),
      }))
    ) || [];

    // Update event
    await eventRef.update({
      status,
      summary,
      actions,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    });

    // Save conversation to chats collection
    await db.doc(`chats/${chatId}`).set({
      source: 'autonomous',
      eventId,
      siteId,
      targetType: 'machine',
      targetMachineId: machineId,
      machineName,
      title: `Auto: ${processName} ${eventLabel}`,
      autonomousSummary: summary,
      messages: result.response.messages, // Full message history
      createdAt: Timestamp.fromMillis(startTime),
      updatedAt: Timestamp.now(),
    });

    // Escalate if needed
    if (escalated) {
      await escalate(db, siteId, eventId, machineName, processName, finalText);
    }

    console.log(`[cortex/autonomous] ${eventId}: ${status} in ${Date.now() - startTime}ms`);

  } catch (err) {
    console.error(`[cortex/autonomous] ${eventId} error:`, err);
    await eventRef.update({
      status: 'failed',
      summary: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    }).catch(() => {});
  } finally {
    // Always decrement lock
    await db.runTransaction(async (tx) => {
      const lockDoc = await tx.get(lockRef);
      const active = lockDoc.data()?.activeSessions ?? 1;
      tx.set(lockRef, {
        activeSessions: Math.max(0, active - 1),
        lastUpdated: Timestamp.now(),
      }, { merge: true });
    }).catch(() => {});
  }
}
```

### Important: `generateText` import

The existing cortex route uses `streamText` from `ai`. The autonomous route uses `generateText` (non-streaming, synchronous multi-turn). Both are from the `ai` package (Vercel AI SDK).

```typescript
import { generateText, tool, jsonSchema, type StepResult } from 'ai';
```

`generateText` with `maxSteps` handles the full tool-calling loop internally — it calls the LLM, sees tool calls, executes them, feeds results back, and repeats until the model stops calling tools or maxSteps is reached.

---

## Phase 4: Wire Alert Route

**Modify:** `web/app/api/agent/alert/route.ts`

Add a `triggerAutonomousCortex()` helper and call it after the existing webhook logic, **only for process events**.

### Helper function (add at top of file or in a separate util)

```typescript
async function triggerAutonomousCortex(params: {
  siteId: string;
  machineId: string;
  machineName: string;
  eventType: string;
  processName: string;
  errorMessage: string;
  agentVersion: string;
}) {
  const secret = process.env.CORTEX_INTERNAL_SECRET;
  if (!secret) return; // Not configured — skip silently

  // Quick check: is autonomous mode enabled for this site?
  const db = getAdminDb();
  const settingsDoc = await db.doc(`sites/${params.siteId}/settings/cortex`).get();
  if (!settingsDoc.exists || !settingsDoc.data()?.autonomousEnabled) return;

  // Build internal URL
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

  // Fire and forget
  fetch(`${baseUrl}/api/cortex/autonomous`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cortex-secret': secret,
    },
    body: JSON.stringify(params),
  }).catch(err => console.error('[agent/alert] Failed to trigger Cortex:', err));
}
```

### Integration point (after line ~218 in alert route)

```typescript
// After fireWebhooks() call...

// Trigger autonomous Cortex investigation (non-blocking, process events only)
if (isProcessEvent) {
  triggerAutonomousCortex({
    siteId,
    machineId,
    machineName: machineId,  // machineId is the best we have here
    eventType: resolvedEventType,
    processName: processName || '',
    errorMessage: errorMessage || '',
    agentVersion: agentVersion || '',
  }).catch(err => console.error('[agent/alert] Cortex trigger failed:', err));
}
```

---

## Phase 5: Firestore Collections & Guardrails

### New Firestore Data

**`sites/{siteId}/settings/cortex`** — Directive config (set via Firestore console for now):
```json
{
  "autonomousEnabled": false,
  "directive": "",
  "maxTier": 2,
  "autonomousModel": null,
  "maxEventsPerHour": 10,
  "cooldownMinutes": 15,
  "escalationEmail": true
}
```

**`sites/{siteId}/cortex-events/{eventId}`** — Event audit trail:
```json
{
  "machineId": "MEDIA-PC-01",
  "machineName": "Media Server",
  "processName": "TouchDesigner",
  "eventType": "process_crash",
  "errorMessage": "Process stopped unexpectedly",
  "timestamp": "<Timestamp>",
  "chatId": "auto_1711036800000_MEDIA-PC-01",
  "status": "investigating | resolved | escalated | failed",
  "summary": "Restarted TouchDesigner successfully",
  "actions": [
    { "tool": "get_agent_logs", "timestamp": "<Timestamp>" },
    { "tool": "restart_process", "params": { "process_name": "TouchDesigner" }, "timestamp": "<Timestamp>" }
  ],
  "resolvedAt": "<Timestamp>",
  "durationMs": 45000
}
```

**`sites/{siteId}/cortex-state/lock`** — Concurrency control:
```json
{
  "activeSessions": 0,
  "lastUpdated": "<Timestamp>"
}
```

**Changes to `chats/{chatId}`** — new fields:
```
+ source: "user" | "autonomous"
+ eventId: string | null
+ autonomousSummary: string | null
```

### New Firestore Index

Add to `firestore.indexes.json`:

```json
{
  "collectionGroup": "cortex-events",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "machineId", "order": "ASCENDING" },
    { "fieldPath": "processName", "order": "ASCENDING" },
    { "fieldPath": "timestamp", "order": "DESCENDING" }
  ]
}
```

### Guardrails Summary

| Guardrail | Mechanism | Default |
|-----------|-----------|---------|
| Event dedup | Query cortex-events within cooldown window | 15 min cooldown |
| Concurrency cap | Firestore transaction on lock doc | Max 3 per site |
| Step limit | `maxSteps` in `generateText()` | 15 steps |
| Restart cap | System prompt instruction | Max 2 per session |
| Tier restriction | `maxTier` in directive config | Tier 2 (no shell) |
| Offline detection | Check presence before starting | Immediate escalation |
| Opt-in | `autonomousEnabled` flag | Disabled by default |

---

## Phase 6: Escalation System

**New file:** `web/lib/cortex-escalation.server.ts`

### `escalate()` function

```typescript
export async function escalate(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  eventId: string,
  machineName: string,
  processName: string,
  cortexResponse: string
): Promise<void> {
  // 1. Get site admin emails
  const recipients = await getSiteAdminEmails(siteId, true);
  if (recipients.length === 0) return;

  // 2. Build escalation email
  const subject = `[Cortex] Escalation: ${processName} on ${machineName}`;
  const html = buildEscalationEmail(machineName, processName, cortexResponse, eventId);

  // 3. Send via Resend
  const resend = getResend();
  if (!resend) return;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: recipients,
    subject,
    html,
  });
}
```

### Email content

The escalation email includes:
- Machine name and process name
- What Cortex investigated and attempted
- Why it's escalating (from Cortex's response)
- Link to the autonomous conversation in the dashboard
- Timestamp

---

## Phase 7: Minimal UI — Autonomous Chat Badge

**Modify:** `web/app/cortex/page.tsx` (or the sidebar component within it)

In the conversation list sidebar, check the `source` field of each chat:
- If `source === 'autonomous'`: show a `<Badge>Auto</Badge>` or `<Zap className="h-3 w-3" />` icon next to the chat title
- Autonomous chats should be viewable (read-only is fine) just like user chats
- Sort autonomous chats alongside user chats by timestamp

This is the only UI change in this workstream.

---

## Files Modified/Created

| File | Action | Phase |
|------|--------|-------|
| `web/lib/cortex-utils.server.ts` | **New** | 1 |
| `web/app/api/cortex/route.ts` | Modify (extract utils) | 1 |
| `web/lib/llm.ts` | Modify (add autonomous prompt) | 2 |
| `web/app/api/cortex/autonomous/route.ts` | **New** | 3 |
| `web/app/api/agent/alert/route.ts` | Modify (add trigger) | 4 |
| `firestore.indexes.json` | Modify (add index) | 5 |
| `web/lib/cortex-escalation.server.ts` | **New** | 6 |
| `web/app/cortex/page.tsx` | Modify (auto badge) | 7 |

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `CORTEX_INTERNAL_SECRET` | Shared secret for internal autonomous endpoint auth | Yes (for autonomous mode) |

Add to Railway env vars for both dev and production.

## Testing

### Via Admin API (simulated)

```bash
# 1. Ensure autonomous is enabled in Firestore console:
#    sites/{siteId}/settings/cortex → { autonomousEnabled: true }

# 2. Simulate a process crash event
curl -X POST https://dev.owlette.app/api/admin/events/simulate \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "siteId": "YOUR_SITE",
    "machineId": "YOUR_MACHINE",
    "eventType": "process_crash",
    "processName": "TestProcess",
    "errorMessage": "Process stopped unexpectedly"
  }'

# 3. Check Firestore for:
#    - sites/{siteId}/cortex-events/ → new event doc with status
#    - chats/ → new chat doc with source: "autonomous"

# 4. Check Cortex UI → autonomous chat should appear with "Auto" badge
```

### Via real agent crash

1. Configure a test process in Owlette that you can manually kill
2. Enable autonomous mode for the site
3. Kill the process → agent detects crash → alert fires → Cortex investigates
4. Check the autonomous conversation in Cortex UI
