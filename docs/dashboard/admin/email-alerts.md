# Email Alerts

owlette sends email notifications when machines go offline, processes crash, or connections fail.

---

## Alert Types

| Alert | Trigger | Recipients |
|-------|---------|------------|
| **Machine Offline** | Heartbeat missing for 3+ minutes | All site users with `healthAlerts` enabled |
| **Process Crash** | Configured process exits unexpectedly | Users subscribed to process alerts for that site |
| **Process Start Failed** | Process failed to launch | Users subscribed to process alerts |
| **Connection Failure** | Agent lost connection to Firestore | Site admins |

---

## Machine Offline Alerts

### How It Works

A Railway cron job runs every 5 minutes, calling `GET /api/cron/health-check`:

1. Scans all `sites/{siteId}/machines/{machineId}` for stale heartbeats
2. A machine is considered **offline** if its last heartbeat is older than 3 minutes
3. Sends one grouped email per site listing all offline machines
4. Writes `health.lastCronAlertAt` to Firestore to prevent repeat alerts
5. **Cooldown**: 1 hour per machine — won't send another alert for the same machine within an hour

### Email Content

The email includes:

- Site name
- List of offline machines with last-seen timestamps
- Direct link to the dashboard

---

## Process Crash Alerts

When the agent detects a process crash:

1. Agent sends `POST /api/agent/alert` with alert type `process_crash`
2. Server looks up users subscribed to process alerts for that site
3. Sends email with process name, machine name, and error details

### Rate Limiting

- **Process alerts**: 3 per hour per process per machine
- **Connection failures**: 5 per hour per IP

---

## Setting Up Alerts

### Prerequisites

1. **Resend API key** — Set `RESEND_API_KEY` environment variable in Railway
2. **Admin email** — Set `ADMIN_EMAIL_PROD` (production) or `ADMIN_EMAIL_DEV` (development)
3. **Cron job** — Configure Railway cron schedule (see below)

### Configuring the Cron Job

1. In Railway dashboard, open your web service
2. Go to **Settings** → **"Cron Schedule"**
3. Enter: `*/5 * * * *` (every 5 minutes)
4. Add `CRON_SECRET` environment variable:
    ```bash
    python -c "import secrets; print(secrets.token_hex(32))"
    ```

### User Preferences

Users can control their alert preferences:

- **Health alerts**: Opt in/out of machine offline notifications
- **Process alerts**: Opt in/out of process crash notifications

### Unsubscribe

Each alert email contains a one-click unsubscribe link that disables health alerts for that user.

---

## Testing Emails

### Test Email Page

Admins can send test emails from **Admin Panel → Email Test** (`/admin/test-email`):

1. Enter a recipient email
2. Optionally customize subject and message
3. Click **"Send Test Email"**
4. Verify delivery in your inbox

### Simulate Events

Test the full alert pipeline from **`/api/admin/events/simulate`**:

```bash
curl -X POST https://your-dashboard.app/api/admin/events/simulate \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -d '{
    "siteId": "your-site",
    "event": "process_crash",
    "data": {
      "machineId": "DESKTOP-TEST",
      "machineName": "Test Machine",
      "processName": "TouchDesigner",
      "errorMessage": "Process exited with code 1"
    }
  }'
```

This triggers the same email alert flow as a real event, without requiring a real crash.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | API key from [Resend](https://resend.com) |
| `CRON_SECRET` | Yes | Shared secret for cron authentication |
| `ADMIN_EMAIL_PROD` | Yes | Fallback admin email (production) |
| `ADMIN_EMAIL_DEV` | Yes | Fallback admin email (development) |

---

## Troubleshooting

### No Emails Received

1. Check `RESEND_API_KEY` is set in Railway environment variables
2. Verify the Resend API key is valid (test at resend.com)
3. Check spam/junk folder
4. Use the test email page to verify delivery
5. Check Railway logs for email-related errors

### Duplicate Alerts

The system has built-in cooldowns (1 hour per machine for offline alerts, rate limits for process alerts). If you're getting duplicates, check that the cron job isn't running more frequently than expected.

### Cron Not Running

1. Verify Railway cron schedule is set: `*/5 * * * *`
2. Check that `CRON_SECRET` matches between the env var and the cron configuration
3. Review Railway deployment logs for cron execution
