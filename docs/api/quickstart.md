# Owlette public API quickstart

**Last updated**: 2026-04-28

This developer-preview quickstart creates a scoped API key, verifies it, lists
your site inventory, queues a safe screenshot command on one machine, and polls
the command result. It uses only the live REST API and common shell tools; no
SDK publishing or external launch packaging is required.

The happy path takes about 10 minutes once you have a site with one online
machine.

## What you need

- An Owlette account on `https://owlette.app` or `https://dev.owlette.app`.
- At least one site with one paired, online machine.
- A Bash-compatible shell, `curl`, and `jq`. On Windows, Git Bash works well
  for the commands below.
- `uuidgen` for idempotency keys. On Windows PowerShell, use
  `[guid]::NewGuid().ToString()` if `uuidgen` is not available.

Use `dev.owlette.app` and a `test` key for local/staging checks. Use
`owlette.app` and a `live` key only when you are intentionally acting on a real
fleet.

## 1. Create a scoped key

Open **Settings > API Keys > New Key** in the dashboard and create a key with:

| Field | Value |
| --- | --- |
| Environment | `test` for dev/staging, `live` for production |
| Expiration | 30 or 90 days |
| Scopes | `site=<your-site-id>:read`, `machine=*:read`, `machine=*:write` |

`machine=*` keeps the first run simple because you may not know the machine id
until you list inventory. After the quickstart, rotate into a narrower key such
as `machine=<machine-id>:read` and `machine=<machine-id>:write`.

Copy the raw key immediately. Owlette shows it once.

Scripted key creation is also available through `POST /api/keys`, but that
endpoint requires a signed-in user session or Firebase ID token. You cannot
bootstrap a new key with an existing API key.

## 2. Export your environment

```bash
export OWLETTE_API_URL="https://dev.owlette.app"
export OWLETTE_API_KEY="owk_test_..."
```

For production, use:

```bash
export OWLETTE_API_URL="https://owlette.app"
export OWLETTE_API_KEY="owk_live_..."
```

Create a tiny helper for the rest of the guide:

```bash
api() {
  method="$1"
  path="$2"
  shift 2
  curl -fsS -X "$method" "$OWLETTE_API_URL$path" \
    -H "Authorization: Bearer $OWLETTE_API_KEY" \
    -H "Content-Type: application/json" \
    "$@"
}
```

## 3. Verify the key

```bash
api GET /api/whoami | jq '{
  userId,
  email,
  keyId: .key.keyId,
  keyPrefix: .key.keyPrefix,
  environment: .key.environment,
  scopes: .key.scopes,
  primarySiteId
}'
api GET /api/version | jq
```

You should see the key environment and the scopes you granted. If you receive
`401`, check that the key was copied exactly. If you receive `403` later in the
guide, create or rotate a key with the missing scope listed in the error body.

## 4. Select a site

```bash
api GET /api/sites | tee sites.json | jq -r '.sites[] | [.id, .name] | @tsv'
export OWLETTE_SITE_ID="$(jq -r '.sites[0].id' sites.json)"
echo "$OWLETTE_SITE_ID"
```

If `sites` is empty, the key does not have `site=<site-id>:read`, or the account
does not have access to a site.

## 5. Select an online machine

```bash
api GET "/api/sites/$OWLETTE_SITE_ID/machines" \
  | tee machines.json \
  | jq -r '.machines[] | [.id, .name, .online] | @tsv'

export OWLETTE_MACHINE_ID="$(
  jq -r '.machines[] | select(.online == true) | .id' machines.json | head -n 1
)"
echo "$OWLETTE_MACHINE_ID"
```

If no machine id is printed, pair an agent or wait for a machine to come online.
The command endpoint refuses to queue work for offline machines.

## 6. Queue a safe screenshot command

`capture_screenshot` is a useful first command because it is read-only from an
operator perspective and exercises the same async command path as other machine
operations.

```bash
new_idempotency_key() {
  uuidgen 2>/dev/null || powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString()"
}

export IDEMPOTENCY_KEY="$(new_idempotency_key)"

api POST "/api/sites/$OWLETTE_SITE_ID/machines/$OWLETTE_MACHINE_ID/commands" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{
    "type": "capture_screenshot",
    "params": { "monitor": "primary" },
    "timeout_seconds": 60
  }' | tee command.json

export OWLETTE_COMMAND_ID="$(jq -r '.data.commandId' command.json)"
echo "$OWLETTE_COMMAND_ID"
```

Expected response:

```json
{
  "ok": true,
  "data": {
    "commandId": "cmd_...",
    "status": "pending"
  }
}
```

Reusing the same `Idempotency-Key` with the same body returns the cached result.
Reusing it with a different body returns `422 idempotency_key_mismatch`.

## 7. Poll the result

```bash
for i in $(seq 1 20); do
  api GET "/api/sites/$OWLETTE_SITE_ID/machines/$OWLETTE_MACHINE_ID/commands/$OWLETTE_COMMAND_ID" \
    | tee command-status.json

  STATUS="$(jq -r '.data.status' command-status.json)"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi

  sleep 3
done

jq '.data' command-status.json
```

A completed screenshot command can include a one-hour signed URL:

```json
{
  "commandId": "cmd_...",
  "status": "completed",
  "result": {
    "screenshot_url": "https://...",
    "expires_at": "2026-04-28T19:30:00Z"
  }
}
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401 unauthorized` | Re-copy the raw `owk_*` key, check the environment, and confirm the key has not expired or been revoked. |
| `403 scope_insufficient` | Add the scope named in the problem response. This guide needs `site=<id>:read`, `machine=<id or *>:read`, and `machine=<id or *>:write`. |
| `409 machine_offline` | Choose an online machine from step 5 or wait for the agent heartbeat to recover. |
| `422 idempotency_key_mismatch` | Generate a new idempotency key when changing the command body. |
| `jq: command not found` | Install `jq`, or run the same requests and inspect the JSON manually. |

## Next steps

- Browse the interactive reference at `https://owlette.app/docs/api`.
- Read [`authentication.md`](authentication.md), [`pagination.md`](pagination.md),
  [`idempotency.md`](idempotency.md), [`errors.md`](errors.md), and
  [`rate-limits.md`](rate-limits.md) before wiring production automation.
- Add webhooks with [`webhooks.md`](webhooks.md) once you want event callbacks.
- Move from curl to the Node or Python SDK examples in
  [`examples/sdk-workflows.md`](examples/sdk-workflows.md) after the REST smoke
  workflow is green.
