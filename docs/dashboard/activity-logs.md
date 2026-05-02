# activity logs

The activity logs page shows a site-scoped timeline for agent, process, command, deployment, and scheduled reboot events. Open it from the dashboard menu by selecting **logs**, or go directly to `/logs`.

---

## event types

The action filter is built from the current dashboard action list:

| action | label | typical level |
|--------|-------|---------------|
| `agent_started` | agent started | info |
| `agent_stopped` | agent stopped | info |
| `process_started` | process started | info |
| `process_killed` | process killed | warning |
| `process_crash` | process crashed | error |
| `process_start_failed` | start failed | error |
| `command_executed` | command executed | info |
| `deployment_completed` | deployment completed | info |
| `deployment_failed` | deployment failed | error |
| `deployment_cancelled` | deployment cancelled | warning |
| `scheduled_reboot` | scheduled reboot | warning |

The menu also includes **all actions** as the reset value.

---

## filtering

Select **show filters** to narrow the timeline.

| filter | options |
|--------|---------|
| **action type** | all actions, or one action from the table above |
| **machine** | all machines, or a machine present in the loaded logs |
| **level** | all levels, info, warning, error |
| **date range** | all time, last hour, last 24 hours, today, yesterday, last 7 days, last 30 days, this week, this month, last month, custom range |

When **custom range** is selected, the page shows **from** and **to** date inputs. Use **reset filters** to clear action, machine, level, and date filters.

---

## browsing logs

The first batch is loaded with a real-time Firestore listener, ordered newest first when the active filters allow it. The page loads 50 entries at a time and uses infinite scroll: when you reach the end of the visible list, the next batch is fetched automatically and a **loading more...** indicator appears.

There are no numbered page controls on the current page.

---

## log entry details

Each collapsed row shows:

| field | description |
|-------|-------------|
| **level** | Severity badge for info, warning, error, or another stored level |
| **action** | Stored action value rendered as readable text |
| **machine** | Machine name for the event |
| **process** | Process name when the event is process-scoped |
| **timestamp** | Rendered using the user's selected dashboard time display mode |
| **details** | Short text preview when present |
| **screenshot** | Camera marker when a crash screenshot is attached |

Expand a row to see the machine id, user id when present, the full timestamp, full details text, and an attached crash screenshot preview.

---

## storage and API

Logs are stored under:

```text
sites/{siteId}/logs/{logId}
```

The dashboard reads from that collection directly. The site logs API reads the same collection with cursor pagination:

```http
GET /api/sites/{siteId}/logs?action=process_crash&machineId=machine-1&level=error&since=1714521600000&until=1714607999999
```

Supported API query filters are `action`, `machineId`, `level`, `since`, `until`, `page_size`, and `page_token`.

Stored log entries may include `timestamp`, `action`, `level`, `machineId`, `machineName`, `processName`, `details`, `userId`, and `screenshotUrl`.

---

## clearing logs

The **clear logs** button permanently deletes logs for the current site. It opens a confirmation dialog before sending:

```http
DELETE /api/sites/{siteId}/logs
Idempotency-Key: dashboard-clear-logs-<uuid>
Content-Type: application/json

{ "action": "deployment_failed", "machineId": "machine-1", "level": "error" }
```

Clearing requires the site-scoped `SITE_LOGS_MANAGE` capability. Site admins have this capability for their assigned sites; superadmins have it globally. API-key calls must use an admin-capable key.

The delete body can include `action`, `machineId`, and `level` filters. If no filters are provided, the body must explicitly be:

```json
{ "all": true }
```

The response includes `siteId`, `deletedCount`, and the applied `filters`. Whole-site clears and filtered clears are destructive and cannot be undone. The current dashboard clear action applies action, machine, and level filters only; date range filters are view filters and are not sent in the clear request.
