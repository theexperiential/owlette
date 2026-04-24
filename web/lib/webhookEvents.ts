/**
 * Canonical roost webhook event catalog.
 *
 * Single source of truth for:
 *   - subscription validation (which event names users may subscribe to)
 *   - dispatcher publishing (enum used when fanning out in wave 6.9)
 *   - sdk/probe type hints
 *
 * Mirrors docs/api/webhooks.md — keep both in sync when adding events.
 */

export const ROOST_WEBHOOK_EVENTS = [
  // manifests
  'manifest.published',
  'manifest.rolled_back',
  // deployments
  'deployment.started',
  'deployment.completed',
  'deployment.failed',
  // machines
  'machine.online',
  'machine.offline',
  // chunks
  'chunk.garbage_collected',
  'chunk.verify_failed',
  // quota
  'quota.warning',
  'quota.exceeded',
  // api keys
  'api_key.used',
  'api_key.expired',
] as const;

export type RoostWebhookEvent = (typeof ROOST_WEBHOOK_EVENTS)[number];

const EVENT_SET = new Set<string>(ROOST_WEBHOOK_EVENTS);

export function isValidWebhookEvent(event: string): event is RoostWebhookEvent {
  return EVENT_SET.has(event);
}

/**
 * Validate a user-supplied events[] array against the catalog.
 *
 * Returns the normalized (deduped) list on success, or a list of unknown
 * event names on failure.
 */
export function validateEvents(
  events: unknown,
): { ok: true; events: RoostWebhookEvent[] } | { ok: false; unknown: string[] } {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, unknown: [] };
  }
  const unknown: string[] = [];
  const accepted = new Set<RoostWebhookEvent>();
  for (const e of events) {
    if (typeof e !== 'string') {
      unknown.push(String(e).slice(0, 64));
      continue;
    }
    if (!isValidWebhookEvent(e)) {
      unknown.push(e.slice(0, 64));
      continue;
    }
    accepted.add(e);
  }
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, events: [...accepted] };
}
