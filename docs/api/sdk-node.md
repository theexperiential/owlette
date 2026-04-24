# sdk — node / typescript

**Last updated**: 2026-04-24
**Package**: [`@owlette/roost`](https://www.npmjs.com/package/@owlette/roost) · node ≥ 20 · zero runtime deps

the official typescript sdk for the [roost api](./overview.md). wraps the rest surface with a typed resource tree, auto-retry, automatic `Idempotency-Key`, chunk-aware `push()`, stripe-style webhook verification, and progress events. if you can use `fetch` directly you can use this — it just adds the tedious bits.

---

## installation

```bash
npm install @owlette/roost
# or: pnpm add @owlette/roost
# or: yarn add @owlette/roost
```

the package ships `.js` + `.d.ts` for both esm and cjs. no native modules; no wasm; no postinstall script.

---

## hello world (< 10 lines)

```ts
import { Roost } from '@owlette/roost';

const roost = new Roost({ token: process.env.ROOST_TOKEN! });
const result = await roost.roosts.push('./dist', 'rst_abc', { siteId: 'kiosk-fleet-01' });
console.log('published', result.manifestId, '—', result.stats.uploadedChunks, 'chunks uploaded');
```

that's the whole flow: walk `./dist`, sha-256 chunk it, dedup-check against r2, upload what's missing, publish a manifest, return the new id.

---

## authentication

every request needs an `owk_live_*` or `owk_test_*` key. mint one from the dashboard (`settings → api keys → new key`) or via [`POST /api/keys`](./authentication.md#creating-a-key). the sdk reads the token from the constructor — it never touches the filesystem.

```ts
const roost = new Roost({
  token: process.env.ROOST_TOKEN!,     // required — owk_live_* or owk_test_*
  apiUrl: 'https://owlette.app',       // default
  environment: 'live',                 // optional — 'live' | 'test' (defaults from token prefix)
  roostVersion: '2026-04-22',          // default — sent as Roost-Version header
  retry: { maxAttempts: 5 },           // optional — overrides default policy
  fetch: customFetch,                  // optional — drop-in proxy / mtls / tracing wrapper
});
```

**scope enforcement is server-side.** the sdk does not validate scopes locally — an over-broad call fails with `RoostApiError.code === 'scope_insufficient'`. see [authentication.md](./authentication.md) for the full scope grammar.

the sdk auto-generates an `Idempotency-Key` header on every mutating request (POST / PATCH / PUT) unless you pass one explicitly. transparent retries can't create duplicate rollouts, roosts, or keys. see [rate-limits.md](./rate-limits.md#idempotency) for the replay window.

---

## resources

every top-level noun is a resource class hung off the client.

| resource             | methods                                                                                         |
|----------------------|-------------------------------------------------------------------------------------------------|
| `roost.roosts`       | `list`, `get`, `create`, `patch`, `remove`, `push`, `rollback`, `deploy`                        |
| `roost.chunks`       | `check`, `uploadUrls`, `downloadUrls`, `mount`, `referrers`                                     |
| `roost.manifests`    | `list`, `get`, `files`, `diff`                                                                  |
| `roost.deployments`  | `list`, `get`                                                                                   |
| `roost.keys`         | `create`, `list`, `rotate`, `revoke`                                                            |
| `roost.webhooks`     | `subscribe`, `list`, `get`, `update`, `remove`, `rotateSecret`, `probe`                         |
| `roost.sites`        | `list`, `get`                                                                                   |
| `roost.machines`     | `list`, `get`, `deployments`                                                                    |
| `roost.quotas`       | `current`, `history`                                                                            |
| `roost.events`       | `verifySignature`, `isSignatureValid`, `signBody`                                               |
| `roost.http`         | raw low-level client — escape hatch when you need headers/bodies the wrapper doesn't expose     |

### roosts

```ts
// list roosts in a site (cursor-paged)
const page = await roost.roosts.list({ siteId: 'site-1', pageSize: 20 });
for (const r of page.roosts) console.log(r.id, r.name, r.currentManifest?.id);
if (page.nextPageToken) {
  const page2 = await roost.roosts.list({
    siteId: 'site-1',
    cursor: page.nextPageToken,
  });
}

// fetch one
const r = await roost.roosts.get('rst_abc', { siteId: 'site-1' });

// create
const created = await roost.roosts.create({
  siteId: 'site-1',
  name: 'lobby touchdesigner',
  targets: ['machine-a7f3'],            // machine ids
  extractPath: 'C:\\Projects\\lobby',   // optional
  roostId: 'rst_lobby_td',              // optional — server generates if omitted
});

// patch (rename, retarget)
await roost.roosts.patch('rst_lobby_td', { siteId: 'site-1', name: 'lobby (v2)' });

// soft-delete (undo by re-creating with same id within 30 days)
await roost.roosts.remove('rst_lobby_td', { siteId: 'site-1' });

// publish from a directory — the flagship call
const { manifestId, stats, events } = await roost.roosts.push('./dist', 'rst_abc', {
  siteId: 'site-1',
  onProgress: (evt) => console.log(evt),
});

// rollback (omit targetManifestId to revert one step)
await roost.roosts.rollback('rst_abc', {
  siteId: 'site-1',
  targetManifestId: 'mf_prev',
});

// trigger a deployment (targeted / scheduled / dry-run)
const deploy = await roost.roosts.deploy('rst_abc', {
  siteId: 'site-1',
  machines: ['machine-a7f3'],           // subset of targets — omit for the full target list
  scheduleAt: '2026-04-25T03:00:00Z',   // optional — iso-8601 utc or Date
  dryRun: false,
});
```

### chunks — low-level data plane

most users never touch these; `roosts.push()` is the high-level wrapper. when you need raw control (network shares, custom uploaders, reuse across roosts) the methods are here:

```ts
// dedup-check — pass sha-256 digests, get back which ones r2 needs
const { missing } = await roost.chunks.check({
  siteId: 'site-1',
  hashes: ['sha256:ab12...', 'sha256:cd34...'],
});

// mint signed r2 put urls (60 min ttl)
const { uploads } = await roost.chunks.uploadUrls({ siteId: 'site-1', hashes: missing });
for (const { hash, url } of uploads) {
  await fetch(url, { method: 'PUT', body: await chunkBytes(hash) });
}

// mint signed r2 get urls (15 min ttl) — agent-side / downstream consumers
const { downloads } = await roost.chunks.downloadUrls({ siteId: 'site-1', hashes: ['sha256:ab12...'] });

// mount an existing chunk under a different roost (no re-upload)
await roost.chunks.mount('sha256:ab12...', { siteId: 'site-1', roostId: 'rst_abc' });

// which roosts reference this chunk?
const refs = await roost.chunks.referrers('sha256:ab12...', { siteId: 'site-1' });
```

### manifests

```ts
// list manifests for a roost (paged)
const page = await roost.manifests.list({ siteId: 'site-1', roostId: 'rst_abc' });

// fetch one — full oci manifest doc
const mf = await roost.manifests.get('mf_xyz', { siteId: 'site-1', roostId: 'rst_abc' });

// file listing (paths + per-file digests)
const files = await roost.manifests.files('mf_xyz', { siteId: 'site-1', roostId: 'rst_abc' });

// diff two manifests (what changed between versions)
const diff = await roost.manifests.diff({
  siteId: 'site-1',
  roostId: 'rst_abc',
  from: 'mf_old',
  to: 'mf_new',
});
```

### keys

```ts
// create a scoped key (response contains `key` once — store it now)
const key = await roost.keys.create({
  name: 'ci publisher',
  environment: 'live',
  scopes: [
    { resource: 'site', id: 'site-1', permissions: ['read'] },
    { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy'] },
  ],
  ttlDays: 90,
});
console.log(key.key);                  // owk_live_...  <-- shown exactly once

// list, rotate (24h grace), revoke
await roost.keys.list();
await roost.keys.rotate(key.id, { ttlDays: 90 });
await roost.keys.revoke(key.id);
```

### sites / machines / quotas

```ts
await roost.sites.list();
await roost.sites.get('site-1');
await roost.machines.list({ siteId: 'site-1' });
await roost.machines.get('machine-a7f3', { siteId: 'site-1' });
await roost.machines.deployments('machine-a7f3', { siteId: 'site-1' });
await roost.quotas.current({ siteId: 'site-1' });
await roost.quotas.history({ siteId: 'site-1', days: 30 });
```

### webhooks

```ts
// subscribe — signing secret is returned ONCE; store it now
const hook = await roost.webhooks.subscribe({
  url: 'https://example.com/hooks/roost',
  events: ['manifest.published', 'deploy.failed'],
});
console.log(hook.signingSecret);

// crud + send a test event
await roost.webhooks.list();
await roost.webhooks.get(hook.id);
await roost.webhooks.update(hook.id, { events: ['manifest.published'] });
await roost.webhooks.rotateSecret(hook.id);
await roost.webhooks.remove(hook.id);
await roost.webhooks.probe(hook.id, { event: 'manifest.published' });
```

---

## push progress

`roost.roosts.push()` emits progress two ways so you can plug it into whatever ui you already have.

### callback

```ts
await roost.roosts.push('./dist', 'rst_abc', {
  siteId: 'site-1',
  onProgress: (evt) => {
    switch (evt.phase) {
      case 'discover': console.log(`found ${evt.files} files`); break;
      case 'hash':     console.log(`hashing ${evt.file} (${evt.hashed}/${evt.total})`); break;
      case 'check':    console.log(`${evt.missing} of ${evt.total} chunks need upload`); break;
      case 'upload':   console.log(`${evt.uploaded}/${evt.total} chunks (${evt.bytesUploaded} bytes)`); break;
      case 'publish':  console.log('publishing manifest'); break;
    }
  },
});
```

### event emitter

for long-running pushes behind a ui you want to wire listeners to:

```ts
const result = await roost.roosts.push('./dist', 'rst_abc', { siteId: 'site-1' });
result.events.on('progress', (evt) => {
  // same shape as the callback above — fired after push completes
});
```

### push options reference

```ts
interface PushOptions {
  siteId: string;
  concurrency?: number;                // parallel chunk uploads (default 8)
  idempotencyKey?: string;             // override auto-generated key
  manifestMetadata?: Record<string, string>;
  onProgress?: (evt: PushProgressEvent) => void;
  signal?: AbortSignal;                // cooperative cancel
  ignore?: string[];                   // glob patterns (default: ['.git/**', 'node_modules/**'])
}
```

**retry on concurrent publish (412).** if another writer publishes between your `push()` starting and the manifest post, the sdk re-reads the current manifest, re-diffs, and retries up to 3 times before surfacing `RoostApiError`. your chunk uploads never re-run — they're already addressed by hash.

---

## webhook signature verification

roost signs every webhook with `Roost-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>`. the sdk ships a verifier that enforces a 5-minute replay window and uses `crypto.timingSafeEqual`:

```ts
import { verifySignature, isSignatureValid } from '@owlette/roost';

// in your raw-body webhook handler:
const result = verifySignature(
  req.headers['roost-signature'],
  req.rawBody,                         // MUST be the raw bytes, not parsed json
  process.env.WEBHOOK_SECRET!,
);
if (!result.ok) {
  console.log('rejected:', result.reason);  // 'missing_header' | 'malformed' | 'outside_tolerance' | 'bad_signature'
  return res.status(401).json({ error: result.reason });
}
// safe to process — result.event is the parsed payload
handleEvent(result.event);

// boolean shortcut for quick paths
if (!isSignatureValid(sig, raw, secret)) return res.status(401).end();
```

**tolerance window** defaults to 300 seconds; override via `verifySignature(sig, body, secret, { toleranceSeconds: 600 })`. more than 15 minutes is almost always a bug — either your clock is wrong or you're replaying.

### signing outbound (for tests)

```ts
import { signBody } from '@owlette/roost';

const sig = signBody(JSON.stringify({ event: 'manifest.published' }), 'whsec_...');
// → 't=1735689600,v1=ab12...'
```

---

## errors

every non-2xx response throws `RoostApiError` with structured fields pulled from the rfc 7807 problem+json body:

```ts
import { Roost, RoostApiError } from '@owlette/roost';

try {
  await roost.roosts.get('rst_missing', { siteId: 'site-1' });
} catch (err) {
  if (err instanceof RoostApiError) {
    console.log(err.status);            // 404
    console.log(err.code);              // 'roost_not_found' — stable, machine-readable
    console.log(err.requestId);         // for support tickets
    console.log(err.problem);           // full problem+json body
    console.log(err.problem.doc_url);   // link to errors.md#<code>
  }
  throw err;
}
```

the sdk auto-retries `429` and `5xx` with exponential backoff + jitter, honoring the problem's `retry_after` seconds field and the `Retry-After` header when present. `401`, `403`, `404`, `412`, `422`, and other 4xxs bubble immediately — retrying them will never succeed.

**common codes** you'll hit early (full list: [errors.md](./errors.md)):

| code                       | status | when it fires                                                          |
|----------------------------|--------|------------------------------------------------------------------------|
| `scope_insufficient`       | 403    | api key doesn't carry the resource+permission for this call            |
| `token_expired`            | 401    | key hit its `expiresAt` — rotate or mint a new one                     |
| `idempotency_key_mismatch` | 409    | same key replayed with a different body                                |
| `manifest_stale`           | 412    | someone else published between your read and write — re-push           |
| `rate_limited`             | 429    | see `retry_after` — the sdk already honors it                          |
| `unsupported_version`      | 400    | `roostVersion` older than the minimum — update this package            |

---

## cancellation

every resource method accepts an `AbortSignal` to abort in-flight requests:

```ts
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 30_000);
await roost.roosts.list({ siteId: 'site-1', signal: ctl.signal });
```

for `push()` the signal also stops the chunk-upload queue cooperatively — in-flight PUTs complete, pending ones are dropped, and the promise rejects with an `AbortError`.

---

## typescript

the package is written in typescript and ships `.d.ts` for every public export. strict mode + `exactOptionalPropertyTypes` clean. all request/response shapes are typed from the same contract the api surface uses — no hand-rolled types to drift.

```ts
import type {
  RoostSummary, RoostDetail, ManifestSummary,
  PushOptions, PushProgressEvent, PushResult,
  ApiKeyScope, WebhookEvent,
} from '@owlette/roost';
```

---

## custom fetch (proxy / mtls / tracing)

pass your own `fetch` to the constructor. the sdk treats it as opaque — same signature, same return type. used for corporate proxies, client-cert auth, distributed tracing hooks, or deterministic test mocks.

```ts
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY!);
const roost = new Roost({
  token: process.env.ROOST_TOKEN!,
  fetch: (url, init) => fetch(url, { ...init, agent } as any),
});
```

---

## next steps

- **[quickstart](./quickstart.md)** — the same flow in `curl`, useful for debugging or shell pipelines.
- **[authentication](./authentication.md)** — scope grammar, presets, rotation, revocation.
- **[webhooks](./webhooks.md)** — event catalog, retry model, signing secret lifecycle.
- **[examples/ci-cd-github-actions.md](./examples/ci-cd-github-actions.md)** — the sdk inside an actual workflow.
- **[python sdk](./sdk-python.md)** — async python, same resource tree, same error codes.

the reference openapi spec is at [`web/openapi.yaml`](../../web/openapi.yaml) — whatever curl can do, this sdk can do.
