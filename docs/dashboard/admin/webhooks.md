# webhooks

Send event notifications to external systems via HTTPS webhooks. Use webhooks to integrate owlette with Slack, Discord, PagerDuty, or any HTTP endpoint.

**Location**: Admin Panel → Webhooks

---

## overview

Webhooks fire when events occur in your site — process crashes, machines going offline, connection failures. Each webhook is configured with a URL and a set of subscribed events. owlette sends a signed HTTP POST to your URL with event details.

---

## creating a webhook

1. Navigate to **Admin Panel → Webhooks**
2. Click **"Add Webhook"**
3. Configure:
    - **Name**: Descriptive label (e.g., "Slack Alerts")
    - **URL**: Your endpoint (must be HTTPS)
    - **Events**: Select which events trigger this webhook
4. Click **Create**

owlette generates an **HMAC-SHA256 signing secret** — save this to verify webhook authenticity on your end.

---

## event types

| event | description |
|-------|-------------|
| `process.crashed` | A configured process exited unexpectedly |
| `machine.offline` | A machine's heartbeat went stale (3+ minutes) |
| `connection_failure` | An agent lost connection to Firestore |

---

## payload format

Webhooks receive a JSON POST with this structure:

```json
{
  "event": "process.crashed",
  "timestamp": "2026-03-22T10:30:00Z",
  "site": {
    "id": "nyc-office",
    "name": "NYC Office"
  },
  "data": {
    "machineId": "DESKTOP-ABC123",
    "machineName": "Gallery PC 1",
    "processName": "TouchDesigner",
    "errorMessage": "Process exited with code -1073741819"
  }
}
```

---

## signature verification

Every webhook request includes an `X-owlette-Signature` header containing an HMAC-SHA256 signature of the request body, using your webhook's secret as the key.

**Verify in Node.js:**

```javascript
const crypto = require('crypto');

function verifyWebhook(body, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

---

## testing webhooks

1. Find your webhook in the list
2. Click **"Test"**
3. owlette sends a test payload to your URL
4. Check the response status (shown in the webhook list)

---

## managing webhooks

| action | description |
|--------|-------------|
| **Enable/Disable** | Toggle a webhook on or off without deleting |
| **Delete** | Remove a webhook permanently |
| **Test** | Send a test payload |

---

## auto-disable

If a webhook fails to deliver **10 consecutive times**, it is automatically disabled. The `failCount` and `lastStatus` fields in Firestore track delivery health.

To re-enable: fix the endpoint, then toggle the webhook back on.

---

## webhook vs email alerts

| | email alerts | webhooks |
|---|---|---|
| **Setup** | Built-in, Resend API key only | Custom endpoint required |
| **Speed** | 1-2 minutes | Near-instant |
| **Integration** | Inbox only | Slack, Discord, PagerDuty, anything |
| **Filtering** | Per-user preferences | Per-webhook event subscription |
| **Verification** | N/A | HMAC-SHA256 signing |

Use both — emails for humans, webhooks for automation.
