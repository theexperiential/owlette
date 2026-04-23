# chunks — the content-addressed data plane

**Last updated**: 2026-04-22
**Status**: normative for all roost v2 uploads, downloads, gc, and rollback paths.

chunks are the atomic unit of storage in roost. every file in a manifest is a list of chunk digests; every chunk is an immutable blob of bytes keyed by its sha-256 hash. this doc is the end-to-end contract: chunking algorithm, hash format, storage layout, dedup flow, download flow, cross-roost mount, referrer graph, idempotency, and error taxonomy. a developer with this document should be able to implement a conformant chunker and uploader from scratch.

related:
- [`/docs/internal/manifest-format.md`](../internal/manifest-format.md) — manifest schema (chunks embed into `files[].chunks[]`).
- [`dev/active/roost-public-api/reference/api-surface.md`](../../dev/active/roost-public-api/reference/api-surface.md) — full endpoint reference.
- [`dev/active/roost-public-api/reference/design-principles.md`](../../dev/active/roost-public-api/reference/design-principles.md) — principles 1 (content-addressed), 2 (cross-resource mount), 3 (signed puts, not tus).

---

## 1. chunk shape

- **fixed size**: every chunk is exactly **4 mib (4 194 304 bytes)** except the last chunk of each file, which may be **1..4 194 304 bytes**.
- **algorithm**: sha-256 only in v1. content-defined chunking (fastcdc / rabin) is explicitly deferred to v3.
- **hash encoding**: lowercase hex, exactly 64 chars, matching `^[0-9a-f]{64}$`.
- **wire format**: the public api serialises every digest as `sha256:<64-hex>`. inside the manifest itself the `hash` field is the bare 64-hex string (no prefix) — the `sha256:` prefix only appears on the http wire (request/response bodies, url path params) where cross-algorithm support is planned for v2 of the schema. never mix the two representations inside a single request body.
- **zero-byte files** have `chunks: []` and `size: 0`. the empty chunk is never stored in r2.
- **ordering**: chunks within a file are ordered by file offset. concatenation in order reproduces the file exactly — no gaps, no overlaps.

```
file bytes  ────────────────────────────────────────────────────▶
            ├── chunk[0] ──┼── chunk[1] ──┼── chunk[2] ──┼─ chunk[3] ─┤
            │  4 194 304   │  4 194 304   │  4 194 304   │   812 345  │
            ├──────────────┼──────────────┼──────────────┼────────────┤
            │ sha256:…     │ sha256:…     │ sha256:…     │ sha256:…   │
```

## 2. storage layout

chunks are stored in cloudflare r2 at a per-site, sharded, content-addressed key:

```
project-content/{siteId}/{hash[0:2]}/{hash}
```

| segment | source | purpose |
|---|---|---|
| `project-content` | fixed bucket prefix | separates chunks from `project-manifests/…` |
| `{siteId}` | owlette site that owns the chunk | **tenant isolation** — see §3 |
| `{hash[0:2]}` | first two hex chars of the chunk hash | avoids hot prefixes in r2's keyspace |
| `{hash}` | full 64-hex sha-256 | the content address |

example:

```
project-content/kiosk-fleet-01/4e/4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce
```

chunk paths never appear inside the manifest. the agent reconstructs them from `siteId` (known from the firestore folder document) and `hash` (from the manifest). third-party clients never construct them at all — they receive signed urls that embed the full path.

## 3. per-site isolation — a security property, not a performance tweak

**the rule.** chunks are scoped to the `siteId` they were uploaded under. two different sites cannot dedup against each other's content, even if they independently upload byte-identical files. this is enforced at the storage-key level (`{siteId}` is part of the r2 path) and at the api level (`/api/chunks/check` and `/api/chunks/upload-urls` require `siteId` and a scope that covers it).

