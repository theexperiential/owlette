/**
 * `roost listen --forward-to <url>` — wave 4.8.
 *
 * Opens a persistent SSE connection to `/api/events/stream` on the
 * roost api, parses each incoming event, and replays it as an HTTP
 * POST to the user's local url with the original headers (including
 * `Roost-Signature`) preserved. The practical shape of this loop
 * mirrors `stripe listen` — the cli becomes a development webhook
 * tunnel without needing a public URL.
 *
 * Auth: passes `?api_key=<token>` as a query param (EventSource-style)
 * because the native Node streaming `fetch` for SSE honors the
 * `Authorization` header but many middleboxes strip cookies / headers
 * off long-lived streams; the query-param form is the contract
 * `/api/events/stream` documents.
 *
 * Event wire format:
 *   event: <kind>\n
 *   data: <json>\n
 *   \n
 *
 * The server today emits `connected` on open and `keepalive` every
 * ~15s as a liveness signal (wave 3.9). Real-event plumbing is
 * deferred to a follow-up server wave; the cli is already ready to
 * relay whatever events arrive — no further cli changes needed when
 * the server starts emitting `roost.manifest.published` / etc.
 *
 * Exit codes:
 *   0 — clean shutdown via SIGINT
 *   1 — connection error, forward failure, stream closed by server
 *   2 — usage / auth problem
 */

import { Command } from 'commander';
import { createHmac } from 'crypto';
import { loadConfig } from '../config';

const KEEPALIVE_EVENT = 'keepalive';
const CONNECTED_EVENT = 'connected';

