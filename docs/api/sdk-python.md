# sdk — python

**Last updated**: 2026-04-28
**Package**: [`owlette-sdk`](https://pypi.org/project/owlette-sdk/) · python ≥ 3.10 · single runtime dep on `httpx`

the official async python sdk for the [roost api](./overview.md). `async`-first (built on `httpx.AsyncClient`), typed with dataclasses + `py.typed` marker, and behaviour-compatible with [`@owlette/sdk`](./sdk-node.md): the resource tree, progress events, error codes, and signature scheme match, with pythonic `snake_case` method names.

---

## installation

```bash
pip install owlette-sdk
# or: poetry add owlette-sdk
# or: uv pip install owlette-sdk
```

python 3.10+ is required (async iterator + `match` + pep 604 unions). the package has one runtime dependency: `httpx>=0.27`.

---

## hello world (< 10 lines)

```python
import asyncio, os
from roost import Roost, PushOptions

async def main():
    async with Roost(token=os.environ["ROOST_TOKEN"]) as client:
        identity = await client.account.whoami()
        site_id = identity.primary_site_id or "kiosk-fleet-01"
        result = await client.roosts.push(
            "./dist", "rst_abc",
            PushOptions(site_id=site_id, description="initial publish"),
        )
        print(f"published v{result.version_number}", result.version_id, "—", result.stats.uploaded_chunks, "chunks uploaded")

asyncio.run(main())
```

that's the whole flow: walk `./dist`, sha-256 chunk it, dedup-check against r2, upload what's missing, publish a version, return the new id + `version_number`.

For a complete script that verifies identity, API version, site/roost access,
publish, and optional deploy, run `sdks/python/examples/run_roost_workflow.py`.

---

## authentication

every request needs an `owk_live_*` or `owk_test_*` key. mint one from the dashboard (`settings -> api keys -> new key`) or via the account key route. pass it to the constructor; the sdk never touches the filesystem.

```python
from roost import Roost, RetryPolicy

async with Roost(
    token=os.environ["ROOST_TOKEN"],         # required — owk_live_* or owk_test_*
    api_url="https://owlette.app",           # default
    environment="live",                      # optional — "live" | "test" metadata
    roost_version="2026-04-22",              # default — sent as Roost-Version header
    retry=RetryPolicy(max_attempts=5),       # optional
    timeout=30.0,                            # httpx timeout seconds (default 30)
) as client:
    ...
```

**scope enforcement is server-side.** the sdk does not validate scopes locally — an over-broad call raises `RoostApiError` with `code="scope_insufficient"`. see [authentication.md](./authentication.md) for the full scope grammar.

the sdk auto-generates an `Idempotency-Key` header on every mutating request (`POST` / `PATCH` / `PUT`) unless you pass one explicitly. transparent retries can't create duplicate rollouts, roosts, or keys.

**always use `async with`**. the `Roost` context manager owns the underlying `httpx.AsyncClient` connection pool — exiting the block calls `close()` and releases the pool. forgetting this leaks file descriptors and slows teardown.

---

## resources

every top-level noun is a resource class hung off the client. all methods are `async` and coroutine-returning — `await` every call.

| resource             | methods                                                                                            |
|----------------------|----------------------------------------------------------------------------------------------------|
| `client.account`     | `whoami`, `version`, `api_keys.list`, `api_keys.create`, `api_keys.revoke`                         |
| `client.roosts`      | `list`, `list_page`, `get`, `create`, `patch`, `remove`, `push`, `rollback`, `deploy`              |
| `client.chunks`      | `check`, `upload_urls`, `download_urls`, `mount`, `referrers`                                      |
| `client.versions`    | `list`, `list_page`, `get`, `patch`, `files`, `diff`                                               |
| `client.deployments` | `list`, `list_page`, `get`                                                                         |
| `client.keys`        | legacy session/ID-token key admin: `create`, `list`, `rotate`, `revoke`                            |
| `client.webhooks`    | `subscribe`, `list`, `get`, `update`, `remove`, `rotate_secret`, `probe`                           |
| `client.sites`       | `list`, `get`                                                                                      |
| `client.machines`    | `list`, `get`, `deployments`, `dispatch_command`, `get_command`, `capture_screenshot`              |
| `client.installer_deployments` | `list`, `get`, `create`, `retry`, `cancel`, `uninstall`, `delete`                         |
| `client.installer`   | `list`, `latest`, `upload`, `set_latest`, `delete`                                                 |
| `client.processes(site_id, machine_id)` | `list`, `create`, `update`, `start`, `stop`, `restart`, `schedule`, `remove`    |
| `client.chat`        | `new`, `list`, `send`, `rename`, `delete`                                                          |
| `client.users`       | `list`, `get`, `promote`, `demote`, `assign_sites`, `remove_sites`, `delete`                       |
| `client.members(site_id)` | `list`, `add`, `remove`                                                                       |
| `client.quotas`      | `current`, `history`                                                                               |
| `client.http`        | raw low-level `RoostClient` — escape hatch for unmapped endpoints                                  |

**paging idiom.** `client.roosts.list()`, `client.versions.list()`, `client.deployments.list()`, `client.versions.files()`, and `client.chunks.referrers()` are async generators that transparently follow `nextPageToken` / `next_page_token`. use `list_page()` on roosts, versions, and deployments when you need explicit control. other resources return a list or a page envelope matching their route.

### account

```python
identity = await client.account.whoami()
print(identity.email or identity.user_id, identity.key.key_prefix if identity.key else None)

api_version = await client.account.version()
print(api_version.current, api_version.supported)

# API-key-compatible key management. New keys inherit the caller's allowed
# scopes, so an API-key caller cannot widen its own privileges.
created = await client.account.api_keys.create(name="preview publisher")
keys = await client.account.api_keys.list()
await client.account.api_keys.revoke(created["keyId"])
```

### roosts

```python
# list — async generator, transparent paging
async for r in client.roosts.list(site_id="site-1"):
    print(r.roost_id, r.name, r.current_version_id)

# single page explicitly (for resumable batch jobs)
rows, cursor = await client.roosts.list_page(site_id="site-1", page_size=20)
if cursor:
    rows2, _ = await client.roosts.list_page(site_id="site-1", cursor=cursor)

# fetch one — returns RoostDetail with current_version (object, not id)
r = await client.roosts.get("rst_abc", site_id="site-1")
print(r.current_version.version_id if r.current_version else None)

# create
created = await client.roosts.create(
    site_id="site-1",
    name="lobby touchdesigner",
    targets=["machine-a7f3"],                # machine ids
    extract_path=r"C:\Projects\lobby",       # optional
    roost_id="rst_lobby_td",                 # optional — server generates if omitted
)

# patch (rename, retarget)
await client.roosts.patch("rst_lobby_td", site_id="site-1", name="lobby (v2)")

# soft-delete (undo by re-creating with same id within 30 days)
await client.roosts.remove("rst_lobby_td", site_id="site-1")

# publish from a directory — the flagship call
from roost import PushOptions
result = await client.roosts.push(
    "./dist", "rst_abc",
    PushOptions(
        site_id="site-1",
        description="fixed broken lobby video",   # optional ≤500 chars
        on_progress=print,
    ),
)

# rollback — `target_version` accepts str | int:
#   int / "#3" / "v3"        → the third publish for this roost
#   "vrs_..."                → a stable version id
#   "current" / "previous" / "first" → aliases resolved server-side
# omit it entirely to revert one step (equivalent to "previous").
from roost import RollbackOptions
await client.roosts.rollback(
    "rst_abc",
    RollbackOptions(site_id="site-1", target_version=3),
)

# trigger a deployment (targeted / scheduled / dry-run)
from roost import DeployOptions
deploy = await client.roosts.deploy(
    "rst_abc",
    DeployOptions(
        site_id="site-1",
        machines=["machine-a7f3"],           # subset of targets — or None for the full target list
        schedule_at="2026-04-25T03:00:00Z",  # optional — iso-8601 utc
        dry_run=False,
    ),
)
```

### cortex

```python
conversation = await client.chat.new(
    site_id="site-1",
    machine_id="machine-a7f3",
    title="diagnostics",
)

page = await client.chat.list(site_id="site-1", page_size=10)

async for delta in client.chat.send(
    conversation["conversationId"],
    "summarize machine health",
):
    print(delta, end="", flush=True)
```

The SDK uses canonical `/api/cortex/conversations` routes. API-key callers are capped to read-only Cortex tools during streamed replies.

### chunks — low-level data plane

most users never touch these; `roosts.push()` is the high-level wrapper. when you need raw control (network shares, custom uploaders, reuse across roosts):

```python
# dedup-check — returns the list of hashes that r2 is missing
missing = await client.chunks.check(site_id="site-1", hashes=["sha256:ab12...", "sha256:cd34..."])

# mint signed r2 put urls (60 min ttl)
payload = await client.chunks.upload_urls(site_id="site-1", hashes=missing)
async with httpx.AsyncClient() as http:
    for item in payload.get("uploads", []):
        await http.put(item["url"], content=await chunk_bytes(item["hash"]))

# mint signed r2 get urls (15 min ttl)
downloads = await client.chunks.download_urls(site_id="site-1", hashes=["sha256:ab12..."])

# mount an existing chunk into a different roost (no re-upload)
await client.chunks.mount(
    "sha256:ab12...", site_id="site-1", from_roost="rst_a", to_roost="rst_b",
)

# which roosts reference this chunk?
async for ref in client.chunks.referrers("sha256:ab12...", site_id="site-1"):
    print(ref["roostId"], ref["versionId"])
```

### versions

```python
# list (async gen, transparent paging, newest first)
async for v in client.versions.list("rst_abc", site_id="site-1"):
    print(f'v{v["versionNumber"]}', v["versionId"], v.get("description"), v["createdAt"])

# full version doc — `version_ref` accepts the same forms as rollback's target_version:
#   an int (3), "#3" / "v3", a "vrs_*" id, or "current" / "previous" / "first"
v = await client.versions.get("rst_abc", "current", site_id="site-1")

# edit the description only (everything else on a published version is immutable)
await client.versions.patch(
    "rst_abc", v["versionId"],
    site_id="site-1", description="updated release notes",
)

# file listing (async gen)
async for f in client.versions.files("rst_abc", 3, site_id="site-1"):
    print(f["path"], f["digest"], f["size"])

# diff two versions — `against` is the baseline; both sides accept any versionRef form
diff = await client.versions.diff(
    "rst_abc",
    "current",
    site_id="site-1",
    against="previous",
)
```

### keys

```python
from roost import ApiKeyScope

# legacy scoped key creation requires a session or Firebase ID token.
# API-key callers should prefer client.account.api_keys.
created = await client.keys.create(
    name="ci publisher",
    environment="live",
    scopes=[
        ApiKeyScope(resource="site",  id="site-1", permissions=["read"]),
        ApiKeyScope(resource="roost", id="*",      permissions=["read", "write", "deploy"]),
    ],
    ttl_days=90,
)
print(created["key"])                         # owk_live_...  <-- once

# list returns typed ApiKeyRecord values
for k in await client.keys.list():
    print(k.id, k.key_prefix, k.environment)

# rotate (24h grace) + revoke
await client.keys.rotate(created["id"], ttl_days=90)
await client.keys.revoke(created["id"])
```

### sites / machines / quotas

```python
sites = await client.sites.list()            # list[Site]
for s in sites:
    print(s.id, s.name)
site = await client.sites.get("site-1")

machines = await client.machines.list("site-1")
for m in machines:
    print(m.id, m.online, m.last_heartbeat)

machine = await client.machines.get("site-1", "machine-a7f3")
deploys = await client.machines.deployments("site-1", "machine-a7f3")

quota = await client.quotas.current("site-1")
print(quota.storage_bytes_used, "/", quota.storage_bytes_limit)

history = await client.quotas.history("site-1", days=30)
```

### webhooks

```python
# subscribe — the signing secret is returned ONCE as response["signingSecret"]
hook = await client.webhooks.subscribe(
    site_id="site-1",
    url="https://example.com/hooks/roost",
    events=["version.published", "deployment.failed"],
)
print(hook["signingSecret"])

# list returns typed WebhookSubscription values
for h in await client.webhooks.list(site_id="site-1"):
    print(h.id, h.url, h.events)

await client.webhooks.update(hook["id"], site_id="site-1", events=["version.published"])
await client.webhooks.rotate_secret(hook["id"], site_id="site-1")
deliveries = await client.webhooks.deliveries(hook["id"], "site-1")
if deliveries["deliveries"]:
    first = deliveries["deliveries"][0]
    await client.webhooks.delivery(hook["id"], first["id"], "site-1")
    await client.webhooks.retry_delivery(hook["id"], first["id"], "site-1")
await client.webhooks.remove(hook["id"], site_id="site-1")

# probe fires a signed test delivery
await client.webhooks.probe(
    "site-1",
    "version.published",
    url="https://example.com/hooks/roost",
    payload={"roostId": "rst_abc", "versionId": "vrs_xyz", "versionNumber": 7},
)
```

---

## push progress

`client.roosts.push()` accepts an `on_progress` callback (sync or async) and invokes it once per phase transition plus on every chunk upload.

```python
from roost import PushOptions, PushProgressEvent

async def handle(evt: PushProgressEvent) -> None:
    if evt.phase == "discover":
        print(f"found {evt.file_count} files ({evt.total_bytes} bytes)")
    elif evt.phase == "hash":
        print(f"hashing {evt.file} ({evt.files_done}/{evt.files_total})")
    elif evt.phase == "check-missing":
        print(f"{evt.missing} of {evt.total} chunks need upload")
    elif evt.phase == "upload":
        print(f"{evt.uploaded}/{evt.total} chunks uploaded")
    elif evt.phase == "publish":
        print(f"publishing version (attempt {evt.attempt})")

await client.roosts.push(
    "./dist", "rst_abc",
    PushOptions(site_id="site-1", on_progress=handle),
)
```

both plain `def` and `async def` callbacks work — the sdk auto-detects and awaits the latter. keep handlers cheap; they run inside the upload tight-loop.

### push options

```python
@dataclass(slots=True)
class PushOptions:
    site_id: str
    name: str | None = None                  # optional — overrides the roost's current name
    targets: list[str] | None = None         # optional — machine ids to retarget to on publish
    extract_path: str | None = None          # optional — on-disk extract root for the roost
    description: str | None = None           # optional — plaintext ≤500 chars, stored on the version doc
    on_progress: Callable[[PushProgressEvent], None] | Callable[[...], Awaitable[None]] | None = None
    ignore: Sequence[str] = ()               # extra glob patterns to skip during the file walk
```

pass either a sync or async `on_progress`; the sdk auto-detects and awaits the latter.

**retry on concurrent publish (412).** if another writer publishes between your `push()` starting and the version post, the sdk retries the final publish with the server-reported current version before raising `RoostApiError`. chunk uploads never re-run; they're content-addressed.

---

## webhook signature verification

roost signs every webhook with `Roost-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>`. the sdk ships a verifier that enforces a 5-minute replay window and uses `hmac.compare_digest`:

```python
from fastapi import Request, HTTPException
from roost import verify_signature, is_signature_valid

@app.post("/hooks/roost")
async def webhook(request: Request):
    raw = await request.body()               # MUST be raw bytes, not parsed json
    sig = request.headers.get("roost-signature")
    result = verify_signature(sig, raw, secret=os.environ["WEBHOOK_SECRET"])
    if not result.ok:
        # result.reason: "missing_header" | "malformed" | "outside_tolerance" | "bad_signature"
        raise HTTPException(status_code=401, detail=result.reason)
    return await handle_event(result.event)

# boolean shortcut for quick paths
if not is_signature_valid(sig, raw, secret):
    raise HTTPException(401)
```

**tolerance window** defaults to 300 seconds; override via `verify_signature(..., tolerance_seconds=600)`. more than 15 minutes is almost always a bug — either your clock is wrong or you're replaying.

### signing outbound (for tests)

```python
from roost import sign_body

sig = sign_body(b'{"event":"version.published"}', secret="whsec_...")
# → 't=1735689600,v1=ab12...'
```

### frameworks

| framework    | raw-body access                                                              |
|--------------|------------------------------------------------------------------------------|
| fastapi      | `await request.body()` (shown above)                                         |
| flask        | `request.get_data()` — set `app.config['REQUEST_BODY_PRESERVE'] = True`      |
| django       | `request.body` (bytes, already raw)                                          |
| aiohttp      | `await request.read()`                                                       |
| starlette    | `await request.body()`                                                       |

never pass parsed json — json stringification is not byte-stable across libraries, and the hmac will not match.

---

## errors

every non-2xx response raises `RoostApiError` with structured fields pulled from the rfc 7807 problem+json body:

```python
from roost import RoostApiError

try:
    await client.roosts.get("rst_missing", site_id="site-1")
except RoostApiError as err:
    print(err.status)               # 404
    print(err.code)                 # "roost_not_found" — stable, machine-readable
    print(err.request_id)           # for support tickets
    print(err.problem)              # full problem+json dict
    print(err.problem.get("doc_url"))  # link to errors.md#<code>
    raise
```

the sdk auto-retries `429` and `5xx` with exponential backoff + jitter, honoring the problem's `retry_after` seconds field and the `Retry-After` header when present. `401`, `403`, `404`, `412`, `422`, and other 4xxs bubble immediately — retrying them will never succeed.

**common codes** you'll hit early (full list: [errors.md](./errors.md)):

| code                       | status | when it fires                                                          |
|----------------------------|--------|------------------------------------------------------------------------|
| `scope_insufficient`       | 403    | api key doesn't carry the resource+permission for this call            |
| `token_expired`            | 401    | key hit its `expires_at` — rotate or mint a new one                    |
| `idempotency_key_mismatch` | 409    | same key replayed with a different body                                |
| `version_stale`            | 412    | someone else published between your read and write — re-push           |
| `version_not_found`        | 404    | `target_version` / `version_ref` didn't resolve against the roost      |
| `rate_limited`             | 429    | see `retry_after` — the sdk already honors it                          |
| `unsupported_version`      | 400    | `roost_version` older than the minimum — update this package           |

---

## cancellation

wrap any call in `asyncio.timeout()` or `asyncio.wait_for()` — the underlying `httpx.AsyncClient` respects python's cancellation protocol and raises `CancelledError` through the await chain:

```python
async with asyncio.timeout(30):
    rows = [r async for r in client.roosts.list(site_id="site-1")]
```

for `push()`, raising any exception inside the `on_progress` callback stops the upload queue — in-flight PUTs complete, pending ones are dropped, and the coroutine re-raises your exception.

---

## typing

the package ships a `py.typed` marker; mypy strict mode + pyright both resolve every public export. core workflow request/response shapes are typed dataclasses, while a few admin/debug endpoints intentionally return raw response envelopes.

```python
from roost import (
    RoostSummary, RoostDetail, VersionSummary,
    PushOptions, PushProgressEvent, PushResult,
    ApiKeyScope, WebhookSubscription,
)
```

---

## custom transport (proxy / mtls / tracing)

pass an `httpx.AsyncBaseTransport` for proxies, client-cert auth, distributed tracing, or deterministic test mocks:

```python
import httpx
from roost import Roost

transport = httpx.AsyncHTTPTransport(
    proxy="http://corp-proxy.example.com:3128",
    verify="/path/to/ca-bundle.pem",
)
async with Roost(token=..., transport=transport) as client:
    ...
```

for unit tests, use `httpx.MockTransport` to assert request shape without a network:

```python
def handler(request: httpx.Request) -> httpx.Response:
    assert request.url.path == "/api/sites"
    assert request.headers["authorization"].startswith("Bearer owk_")
    return httpx.Response(200, json={"sites": []})

async with Roost(token="owk_test_...", transport=httpx.MockTransport(handler)) as client:
    assert (await client.sites.list()) == []
```

---

## next steps

- **[quickstart](./quickstart.md)** — the same flow in `curl`, useful for debugging or shell pipelines.
- **[authentication](./authentication.md)** — scope grammar, presets, rotation, revocation.
- **[webhooks](./webhooks.md)** — event catalog, retry model, signing secret lifecycle.
- **[sdk workflow examples](./examples/sdk-workflows.md)** — executable Node/Python samples and dev fixture env.
- **[examples/nightly-sync.md](./examples/nightly-sync.md)** — a realistic async batch job.
- **[node sdk](./sdk-node.md)** — typescript, same resource tree, same error codes.

the reference openapi spec is at [`web/openapi.yaml`](../../web/openapi.yaml). for endpoints not yet wrapped by a high-level helper, use `client.http.request(...)`.