**why.** dedup-across-tenants would leak presence information: an attacker who uploads a candidate file and sees `missing: []` in the check response learns that some other site already has that file. this is the same "cross-user dedup oracle" flaw that affected dropbox's cross-user client-side dedup in 2011. roost's dedup surface ends at the site boundary; inside a site, cross-roost dedup is explicit and uses the mount endpoint (§6).

**consequence for the chunker.** the client never asks "does roost have this chunk?" — it asks "does site X have this chunk?". every chunk-plane endpoint takes `siteId` in the body or query string; a missing `siteId` is `validation_failed`.

## 4. dedup flow (upload)

the chunker never ships bytes the server already has. the upload dance is a three-step round trip per batch:

```
┌───────────┐   POST /api/chunks/check      ┌──────────────┐
│  client   │─────────────────────────────▶│  roost api   │
│  chunker  │◀── { missing: [hash,…] } ────│              │
│           │                               │              │
│           │   POST /api/chunks/upload-urls│              │
│           │─────────────────────────────▶│              │
│           │◀── { urls: { hash: url,…} }──│              │
│           │                               └──────────────┘
│           │   PUT <signed r2 url>         ┌──────────────┐
│           │─── bytes (4 mib) ───────────▶│      r2      │
│           │◀── 200 OK ───────────────────│              │
└───────────┘                               └──────────────┘
                                                    │
                        async server-side sha-256 recompute
                        (chunkVerify cloud function)
```

### step 1 — batch existence check

```
POST /api/chunks/check
content-type: application/json

{
  "siteId": "kiosk-fleet-01",
  "hashes": [
    "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6",
    "sha256:18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4",
    "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce"
  ]
}
```

- up to **1000 hashes per call**; the validator rejects larger batches with `validation_failed`.
- response lists only the digests **missing** from the site's cas namespace — everything else is already reusable.

```json
{
  "missing": [
    "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce"
  ]
}
```

### step 2 — mint signed put urls for the missing set

```
POST /api/chunks/upload-urls
content-type: application/json
idempotency-key: 3f7b9c2a-8e14-4f1c-9d6e-2c8a5b0e9f4d

{
  "siteId": "kiosk-fleet-01",
  "hashes": [
    "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce"
  ]
}
```

- signed urls carry a **60-minute ttl**. the expiry is returned in the response as `expiresAt` (rfc 3339 utc).
- urls are per-hash. one request can mint many urls at once (again capped at 1000).

```json
{
  "urls": {
    "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce": "https://owlette-prod.r2.cloudflarestorage.com/project-content/kiosk-fleet-01/4e/4e0740856…?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=…"
  },
  "expiresAt": "2026-04-22T16:30:00Z"
}
```

### step 3 — put the bytes directly to r2

```
PUT <signed url>
content-type: application/octet-stream

<exactly size bytes of chunk content>
```

- data plane is **off roost's servers entirely** — bytes travel client → r2 with no roost intermediary. this is principle 3 (signed puts, not tus).
- retry policy: per-chunk. if the `PUT` fails (transient 5xx, network drop), retry the single chunk. if the signed url has expired (403 from r2), re-mint only that hash via `POST /api/chunks/upload-urls`.
- parallelism: clients should upload chunks concurrently. 8–16 parallel `PUT`s is typical; r2 tolerates much higher.

### server-side verification

after the upload window closes (tracked by the finalize manifest publish), the `chunkVerify` cloud function recomputes sha-256 on each newly uploaded object and compares against the expected hash embedded in the r2 key. a mismatch quarantines the blob and blocks the manifest from becoming `current`. clients cannot tamper with content after upload — the verification is server-authoritative.

## 5. download flow

```
POST /api/chunks/download-urls        (or GET with query-string hashes)
content-type: application/json

{
  "siteId": "kiosk-fleet-01",
  "hashes": [
    "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6",
    "sha256:18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4"
  ]
}
```