export function registerListenCommand(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'listen');
  if (existing) {
    const list = program.commands as Command[];
    const idx = list.indexOf(existing);
    if (idx >= 0) list.splice(idx, 1);
  }

  program
    .command('listen')
    .description('tunnel webhook events from the roost api to a local url')
    .requiredOption('--forward-to <url>', 'local http endpoint that receives each event')
    .option(
      '--events <names>',
      'comma-separated event kinds to forward (default: all non-keepalive)',
    )
    .option(
      '--signing-secret <secret>',
      'secret used to re-sign the forwarded payload with a Roost-Signature header (default: print-only, no re-sign)',
    )
    .option(
      '--print',
      'print events to stderr as they arrive (always on; kept for explicitness)',
    )
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'roost: no token configured. run `roost auth login` or set ROOST_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }

      // Parse --forward-to + event filter.
      let forwardUrl: URL;
      try {
        forwardUrl = new URL(String(opts.forwardTo));
      } catch {
        process.stderr.write(`roost: --forward-to '${opts.forwardTo}' is not a valid url\n`);
        process.exitCode = 2;
        return;
      }

      const allowedEvents: Set<string> | null = opts.events
        ? new Set(
            String(opts.events)
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean),
          )
        : null;

      const streamUrl = new URL(`${apiUrl}/api/events/stream`);
      streamUrl.searchParams.set('api_key', token);

      process.stderr.write(
        `roost: listening on ${apiUrl}/api/events/stream\n` +
          `       forwarding to ${forwardUrl}\n` +
          (allowedEvents
            ? `       events: ${[...allowedEvents].join(', ')}\n`
            : '       events: all (except keepalive)\n') +
          (opts.signingSecret
            ? `       re-signing with supplied secret\n`
            : `       (no re-sign secret — forwarded payloads carry the server's original Roost-Signature if present)\n`),
      );

      // Wire SIGINT for clean shutdown.
      const aborter = new AbortController();
      let stopping = false;
      process.on('SIGINT', () => {
        stopping = true;
        aborter.abort();
      });

      let res: Response;
      try {
        res = await fetch(streamUrl.toString(), {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          signal: aborter.signal,
        });
      } catch (err) {
        process.stderr.write(
          `roost: failed to open stream: ${(err as Error).message}\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (!res.ok || !res.body) {
        process.stderr.write(
          `roost: stream open failed (${res.status}): ${await res.text().catch(() => '')}\n`,
        );
        process.exitCode = 1;
        return;
      }

      const counts = { connected: 0, keepalive: 0, event: 0, forwarded: 0, forwardErrors: 0 };

      try {
        for await (const event of sseEvents(res.body)) {
          if (event.kind === CONNECTED_EVENT) {
            counts.connected += 1;
            process.stderr.write(`roost: stream connected\n`);
            continue;
          }
          if (event.kind === KEEPALIVE_EVENT) {
            counts.keepalive += 1;
            continue;
          }

          counts.event += 1;
          if (allowedEvents && !allowedEvents.has(event.kind)) {
            process.stderr.write(`roost: (filtered) ${event.kind}\n`);
            continue;
          }

          const headers = buildForwardHeaders(event, opts.signingSecret);
          process.stderr.write(
            `roost: → forwarding ${event.kind}` +
              (headers['Roost-Signature'] ? ` [sig: ${headers['Roost-Signature']}]` : '') +
              '\n',
          );

          try {
            const forwarded = await fetch(forwardUrl.toString(), {
              method: 'POST',
              headers,
              body: event.data,
            });
            counts.forwarded += 1;
            process.stderr.write(
              `roost: ← ${forwarded.status} from ${forwardUrl}\n`,
            );
          } catch (err) {
            counts.forwardErrors += 1;
            process.stderr.write(
              `roost: forward failed for ${event.kind}: ${(err as Error).message}\n`,
            );
          }
        }
      } catch (err) {
        if (!stopping) {
          process.stderr.write(
            `roost: stream error: ${(err as Error).message}\n`,
          );
          process.exitCode = 1;
        }
      }

      process.stderr.write(
        `roost: listener stopped. ` +
          `connected=${counts.connected} events=${counts.event} ` +
          `forwarded=${counts.forwarded} forwardErrors=${counts.forwardErrors} ` +
          `keepalives=${counts.keepalive}\n`,
      );
    });
}

/* --------------------------------------------------------------------- */
/*  SSE parser                                                           */
/* --------------------------------------------------------------------- */

export interface SseEvent {
  kind: string;
  id: string | null;
  data: string;
}

/**
 * Parse an SSE byte stream into discrete events. Yields one event per
 * `event:` / `data:` block — intentionally minimal vs. the full SSE
 * spec (we don't implement retry fields because the server doesn't
 * emit them, and multi-line `data:` concatenation because every event
 * roost emits is single-line JSON).
 *
 * Exported for tests; also consumable by other cli commands if they
 * ever want to tap the event stream.
 */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseBlock(rawEvent);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let kind: string | null = null;
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) kind = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!kind && dataLines.length === 0) return null;
  return {
    kind: kind ?? 'message',
    id,
    data: dataLines.join('\n'),
  };
}

/* --------------------------------------------------------------------- */
/*  forward headers                                                      */
/* --------------------------------------------------------------------- */

/**
 * Build the header set sent to --forward-to.
 *
 * If a signing secret is supplied, re-signs the payload with the
 * stripe-style `t=<unix>,v1=<hmac>` scheme so local test suites can
 * verify against a known-to-them secret. Without a secret, the
 * original server-issued signature (if any) passes through
 * unmodified.
 *
 * Exported for tests.
 */
export function buildForwardHeaders(
  event: SseEvent,
  signingSecret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Roost-Event': event.kind,
  };
  if (event.id) headers['Roost-Delivery'] = event.id;

  if (typeof signingSecret === 'string' && signingSecret.length > 0) {
    const t = Math.floor(Date.now() / 1000);
    const signed = createHmac('sha256', signingSecret)
      .update(`${t}.${event.data}`)
      .digest('hex');
    headers['Roost-Signature'] = `t=${t},v1=${signed}`;
  } else {
    // Try to forward the server's original Roost-Signature if it
    // travelled inside the SSE data payload (server wire format under
    // discussion). For the transport-only v0 stream, there is no
    // signature embedded; this branch is a no-op today.
    try {
      const parsed = JSON.parse(event.data) as { roostSignature?: string };
      if (typeof parsed?.roostSignature === 'string') {
        headers['Roost-Signature'] = parsed.roostSignature;
      }
    } catch {
      /* event.data may not be json — leave headers alone */
    }
  }

  return headers;
}

/** Export for tests. */
export const _internals = { parseSseBlock, buildForwardHeaders };
