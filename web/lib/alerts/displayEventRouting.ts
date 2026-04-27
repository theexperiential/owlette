/**
 * displayEventRouting — single source of truth for how `display_*` audit
 * events fan out across the alert pipeline.
 *
 * Two downstream consumers read this table:
 *   1. `webhookSender.server.ts` — derives EVENT_META + extractFields entries
 *      so the 10 events render with correct colors / titles in Slack/Discord.
 *   2. `/api/agent/alert` — uses `email` / `webhook` to decide whether to
 *      enqueue a digest entry vs. fire the webhook synchronously.
 *
 * Severity rationale (locked in plan.md decision log):
 *   - Email+webhook: critical events the operator MUST notice within seconds
 *     (panel disappeared, apply failed, auto-revert fired, sync dropped).
 *   - Webhook only: warnings worth shipping to a chat channel but not loud
 *     enough to warrant an inbox-cluttering email (drift, swap, mosaic flip,
 *     mosaic-refused-apply — operator just saw the refusal in the UI).
 *   - In-dashboard only: routine signals (monitor added, apply succeeded)
 *     that surface in the events feed but don't need an out-of-band ping.
 *
 * Event-type naming: the agent emits snake_case (`display_drift`) into the
 * audit log; the webhook protocol uses dotted notation (`display.drift`) to
 * stay consistent with `process.crashed` / `webhook.test`. The `webhookEventName`
 * field is the dotted form receivers see; the keys in this table are the
 * snake_case agent form so lookup from incoming agent payloads is direct.
 */

export interface DisplayEventRoute {
  /** Email digest delivery via `pending_display_alerts` cron. */
  email: boolean;
  /** Outbound webhook delivery via `webhookSender`. */
  webhook: boolean;
  /**
   * Dotted event name surfaced over webhooks (matches the existing
   * `process.crashed` / `webhook.test` convention so receivers' filters
   * stay consistent across event categories).
   */
  webhookEventName: string;
  /**
   * Stable identifier for the email subject template — keeps the rendering
   * decoupled from this routing table so a copy edit doesn't ripple through
   * every consumer.
   */
  emailSubjectKey: string;
  /**
   * Critical-path flag — `true` for events that bypass the 3-min digest
   * window and email immediately (with the standard 1-hour throttle).
   * Today: `display_monitor_removed` and `display_auto_revert_fired`. The
   * digest is fine for everything else; these two need sub-minute delivery
   * because they're either an outage signal (operator's wall just lost a
   * panel) or a silent failure recovery (the operator's apply attempt died
   * without their knowing). See B3.3 for the bypass implementation.
   */
  criticalPath?: boolean;
}

export const DISPLAY_EVENT_ROUTING: Record<string, DisplayEventRoute> = {
  // ---- email + webhook (4 critical events) ----
  display_monitor_removed: {
    email: true,
    webhook: true,
    webhookEventName: 'display.monitor_removed',
    emailSubjectKey: 'display_monitor_removed',
    criticalPath: true,
  },
  display_apply_failed: {
    email: true,
    webhook: true,
    webhookEventName: 'display.apply_failed',
    emailSubjectKey: 'display_apply_failed',
  },
  display_auto_revert_fired: {
    email: true,
    webhook: true,
    webhookEventName: 'display.auto_revert_fired',
    emailSubjectKey: 'display_auto_revert_fired',
    criticalPath: true,
  },
  display_sync_lost: {
    email: true,
    webhook: true,
    webhookEventName: 'display.sync_lost',
    emailSubjectKey: 'display_sync_lost',
  },

  // ---- webhook only (4 warning events) ----
  display_drift: {
    email: false,
    webhook: true,
    webhookEventName: 'display.drift',
    emailSubjectKey: 'display_drift',
  },
  display_monitor_swapped: {
    email: false,
    webhook: true,
    webhookEventName: 'display.monitor_swapped',
    emailSubjectKey: 'display_monitor_swapped',
  },
  display_mosaic_disabled: {
    email: false,
    webhook: true,
    webhookEventName: 'display.mosaic_disabled',
    emailSubjectKey: 'display_mosaic_disabled',
  },
  display_apply_refused_mosaic: {
    email: false,
    webhook: true,
    webhookEventName: 'display.apply_refused_mosaic',
    emailSubjectKey: 'display_apply_refused_mosaic',
  },

  // ---- in-dashboard only (2 routine events) ----
  // Routed through this table so the simulator can still trigger them and
  // the dashboard's recent-events feed reads from a single registry, but
  // both flags off so neither email nor webhook fires.
  display_monitor_added: {
    email: false,
    webhook: false,
    webhookEventName: 'display.monitor_added',
    emailSubjectKey: 'display_monitor_added',
  },
  display_apply_succeeded: {
    email: false,
    webhook: false,
    webhookEventName: 'display.apply_succeeded',
    emailSubjectKey: 'display_apply_succeeded',
  },
};

/**
 * True when `eventType` is one of the registered `display_*` events. Use as
 * a guard at API boundaries before dereferencing the routing table — keeps
 * arbitrary external strings from leaking through.
 */
export function isDisplayEventType(
  eventType: string,
): eventType is keyof typeof DISPLAY_EVENT_ROUTING {
  return Object.prototype.hasOwnProperty.call(DISPLAY_EVENT_ROUTING, eventType);
}

/**
 * Convenience: every dotted webhook event name in this table. Webhook config
 * UIs (B4.2) consume this to render the event-subscription checklist.
 */
export const DISPLAY_WEBHOOK_EVENT_NAMES: readonly string[] = Object.values(
  DISPLAY_EVENT_ROUTING,
).map((r) => r.webhookEventName);
