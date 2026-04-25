/**
 * GET /api/events/stream
 *     → Server-Sent Events channel. Emits a `connected` event immediately,
 *       then a `keepalive` event + SSE comment every 15s. Auto-closes
 *       after 30 minutes so the connection never outlives the auth's
 *       freshness window.
 *
 * Authenticates via any path `resolveAuth` supports — including the
 * `?api_key=owk_...` query-param and the `Authorization: Bearer owk_...`
 * header (EventSource can't set custom headers, so most programmatic
 * callers will use the query-param form).
 *
 * Note: browsers' native EventSource does pass same-origin cookies, so
 * dashboard usage works with plain session auth.
 *
 * roost public api wave 3.9 — transport only. Firestore-driven event
 * sourcing (version pointer flips, deploy progress, etc.) plugs in via
 * the onSubscribe hook marked below; wave 4.8 wires the actual sources.
 */
import type { NextRequest } from 'next/server';
import {
  problem,
  problemForbidden,
  problemNotFound,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  resolveAuth,
} from '@/lib/apiAuth.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEEPALIVE_MS = 15_000;
const MAX_STREAM_MS = 30 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    await resolveAuth(request);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      if (err.code === 'token_expired') {
        return problem({
          type: ProblemType.TokenExpired,
          title: 'token expired',
          status: 401,
          detail: err.message,
          code: 'token_expired',
          ...(err.details ?? {}),
        });
      }
      if (err.status === 403) return problemForbidden();
      if (err.status === 404) return problemNotFound();
      return problemUnauthorized();
    }
    throw err;
  }

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
        startedAt: new Date(startedAt).toISOString(),
        keepaliveIntervalMs: KEEPALIVE_MS,
        maxDurationMs: MAX_STREAM_MS,
      });

      keepaliveTimer = setInterval(() => {
        try {
          // SSE comment — some intermediaries buffer silent connections,
          // so we emit both a comment and a named event.
          controller.enqueue(encoder.encode(`: ping\n\n`));
          send('keepalive', { t: Date.now() });
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

      // Abort signal from the client — disconnect, tab close, etc.
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

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // hint to reverse proxies (nginx) to not buffer the response
      'X-Accel-Buffering': 'no',
    },
  });
}
