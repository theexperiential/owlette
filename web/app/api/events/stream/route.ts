/**
 * GET /api/events/stream?siteId=...
 *     -> Server-Sent Events channel. Emits a `connected` event immediately,
 *        then a `keepalive` event + SSE comment every 15s. Auto-closes
 *        after 30 minutes so the connection never outlives the auth's
 *        freshness window.
 *
 * Requires `siteId` and `site:<id>:read`. Auth works through any path
 * `resolveAuth` supports, including the `?api_key=owk_...` query-param
 * and the `Authorization: Bearer owk_...` header.
 *
 * Transport note: this MVP route is scoped and filter-validated, but still
 * emits liveness events only. Real webhook/event fanout remains a Wave 3
 * CLI/SDK readiness item, so docs must not promise production event delivery
 * from this stream yet.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { isValidWebhookEvent } from '@/lib/webhookEvents';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  validateSiteIdBody,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEEPALIVE_MS = 15_000;
const MAX_STREAM_MS = 30 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const eventFilter = parseEventFilter(request.nextUrl.searchParams.get('events'));
    if (!eventFilter.ok) return eventFilter.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const encoder = new TextEncoder();
    const startedAt = Date.now();

    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: Record<string, unknown> | string): void => {
          const payload =
            typeof data === 'string' ? data : JSON.stringify(data);
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${payload}\n\n`),
          );
        };

        send('connected', {
          siteId: site.siteId,
          events: eventFilter.events,
          startedAt: new Date(startedAt).toISOString(),
          keepaliveIntervalMs: KEEPALIVE_MS,
          maxDurationMs: MAX_STREAM_MS,
          transportOnly: true,
        });

        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
            send('keepalive', { t: Date.now(), siteId: site.siteId });
          } catch {
            cleanup();
          }
        }, KEEPALIVE_MS);

        closeTimer = setTimeout(() => {
          try {
            send('closing', { reason: 'max_duration_reached' });
          } catch {
            /* already closed */
          }
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }, MAX_STREAM_MS);

        const signal = request.signal;
        if (signal) {
          const onAbort = () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }

        function cleanup(): void {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = null;
          }
        }
      },
      cancel() {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (closeTimer) clearTimeout(closeTimer);
      },
    });

    return applyAuthDeprecations(
      new NextResponse(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'events/stream:GET');
  }
}

function parseEventFilter(raw: string | null):
  | { ok: true; events: string[] | null }
  | { ok: false; response: NextResponse } {
  if (!raw || raw.trim().length === 0) return { ok: true, events: null };
  const events = raw
    .split(',')
    .map((event) => event.trim())
    .filter(Boolean);
  if (events.length === 0) return { ok: true, events: null };

  const unknown = events.filter((event) => !isValidWebhookEvent(event));
  if (unknown.length > 0) {
    return {
      ok: false,
      response: problemValidation(
        `unknown event(s): ${unknown.join(', ')}`,
        { 'query.events': [`unknown: ${unknown.join(', ')}`] },
      ),
    };
  }
  return { ok: true, events: [...new Set(events)] };
}
