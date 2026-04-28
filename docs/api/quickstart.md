# roost api quickstart

**Last updated**: 2026-04-22

end-to-end walkthrough for publishing a new roost from scratch using nothing but `curl`, `sha256sum`, and `jq`. the authoritative endpoint contract is `web/openapi.yaml`; this guide links to the current API docs where a topic has a dedicated page.

**what you'll do** — in about 30 minutes you'll:
1. mint an api key
2. create a roost
3. chunk a local directory
4. dedup-check hashes against r2
5. upload only what's missing
6. publish an oci version
7. watch the fleet roll out
8. (optionally) roll back in one call

everything is copy-pasteable. substitute the `export` values at the top of each block and go.

---

## prerequisites

before you start, confirm the following:

- **dashboard account** at `https://owlette.app` with at least one site containing at least one paired machine. if you don't have one yet see [setup/install-the-agent.md](../setup/install-the-agent.md) — it takes about 10 minutes.
- **site id** — grab it from the browser url on the dashboard (`owlette.app/dashboard/<siteId>`) or from the `site` dropdown. looks like `kiosk-fleet-01`.
- **machine id** — at least one paired machine, listed under `dashboard → machines`. looks like `machine-a7f3`.
- **local tooling** — `curl` ≥ 7.75, `jq` ≥ 1.6, `sha256sum` (linux/macos: `brew install coreutils` for `gsha256sum`, or use `shasum -a 256`). `uuidgen` is nice to have for idempotency keys; any uuidv4 generator works.
- **a directory of files to publish** — e.g. a touchdesigner project under `./my-project/`. the example below assumes about 50 mb of content, but anything from a few kb up works.

**shared env vars** — export these once; every step below uses them.

```bash
export ROOST_BASE="https://owlette.app"           # or https://dev.owlette.app
export ROOST_VERSION="2026-04-22"
export SITE_ID="kiosk-fleet-01"
export MACHINE_ID="machine-a7f3"
export PROJECT_DIR="./my-project"                 # local files to publish
```

---

## step 1: create an api key

api keys are minted from your user session (browser-authenticated), not from another api key. the simplest path is the dashboard (`settings → api keys → new key`), but for a fully-scripted flow you can also hit `POST /api/keys` from a browser devtools fetch after you log in.

request body for a `publisher`-scoped key on one site:

```bash
curl -fsS -X POST "$ROOST_BASE/api/keys" \
  -H "Content-Type: application/json" \
  -H "Cookie: $SESSION_COOKIE" \
  -d '{
    "name": "quickstart publisher",
    "environment": "live",
    "scopes": [
      { "resource": "site", "id": "kiosk-fleet-01", "permissions": ["read"] },
      { "resource": "roost", "id": "*", "permissions": ["read", "write", "deploy", "rollback"] }
    ],
    "ttlDays": 30
  }'
```

**response** (`201 Created`, raw `key` shown exactly once — copy it now):

```json
{
  "id": "key_01HXYZA7F3B2C1D0E9F8G7H6J5",
  "key": "owk_live_kB8n3pQrT5wXvZ2yA9cF1dG4hJ6mN8oL0sU",
  "name": "quickstart publisher",
  "environment": "live",
  "keyPrefix": "owk_live_kB8n3p",
  "expiresAt": "2026-05-22T15:30:00Z",
  "createdAt": "2026-04-22T15:30:00Z"
}
```

export it for the rest of this walkthrough:

```bash
export ROOST_TOKEN="owk_live_kB8n3pQrT5wXvZ2yA9cF1dG4hJ6mN8oL0sU"
```

from here on every request uses `Authorization: Bearer $ROOST_TOKEN` plus `Roost-Version: $ROOST_VERSION`. we'll wrap that in a tiny helper:

```bash
AUTH=(-H "Authorization: Bearer $ROOST_TOKEN" -H "Roost-Version: $ROOST_VERSION" -H "Content-Type: application/json")
```

see [authentication.md](./authentication.md) for API key auth and scope behavior.

---

## step 2: create a roost

a roost is a named, versioned bundle of files targeting one or more machines. create an empty one now; we'll populate it in step 8.

