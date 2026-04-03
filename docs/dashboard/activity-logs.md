# activity logs

The Activity Logs page shows a timeline of events across your machines — process starts, crashes, command executions, and system events.

---

## accessing logs

Navigate to **Logs** from the dashboard menu, or go directly to `/logs`.

---

## event types

| Action | Level | Description |
|--------|-------|-------------|
| `process_started` | Info | A configured process was launched |
| `process_start_failed` | Error | A process failed to start |
| `process_killed` | Warning | A process was terminated (manually or by agent) |
| `process_crashed` | Error | A process exited unexpectedly |
| `command_executed` | Info | A remote command was executed |
| `agent_started` | Info | The agent service started |
| `agent_stopped` | Info | The agent service stopped |
| `config_updated` | Info | Configuration was changed |

---

## filtering

Filter logs by:

| Filter | Options |
|--------|---------|
| **Action** | Any event type from the list above |
| **Machine** | Specific machine name |
| **Level** | Info, Warning, Error |

---

## log entry details

Each log entry shows:

| Field | Description |
|-------|-------------|
| **Timestamp** | When the event occurred |
| **Action** | Event type (color-coded badge) |
| **Level** | Severity: info (blue), warning (yellow), error (red) |
| **Machine** | Which machine the event occurred on |
| **Process** | Which process was involved (if applicable) |
| **Details** | Additional context (error messages, PIDs, etc.) |

---

## pagination

Logs are paginated at 50 entries per page. Use the **Next** and **Previous** buttons to navigate.

---

## log sources

Events are logged by two sources:

1. **Agent** — Writes directly to `sites/{siteId}/activity_logs/` in Firestore when processes start, crash, or when the agent starts/stops
2. **Dashboard API** — Writes logs when commands are sent or events are simulated

---

## retention

Activity logs are stored in Firestore indefinitely. There is no automatic cleanup — delete old logs manually from the Firestore Console if storage is a concern.

!!! tip "Admin event simulation"
    Admins can simulate events (process crash, machine offline) from `/api/admin/events/simulate` to test alerting and logging without requiring a real event.
