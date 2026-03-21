# Workstream 2: Webhook Notifications

**Priority:** 2 | **Effort:** Medium | **Round:** 2 (after WS1 completes) | **Branch:** `dev`

## Goal
Let users configure webhook URLs per site that fire JSON payloads on key events. One feature that covers Slack, Discord, Teams, PagerDuty, and Zapier integrations.

## Status
- [x] Firestore: Webhook collection schema
- [x] Web lib: `webhookSender.server.ts` utility
- [x] Web API: `/api/webhooks/test/route.ts` test endpoint
- [x] Web UI: `WebhookSettingsDialog.tsx` CRUD + test
- [x] Web: Integrate into `/api/agent/alert` (process + connection events)
- [x] Web: Integrate into `/api/cron/health-check` (machine offline)
- [x] Firestore rules: Add webhook collection access rules
- [ ] Testing: webhook.site receives payload
- [ ] Testing: Slack incoming webhook works
- [ ] Testing: HMAC signature validation
- [ ] Testing: Auto-disable after 10 failures

## Prerequisites
**Run after Round 1 (WS1 + WS4) is committed.** This workstream integrates into the alert endpoint that WS1 modifies. By the time you start:
- `/api/agent/alert/route.ts` will have an `eventType` field and process crash email templates (from WS1)
- `firebase_client.py` will have `send_process_alert()` and `set_machine_flag()` methods (from WS1 + WS4)
- Read the current state of these files before starting — don't rely on the code examples in WS1's doc, read what was actually committed.

## Context

### What Already Exists
- **Alert endpoint:** `web/app/api/agent/alert/route.ts` — integration point for process/connection alerts
- **Health check cron:** `web/app/api/cron/health-check/route.ts` — integration point for machine offline
- **Admin panel:** `web/app/admin/page.tsx` — where webhook management UI should live (or site settings)
- **Resend client:** `web/lib/resendClient.server.ts` — pattern to follow for webhook sender (lazy singleton)
- **Rate limiting:** `web/lib/withRateLimit.ts` — available if needed for webhook test endpoint

### Files to Create
| File | Purpose |
|------|---------|
| `web/lib/webhookSender.server.ts` | Core webhook dispatch utility |
| `web/app/api/webhooks/test/route.ts` | Test webhook delivery endpoint |
| `web/components/WebhookSettingsDialog.tsx` | UI for managing webhooks per site |

### Files to Modify
| File | Change |
|------|--------|
| `web/app/api/agent/alert/route.ts` | After email sending, call `fireWebhooks()` |
| `web/app/api/cron/health-check/route.ts` | After email sending, call `fireWebhooks()` for offline machines |
| `web/app/admin/page.tsx` | Add webhook management section (or link to webhook settings) |
| `firestore.rules` | Add read/write rules for `sites/{siteId}/webhooks` subcollection |

### Firestore Schema
```
sites/{siteId}/webhooks/{webhookId}:
  url: string              // Target URL (https required)
  name: string             // User-friendly label ("Slack #alerts")
  events: string[]         // ["machine.offline", "process.crashed", ...]
  enabled: boolean         // Can be toggled without deleting
  secret: string           // HMAC-SHA256 signing secret (auto-generated)
  createdAt: Timestamp
  createdBy: string        // userId who created it
  lastTriggered: Timestamp // When last payload was sent
  lastStatus: number       // HTTP status of last delivery (200, 500, etc.)
  failCount: number        // Consecutive failures (auto-disable at 10)
```

### Supported Events
| Event ID | Trigger Point | Payload Shape |
|----------|--------------|---------------|
| `machine.offline` | health-check cron | `{ machine: { id, name, lastSeen }, site: { id, name } }` |
| `machine.online` | Future: agent heartbeat resume | `{ machine: { id, name }, site: { id, name } }` |
| `process.crashed` | agent alert endpoint | `{ machine: { id, name }, site: { id, name }, process: { name, error, exitCode } }` |
| `process.restarted` | agent alert endpoint | `{ machine: { id, name }, site: { id, name }, process: { name, attempt } }` |
| `deployment.completed` | Future: deployment status update | `{ machine: { id, name }, site: { id, name }, deployment: { id, software } }` |
| `deployment.failed` | Future: deployment status update | `{ machine: { id, name }, site: { id, name }, deployment: { id, error } }` |

Start with `machine.offline` and `process.crashed` — the others can be added later.

### Implementation Details