```bash
curl -fsS -X POST "$ROOST_BASE/api/roosts" \
  "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{
    \"siteId\": \"$SITE_ID\",
    \"name\": \"lobby-touchdesigner\",
    \"targets\": [\"$MACHINE_ID\"]
  }"
```

**response** (`201 Created`):

```json
{
  "id": "roost_lobby_td",
  "siteId": "kiosk-fleet-01",
  "name": "lobby-touchdesigner",
  "targets": ["machine-a7f3"],
  "currentVersionId": null,
  "previousVersionId": null,
  "totalSize": 0,
  "totalFiles": 0,
  "createdAt": "2026-04-22T15:30:00Z",
  "updatedAt": "2026-04-22T15:30:00Z"
}
```

capture the id:

```bash
export ROOST_ID="roost_lobby_td"
```

---

## step 3: chunk your files

roost content is addressed by sha-256 of each file's bytes. for v2 a chunk is one whole file (content-defined chunking is deferred to v3 per [project_roost.md](../../dev/active/project-distribution-v2/)). the script below walks `$PROJECT_DIR`, hashes every file, and emits a json array of `{path, hash, size, abs}` entries — exactly what every subsequent step needs.

```bash
chunk_project() {
  local dir="$1"
  find "$dir" -type f -print0 | while IFS= read -r -d '' f; do
    local rel hash size
    rel=$(realpath --relative-to="$dir" "$f")
    hash="sha256:$(sha256sum "$f" | awk '{print $1}')"
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    jq -n --arg path "$rel" --arg hash "$hash" --argjson size "$size" --arg abs "$f" \
      '{path: $path, hash: $hash, size: $size, abs: $abs}'
  done | jq -s '.'
}

chunk_project "$PROJECT_DIR" > chunks.json
cat chunks.json | jq '.[0:2]'   # peek at first two entries
```

example output (`chunks.json`):

```json
[
  {
    "path": "main.toe",
    "hash": "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6",
    "size": 16384,
    "abs": "./my-project/main.toe"
  },
  {
    "path": "assets/logo.png",
    "hash": "sha256:18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4",
    "size": 524288,
    "abs": "./my-project/assets/logo.png"
  }
]
```

**about chunk size**: if a single file exceeds 4 mib, split it client-side before hashing (the server caps individual chunk bytes at 4 mib). for most touchdesigner projects every `.toe`, `.tox`, `.mov`, and asset file is well under that.

---

## step 4: dedup check

ask the api which of these hashes it already has in this site's content-addressed store. identical files across roosts are stored once; only genuinely new bytes ever move.

```bash
HASHES=$(jq '[.[].hash]' chunks.json)

curl -fsS -X POST "$ROOST_BASE/api/chunks/check" \
  "${AUTH[@]}" \
  -d "{\"siteId\": \"$SITE_ID\", \"hashes\": $HASHES}" \
  > check.json

jq '.missing | length' check.json   # how many chunks we need to upload
```

**response** (`200 OK`):

```json
{
  "missing": [
    "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
    "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6"
  ]
}
```

on a brand-new roost every hash will be in `missing`. on a subsequent publish with small changes, `missing` will be a fraction of the total — that's the dedup payoff.

**batch limit**: 1000 hashes per call. for larger projects, split `HASHES` into windows of 1000 and union the `missing` arrays.

---

## step 5: mint upload urls

request 60-min signed r2 `PUT` urls for the missing subset only.

```bash
MISSING=$(jq '.missing' check.json)

curl -fsS -X POST "$ROOST_BASE/api/chunks/upload-urls" \
  "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"siteId\": \"$SITE_ID\", \"hashes\": $MISSING}" \
  > upload-urls.json

jq '.expiresAt' upload-urls.json
```

**response** (`200 OK`):

```json
{
  "urls": {
    "sha256:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce": "https://owlette-prod.r2.cloudflarestorage.com/project-content/kiosk-fleet-01/4e/4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...",
    "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6": "https://owlette-prod.r2.cloudflarestorage.com/project-content/kiosk-fleet-01/2e/2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=..."
  },
  "expiresAt": "2026-04-22T16:30:00Z"
}
```

finish step 6 before the urls expire (you have 60 minutes).

---

## step 6: upload chunks

`PUT` each missing chunk's bytes directly to its r2 signed url. the api server never sees the data plane — bytes go client-to-r2.