- signed urls carry a **15-minute ttl**. shorter than upload because downloads are fast and urls are more likely to leak into logs/traces.
- `GET` variant exists for small batches where the hash list fits in the query string (`?siteId=…&hashes=sha256:…,sha256:…`); `POST` is required once the list exceeds typical url-length limits.
- cross-site requests are rejected. a key scoped to `site:A:read` requesting download urls for chunks stored under `site:B` returns `403 scope_insufficient` — there is no out-of-band way to resolve a digest to a tenant.

```json
{
  "urls": {
    "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6": "https://owlette-prod.r2.cloudflarestorage.com/project-content/kiosk-fleet-01/2e/2e7d2c03…?X-Amz-Algorithm=AWS4-HMAC-SHA256&…",
    "sha256:18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4": "https://owlette-prod.r2.cloudflarestorage.com/project-content/kiosk-fleet-01/18/18ac3e73…?X-Amz-Algorithm=AWS4-HMAC-SHA256&…"
  },
  "expiresAt": "2026-04-22T15:45:00Z"
}
```

clients then issue `GET` against each signed url. the agent re-verifies each chunk's sha-256 as it is written to its local content store (see `agent/src/sync_assembler.py`); a mismatch aborts the sync and re-fetches after quarantining the local copy.

## 6. cross-roost mount — zero-byte dedup across roosts

`POST /api/chunks/{digest}/mount?from=<sourceRoostId>` is roost's moat (principle 2). it attaches an existing chunk to a second roost without moving a byte.

```
POST /api/chunks/sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6/mount?from=roost_lobby_td
content-type: application/json
idempotency-key: 01HW8Z3VKQXG7M0F5T2EJ1RA9P

{
  "siteId": "kiosk-fleet-01",
  "toRoostId": "roost_lobby_td_v2"
}
```

- **authorisation**: the caller must hold `roost:toRoostId:write` **and** `roost:from:read`. mounting is read of source + write of destination.
- **payload shape**: the source roost id is in the query string (`from=`); the destination (and the `siteId` for isolation checks) are in the body.
- **same-site constraint**: source and destination must share a `siteId`. cross-site mounts return `scope_insufficient` — chunks never leave their tenant by any path.
- **bytes moved**: zero. the r2 key is unchanged. firestore records a new referrer edge in the chunk's referrer graph; billing still counts the chunk once per site.
- **idempotent**: mounting the same digest twice returns 200 on the second call (referrer count is not double-incremented for the same destination roost).

```json
{
  "digest": "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6",
  "fromRoostId": "roost_lobby_td",
  "toRoostId": "roost_lobby_td_v2",
  "mountedAt": "2026-04-22T15:30:00Z",
  "referrerCount": 3
}
```

## 7. referrer query

`GET /api/chunks/{digest}/referrers` returns the manifests currently using a chunk. used for ops/debug, gc eligibility, and the dashboard's "where is this file?" view.

```
GET /api/chunks/sha256:2e7d2c03…/referrers?siteId=kiosk-fleet-01&page_size=25
```

```json
{
  "items": [
    { "roostId": "roost_lobby_td",    "manifestId": "sha256:8d969eef…", "fileCount": 2 },
    { "roostId": "roost_lobby_td_v2", "manifestId": "sha256:8d969eef…", "fileCount": 2 }
  ],
  "next_page_token": ""
}
```

- paginated per google aip-158 (opaque `page_token`, max 100 per page).
- a chunk with zero referrers is eligible for the 30-day gc grace period (principle 15). force-delete does not exist.

## 8. idempotency

