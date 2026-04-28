---
hide:
  - navigation
---

# webhook

> **CLI noun group planned for Wave 3.** The public webhook API routes are live for developer preview. Full `owlette webhook ...` management commands remain planned; today the shipped top-level helpers are `owlette listen` and `owlette trigger <event>`.

`owlette webhook` will be a top-level operator noun for cross-product event subscriptions. Site-scoped commands require `--site` or a site-scoped API key.

---

## planned verbs

### create (planned)

```bash
owlette webhook create --site <s> --url <url> --events <csv> [--description <text>]
```

New subscription. The signing secret is shown once in the response. Backing endpoint: `POST /api/webhooks?siteId=<s>`.

### list (planned)

```bash
owlette webhook list --site <s>
```

List subscriptions on a site. Backing endpoint: `GET /api/webhooks?siteId=<s>`.

### get (planned)

```bash
owlette webhook get <id> --site <s>
```

Subscription detail. Response never includes the secret. Backing endpoint: `GET /api/webhooks/{id}?siteId=<s>`.

### update (planned)

```bash
owlette webhook update <id> --site <s> [--url <url>] [--events <csv>] [--paused]
```

Partial update. Backing endpoint: `PATCH /api/webhooks/{id}?siteId=<s>`.

### delete (planned)

```bash
owlette webhook delete <id> --site <s> [--yes]
```

Soft-delete with a 30-day tombstone. Backing endpoint: `DELETE /api/webhooks/{id}?siteId=<s>`.

### rotate-secret (planned)

```bash
owlette webhook rotate-secret <id> --site <s>
```

Issue a new signing secret with a 24-hour grace window on the old one. Backing endpoint: `POST /api/webhooks/{id}/rotate-secret?siteId=<s>`.

### deliveries (planned)

```bash
owlette webhook deliveries <id> --site <s> [--limit <n>] [--cursor <token>]
```

30-day delivery history. Backing endpoint: `GET /api/webhooks/{id}/deliveries?siteId=<s>`.

### delivery get (planned)

```bash
owlette webhook delivery get <id> <deliveryId> --site <s>
```

Full request/response transcript for one delivery. Backing endpoint: `GET /api/webhooks/{id}/deliveries/{deliveryId}?siteId=<s>`.

### retry (planned)

```bash
owlette webhook retry <id> <deliveryId> --site <s>
```

Re-enqueue a single delivery. Backing endpoint: `POST /api/webhooks/{id}/deliveries/{deliveryId}/retry?siteId=<s>`.

### probe (planned noun)

```bash
owlette webhook probe --site <s> --url <url> --event <name> [--payload <json>]
```

Fire a signed synthetic event at an arbitrary URL without creating a subscription. Backing endpoint: `POST /api/webhooks/probe?siteId=<s>`.

### listen

```bash
owlette listen --site <s> --forward-to <url> [--events <csv>]
```

Shipped top-level helper. It opens `GET /api/events/stream?siteId=<s>` and forwards received SSE events. In the current developer preview the stream emits `connected` and `keepalive` liveness events only; production event fanout is deferred.

### trigger

```bash
owlette trigger <event> --site <s> --to <url> [--payload <json>] [--via-api]
```

Shipped top-level helper. Without `--via-api`, it posts a canned payload directly to `--to`. With `--via-api`, it calls `POST /api/webhooks/probe?siteId=<s>`.

---

## migration from top-level verbs

Current:

```bash
owlette listen --site site-1 --forward-to http://localhost:3000/hooks
owlette trigger version.published --site site-1 --to http://localhost:3000/hooks
```

When the `webhook` noun group ships, these move under it:

```bash
owlette webhook listen --site site-1 --forward-to http://localhost:3000/hooks
owlette webhook trigger version.published --site site-1 --to http://localhost:3000/hooks
```

The top-level forms will remain compatibility aliases through the standard 2026-10-01 sunset.

---

## exit codes

- `0` - success
- `1` - generic error (network, 5xx, signature verification failure on probe)
- `2` - usage error (missing `--site`, malformed `--events` csv, bad `--payload` json)

---

## notes

- **scope**: list/detail/deliveries use `site:<siteId>:read`; create/update/delete/rotate/probe/retry use `site:<siteId>:write`.
- **secret handling**: `create` and `rotate-secret` are the only places the secret is returned. it is never readable again.
- **signing**: deliveries use `Roost-Signature: t=<unix>,v1=<hmac_sha256_hex>`.
- **contract**: `web/openapi.yaml` is authoritative for request/response shapes.