```bash
jq -r '.missing[]' check.json | while read -r H; do
  URL=$(jq -r --arg h "$H" '.urls[$h]' upload-urls.json)
  ABS=$(jq -r --arg h "$H" '.[] | select(.hash==$h) | .abs' chunks.json)
  echo "uploading $H ($(stat -c%s "$ABS" 2>/dev/null || stat -f%z "$ABS") bytes)"
  curl -fsS -X PUT "$URL" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$ABS"
done
```

each `PUT` returns `200 OK` with an empty body and an `ETag` header. if any upload fails, rerun step 5 (idempotent with the same `Idempotency-Key`) to get a fresh url, then retry that single chunk. r2 verifies the sha-256 server-side; a byte-mangled upload is rejected with `400 BadDigest`.

**parallelism**: the sequential loop above is easy to read but slow. for big publishes, pipe into `xargs -P 8` or use `GNU parallel` to run 8–16 uploads concurrently — r2 scales linearly with that.

---

## step 7: build the version

a roost version is an oci-shaped json document: `config` (arbitrary roost metadata) + `files` (one per file). it's the immutable snapshot the fleet downloads.

```bash
# config blob — describes the roost itself
CONFIG_JSON=$(jq -n --arg site "$SITE_ID" --arg roost "$ROOST_ID" \
  '{siteId: $site, roostId: $roost, publishedBy: "quickstart", createdAt: (now | todate)}')
CONFIG_BYTES=${#CONFIG_JSON}
CONFIG_DIGEST="sha256:$(printf '%s' "$CONFIG_JSON" | sha256sum | awk '{print $1}')"

# files - one entry per file, in canonical path order
FILES=$(jq '[.[] | {path: .path, chunks: [{hash: .hash, size: .size}], size: .size}] | sort_by(.path)' chunks.json)

# assemble
cat > version-body.json <<EOF
{
  "siteId": "$SITE_ID",
  "version": {
    "schemaVersion": 2,
    "mediaType": "application/vnd.owlette.version.v1+json",
    "config": {
      "mediaType": "application/vnd.owlette.roost.config.v1+json",
      "digest": "$CONFIG_DIGEST",
      "size": $CONFIG_BYTES
    },
    "files": $FILES
  },
  "description": "initial publish from quickstart"
}
EOF

jq '.version.files | length' version-body.json   # sanity check
```

notes:
- **first publish** — omit `expectedCurrentVersionId` (no prior version). for subsequent publishes, include `"expectedCurrentVersionId": "<previous id>"` or send `If-Match` as a header (cas).
- **path order matters** for a deterministic digest — always sort by `path`. two identical file sets must produce the same version digest.
- the config blob is authoritative metadata — put anything you want the agent to know there (e.g. `renderJob`, `buildCommit`). its bytes aren't uploaded separately in v2; the version embeds everything it references.
- `description` is optional plaintext (≤500 chars) shown in the version-history ui.

---

## step 8: publish the version

