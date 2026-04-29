# Roost versions

> **Note**: this resource was previously named "manifest" — it was renamed to "version" in 2026-04. all api paths, sdk method names, and docs have been updated.

a version is an immutable snapshot of a roost at a point in time. this document is the external reference for the version schema, how to compute a version digest, how to publish, how concurrency works, and how rollback behaves.

if you have not already, read [overview.md](./overview.md) first — it explains how chunks, versions, roosts, and deployments compose. this document focuses only on versions.

---

## 1. what is a version

a version is a single json document that enumerates every file in a roost at a specific point in time, and for each file names the sha-256 digests of the chunks that make up its bytes. it is the authoritative file list for that point in time.

- **immutable**: once `POST /api/roosts/{roostId}/versions` returns `201 Created`, that version and the chunks it names are pinned for the lifetime of the roost. the version body is never mutated. a new publish produces a new version with its own digest; the prior version stays addressable by id forever. (the one exception: the optional `description` field is editable after the fact — see [§4](#4-description-field). version *content* stays immutable.)
- **content-addressed**: the version is identified by the sha-256 digest of its canonical-json body. the same bytes always yield the same digest, and any change to the body — a single whitespace character, a reordered key — produces a different digest.
- **oci-derived**: the shape is derived from the [oci image spec v1.1 snapshot format](https://github.com/opencontainers/image-spec), with roost-specific media types and a `files[]` array in place of oci's tar-oriented `layers[]`. readers familiar with oci will recognize `schemaVersion`, `mediaType`, `config`, and `annotations`.
- **the source of truth**: firestore, the dashboard, the agent's on-disk state all defer to the version. if any of them disagree with the version, the version wins.

what a version is **not**: a filesystem snapshot (no acls, ownership, or xattrs), a backup format (chunks are referenced, not embedded), or a signed attestation (v1 is unsigned; signing lands in v3).

---

## 2. schema reference

top-level:

| field | type | required | notes |
|---|---|---|---|
| `schemaVersion` | int | yes | must be exactly `2`. matches oci convention. bumped only on breaking changes to the schema. |
| `mediaType` | string | yes | must be exactly `application/vnd.owlette.version.v1+json`. the real version discriminator — future schemas mint new mediatypes. |
| `config` | object | yes | version-level metadata (see below). |
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
| `createdBy` | string | yes | the api key prefix (e.g. `owk_live_kB8n3p`) or firebase uid that published the version. never the full api key. |
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
| `path` | string | yes | posix forward slashes, relative to the roost root, no `..` or `.` segments, utf-8 nfc, unique within the version, ≤ 1024 bytes encoded. |
| `size` | int | yes | file size in bytes. must equal `sum(chunks[].size)`. |
| `chunks` | array | yes | ordered chunk list; concatenating their bytes in order reproduces the file. empty `[]` is only valid when `size` is `0`. |

each chunk:

| field | type | required | notes |
|---|---|---|---|
| `hash` | string | yes | lowercase hex sha-256, exactly 64 chars, matching `^[0-9a-f]{64}$`. no `sha256:` prefix inside the version body. |
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
  "mediaType": "application/vnd.owlette.version.v1+json",
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

for the authoritative schema (validation rules, path constraints, evolution policy), the internal spec lives at [`docs/internal/version-format.md`](../internal/version-format.md). external readers should not need it — everything load-bearing for publishing against the public api is restated here.

---

## 3. digest computation

a version's stable id is `vrs_<hex>` where `<hex>` is the sha-256 of the version body serialised as canonical json: sorted keys at every level, no insignificant whitespace, utf-8 encoded. compute the digest yourself before publishing — the server recomputes it on receive and returns the same id, so matching locally lets you log, dedupe, and retry safely.

canonical json means: keys lexically sorted at every object level, no whitespace between tokens, standard json number formatting, utf-8. this is the shape [rfc 8785 jcs](https://datatracker.ietf.org/doc/html/rfc8785) specifies.

### bash

```bash
# assumes version.json contains the version body
jq -cS . version.json | tr -d '\n' | sha256sum | awk '{print "vrs_"$1}'
```

### node

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const version = JSON.parse(readFileSync("version.json", "utf8"));
const versionId = "vrs_" + createHash("sha256").update(canonicalJson(version)).digest("hex");
console.log(versionId);
```

### python

```python
import hashlib, json

with open("version.json", "rb") as f:
    version = json.load(f)

canonical = json.dumps(version, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
version_id = "vrs_" + hashlib.sha256(canonical).hexdigest()
print(version_id)
```

the stable `vrs_*` id is what appears everywhere a version id appears: the `versionId` field in list responses, as one of the accepted forms of the `{versionRef}` path parameter, the `If-Match` header on rollback, the `expectedCurrentVersionId` body field on publish.

---

## 4. description field

every version carries an optional `description`: a short human-readable note explaining what changed. this is purely metadata — it is not hashed into the version id, it does not participate in deduplication, and it has no effect on agent behavior. it exists for the operator reading the version history six months later.

rules:

- **optional** — omit to leave it null. the ui renders an empty string in that case.
- **plaintext** — markdown is not rendered. newlines are preserved; everything else is shown as typed.
- **≤ 500 characters** — longer submissions are rejected with `validation_failed`.
- **editable after the fact** — unlike version content, description is mutable. see below.

setting on publish:

- **cli** — `owlette roost push --description "fixed broken video"` (or `-m "..."` for short).
- **api** — include `"description": "..."` in the `POST /api/roosts/{roostId}/versions` body.
- **sdk (node)** — `client.versions.publish(roostId, { description: "fixed broken video", files: [...] })`.
- **sdk (python)** — `client.versions.publish(roost_id, description="fixed broken video", files=[...])`.

editing after the fact:

```bash
curl -fsS -X PATCH "$ROOST_BASE/api/roosts/$ROOST_ID/versions/vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92" \
  "${AUTH[@]}" \
  -d '{"description": "the audio palette revert — not the one we kept"}'
```

response (`200 OK`):

```json
{
  "versionId": "vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "versionNumber": 3,
  "description": "the audio palette revert — not the one we kept",
  "updatedAt": "2026-04-24T09:12:00Z"
}
```

only `description` is accepted in the patch body. attempts to patch other fields return `validation_failed`. **version content — `files`, `chunks`, `config`, `annotations`, `versionNumber` — is immutable.** the patch exists purely so operators can fix a typo in the description or add context retroactively, not to rewrite history.

the patch writes an audit-log entry with `kind=roost_mutated` and `attributes.verb=version_description_update`, capturing the old + new description and the actor, so even "fixed" descriptions leave a trail.

---

## 5. version numbering

alongside the content-addressed `versionId`, every version also gets a `versionNumber`: a per-roost auto-incrementing integer, starting at 1.

- **1-indexed** — the first push to a fresh roost is version #1; the second is #2; and so on.
- **per roost** — numbering is scoped to the roost, not the site or the user. two different roosts each have their own `#1`.
- **monotonic, no gaps** — every successful publish gets exactly one number, one higher than the previous. this is enforced by a firestore transaction on the roost doc's `versionCounter` field; two concurrent publishes never race to produce the same number, and a failed publish does not burn a number.
- **stable** — once minted, a version's number never changes. rollback does **not** renumber; rolling back to `#3` from `#7` leaves both `#3` and `#7` in the list, and the next publish will be `#8`.

`versionNumber` is the natural handle humans use ("roll back to #3"); `versionId` is the natural handle scripts and ci use. both point at the same document, and the server's resolver accepts either — see the next section.

---

## 6. version addressing

every path that takes `{versionRef}` — `GET /api/roosts/{roostId}/versions/{versionRef}`, `GET .../files`, `GET .../diff`, `PATCH ...`, `POST /rollback` target — accepts **three interchangeable forms**:

| form | example | typical user |
|---|---|---|
| stable id | `vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92` | ci/cd scripts, the sdk, anywhere the exact bytes matter |
| version number | `3`, `#3`, `v3` (all equivalent) | humans rolling back from a terminal or a chat command |
| alias | `current`, `previous`, `first` | "undo my last deploy" automations, dashboard shortcuts |

all three resolve server-side to the same version document. same response body, same headers — the difference is only in which handle you held in your hand at request time.

### all three forms hitting the same endpoint

stable id (ci/cd):

```bash
curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions/vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92" "${AUTH[@]}"
```

version number — any of `3`, `#3`, or `v3` works. `#` is url-safe when sent as a literal segment; some http clients may url-encode it as `%23`, which also resolves:

```bash
curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions/3" "${AUTH[@]}"
curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions/%233" "${AUTH[@]}"
curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions/v3" "${AUTH[@]}"
```

alias (undo last deploy):

```bash
curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions/previous" "${AUTH[@]}"
```

### when to use which

- **stable id (`vrs_*`)** — use in ci/cd, in infra-as-code, in any script where reproducibility over time matters. a `vrs_*` id means "this exact bytes" forever; a number means "whatever the third push to this roost was", which is stable today but confusing next year when someone re-reads the commit.
- **version number (`3` / `#3` / `v3`)** — use when humans are in the loop. "hey, can you roll us back to v3?" is how people actually talk; the api accepts it verbatim. `#3` reads naturally in chat (`rollback to #3`) and `v3` reads naturally in release notes. prefer the bare `3` in scripts unless the surrounding syntax is ambiguous.
- **alias (`current` / `previous` / `first`)** — use when the question is relative, not absolute. "rollback to previous" is the one-click undo; "diff against current" is "what would this publish actually change on disk"; "show first" is "what did we start with". aliases re-resolve on every call, so they always mean **now** — `previous` today may not be `previous` tomorrow if there's been another publish in between.

invalid refs return `400 validation_failed` with a `detail` pointing at the offending segment. unknown refs (id not in this roost, number past the counter, alias that has no target yet) return `404 version_not_found`.

---

## 7. publishing

```http
POST /api/roosts/{roostId}/versions
Authorization: Bearer owk_live_...
Idempotency-Key: 3f7b9c2a-8e14-4f1c-9d6e-2c8a5b0e9f4d
If-Match: "vrs_2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
Content-Type: application/json

{
  "siteId": "kiosk-fleet-01",
  "version": { ... full version body ... },
  "description": "fixed broken video on the lobby screen",
  "expectedCurrentVersionId": "vrs_2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
}
```

prerequisites, in order:

1. **chunk-check**: `POST /api/chunks/check` with the set of digests your version references. the server returns the `missing` subset.
2. **chunk-upload**: `POST /api/chunks/upload-urls` for the missing ones and `PUT` the bytes directly to r2.
3. **publish**: `POST /api/roosts/{roostId}/versions` with the full version body.

the server validates on receive:

- **shape**: every required field present, types correct, `schemaVersion === 2`, `mediaType` exact match, all path constraints, every chunk hash well-formed, every file `size` equal to `sum(chunks[].size)`.
- **existence**: every chunk digest referenced by `files[].chunks[]` must already be uploaded to r2 under the site's namespace. a referenced but not-yet-uploaded chunk returns `chunk_not_found`.
- **description**: ≤ 500 chars if provided; the server neither normalises nor renders it.
- **concurrency**: if `expectedCurrentVersionId` (body) or `If-Match` (header) is provided, the server compares it against the roost's current pointer inside a firestore transaction and refuses the write on mismatch.
- **numbering**: inside the same transaction, the server reads the roost's `versionCounter`, increments it, and writes the new version with that number. concurrent publishes never produce the same `versionNumber`.

response (`201 Created`):

```json
{
  "versionId": "vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "versionNumber": 3,
  "description": "fixed broken video on the lobby screen",
  "currentVersionId": "vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "previousVersionId": "vrs_2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "publishedAt": "2026-04-22T15:30:00Z"
}
```

the `versionId` is the digest the server computed from your body — you should compare it against the digest you computed locally before sending. if they differ, something mutated the body in transit (encoding, reserialisation) and the publish should be considered unsafe.

`Idempotency-Key` is recommended on every publish. a retry with the same key and identical body replays the cached response for up to 24 hours. the same key with a different body returns `idempotency_key_mismatch`; see [errors.md](./errors.md#idempotency_key_mismatch) for remediation.

---

## 8. optimistic concurrency

publishing is a compare-and-swap against the roost's `currentVersionId`. you declare what you believe the current version is; the server accepts the publish only if that belief is correct. this prevents the "operator a rolls back while operator b is deploying" class of bug, where without a concurrency guard one operator's change silently disappears.

two ways to express the expected-current pointer, equivalent in effect:

- **body field**: `"expectedCurrentVersionId": "vrs_..."` inside the request json.
- **header**: `If-Match: "vrs_..."` (note the quotes — this follows rfc 7232 http entity-tag syntax).

`If-Match` wins when both are present. if neither is provided, the publish advances the pointer unconditionally — useful for the first publish on an empty roost, discouraged for anything else.

on a mismatch, the server returns:

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json

{
  "type": "https://owlette.app/problems/precondition-failed",
  "title": "precondition failed",
  "status": 412,
  "detail": "current version digest is vrs_cc33...dd44, not vrs_aa11...bb22",
  "code": "precondition_failed",
  "expected": "vrs_aa11...bb22",
  "actual": "vrs_cc33...dd44",
  "currentVersionId": "vrs_cc33...dd44",
  "requestId": "req_01HW..."
}
```

the recovery loop is always the same:

1. catch the 412.
2. `GET /api/roosts/{roostId}` to fetch the new `currentVersionId`.
3. decide: rebase (recompute your version against the new parent) or abort (some other deploy intentionally ran — you may not want to overwrite it).
4. retry with the updated `expectedCurrentVersionId`.

the same `If-Match` discipline applies to rollback and to `POST /api/roosts/{roostId}/deploy`.

---

## 9. rollback semantics

rollback flips `currentVersionId` to a prior version. it is a pointer move, not a re-upload — the chunks referenced by the older version have been pinned the whole time, so no bytes are transferred, and the operation completes in tens of milliseconds even for gigabyte-scale roosts.

```http
POST /api/roosts/{roostId}/rollback
Authorization: Bearer owk_live_...
If-Match: "vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
Content-Type: application/json

{
  "siteId": "kiosk-fleet-01",
  "targetVersion": "previous"
}
```

`targetVersion` accepts the same three forms as `{versionRef}` ([§6](#6-version-addressing)):

- a stable id: `"targetVersion": "vrs_2c26b46b..."`.
- a version number: `"targetVersion": 3`, `"targetVersion": "#3"`, `"targetVersion": "v3"`.
- an alias: `"targetVersion": "previous"` (the common case — one-click undo) or `"targetVersion": "first"`.

`targetVersion` is also **optional**: if omitted, the server treats it as `"previous"` — the "undo my last deploy" case. new callers should pass the ref explicitly.

whatever form you pass, the ref must resolve to a version in this roost's history. rolling back to an arbitrary digest from another roost is not supported and returns `404 version_not_found`.

`If-Match` (or body `expectedCurrentVersionId`) works the same as on publish: the rollback refuses to run if the pointer has moved since you last looked.

response (`200 OK`):

```json
{
  "currentVersionId": "vrs_2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "currentVersionNumber": 2,
  "previousVersionId": "vrs_8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  "rolledBackAt": "2026-04-22T15:35:00Z",
  "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W3"
}
```

audit trail: every rollback writes an audit record capturing `rolledBackAt`, `rolledBackBy` (the api key or user that performed it), and `rolledBackFrom` (the version id that was current at the moment of the flip). use `GET /api/sites/{siteId}/audit-log?kind=roost_mutated` and filter for `attributes.verb=rollback` to see pointer flips for a roost.

after rollback, the former-current version stays available at `GET /api/roosts/{roostId}/versions/{versionRef}` and can be rolled forward to with another rollback call. the pointer is reversible; the versions are not deleted, and their numbers do not change.

### rollback error cases

- `404 not_found` — roost does not exist, or `targetVersion` does not resolve to a version in the roost's history.
- `409 conflict` — you omitted `targetVersion` (or passed `"previous"`) and the roost has no `previousVersionId` (only one version has ever been published).
- `409 conflict` — the resolved target equals the current version (no-op rollback).
- `412 precondition_failed` — `If-Match` or `expectedCurrentVersionId` mismatch. recover as described in [§8](#8-optimistic-concurrency).

---

## 10. how agents apply a version (patch semantics)

when an agent receives a `sync_pull` for a new version, it iterates the version's `files[]`, fetches any chunks it doesn't already have, and writes each listed file to `<extract_path>/<file.path>`. **files that exist under `extract_path` but are not listed in the version are not touched.**

this is a **patch model**, not a snapshot model. a version describes what *should be there* for the files it lists; it does not assert what *should not be there*. concretely:

- if v1 publishes `[a.mp4, b.mp4, c.mp4]` and v2 publishes only `[b.mp4]` (with new bytes), the agent overwrites `b.mp4` and leaves `a.mp4` and `c.mp4` in place. after applying v2, the directory still contains all three files.
- rolling back to v1 overwrites `a.mp4`, `b.mp4`, and `c.mp4` with their v1 content. (in practice, `a.mp4` and `c.mp4` already match v1, so the assembler short-circuits and writes nothing — the chunks are content-addressed.)
- **a file removed from the version list will persist on disk forever** unless the operator deletes it manually at the kiosk. there is no current api for declarative deletion.

this is intentional for the digital-signage use case it grew out of: an upload of a single file to fix one broken video should not blow away the rest of the lobby loop. operators who want snapshot semantics ("destination should match the version exactly, period") should publish the *complete* file set every time — uploading 10 videos in v2 to match what v1 had, plus the change.

> **in v3** we plan to add an opt-in `pruneOrphans: true` on the version body so a version can declare itself authoritative for the entire `extract_path`. tracked in the v3 roadmap; not available today.

---

## 11. immutability guarantees

what you can rely on once a version has been published:

- **the body is frozen.** the json at `GET /api/roosts/{roostId}/versions/{versionRef}` will be byte-identical for the lifetime of the roost (with the single exception of `description`, documented in [§4](#4-description-field)). the server does not rewrite, re-serialise, or normalise the content. anyone who has computed the digest can verify it indefinitely.
- **the chunks it references survive gc.** chunks are reclaimed by the garbage collector only after **every** live version referencing them has been removed from the roost's history **and** a 30-day grace period has elapsed. a chunk referenced by even one live version in any roost on your site is safe.
- **historical versions stay addressable.** untagging a version (by publishing over it or rolling back past it) does not delete it. `GET /api/roosts/{roostId}/versions/{versionRef}` continues to return `200 OK` with the full body.
- **version numbers are stable.** rollback does not renumber; deletion of a version is not supported; numbers only ever increase.
- **rollback is always available.** because historical versions and their chunks are both pinned, "go back to the version from three weeks ago" is a single api call and requires no restore procedure.

what you should **not** rely on:

- versions are not content-signed in v1. integrity rests on tls, firebase auth, and signed r2 urls. v3 will add tuf-style signing.
- the roost itself can be soft-deleted (`DELETE /api/roosts/{roostId}`), which starts a 30-day tombstone clock on its versions and chunks. purge is irreversible after that window.
- there is no way to force-delete a specific version or chunk. if you need the bytes gone — e.g. dmca takedown — the path is roost deletion plus site-admin action, not a version-scoped delete.

---

## 11. listing history

### list versions

```http
GET /api/roosts/{roostId}/versions?siteId=kiosk-fleet-01&page_size=25
```

returns versions in reverse chronological order (newest first) with denormalised metadata:

```json
{
  "items": [
    {
      "versionId": "vrs_8d969eef...",
      "versionNumber": 3,
      "description": "fixed broken video on the lobby screen",
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

cursor-paginated with `page_size` max 100, default 25. `next_page_token` is an opaque server-signed blob — do not parse it. an empty string means no more pages.

### fetch one version

```http
GET /api/roosts/{roostId}/versions/{versionRef}
```

returns the denormalised header plus the full oci-shaped version body — the same json you uploaded, byte-for-byte (modulo `description`). use this to verify the digest, to rebuild a local mirror, or to drive diff tooling.

### per-version file list

```http
GET /api/roosts/{roostId}/versions/{versionRef}/files?prefix=assets/&page_size=100
```

paginated flat file list. avoids pulling the full version body when you only need filenames — useful for large versions (tens of thousands of files). `prefix` filters by path prefix.

### diff two versions

```http
GET /api/roosts/{roostId}/versions/{versionRef}/diff?against=v2
```

`against` accepts the same three ref forms as the path segment — stable id, number, or alias. a common shape:

```bash
# diff v3 against the current version
curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions/3/diff?against=current" "${AUTH[@]}"
```

file-level diff:

```json
{
  "fromVersion": "vrs_2c26b46b...",
  "fromVersionNumber": 2,
  "toVersion": "vrs_8d969eef...",
  "toVersionNumber": 3,
  "added":    [ { "path": "assets/new_logo.png", "digest": "sha256:...", "size": 524288 } ],
  "removed":  [ { "path": "assets/old_logo.png", "digest": "sha256:...", "size": 512 } ],
  "modified": [ { "path": "main.toe", "digestBefore": "sha256:...", "digestAfter": "sha256:...", "sizeBefore": 8192, "sizeAfter": 16384 } ]
}
```

a file is "modified" when the same `path` maps to a different chunk hash set between the two versions. this is what the dashboard's rollback preview shows before you confirm.

---

## 12. error codes

all version errors use rfc 7807 `application/problem+json` with stable `code` identifiers. see [errors.md](./errors.md) for the envelope shape and global error catalog.

| code | http | meaning | typical cause |
|---|---|---|---|
| `validation_failed` | 400 / 422 | the version body does not satisfy the schema — malformed path, wrong `schemaVersion`, `size` mismatch against `sum(chunks[].size)`, duplicate path, annotation over size cap, `mediaType` wrong, `description` over 500 chars, `versionRef` malformed. | client built an invalid payload. the `param` field names the offending path. |
| `chunk_not_found` | 400 | one or more chunks referenced by `files[].chunks[].hash` are not present in r2 for this site. | you forgot to upload a chunk, or the upload failed silently. re-run `POST /api/chunks/check` to find which digests are missing, upload them, and retry. see [chunks.md](./chunks.md). |
| `version_stale` | 409 | your publish was built against a parent that is no longer current; a concurrent publish got in first. | concurrent publisher moved the pointer between your read and your write. refetch `GET /api/roosts/{roostId}` and retry. |
| `precondition_failed` | 412 | `If-Match` or `expectedCurrentVersionId` does not match the roost's current pointer. | same root cause as `version_stale`, surfaced via http semantics when the caller opted in with `If-Match`. the response body includes `expected` and `actual`. |
| `version_not_found` | 404 | the roost does not exist, the caller has no read access to it, or the `{versionRef}` / `targetVersion` does not resolve to any version in this roost's history. | typo in ref, revoked scope, alias that has no target yet (`previous` on a fresh roost), or referencing a version from a different roost. |
| `conflict` | 409 | rollback would be a no-op (resolved target equals current), or was called without `targetVersion` on a roost with only one version published. | first publish has no prior to roll back to; omit the call or specify an explicit target once a second version exists. |
| `idempotency_key_mismatch` | 422 | the same `Idempotency-Key` was reused with a different request body hash. | regenerate the uuid when you change the payload. |
| `quota_exceeded` | 402 | publishing this version would push the site over its storage limit. | the `missing` chunks you were about to upload would exceed your plan cap. check `GET /api/sites/{siteId}/quota`. |

responses that pass through the public rate limiter include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers when counters are available. on 429 use `Retry-After`, not arbitrary backoff.

---

## see also

- [chunks.md](./chunks.md) — the data-plane primitives versions reference.
- [webhooks.md](./webhooks.md) — subscribe to `version.published` / `version.rolled_back` events.
- [errors.md](./errors.md) — global error code catalog and recovery guidance.
