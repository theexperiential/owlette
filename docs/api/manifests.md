# roost api — manifests

a manifest is an immutable snapshot of a roost at a point in time. this document is the external reference for the manifest schema, how to compute a manifest digest, how to publish, how concurrency works, and how rollback behaves.

if you have not already, read [overview.md](./overview.md) first — it explains how chunks, manifests, roosts, and deployments compose. this document focuses only on manifests.

---

## 1. what is a manifest

a manifest is a single json document that enumerates every file in a roost at a specific version, and for each file names the sha-256 digests of the chunks that make up its bytes. it is the authoritative file list for that version.

- **immutable**: once `POST /api/roosts/{roostId}/manifests` returns `201 Created`, that manifest and the chunks it names are pinned for the lifetime of the roost. the manifest body is never mutated. a new publish produces a new manifest with its own digest; the prior manifest stays addressable by id forever.
- **content-addressed**: the manifest is identified by the sha-256 digest of its canonical-json body. the same bytes always yield the same digest, and any change to the body — a single whitespace character, a reordered key — produces a different digest.
- **oci-derived**: the shape is derived from [oci image manifest v1.1](https://github.com/opencontainers/image-spec/blob/main/manifest.md), with roost-specific media types and a `files[]` array in place of oci's tar-oriented `layers[]`. readers familiar with oci will recognize `schemaVersion`, `mediaType`, `config`, and `annotations`.
- **the source of truth for a version**: firestore, the dashboard, the agent's on-disk state all defer to the manifest. if any of them disagree with the manifest, the manifest wins.

what a manifest is **not**: a filesystem snapshot (no acls, ownership, or xattrs), a backup format (chunks are referenced, not embedded), or a signed attestation (v1 is unsigned; signing lands in v3).

---

## 2. schema reference

top-level:

| field | type | required | notes |
|---|---|---|---|
| `schemaVersion` | int | yes | must be exactly `2`. matches oci convention. bumped only on breaking changes to the schema. |
| `mediaType` | string | yes | must be exactly `application/vnd.owlette.manifest.v1+json`. the real version discriminator — future versions mint new mediatypes. |
| `config` | object | yes | manifest-level metadata (see below). |
| `files` | array | yes | every file in this version. may be empty (`[]` means "this roost is now empty at this version"). |
| `annotations` | object | no | optional string→string map. non-normative — readers must ignore unknown keys. |

### config

```json
{
  "name": "lobby-touchdesigner",
  "createdAt": "2026-04-22T15:30:00Z",
  "createdBy": "owk_live_kB8n3p",
  "siteId": "kiosk-fleet-01"
}
```

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes | human-readable name for the version, 1–256 chars. the roost name plus an optional label works well. |
| `createdAt` | string | yes | rfc 3339 utc timestamp, `Z` suffix. server-issued at publish time. |
| `createdBy` | string | yes | the api key prefix (e.g. `owk_live_kB8n3p`) or firebase uid that published the manifest. never the full api key. |
| `siteId` | string | yes | the owlette site that owns the roost. must match the request context; the server rejects mismatches. |

### files[]

each entry:

```json
{
  "path": "assets/logo.png",
  "size": 524288,
  "chunks": [
    { "hash": "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4", "size": 524288 }
  ]
}
```

| field | type | required | notes |
|---|---|---|---|
| `path` | string | yes | posix forward slashes, relative to the roost root, no `..` or `.` segments, utf-8 nfc, unique within the manifest, ≤ 1024 bytes encoded. |
| `size` | int | yes | file size in bytes. must equal `sum(chunks[].size)`. |
| `chunks` | array | yes | ordered chunk list; concatenating their bytes in order reproduces the file. empty `[]` is only valid when `size` is `0`. |

each chunk:

| field | type | required | notes |
|---|---|---|---|
| `hash` | string | yes | lowercase hex sha-256, exactly 64 chars, matching `^[0-9a-f]{64}$`. no `sha256:` prefix inside the manifest body. |
| `size` | int | yes | byte length of this chunk. exactly `4194304` (4 mib) for every chunk except the last in a file; the last chunk may be `1..4194304`. |

### annotations (optional)

free-form metadata map for ui display and tooling hints. never load-bearing.

```json
{
  "annotations": {
    "com.owlette.uploadClient": "roost-cli/0.1.0",
    "com.owlette.notes": "swapped audio palette to the reactive variant"
  }
}
```

- keys are reverse-dns strings, max 255 chars.
- values are utf-8 strings, max 4 kib each.
- combined payload ≤ 64 kib.
- readers must ignore unknown keys.

### full example

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.owlette.manifest.v1+json",
  "config": {
    "name": "lobby-touchdesigner",
    "createdAt": "2026-04-22T15:30:00Z",
    "createdBy": "owk_live_kB8n3p",
    "siteId": "kiosk-fleet-01"
  },
  "files": [
    {
      "path": "main.toe",
      "size": 5242880,
      "chunks": [
        { "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "size": 4194304 },
        { "hash": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae", "size": 1048576 }
      ]
    },
    {
      "path": "assets/logo.png",
      "size": 524288,
      "chunks": [
        { "hash": "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4", "size": 524288 }
      ]
    }
  ],
  "annotations": {
    "com.owlette.uploadClient": "roost-cli/0.1.0"
  }
}
```

for the authoritative schema (validation rules, path constraints, evolution policy), the internal spec lives at [`docs/internal/manifest-format.md`](../internal/manifest-format.md). external readers should not need it — everything load-bearing for publishing against the public api is restated here.

---

## 3. digest computation

a manifest's id is `sha256:<hex>` where `<hex>` is the sha-256 of the manifest body serialised as canonical json: sorted keys at every level, no insignificant whitespace, utf-8 encoded. compute the digest yourself before publishing — the server recomputes it on receive and returns the same id, so matching locally lets you log, dedupe, and retry safely.

canonical json means: keys lexically sorted at every object level, no whitespace between tokens, standard json number formatting, utf-8. this is the shape [rfc 8785 jcs](https://datatracker.ietf.org/doc/html/rfc8785) specifies.

### bash

```bash
# assumes manifest.json contains the manifest body
jq -cS . manifest.json | tr -d '\n' | sha256sum | awk '{print "sha256:"$1}'
```

### node

```js
import { createHash } from "node:crypto";

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const digest = "sha256:" + createHash("sha256").update(canonicalJson(manifest)).digest("hex");
console.log(digest);
```

### python

```python
import hashlib, json

with open("manifest.json", "rb") as f:
    manifest = json.load(f)

canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
digest = "sha256:" + hashlib.sha256(canonical).hexdigest()
print(digest)
```

the digest is what appears everywhere a manifest id appears: the `id` field in list responses, the `{manifestId}` path parameter, the `If-Match` header on rollback, the `expectedCurrentManifestId` body field on publish.

---

## 4. publishing

```http
POST /api/roosts/{roostId}/manifests
Authorization: Bearer owk_live_...
Idempotency-Key: 3f7b9c2a-8e14-4f1c-9d6e-2c8a5b0e9f4d
If-Match: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
Content-Type: application/json

{
  "siteId": "kiosk-fleet-01",
  "manifest": { ... full manifest body ... },
  "expectedCurrentManifestId": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
}
```

prerequisites, in order:

1. **chunk-check**: `POST /api/chunks/check` with the set of digests your manifest references. the server returns the `missing` subset.
2. **chunk-upload**: `POST /api/chunks/upload-urls` for the missing ones and `PUT` the bytes directly to r2.
3. **publish**: `POST /api/roosts/{roostId}/manifests` with the full manifest body.

the server validates on receive:

- **shape**: every required field present, types correct, `schemaVersion === 2`, `mediaType` exact match, all path constraints, every chunk hash well-formed, every file `size` equal to `sum(chunks[].size)`.
- **existence**: every chunk digest referenced by `files[].chunks[]` must already be uploaded to r2 under the site's namespace. a referenced but not-yet-uploaded chunk returns `chunk_not_found`.
- **concurrency**: if `expectedCurrentManifestId` (body) or `If-Match` (header) is provided, the server compares it against the roost's current pointer inside a firestore transaction and refuses the write on mismatch.

response (`201 Created`):

```json
{
  "manifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "currentManifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "previousManifestId": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "publishedAt": "2026-04-22T15:30:00Z"
}
```

the `manifestId` is the digest the server computed from your body — you should compare it against the digest you computed locally before sending. if they differ, something mutated the body in transit (encoding, reserialisation) and the publish should be considered unsafe.

`Idempotency-Key` is recommended on every publish. a retry with the same key and identical body replays the cached response for up to 24 hours. the same key with a different body returns `idempotency_key_mismatch` — see [design-principles.md principle 4](../../dev/active/roost-public-api/reference/design-principles.md).

---

## 5. optimistic concurrency

publishing is a compare-and-swap against the roost's `currentManifestId`. you declare what you believe the current manifest is; the server accepts the publish only if that belief is correct. this prevents the "operator a rolls back while operator b is deploying" class of bug, where without a concurrency guard one operator's change silently disappears.

two ways to express the expected-current pointer, equivalent in effect:

- **body field**: `"expectedCurrentManifestId": "sha256:..."` inside the request json.
- **header**: `If-Match: "sha256:..."` (note the quotes — this follows rfc 7232 http entity-tag syntax).

`If-Match` wins when both are present. if neither is provided, the publish advances the pointer unconditionally — useful for the first publish on an empty roost, discouraged for anything else.

on a mismatch, the server returns:

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json

{
  "type": "https://owlette.app/errors/precondition_failed",
  "title": "precondition failed",
  "status": 412,
  "detail": "current manifest digest is sha256:cc33...dd44, not sha256:aa11...bb22",
  "code": "precondition_failed",
  "expected": "sha256:aa11...bb22",
  "actual": "sha256:cc33...dd44",
  "currentManifestId": "sha256:cc33...dd44",
  "requestId": "req_01HW..."
}
```

the recovery loop is always the same:

1. catch the 412.
2. `GET /api/roosts/{roostId}` to fetch the new `currentManifestId`.
3. decide: rebase (recompute your manifest against the new parent) or abort (some other deploy intentionally ran — you may not want to overwrite it).
4. retry with the updated `expectedCurrentManifestId`.

the same `If-Match` discipline applies to rollback and to `POST /api/roosts/{roostId}/deploy`. see [design-principles.md principle 5](../../dev/active/roost-public-api/reference/design-principles.md) for the full rationale.

---

## 6. rollback semantics

rollback flips `currentManifestId` to a prior manifest. it is a pointer move, not a re-upload — the chunks referenced by the older manifest have been pinned the whole time, so no bytes are transferred, and the operation completes in tens of milliseconds even for gigabyte-scale roosts.

```http
POST /api/roosts/{roostId}/rollback
Authorization: Bearer owk_live_...
If-Match: "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
Content-Type: application/json

{
  "siteId": "kiosk-fleet-01",
  "targetManifestId": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
}
```

- `targetManifestId` is **optional**. if omitted, the server rolls back to the roost's `previousManifestId` — the one-click "undo my last deploy" case.
- if you pass `targetManifestId`, it must be a manifest that has existed in this roost's history. rolling back to an arbitrary digest from another roost is not supported.
- `If-Match` (or body `expectedCurrentManifestId`) works the same as on publish: the rollback refuses to run if the pointer has moved since you last looked.

response (`200 OK`):

```json
{
  "currentManifestId": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "previousManifestId": "sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "rolledBackAt": "2026-04-22T15:35:00Z",
  "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W3"
}
```

audit trail: every rollback writes an audit record capturing `rolledBackAt`, `rolledBackBy` (the api key or user that performed it), and `rolledBackFrom` (the manifest id that was current at the moment of the flip). see [`GET /api/sites/{siteId}/audit-log`](../../dev/active/roost-public-api/reference/api-surface.md) — filter on `kind=manifest_pointer_changed` to see the full history of pointer flips for a roost.

after rollback, the former-current manifest stays available at `GET /api/roosts/{roostId}/manifests/{manifestId}` and can be rolled forward to with another rollback call. the pointer is reversible; the manifests are not deleted.

### rollback error cases

- `404 not_found` — roost does not exist, or `targetManifestId` is not in the roost's history.
- `409 conflict` — you omitted `targetManifestId` and the roost has no `previousManifestId` (only one manifest has ever been published).
- `409 conflict` — `targetManifestId` equals the current manifest id (no-op rollback).
- `412 precondition_failed` — `If-Match` or `expectedCurrentManifestId` mismatch. recover as described in [section 5](#5-optimistic-concurrency).

---

## 7. immutability guarantees

what you can rely on once a manifest has been published:

- **the body is frozen.** the json at `GET /api/roosts/{roostId}/manifests/{manifestId}` will be byte-identical for the lifetime of the roost. the server does not rewrite, re-serialise, or normalise it. anyone who has computed the digest can verify it indefinitely.
- **the chunks it references survive gc.** chunks are reclaimed by the garbage collector only after **every** live manifest referencing them has been removed from the roost's history **and** a 30-day grace period has elapsed. a chunk referenced by even one live manifest in any roost on your site is safe.
- **historical manifests stay addressable.** untagging a manifest (by publishing over it or rolling back past it) does not delete it. `GET /api/roosts/{roostId}/manifests/{manifestId}` continues to return `200 OK` with the full body.
- **rollback is always available.** because historical manifests and their chunks are both pinned, "go back to the version from three weeks ago" is a single api call and requires no restore procedure.

what you should **not** rely on:

- manifests are not content-signed in v1. integrity rests on tls, firebase auth, and signed r2 urls. v3 will add tuf-style signing.
- the roost itself can be soft-deleted (`DELETE /api/roosts/{roostId}`), which starts a 30-day tombstone clock on its manifests and chunks. purge is irreversible after that window.
- there is no way to force-delete a specific manifest or chunk. if you need the bytes gone — e.g. dmca takedown — the path is roost deletion plus site-admin action, not a manifest-scoped delete. see [design-principles.md principle 15](../../dev/active/roost-public-api/reference/design-principles.md).

---

## 8. listing history

### list manifests

```http
GET /api/roosts/{roostId}/manifests?siteId=kiosk-fleet-01&page_size=25
```

returns manifest ids in reverse chronological order (newest first) with denormalised metadata:

```json
{
  "items": [
    {
      "id": "sha256:8d969eef...",
      "publishedAt": "2026-04-22T15:30:00Z",
      "publishedBy": "owk_live_kB8n3p",
      "totalSize": 2147483648,
      "totalFiles": 342,
      "isCurrent": true
    }
  ],
  "next_page_token": ""
}
```

cursor-paginated per [design-principles.md principle 9](../../dev/active/roost-public-api/reference/design-principles.md). `page_size` max 100, default 25. `next_page_token` is an opaque server-signed blob — do not parse it. an empty string means no more pages.

### fetch one manifest

```http
GET /api/roosts/{roostId}/manifests/{manifestId}
```

returns the denormalised header plus the full oci manifest body — the same json you uploaded, byte-for-byte. use this to verify the digest, to rebuild a local mirror, or to drive diff tooling.

### per-manifest file list

```http
GET /api/roosts/{roostId}/manifests/{manifestId}/files?prefix=assets/&page_size=100
```

paginated flat file list. avoids pulling the full manifest body when you only need filenames — useful for large manifests (tens of thousands of files). `prefix` filters by path prefix.

### diff two manifests

```http
GET /api/roosts/{roostId}/manifests/{manifestId}/diff?against=sha256:2c26b46b...
```

file-level diff:

```json
{
  "from": "sha256:2c26b46b...",
  "to": "sha256:8d969eef...",
  "added":    [ { "path": "assets/new_logo.png", "digest": "sha256:...", "size": 524288 } ],
  "removed":  [ { "path": "assets/old_logo.png", "digest": "sha256:...", "size": 512 } ],
  "modified": [ { "path": "main.toe", "digestBefore": "sha256:...", "digestAfter": "sha256:...", "sizeBefore": 8192, "sizeAfter": 16384 } ]
}
```

a file is "modified" when the same `path` maps to a different chunk hash set between the two manifests. this is what the dashboard's rollback preview shows before you confirm.

---

## 9. error codes

all manifest errors use rfc 7807 `application/problem+json` with stable `code` identifiers. see [design-principles.md principle 8](../../dev/active/roost-public-api/reference/design-principles.md) for the envelope shape.

| code | http | meaning | typical cause |
|---|---|---|---|
| `validation_failed` | 400 / 422 | the manifest body does not satisfy the schema — malformed path, wrong `schemaVersion`, `size` mismatch against `sum(chunks[].size)`, duplicate path, annotation over size cap, `mediaType` wrong. | client built an invalid manifest. the `param` field names the offending path. |
| `chunk_not_found` | 400 | one or more chunks referenced by `files[].chunks[].hash` are not present in r2 for this site. | you forgot to upload a chunk, or the upload failed silently. re-run `POST /api/chunks/check` to find which digests are missing, upload them, and retry. |
| `precondition_failed` | 412 | `If-Match` or `expectedCurrentManifestId` does not match the roost's current pointer. | concurrent publisher moved the pointer between your read and your write. refetch `GET /api/roosts/{roostId}` and retry. the response body includes `expected` and `actual`. |
| `not_found` | 404 | the roost does not exist, the caller has no read access to it, or (on rollback / fetch) the `targetManifestId` / `manifestId` is not in this roost's history. | typo in id, revoked scope, or referencing a manifest from a different roost. |
| `conflict` | 409 | rollback would be a no-op (`targetManifestId` equals current), or was called without `targetManifestId` on a roost that has no `previousManifestId`. | first publish has no prior to roll back to; omit the call or specify an explicit target once a second manifest exists. |
| `idempotency_key_mismatch` | 409 | the same `Idempotency-Key` was reused with a different request body hash. | regenerate the uuid when you change the payload. |
| `quota_exceeded` | 402 | publishing this manifest would push the site over its storage limit. | the `missing` chunks you were about to upload would exceed your plan cap. check `GET /api/sites/{siteId}/quota`. |

every response — success or error — carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers ([principle 10](../../dev/active/roost-public-api/reference/design-principles.md)). on 429 use `Retry-After`, not arbitrary backoff.