`POST /api/roosts/{id}/versions` validates every referenced chunk digest against r2 (so unreferenced chunks aren't allowed), assigns the version its own id, flips `currentVersionId`, and triggers fan-out to all targets. the server atomically mints a `versionNumber` (auto-incrementing integer, 1-indexed per roost) in the same transaction.

```bash
VERSION_RESP=$(curl -fsS -X POST "$ROOST_BASE/api/roosts/$ROOST_ID/versions" \
  "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d @version-body.json)
echo "$VERSION_RESP" | jq '.'
export VERSION_ID=$(echo "$VERSION_RESP" | jq -r '.versionId')
export VERSION_NUMBER=$(echo "$VERSION_RESP" | jq -r '.versionNumber')
```

**response** (`201 Created`):

```json
{
  "versionId": "vrs_8d969eef6ecad3c29a3a629280e686cf",
  "versionNumber": 1,
  "currentVersionId": "vrs_8d969eef6ecad3c29a3a629280e686cf",
  "previousVersionId": null,
  "publishedAt": "2026-04-22T15:30:00Z"
}
```

the `Idempotency-Key` makes it safe to rerun this exact call — same key + same body replays the cached response for 24 hours. same key + different body returns `409 idempotency_key_mismatch`.

fan-out to every machine in `roost.targets` starts automatically. if you need targeted rollout (canary, subset of targets, or dry-run), call `POST /api/roosts/{id}/deploy` instead; the authoritative route contract is `web/openapi.yaml`.

the api returns a `rolloutId` via the implicit deployment triggered by the publish — fetch it with:

```bash
ROLLOUT_ID=$(curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/deployments?page_size=1" \
  "${AUTH[@]}" | jq -r '.items[0].rolloutId')
echo "rollout: $ROLLOUT_ID"
```

---

## step 9: verify deployment

poll the rollout until every machine reports the new version. the endpoint returns per-machine state; we loop until the aggregate `state` is terminal.

```bash
DEADLINE=$(( $(date +%s) + 600 ))   # 10-minute timeout
while (( $(date +%s) < DEADLINE )); do
  RES=$(curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/deployments/$ROLLOUT_ID" "${AUTH[@]}")
  STATE=$(echo "$RES" | jq -r '.state')
  PROGRESS=$(echo "$RES" | jq -r '[.machines[] | "\(.machineId):\(.state)"] | join(" ")')
  echo "state=$STATE  $PROGRESS"
  [[ "$STATE" == "succeeded" || "$STATE" == "failed" ]] && break
  sleep 10
done

[[ "$STATE" == "succeeded" ]] && echo "rollout complete" || { echo "rollout ended: $STATE"; exit 1; }
```

**typical output**:

```
state=in_progress  machine-a7f3:in_progress
state=in_progress  machine-a7f3:in_progress
state=succeeded    machine-a7f3:succeeded
rollout complete
```

**interpreting per-machine state**:
- `queued` — agent hasn't picked up the version yet (next heartbeat, up to 30s)
- `in_progress` — agent is downloading missing chunks
- `succeeded` — version applied; new files are live on disk
- `failed` — check `.machines[].error` for details (usually disk full, offline mid-sync, or a chunk verification mismatch)

in a healthy fleet, a 50 mb publish to an already-warm machine completes in under a minute. a 2 gb cold publish to a fresh machine takes 2–10 minutes depending on link speed.

---

## step 10: rollback (optional)

every version flip is atomic. to revert to the prior version — e.g. qa spots a regression thirty seconds after step 9 — one call does it.

```bash
curl -fsS -X POST "$ROOST_BASE/api/roosts/$ROOST_ID/rollback" \
  "${AUTH[@]}" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "If-Match: \"$VERSION_ID\"" \
  -d "{\"siteId\": \"$SITE_ID\"}"
```

**response** (`200 OK`):

```json
{
  "currentVersionId": "vrs_2c26b46b68ffc68ff99b453c1d304134",
  "previousVersionId": "vrs_8d969eef6ecad3c29a3a629280e686cf",
  "rolledBackAt": "2026-04-22T15:35:00Z",
  "rolloutId": "rollout_01HYA8K3R2N7P9Q1S5T6U8V0W3"
}
```

omitting `targetVersion` flips to `previousVersionId`. to roll back further, pass `targetVersion` explicitly — it accepts `string | number` (a positive integer like `3`, `"#3"` / `"v3"` shorthand, a `vrs_*` id, or the aliases `"current"` / `"previous"` / `"first"`). the server resolves the ref and verifies it exists in the roost's version history (browse with `GET /api/roosts/$ROOST_ID/versions`).

the `If-Match` header guards against a second publisher flipping the pointer between your verify and your rollback — if it doesn't match the current head, you get `412 precondition_failed` and a body containing the real `currentVersionId` to reconcile.

since there's no rollback-from-rollback concept, rolling back when `previousVersionId` is `null` returns `409 conflict` with code `no_previous_version`. publish a fresh corrected version instead.

the rollback itself fans out on the same machinery as step 9; poll the returned `rolloutId` the same way.

---

## troubleshooting

common errors you'll hit during the walkthrough, with resolution.

### `401 auth_required` / `401 token_expired`

- **cause** — missing `Authorization` header, malformed token, or key revoked/expired.
- **fix** — confirm `ROOST_TOKEN` starts with `owk_live_` or `owk_test_`. if expired, mint a new one via step 1.

### `403 scope_insufficient`

- **cause** — your key doesn't have the permission the endpoint requires. e.g. a `roost:*:read` key can't publish.
- **response body** (`application/problem+json`):
  ```json
  { "code": "scope_insufficient", "detail": "key lacks roost:roost_lobby_td:write", "requiredScope": "roost:roost_lobby_td:write" }
  ```
- **fix** — mint a new key with the scope from `requiredScope`, or patch an existing one via `POST /api/keys/{id}/rotate` after narrowing its scopes. see the auth and scope notes in `web/openapi.yaml`.

### `412 precondition_failed` (publish or rollback)

- **cause** — `expectedCurrentVersionId` / `If-Match` doesn't match the roost's actual head. someone else published between your `GET` and your `POST`.
- **response body**:
  ```json
  { "code": "precondition_failed", "currentVersionId": "vrs_<actual>" }
  ```
- **fix** — refetch `GET /api/roosts/$ROOST_ID`, rebuild your version against the new head (in case files changed on the other side), retry with the correct `expectedCurrentVersionId`.

### `402 quota_exceeded`

- **cause** — your site hit its storage or bandwidth limit.
- **response body**:
  ```json
  { "code": "quota_exceeded", "detail": "site kiosk-fleet-01 at 100% of pro tier storage", "quotaUrl": "/api/sites/kiosk-fleet-01/quota" }
  ```
- **fix** — inspect `GET /api/sites/$SITE_ID/quota` to confirm what's full (storage vs bandwidth). either upgrade tier in the dashboard, delete unused roosts (chunks become gc-eligible 30 days later), or wait for the monthly bandwidth reset (`periodResetsAt` in the quota response).

### `409 idempotency_key_mismatch`

- **cause** — you reused an `Idempotency-Key` across two requests with different bodies (within the 24h window).
- **fix** — generate a new key (`uuidgen`) for genuinely new requests; keep the same key only for retries of the exact same request.

### `404 not_found` on publish

- **cause** — a file digest in your version has no corresponding chunk in r2. usually means a missed step 5/6 upload, or an orphaned hash that got gc'd before publish.
- **fix** — rerun step 4 (dedup check) — the problem chunks will show up in `missing`. upload them (step 5/6) and republish.

### `429 rate_limited`

- **cause** — you exceeded the key's request budget.
- **response headers** — `RateLimit-Remaining: 0`, `Retry-After: 12`.
- **fix** — sleep `Retry-After` seconds, then retry. for scripts doing many parallel calls, throttle by watching `RateLimit-Remaining` — back off when it drops below 10% of `RateLimit-Limit`. publisher keys get a higher budget than read-only keys.

### upload to r2 returns `403 SignatureDoesNotMatch`

- **cause** — the signed url expired (60-min ttl from step 5), or the `Content-Type` header doesn't match what was signed.
- **fix** — rerun step 5 for a fresh url. always send `Content-Type: application/octet-stream` on the `PUT`; r2 rejects any other value.

### upload to r2 returns `400 BadDigest`

- **cause** — the bytes you uploaded don't match the sha-256 in the url path. file changed between step 3 and step 6, or you swapped the hash→file mapping.
- **fix** — re-hash the file in step 3, regenerate `chunks.json`, then rerun step 4 onward. idempotency keys on `upload-urls` mean you won't leak new signed urls on retries.

---

## next steps

- **automate the flow** - adapt the curl steps above into your CI runner with a scoped API key and per-publish `Idempotency-Key`.
- **diff two versions** — before rolling out a big change, call `GET /api/roosts/{id}/versions/{versionRef}/diff?against=<prior>` to see exactly which files change.
- **subscribe to events** - `POST /api/webhooks?siteId=<id>` manages subscriptions; use `POST /api/webhooks/probe?siteId=<id>` while production dispatch is deferred. see [webhooks.md](./webhooks.md).
- **ask Cortex** — `POST /api/cortex/conversations` starts a site or machine conversation; see [cortex.md](./cortex.md) for streaming message examples and scope notes.
- **targeted rollouts** - `POST /api/roosts/{id}/deploy` supports canary strategy, scheduled rollouts, and dry-run.
- **audit compliance** — `GET /api/sites/{id}/audit-log` gives you a tamper-evident chain of every sensitive action.
