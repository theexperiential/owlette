# idempotency

**Last updated**: 2026-04-28

Mutating public API requests use an `Idempotency-Key` header so clients can retry safely after a timeout, `429`, or transient `5xx` without accidentally creating duplicate work.

The endpoint reference is the source of truth for whether the header is required on a specific operation. When in doubt, send it on every `POST`, `PATCH`, `PUT`, and `DELETE`.

---

## header

```http
Idempotency-Key: 7c55c5de-7ec6-4c63-a1c8-94e13c56f962
```

Rules:

- The key is an opaque client-generated string.
- Maximum length is 255 characters.
- Generate one key per logical mutation and reuse that same key for retries of the identical request.
- Generate a new key when the method, URL, query string, or body changes.
- UUIDv4, ULID, and deterministic hashes such as `bulk-<sha256(row)>` are valid.

---

## replay semantics

Owlette caches successful non-streaming responses for 24 hours.

A replay matches only when all of these are the same:

- authenticated user
- API-key environment (`live`, `test`, or `unknown` for session/ID-token callers)
- `Idempotency-Key`
- HTTP method
- path
- query string
- request body hash

If the same key is reused with the same method, path, query, and body, the API returns the original response instead of executing the handler again. Replayed responses include:

```http
Idempotent-Replayed: true
```

Error responses are not cached. Streaming responses, including SSE and streamed Cortex responses, are not cached.

---

## required vs optional

The API requires `Idempotency-Key` for mutations where a retry could double-trigger side effects, especially:

- async machine commands and machine destructive operations
- installer deployment create, retry, cancel, uninstall, and delete operations
- installer upload, finalize, set-latest, and protected delete operations
- site, user, member, process, and display-layout mutations
- Roost publish, deploy, rollback, and other side-effecting Roost mutations where marked in the reference
- Cortex conversation create, send, rename, and delete compatibility routes

Some routes are naturally idempotent or read-only and do not require the header. The rendered endpoint reference marks required headers operation by operation.

---

## errors

| status | code | cause | client action |
|---|---|---|---|
| 400 | `idempotency_key_required` | Required header missing or blank. | Retry the same request with a generated key. |
| 400 | `idempotency_key_invalid` | Header exceeds 255 characters. | Generate a shorter opaque key. |
| 422 | `idempotency_key_mismatch` | Same key reused on the same route with a different body. | Use a new key for the changed payload, or resend the original body. |

All three errors use the standard `application/problem+json` envelope documented in [errors.md](errors.md).

---

## retry pattern

1. Build the request body.
2. Generate an idempotency key and attach it to the request.
3. If the network fails, the client times out, or the API returns `429` or a transient `5xx`, retry the identical request with the same key.
4. If you intentionally change the body or query, generate a new key.

```bash
IDEMPOTENCY_KEY="$(uuidgen)"

curl -fsS -X POST "$OWLETTE_API_URL/api/sites/$SITE_ID/machines/$MACHINE_ID/commands" \
  -H "Authorization: Bearer $OWLETTE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"type":"capture_screenshot","params":{"monitor":"primary"},"timeout_seconds":60}'
```

For batch importers, deterministic keys are useful because a rerun replays rows that already succeeded:

```text
Idempotency-Key: bulk-create-site-<sha256(canonical-row-json)>
```

---

## see also

- [errors.md](errors.md) for `idempotency_*` error bodies.
- [rate-limits.md](rate-limits.md) for retry timing and `Retry-After`.
- [pagination.md](pagination.md) for collection traversal conventions.
- The interactive reference at `/docs/api` for operation-level required headers.