| operation | idempotent? | how |
|---|---|---|
| `POST /api/chunks/check` | yes (read-only) | stateless; every call recomputes from r2 metadata. |
| `POST /api/chunks/upload-urls` | yes by convention — same `Idempotency-Key` + same body returns the cached response for 24h. minting multiple urls for the same hash is **safe** (multiple valid urls can coexist; r2 sees identical `PUT`s and accepts the first). | server caches `{userId, env, idempotencyKey, bodyHash}` → response for 24h. a reuse with a different body hash returns `idempotency_key_mismatch` (409). |
| `PUT <signed r2 url>` | yes — r2 is natively idempotent on content-addressed writes. the same bytes to the same key is a no-op on the second call. | r2 handles internally; the client does not need to track "did this succeed?" beyond status code. |
| `POST /api/chunks/download-urls` | yes (read-only). | minting multiple download urls for the same hash is cheap and safe. |
| `POST /api/chunks/{digest}/mount` | yes — same digest, same `toRoostId`, same `siteId` is a no-op on the second call. | enforced via firestore transaction; the referrer edge is upserted, never duplicated. |

**rule of thumb for clients**: always send `Idempotency-Key` on `POST /api/chunks/upload-urls` and `POST /api/chunks/{digest}/mount`. for `/check` and `/download-urls` it is optional — the operations are read-only and safe to retry unconditionally.

## 9. reference chunker — pseudocode

both snippets below stream-read a file in fixed 4-mib blocks, compute sha-256 per block, and yield `(hash, size, offset)`. neither loads the file into memory.

### python (cpython 3.9+)

```python
import hashlib
from pathlib import Path
from typing import Iterator

CHUNK_SIZE = 4 * 1024 * 1024  # 4 mib

def chunk_file(path: Path) -> Iterator[dict]:
    """
    stream-read `path` in 4 mib blocks; yield {"hash": hex, "size": int, "offset": int}
    for each chunk. the last chunk may be 1..CHUNK_SIZE bytes. a zero-byte file yields
    no chunks.
    """
    offset = 0
    with path.open("rb") as f:
        while True:
            block = f.read(CHUNK_SIZE)
            if not block:
                return
            digest = hashlib.sha256(block).hexdigest()  # 64 lowercase hex
            yield {"hash": digest, "size": len(block), "offset": offset}
            offset += len(block)


def file_to_manifest_entry(path: Path, rel_path: str) -> dict:
    chunks = list(chunk_file(path))
    return {
        "path": rel_path,                           # posix, relative to folder root
        "size": sum(c["size"] for c in chunks),
        "chunks": [{"hash": c["hash"], "size": c["size"]} for c in chunks],
    }
```

wire-format note: when the hash is sent over the api (e.g. in `/api/chunks/check`) it must be prefixed with `sha256:` — `f"sha256:{digest}"`. when it is embedded in the manifest's `files[].chunks[].hash` field it is the bare 64-hex string.

### node (20+)

```js
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 mib

/**
 * stream-read `path` in 4 mib blocks; yield { hash, size, offset } per chunk.
 * last chunk may be 1..CHUNK_SIZE bytes. zero-byte files yield nothing.
 */
export async function* chunkFile(path) {
  let offset = 0;
  let pending = Buffer.alloc(0);

  for await (const buf of createReadStream(path, { highWaterMark: CHUNK_SIZE })) {
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);

    while (pending.length >= CHUNK_SIZE) {
      const block = pending.subarray(0, CHUNK_SIZE);
      pending = pending.subarray(CHUNK_SIZE);
      const hash = createHash('sha256').update(block).digest('hex');
      yield { hash, size: block.length, offset };
      offset += block.length;
    }
  }

  if (pending.length > 0) {
    const hash = createHash('sha256').update(pending).digest('hex');
    yield { hash, size: pending.length, offset };
  }
}

export async function fileToManifestEntry(path, relPath) {
  const chunks = [];
  for await (const c of chunkFile(path)) {
    chunks.push({ hash: c.hash, size: c.size });
  }
  return {
    path: relPath,
    size: chunks.reduce((n, c) => n + c.size, 0),
    chunks,
  };
}
```

notes applicable to both implementations:

