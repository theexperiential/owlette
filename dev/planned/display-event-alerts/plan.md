# display-event-alerts — plan
**Created**: 2026-04-24 | **Status**: Planned (not started) | **Split from**: dev/completed/display-layout-management (Wave 8)

## problem

display topology events (`display_monitor_removed`, `display_auto_revert_fired`, `display_drift`, etc.) are emitted into Firestore and surface as toasts in the dashboard, but they don't route through the existing email + webhook alert pipeline. Critical events like a kiosk losing its only monitor, or an auto-revert firing because an operator's apply died silently, should notify on-call the same way process crashes and threshold alerts do.

## scope

phase 2 of the display-layout-management feature — routing display events through the alert plumbing that already exists for process and threshold alerts.

explicitly **in scope**:
- map each `display_*` event type to a severity + alert channel (email / webhook / both / none)
- per-(machineId, eventType) throttling so flapping doesn't spam inboxes
- respect `userPreferences.mutedMachines`
- document webhook payload schema for external integrations

explicitly **out of scope** (phase 3, revisit separately):
- cortex MCP `get_display_alerts` tool for autonomous monitoring queries
- per-site configurable severity thresholds
- drift event aggregation in the dashboard's events view
- push notifications (no mobile app — defer indefinitely)

## proposed tasks

### Task 1: event-to-alert routing
- **Files**: `agent/src/firebase_client.py` (or the web-side alert router — likely `web/lib/alerts/` or a Cloud Function; confirm during implementation)
- **Do**: Map each `display_*` event type to severity + alert eligibility:
  | event | severity | channels |
  |---|---|---|
  | `display_monitor_removed` | critical | email + webhook |
  | `display_auto_revert_fired` | critical | email + webhook |
  | `display_apply_failed` | warning | webhook only |
  | `display_drift` | warning | webhook only |
  | `display_monitor_added` | warning | webhook only |
  | `display_monitor_swapped` | warning | webhook only |
  | `display_mosaic_disabled` | warning | webhook only |
  | `display_sync_lost` | warning | webhook only |
  | info-tier events | — | audit log only |
- Use existing email + webhook plumbing — no new infra. The `727654c feat(webhooks)` landing provides the outbound webhook signing + retry machinery.
- **Done when**: a `display_monitor_removed` event triggers email + webhook for subscribed users. A `display_drift` event triggers webhook only.

### Task 2: per-event-type throttling
- **Files**: the alert routing layer (as found in Task 1)
- **Do**: Per-(machineId, eventType) throttle, max 1 alert per hour. Prevents flapping cables, intermittent driver issues, or other rapidly-recurring events from spamming inboxes. Use the existing `throttleAlerts` mechanism if one exists; otherwise add a small Firestore-backed last-sent timestamp per (machineId, eventType).
- **Done when**: triggering the same event type 5 times in a minute produces 1 alert, not 5.

### Task 3: respect mutedMachines
- **Files**: alert routing layer
- **Do**: Skip email + webhook entirely when `userPreferences.mutedMachines` includes the machineId. Same semantics as other alert types — operator-muted machines are silent across the board.
- **Done when**: muting a machine in the dashboard prevents future display alerts for that machine for the muting user. Other users unaffected.

### Task 4: webhook payload schema + docs
- **Files**: `docs/architecture.md` (or wherever webhook payload docs currently live)
- **Do**: Document the display event payload schema so external integrations (Slack, PagerDuty) can parse reliably:
  ```json
  {
    "type": "display_monitor_removed",
    "severity": "critical",
    "machineId": "TEC-A4D",
    "machineName": "lobby-kiosk-01",
    "siteId": "default_site",
    "monitor": { "edidHash": "...", "friendlyName": "DELL P2415Q", "port": "dp" },
    "timestamp": "2026-04-18T18:50:11.046Z"
  }
  ```
- **Done when**: docs include the schema + at least one curl example of a webhook receiver.

## prerequisites

- phase 1 (display-layout-management) completed — event emission is live (waves 7.1/7.2 shipped with `379874f feat(agent): display topology management` and `46b16c0 feat(web): display management`)
- outbound webhook infrastructure live — shipped in `727654c feat(webhooks): scoped outbound webhooks with signed delivery + retry`

no external dependencies — this is purely wiring existing event emission into existing alert plumbing.
