/**
 * `owlette chat new | list | send | delete | rename`.
 *
 * Drives the cortex chat-noun routes shipped in api-sprint wave 3A:
 *
 *   POST   /api/cortex/conversations                      — start a conversation
 *   GET    /api/cortex/conversations?siteId=&page_size=... — list conversations
 *   POST   /api/cortex/conversations/{conversationId}      — append message + stream reply
 *   PATCH  /api/cortex/conversations/{conversationId}      — rename
 *   DELETE /api/cortex/conversations/{conversationId}      — soft delete
 *
 * `send` consumes the AI-SDK v3 line-prefixed stream protocol the server
 * emits via `result.toUIMessageStreamResponse()`:
 *   `0:"<json-encoded delta>"\n` → text delta (write to stdout immediately)
 *   `d:{...}\n`                  → end-of-stream marker
 *   `3:"<error>"\n`              → upstream error frame
 * The CLI flushes deltas as they arrive so users see the model think rather
 * than waiting for the full reply.
 *
 * Mutations carry an auto-generated `Idempotency-Key` header so a network
 * retry doesn't double-create / double-delete. `chat send` sends the header
 * for replay safety even though the server skips the cache for streaming
 * responses (see `web/app/api/cortex/conversations/[conversationId]/route.ts`).
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config';
import { isJson, renderTable } from '../lib/output';

interface ConversationSummary {
  conversationId: string;
  title: string | null;
  siteId: string;
  machineId?: string;
  ownerUid: string;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
  messageCount: number;
}

interface ListResponse {
  conversations?: ConversationSummary[];
  nextPageToken?: string;
}

interface NewResponse {
  conversationId: string;
  title?: string | null;
  siteId?: string;
  machineId?: string;
  messages?: Array<{ role: string; content: string; timestamp?: string }>;
}

interface MutationResponse {
  conversationId?: string;
  title?: string;
  alreadyDeleted?: boolean;
}

export function registerChatCommands(program: Command): void {
  const chat =
    (program.commands.find((c) => c.name() === 'chat') as Command | undefined) ??
    program.command('chat').description('cortex ai chat');

  // Overwrite any earlier stub description so the help text stays
  // canonical regardless of registration order.
  chat.description('cortex ai chat');

  // Drop any earlier sub-command registrations (e.g. stubs from a prior
  // load) so a fresh re-register doesn't double-list verbs.
  for (const verb of ['new', 'list', 'send', 'delete', 'rename'] as const) {
    const existing = chat.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = chat.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  /* -------------------- new -------------------- */

  chat
    .command('new')
    .description('start a new cortex conversation')
    .requiredOption('--site <siteId>', 'site id to scope the conversation to')
    .option('--machine <machineId>', 'optional machine id (omit for site-wide)')
    .option('--title <title>', 'optional human-readable title')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const body: Record<string, unknown> = { siteId: opts.site };
      if (opts.machine) body.machineId = opts.machine;
      if (opts.title) body.title = opts.title;

      const res = await fetch(`${apiUrl}/api/cortex/conversations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': opts.idempotencyKey
            ? String(opts.idempotencyKey)
            : `cli-chat-new-${randomUUID()}`,
        },
        body: JSON.stringify(body),
      });
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: NewResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `POST /api/cortex/conversations failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const data = (raw.data ?? raw) as NewResponse;

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: conversation started\n` +
          `  conversationId  ${data.conversationId}\n` +
          `  siteId          ${data.siteId ?? opts.site}\n` +
          `  machineId       ${data.machineId ?? '(site-wide)'}\n` +
          `  title           ${data.title ?? '(none)'}\n`,
      );
    });

  /* -------------------- list -------------------- */

  chat
    .command('list')
    .description('list cortex conversations on a site')
    .requiredOption('--site <siteId>', 'site id to list conversations for')
    .option('--limit <n>', 'page size (1-100, default 20)')
    .option('--cursor <token>', 'opaque page_token from a previous response')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const params = new URLSearchParams();
      params.set('siteId', String(opts.site));
      if (opts.limit !== undefined) {
        const n = Number(opts.limit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
          fatal('--limit must be an integer between 1 and 100');
          return;
        }
        params.set('page_size', String(n));
      }
      if (opts.cursor) params.set('page_token', String(opts.cursor));

      const res = await fetch(`${apiUrl}/api/cortex/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: ListResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/cortex/conversations failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const payload = (raw.data ?? raw) as ListResponse;
      const conversations = payload.conversations ?? [];

      if (json) {
        process.stdout.write(
          JSON.stringify(
            { conversations, nextPageToken: payload.nextPageToken ?? '' },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      if (conversations.length === 0) {
        process.stdout.write('(no conversations)\n');
        return;
      }

      const rows = conversations.map((c) => [
        c.conversationId,
        c.title ?? '',
        c.machineId ?? '(site-wide)',
        String(c.messageCount ?? 0),
        c.updatedAt ?? '',
      ]);
      process.stdout.write(
        renderTable(
          ['conversationId', 'title', 'machine', 'messages', 'updatedAt'],
          rows,
        ),
      );
      if (payload.nextPageToken) {
        process.stdout.write(`\nnext page: --cursor ${payload.nextPageToken}\n`);
      }
    });

  /* -------------------- send -------------------- */

  chat
    .command('send <conversationId> <message>')
    .description('send a message and stream the assistant reply to stdout')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (conversationId: string, message: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(
        `${apiUrl}/api/cortex/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            // Server skips idempotency caching on streamed responses, but
            // the header is still safe to send and useful for downstream
            // proxies / replay tooling.
            'Idempotency-Key': opts.idempotencyKey
              ? String(opts.idempotencyKey)
              : `cli-chat-send-${randomUUID()}`,
          },
          body: JSON.stringify({ role: 'user', content: message }),
        },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          detail?: string;
          code?: string;
        };
        fatal(
          `POST /api/cortex/conversations/${conversationId} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      const body = res.body;
      if (!body) {
        fatal(`POST /api/cortex/conversations/${conversationId} returned an empty body`);
        return;
      }

      const collected: string[] = [];
      const decoder = new TextDecoder();
      let pending = '';

      const consume = (line: string): void => {
        if (!line) return;
        if (line.startsWith('0:')) {
          // text delta
          try {
            const parsed = JSON.parse(line.slice(2));
            if (typeof parsed === 'string') {
              if (json) {
                collected.push(parsed);
              } else {
                process.stdout.write(parsed);
              }
            }
          } catch {
            // Drop malformed delta — never crash the stream.
          }
        } else if (line.startsWith('3:')) {
          // upstream error
          let detail = line.slice(2);
          try {
            const parsed = JSON.parse(detail);
            if (typeof parsed === 'string') detail = parsed;
          } catch {
            /* keep raw */
          }
          process.stderr.write(`\nowlette: cortex error — ${detail}\n`);
          process.exitCode = 1;
        }
        // `d:` and any other prefix → ignore (end markers / tool frames).
      };

      // Async iteration is the streaming-friendly path; every node version
      // we target supports `for await` on a fetch Response body.
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          consume(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
      if (pending.length > 0) consume(pending);

      if (json) {
        process.stdout.write(
          JSON.stringify({ conversationId, content: collected.join('') }, null, 2) + '\n',
        );
      } else {
        // Final newline so the next shell prompt isn't glued to the reply.
        process.stdout.write('\n');
      }
    });

  /* -------------------- delete -------------------- */

  chat
    .command('delete <conversationId>')
    .description('soft-delete a cortex conversation')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (conversationId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          fatal(
            'stdin is not a tty and --yes was not supplied; refusing to delete silently',
          );
          return;
        }
        const ok = await promptYesNo(
          `delete conversation ${conversationId}? this is a soft delete (recoverable for 30d). [y/N] `,
        );
        if (!ok) {
          process.stdout.write('delete cancelled\n');
          return;
        }
      }

      const res = await fetch(
        `${apiUrl}/api/cortex/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': opts.idempotencyKey
              ? String(opts.idempotencyKey)
              : `cli-chat-delete-${randomUUID()}`,
          },
        },
      );
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: MutationResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `DELETE /api/cortex/conversations/${conversationId} failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const data = (raw.data ?? raw) as MutationResponse;

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        data.alreadyDeleted
          ? `owlette: conversation ${conversationId} was already deleted\n`
          : `owlette: conversation ${conversationId} deleted\n`,
      );
    });

  /* -------------------- rename -------------------- */

  chat
    .command('rename <conversationId> <title>')
    .description('rename a cortex conversation')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (conversationId: string, title: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetch(
        `${apiUrl}/api/cortex/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': opts.idempotencyKey
              ? String(opts.idempotencyKey)
              : `cli-chat-rename-${randomUUID()}`,
          },
          body: JSON.stringify({ title }),
        },
      );
      const raw = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: MutationResponse;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `PATCH /api/cortex/conversations/${conversationId} failed (${res.status}, ${raw.code ?? 'unknown'}): ${raw.detail ?? JSON.stringify(raw)}`,
        );
        return;
      }

      const data = (raw.data ?? raw) as MutationResponse;

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: conversation ${conversationId} renamed to "${data.title ?? title}"\n`,
      );
    });
}

/* --------------------------------------------------------------------- */
/*  util                                                                 */
/* --------------------------------------------------------------------- */

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  if (!token) {
    process.stderr.write(
      'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
    );
    process.exitCode = 2;
    return { apiUrl, token: null, json: isJson(cmd) };
  }
  return { apiUrl, token, json: isJson(cmd) };
}

async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}