**`webhookSender.server.ts`:**
```typescript
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

interface WebhookPayload {
  event: string;
  timestamp: string;
  site: { id: string; name: string };
  data: Record<string, unknown>;
}

/**
 * Fire all enabled webhooks for a site that subscribe to the given event.
 * Non-blocking — uses Promise.allSettled, never throws.
 */
export async function fireWebhooks(
  siteId: string,
  siteName: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  const db = getFirestore();

  // Query enabled webhooks that subscribe to this event
  const snapshot = await db
    .collection(`sites/${siteId}/webhooks`)
    .where('enabled', '==', true)
    .where('events', 'array-contains', eventType)
    .get();

  if (snapshot.empty) return;

  const payload: WebhookPayload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    site: { id: siteId, name: siteName },
    data,
  };

  const body = JSON.stringify(payload);

  const deliveries = snapshot.docs.map(async (doc) => {
    const webhook = doc.data();
    try {
      // HMAC signature
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Owlette-Signature': `sha256=${signature}`,
          'X-Owlette-Event': eventType,
          'User-Agent': 'Owlette-Webhooks/1.0',
        },
        body,
        signal: AbortSignal.timeout(5000), // 5s timeout
      });

      // Update delivery status
      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: response.status,
        failCount: response.ok ? 0 : (webhook.failCount || 0) + 1,
      });

      // Auto-disable after 10 consecutive failures
      if (!response.ok && (webhook.failCount || 0) + 1 >= 10) {
        await doc.ref.update({ enabled: false });
        console.warn(`Webhook ${doc.id} auto-disabled after 10 failures`);
      }
    } catch (error) {
      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: 0, // network error
        failCount: (webhook.failCount || 0) + 1,
      });

      if ((webhook.failCount || 0) + 1 >= 10) {
        await doc.ref.update({ enabled: false });
      }
    }
  });

  await Promise.allSettled(deliveries);
}
```

**Integration into alert endpoint (`/api/agent/alert/route.ts`):**
After the existing email-sending logic, add:
```typescript
// Fire webhooks (non-blocking, don't await in the response path)
fireWebhooks(siteId, siteName, eventType === 'process_crash' ? 'process.crashed' : 'machine.offline', {
  machine: { id: machineId, name: machineName },
  process: processName ? { name: processName, error: errorMessage } : undefined,
}).catch(console.error);
```

**Integration into health-check cron (`/api/cron/health-check/route.ts`):**
After sending offline emails, add:
```typescript
for (const machine of offlineMachines) {
  fireWebhooks(siteId, siteName, 'machine.offline', {
    machine: { id: machine.id, name: machine.name, lastSeen: machine.lastHeartbeat },
  }).catch(console.error);
}
```

**Webhook management UI (`WebhookSettingsDialog.tsx`):**
- Dialog accessible from admin panel or site settings
- List existing webhooks with status indicators (enabled/disabled, last status, fail count)
- Add webhook form: name, URL (https required), event checkboxes
- Auto-generate secret on creation (show once, then hide)
- Edit: toggle enabled, update events, update URL
- Delete with confirmation
- "Test" button: sends a test payload with `event: "test"` to the webhook URL
- Show delivery log (last 5 deliveries — optional, can defer)

**Test endpoint (`/api/webhooks/test/route.ts`):**
```typescript
// POST /api/webhooks/test
// Body: { webhookId: string, siteId: string }
// Sends a test payload to the webhook URL
// Requires admin session
```

### Firestore Rules Addition
```
match /sites/{siteId}/webhooks/{webhookId} {
  allow read: if isAuthenticated() && (isAdmin() || hasSiteAccess(siteId));
  allow write: if isAuthenticated() && isAdmin();
}
```

### Key Considerations
- **NEVER block email delivery** — webhook calls are fire-and-forget
- Webhooks are site-level, not user-level (one set of webhooks per site, managed by admins)
- Secret is auto-generated using `crypto.randomBytes(32).toString('hex')`
- URL must be HTTPS (reject HTTP in validation)
- `machine.online` event requires detecting heartbeat resumption — defer this to a future iteration unless easy to add during health-check cron (check for machines that were offline and are now online)
- Keep the payload format consistent across all events (always has `event`, `timestamp`, `site`, `data`)

### Testing Plan

**Using the Admin API (see `dev/active/ws0-admin-api.md`):**

1. **Create a webhook** via the UI pointing to https://webhook.site (free test endpoint).

2. **Simulate an event via API:**
   ```bash
   curl -X POST "http://localhost:3000/api/admin/events/simulate" \
     -H "Cookie: __session=SESSION" \
     -H "Content-Type: application/json" \
     -d '{"siteId":"SITE_ID","event":"process_crash","data":{"processName":"MyApp.exe","errorMessage":"Test crash"}}'
   ```
   Verify webhook.site receives the payload with correct structure and `X-Owlette-Signature` header.

3. **Verify HMAC:** Copy the signature header and body from webhook.site, compute HMAC-SHA256 with the webhook secret, confirm they match.

4. **Test auto-disable:** Point a webhook at an invalid URL, simulate 10+ events, verify webhook auto-disables (check Firestore `enabled: false`).

5. **Test Slack integration:** Create a Slack incoming webhook, simulate an event, verify Slack message appears.

6. **Test "Test" button** in the webhook management UI → verify test payload arrives.

7. **Verify non-blocking:** Time the simulate endpoint response — webhooks should not add significant latency since they're fire-and-forget.
