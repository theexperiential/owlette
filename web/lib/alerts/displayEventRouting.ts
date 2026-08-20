/**
 * Single source of truth for how `display_*` audit events fan out. Read by
 * `webhookSender.server.ts` (EVENT_META + extractFields) and `/api/agent/alert`
 * (digest vs. synchronous webhook).
 *
 * Severity split is locked in plan.md's decision log: email+webhook for events
 * the operator must see in seconds, webhook-only for chat-worthy warnings, and
 * neither for routine signals that just land in the events feed.
 *
 * Keys are the agent's snake_case form so incoming payloads look up directly;
 * `webhookEventName` is the dotted form receivers see (matching `process.crashed`).
 */

export interface DisplayEventRoute {
  /** Email digest delivery via `pending_display_alerts` cron. */
  email: boolean;
  /** Outbound webhook delivery via `webhookSender`. */
  webhook: boolean;
  /** Dotted name over webhooks, per the `process.crashed` / `webhook.test` convention. */
  webhookEventName: string;
  /** Email subject template id; keeps copy edits out of this table. */
  emailSubjectKey: string;
  /**
   * Bypasses the 3-min digest window and emails immediately (1-hour throttle
   * still applies). Only for outage / silent-failure signals — today
   * `display_monitor_removed` and `display_auto_revert_fired`. Bypass: B3.3.
   */
  criticalPath?: boolean;
}

export const DISPLAY_EVENT_ROUTING: Record<string, DisplayEventRoute> = {
  // email + webhook
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

  // webhook only
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

  // In-dashboard only: listed here so the simulator and the events feed keep one
  // registry, but both flags off so nothing is delivered out of band.
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

/** Guard at API boundaries before dereferencing the table with an external string. */
export function isDisplayEventType(
  eventType: string,
): eventType is keyof typeof DISPLAY_EVENT_ROUTING {
  return Object.prototype.hasOwnProperty.call(DISPLAY_EVENT_ROUTING, eventType);
}

/** Every dotted webhook name here; the B4.2 subscription checklist renders from it. */
export const DISPLAY_WEBHOOK_EVENT_NAMES: readonly string[] = Object.values(
  DISPLAY_EVENT_ROUTING,
).map((r) => r.webhookEventName);
