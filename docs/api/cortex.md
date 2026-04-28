# cortex conversations

The public Cortex API uses the canonical `/api/cortex/conversations` route family. The older `/api/chat/*` routes remain compatibility aliases, but new clients should not depend on them.

## scopes

Use `chat=<siteId>:read` to list conversations and `chat=<siteId>:write` to create, rename, soft-delete, or send a message.

API-key callers are intentionally capped to read-only Cortex tools during streamed replies. A `chat` key can ask Cortex to inspect state, but it cannot inherit the owning user's admin role to dispatch destructive machine, process, or deployment tools. Use the dashboard/session flow for operator-approved destructive tool execution until per-tool API-key scopes are introduced.

## list

```bash
curl -fsS "$ROOST_BASE/api/cortex/conversations?siteId=$SITE_ID&page_size=20" \
  -H "Authorization: Bearer $ROOST_TOKEN"
```

Response:

```json
{
  "ok": true,
  "data": {
    "conversations": [],
    "next_page_token": "",
    "nextPageToken": ""
  }
}
```

## create

```bash
curl -fsS -X POST "$ROOST_BASE/api/cortex/conversations" \
  -H "Authorization: Bearer $ROOST_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"siteId\":\"$SITE_ID\",\"machineId\":\"$MACHINE_ID\",\"title\":\"diagnostics\"}"
```

`machineId` is optional. Omit it for a site-wide conversation. `initial_message`, when supplied, must use `role: "user"`.

## send

```bash
curl -fsS -N -X POST "$ROOST_BASE/api/cortex/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $ROOST_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"role":"user","content":"summarize the current machine health"}'
```

The response is `text/plain; charset=utf-8` with `X-Vercel-AI-Data-Stream: v1`. Frames follow the AI SDK line-prefixed protocol:

- `0:"text"`: assistant text delta
- `d:{...}`: stream completion metadata
- `3:"message"`: upstream Cortex error

Public send accepts only `role` and `content`. To change machines, create a new conversation pinned to the desired machine instead of overriding a conversation target mid-stream.

## rename

```bash
curl -fsS -X PATCH "$ROOST_BASE/api/cortex/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $ROOST_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"morning diagnostics"}'
```

Only `title` is mutable.

## delete

```bash
curl -fsS -X DELETE "$ROOST_BASE/api/cortex/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $ROOST_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)"
```

Delete is a soft delete. A repeated delete returns success with `alreadyDeleted: true`.

## internal routes

`/api/cortex/categorize`, `/api/cortex/provision-key`, `/api/cortex/autonomous`, and `/api/cortex/escalation` are dashboard, agent, or scheduler internals. They are not public API surfaces.
