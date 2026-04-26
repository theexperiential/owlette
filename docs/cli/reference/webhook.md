---
hide:
  - navigation
---

# webhook

> **not yet implemented in the cli.** webhook subscriptions are managed via the dashboard today (settings → webhooks). the cli verbs documented below are a forward-looking spec — they ship in waves 5 and 7 of [`dev/active/roost-public-api/`](../../../dev/active/roost-public-api/), alongside the public webhook routes. this page exists so callers can plan integrations against the eventual surface. tier: **planned**.
>
> until the noun group lands, the only webhook-adjacent verbs in the cli today are the legacy top-level `owlette listen` and `owlette trigger <event>` (see [migration](#migration-from-top-level-verbs) below).

`owlette webhook` will be a top-level operator noun for cross-product event subscriptions — promoted from `roost webhook` because webhooks fan out events from every product surface (roost, machine, deploy, audit-log, chat), not just roost lifecycle. site-scoped: every verb requires `--site` or a site-scoped api key.

---

## planned verbs

### create (planned)

```bash
owlette webhook create --site <s> --url <url> --events <csv> [--description <text>]
```

new subscription. **secret is shown ONCE in the response** — capture it now or rotate later. backing endpoint: `POST /api/webhooks`.

### list (planned)

```bash
owlette webhook list --site <s>
```

list subscriptions on a site. backing endpoint: `GET /api/webhooks`.

### get (planned)

```bash
owlette webhook get <id> --site <s>
```

subscription detail. response never includes the secret. backing endpoint: `GET /api/webhooks/{id}`.

### update (planned)

```bash
owlette webhook update <id> --site <s> [--url <url>] [--events <csv>] [--paused]
```

partial update. idempotency-key supported. backing endpoint: `PATCH /api/webhooks/{id}`.

### delete (planned)

```bash
owlette webhook delete <id> --site <s> [--yes]
```

soft-delete with a 30-day tombstone. backing endpoint: `DELETE /api/webhooks/{id}`.

### rotate-secret (planned)

```bash
owlette webhook rotate-secret <id> --site <s>
```

issue a new signing secret with a 24-hour grace window on the old one. backing endpoint: `POST /api/webhooks/{id}/rotate-secret`.

### deliveries (planned)

```bash
owlette webhook deliveries <id> --site <s> [--limit <n>] [--cursor <token>]
```

30-day delivery history. backing endpoint: `GET /api/webhooks/{id}/deliveries`.

### delivery get (planned)

```bash
owlette webhook delivery get <id> <deliveryId> --site <s>
```

full request/response transcript for one delivery. backing endpoint: `GET /api/webhooks/{id}/deliveries/{did}`.

### retry (planned)

```bash
owlette webhook retry <id> <deliveryId> --site <s>
```

re-enqueue a single delivery. backing endpoint: `POST /api/webhooks/{id}/deliveries/{did}/retry`.

### probe (planned)

```bash
owlette webhook probe --site <s> --url <url> --event <name> [--payload <json>]
```

fire a synthetic event at an arbitrary url **without** creating a subscription — useful for url validation and ngrok smoke tests. backing endpoint: `POST /api/webhooks/probe`.

### listen (planned)

```bash
owlette webhook listen --site <s> --forward-to <url> [--events <csv>]
```

dev tunnel: subscribe to the live event stream and forward to a local url. backing endpoint: `GET /api/events/stream` (sse).

### trigger (planned)

```bash
owlette webhook trigger <event> --site <s> [--to <url>] [--payload <json>]
```

fire a synthetic event for local testing. backing endpoint: `POST /api/webhooks/probe` (or direct to `--to`).

---

## migration from top-level verbs

`listen` and `trigger` exist in the cli **today** as top-level commands:

```bash
owlette listen --forward-to http://localhost:3000/hooks
owlette trigger roost.deployed --payload '{"roostId":"rst_abc"}'
```

when the `webhook` noun group ships (roost-public-api wave 5), they move under it:

```bash
owlette webhook listen --site site-1 --forward-to http://localhost:3000/hooks    # planned
owlette webhook trigger roost.deployed --site site-1 --payload '{...}'            # planned
```

the top-level forms will keep working as deprecation aliases through the standard 2026-10-01 sunset, with a one-line stderr notice. update scripts at the seams.

---

## planned exit codes

- `0` — success
- `1` — generic error (network, 5xx, signature verification failure on probe)
- `2` — usage error (missing `--site`, malformed `--events` csv, bad `--payload` json)

---

## notes

- **scope**: site-scoped. dashboard editing remains available indefinitely; the cli is additive.
- **tier**: planned. shipping in roost-public-api waves 5 (core verbs) and 7 (`probe`/`listen`/`trigger` polish).
- **secret handling**: `create` and `rotate-secret` are the only places the secret is returned. it is never readable again — copy it into your secrets store immediately.
- **signing**: every delivery is hmac-sha256 signed with the subscription secret in the `X-Owlette-Signature` header. signature format and verification snippets land alongside the cli.
- **see also**: planning docs at [`dev/active/roost-public-api/`](../../../dev/active/roost-public-api/); dashboard at owlette.app/settings/webhooks.