- read buffer must be **at least** 4 mib — readers that emit smaller blocks (e.g. tcp socket chunks) must buffer up to 4 mib before hashing. the node version above does this explicitly via `pending`; the python version relies on `io.BufferedReader.read(n)` which returns up to `n` bytes (enough for regular files, but network-backed readers need a wrapper).
- the final chunk is whatever's left in the buffer at eof; zero bytes left means the previous block was the final chunk.
- hashing and i/o must not be interleaved with other writers on the same file — take a read lock or copy the file first.
- the manifest's `files[].size` must equal `sum(chunks[].size)`. the finalize validator rejects mismatches with `validation_failed`.

## 10. error taxonomy

every error response follows rfc 7807 `application/problem+json` with the stripe-style extensions (`code`, `param`, `doc_url`, `request_log_url`, `requestId`). the `code` field is the stable contract; match on that, never on the `detail` prose.

| code | status | endpoints | meaning |
|---|---|---|---|
| `validation_failed` | 400 | all | malformed digest (not `sha256:` + 64 hex), missing `siteId`, batch > 1000 hashes, empty `hashes[]`, invalid `toRoostId` on mount, unknown query params. |
| `quota_exceeded` | 402 | `POST /api/chunks/upload-urls`, `POST /api/chunks/{digest}/mount` | site storage limit reached (upload), or mount would push the target site over its tier limit. see `GET /api/sites/{siteId}/quota`. |
| `scope_insufficient` | 403 | all (universal) | api key lacks the required scope. example: download request for chunks stored under a site the key cannot read; mount without `roost:from:read`. |
| `chunk_not_found` | 404 | `POST /api/chunks/download-urls`, `POST /api/chunks/{digest}/mount`, `GET /api/chunks/{digest}/referrers` | one or more requested digests do not exist in the site's cas namespace. on batch endpoints the error lists the missing digests in the `param` field. |
| `site_isolation_violation` | 403 | `POST /api/chunks/{digest}/mount` | source and destination roost live in different sites. mount across sites is never permitted. |
| `idempotency_key_mismatch` | 409 | `POST /api/chunks/upload-urls`, `POST /api/chunks/{digest}/mount` | the same `Idempotency-Key` was replayed with a different request body hash within the 24h cache window. |
| `rate_limited` | 429 | all | per-key or per-tenant rate limit tripped; retry after `Retry-After` seconds. see the `Roost-Rate-Limited-Reason` response header for the specific bucket. |

universal errors (`auth_required` 401, `token_expired` 401, `internal_error` 500) are documented in the top-level api conventions and are not repeated here.

example `validation_failed` for a malformed digest:

```json
{
  "type": "https://owlette.app/errors/validation_failed",
  "title": "validation failed",
  "status": 400,
  "detail": "hash[0] is not a valid sha-256 digest; expected `sha256:` + 64 hex chars",
  "code": "validation_failed",
  "param": "hashes[0]",
  "doc_url": "https://docs.owlette.app/api/errors#validation_failed",
  "request_log_url": "https://owlette.app/dashboard/logs/req_01HW…",
  "requestId": "req_01HW…"
}
```

## 11. operational notes

- **signed-url expiry** is enforced by r2, not roost. if a client clock skews enough to serve an "expired" url as live, r2 still refuses it — the client must trust `expiresAt` from the api response, not local time.
- **retries during the upload session** should respect `Retry-After` on 429 and exponential backoff (base 500 ms, cap 30 s) on 5xx from r2.
- **partial uploads** are not representable. r2 `PUT` is atomic per-object: either the full chunk lands or nothing does. there is no "resume chunk 7 from byte 3 of 4 mib" — retry the whole chunk. this is principle 3 applied to the wire.
- **gc interaction**: a chunk with zero referrers across all roosts in a site becomes eligible for deletion after a 30-day grace period (principle 15). during that window a mount will resurrect it — the grace exists precisely to cover "roost just rolled back to a manifest whose chunks were about to be gc'd".

---
