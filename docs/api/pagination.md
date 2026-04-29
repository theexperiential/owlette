# pagination

**Last updated**: 2026-04-28

Public collection endpoints use cursor pagination. Cursors are opaque strings returned by the server; clients must round-trip them exactly and must not parse, sort, or construct them.

---

## request parameters

| parameter | status | meaning |
|---|---|---|
| `page_size` | canonical | Maximum items to return. Common default is 25 and common maximum is 100, but endpoint references may specify a different default or maximum. |
| `page_token` | canonical | Opaque cursor from the previous response's `next_page_token`. Omit on the first request. |
| `limit` | compatibility | Legacy alias for `page_size` on routes that document it. |
| `cursor` | compatibility | Legacy alias for `page_token` on routes that document it. |

If both canonical and compatibility names are present, the canonical name wins.

Invalid page sizes return `400 validation_failed`. Page sizes must be positive integers and cannot exceed the endpoint's maximum.

---

## response fields

Canonical paginated responses include:

```json
{
  "items": [],
  "next_page_token": ""
}
```

The collection field name may be resource-specific, such as `sites`, `machines`, `roosts`, `versions`, `deployments`, `records`, `webhooks`, or `deliveries`.

`next_page_token` is an empty string when there are no more pages. Treat `null`, a missing token, or an empty compatibility token as end-of-list only on endpoints that explicitly document that shape.

During the developer-preview compatibility window, some responses also include camelCase aliases:

```json
{
  "roosts": [],
  "next_page_token": "eyJ...",
  "nextPageToken": "eyJ..."
}
```

New clients should read `next_page_token` first and fall back to `nextPageToken` only for compatibility routes.

---

## traversal

```bash
PAGE_TOKEN=""
while true; do
  URL="$OWLETTE_API_URL/api/roosts?siteId=$SITE_ID&page_size=25"
  if [ -n "$PAGE_TOKEN" ]; then
    URL="$URL&page_token=$(printf %s "$PAGE_TOKEN" | jq -sRr @uri)"
  fi

  PAGE="$(curl -fsS "$URL" -H "Authorization: Bearer $OWLETTE_API_KEY")"
  echo "$PAGE" | jq '.roosts[]'

  PAGE_TOKEN="$(echo "$PAGE" | jq -r '.next_page_token // .nextPageToken // ""')"
  [ -z "$PAGE_TOKEN" ] && break
done
```

Rules:

- Preserve the cursor exactly.
- Do not use cursor values as stable IDs.
- Do not assume offset semantics.
- Reapply the same filters when requesting the next page.
- Stop when the next token is empty.

---

## compatibility exceptions

Most public list routes now expose canonical `page_size`, `page_token`, and `next_page_token`. The remaining compatibility shapes are intentional during preview:

| route family | current shape | client guidance |
|---|---|---|
| `/api/cortex/conversations` and `/api/chat` alias | Response is nested under `data` and includes both `data.next_page_token` and `data.nextPageToken`. | Prefer `data.next_page_token`; fall back to `data.nextPageToken`. |
| `/api/sites/{siteId}/machines/{machineId}/processes` | Returns the current configured process list in one response with `data.nextPageToken: null`; no `page_size` or `page_token` query contract. | Treat as unpaged until the reference adds canonical query parameters. |
| older SDK compatibility helpers | May expose `cursor` or `nextPageToken` in language-native APIs. | SDKs normalize to the server's canonical fields internally where supported. |

The rendered endpoint reference at `/docs/api` is the source of truth for each operation's request parameters and response envelope.

---

## related errors

Pagination validation failures use the shared problem envelope:

```json
{
  "type": "https://owlette.app/problems/validation-failed",
  "title": "validation failed",
  "status": 400,
  "detail": "page_size must be a positive integer",
  "code": "validation_failed",
  "errors": {
    "query.page_size": ["must be a positive integer <= 100"]
  },
  "docsUrl": "https://owlette.app/docs/api/errors#validation_failed",
  "requestId": "req_01HYCAM5T4P9R1S3U7V8W0X2Y4"
}
```

See [errors.md](errors.md) for the full envelope contract.
