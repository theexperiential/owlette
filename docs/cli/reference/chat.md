---
hide:
  - navigation
---

# chat

`owlette chat` drives [cortex](https://owlette.app/cortex) ai conversations from the terminal. site-scoped (every verb requires `--site`), with optional machine narrowing on `new`. tier: **ready** — all five verbs are wired to `/api/chat/*` shipped in api-sprint wave 3A.

mutations carry an auto-generated `Idempotency-Key` so a network retry never double-creates, double-deletes, or double-renames. `send` streams the assistant reply to stdout as deltas arrive (ai-sdk v3 line-prefixed protocol).

---

## verbs

### new

start a new conversation.

```bash
owlette chat new --site <siteId> [--machine <machineId>] [--title <title>] [--idempotency-key <key>]
```

| flag | required | purpose |
|---|---|---|
| `--site <siteId>` | yes | site to scope the conversation to |
| `--machine <machineId>` | no | narrow to a single machine (omit for site-wide) |
| `--title <title>` | no | human-readable title (cortex auto-titles otherwise) |
| `--idempotency-key <key>` | no | override the auto-generated `cli-chat-new-<uuid>` |

backing endpoint: `POST /api/chat/new`. emits `{ conversationId, siteId, machineId, title }` on success.

### list

cursor-paged conversation list for a site.

```bash
owlette chat list --site <siteId> [--limit <n>] [--cursor <token>]
```

| flag | required | purpose |
|---|---|---|
| `--site <siteId>` | yes | site to list conversations for |
| `--limit <n>` | no | page size, integer 1–100 (default 20) |
| `--cursor <token>` | no | opaque `page_token` from a prior response |

backing endpoint: `GET /api/chat?siteId=&page_size=&page_token=`. tabular output renders `conversationId | title | machine | messages | updatedAt`; `--json` emits `{ conversations, nextPageToken }`.

### send

append a message and stream the assistant reply to stdout.

```bash
owlette chat send <conversationId> <message> [--idempotency-key <key>]
```

text deltas (ai-sdk frame `0:"…"`) are flushed to stdout as they arrive so users see the model think rather than wait for the full reply. error frames (`3:"…"`) are surfaced on stderr and set exit 1. with `--json` the cli buffers the full reply and emits `{ conversationId, content }` once at the end.

backing endpoint: `POST /api/chat/{conversationId}` (sse-style stream). idempotency-key is sent for replay safety even though the server skips its cache for streamed responses.

### delete

soft-delete a conversation (recoverable for 30 days).

```bash
owlette chat delete <conversationId> [--yes] [--idempotency-key <key>]
```

interactive `[y/N]` prompt by default. `--yes` skips it. when stdin is not a tty and `--yes` was not supplied, the cli refuses rather than delete silently.

backing endpoint: `DELETE /api/chat/{conversationId}`. responses include `alreadyDeleted: true` when the conversation was already tombstoned (still exit 0).

### rename

set a new title on a conversation.

```bash
owlette chat rename <conversationId> <title> [--idempotency-key <key>]
```

backing endpoint: `PATCH /api/chat/{conversationId}` with body `{ title }`.

---

## exit codes

- `0` — success
- `1` — generic error (network, 5xx, malformed stream, upstream cortex error)
- `2` — usage error (bad `--limit`, missing required flag, no token, non-tty without `--yes`)

---

## notes

- **scope**: site-scoped on every verb; `new` accepts an optional `--machine` for single-machine cortex sessions.
- **tier**: ready (api-sprint wave 3A).
- **streaming**: only `send` streams. `new`/`list`/`delete`/`rename` are simple json round-trips.
- **idempotency**: every mutation auto-generates a unique key; pass `--idempotency-key` to deduplicate across script-level retries.
- **soft-delete**: `delete` is reversible for 30 days via the dashboard. there is no hard-delete verb on the cli.
- **see also**: cortex dual-path engine docs at [docs/api/chat.md](../../api/chat.md); per-machine context is fetched server-side from the machine's last heartbeat and process snapshot.
