# sdk — node / typescript

**Last updated**: 2026-04-24
**Package**: [`@owlette/sdk`](https://www.npmjs.com/package/@owlette/sdk) · node ≥ 20 · zero runtime deps

the official typescript sdk for the [roost api](./overview.md). wraps the rest surface with a typed resource tree, auto-retry, automatic `Idempotency-Key`, chunk-aware `push()`, stripe-style webhook verification, version-ref resolution, and progress events. if you can use `fetch` directly you can use this — it just adds the tedious bits.

---

## installation

```bash
npm install @owlette/sdk
# or: pnpm add @owlette/sdk
# or: yarn add @owlette/sdk
```

the package ships `.js` + `.d.ts` for both esm and cjs. no native modules; no wasm; no postinstall script.

---

## hello world (< 10 lines)

```ts
import { Roost } from '@owlette/sdk';

const roost = new Roost({ token: process.env.ROOST_TOKEN! });
const result = await roost.roosts.push('./dist', 'rst_abc', {
  siteId: 'kiosk-fleet-01',
  description: 'initial publish',  // optional ≤500 chars, surfaced in the version-history ui
});
console.log('published', `v${result.versionNumber}`, result.versionId, '—', result.stats.uploadedChunks, 'chunks uploaded');
```

that's the whole flow: walk `./dist`, sha-256 chunk it, dedup-check against r2, upload what's missing, publish a version, return the new id + `versionNumber`.

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
| `roost.versions`     | `list`, `get`, `patch`, `files`, `diff`                                                         |
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
for (const r of page.roosts) console.log(r.roostId, r.name, r.currentVersionId);
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
const { versionId, versionNumber, stats, events } = await roost.roosts.push('./dist', 'rst_abc', {
  siteId: 'site-1',
  description: 'fixed broken lobby video',   // optional ≤500 chars
  onProgress: (evt) => console.log(evt),
});

// rollback — `targetVersion` accepts string | number:
//   number / "#3" / "v3"  → the third publish for this roost
//   "vrs_..."             → a stable version id
//   "current" / "previous" / "first" → aliases resolved server-side
// omit it entirely to revert one step (equivalent to "previous").
await roost.roosts.rollback('rst_abc', {
  siteId: 'site-1',
  targetVersion: 3,
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
// dedup-check — returns the hashes r2 is missing
const missing = await roost.chunks.check('site-1', ['sha256:ab12...', 'sha256:cd34...']);

// mint signed r2 put urls (60 min ttl) — returns { urls, expiresAt }
const { urls } = await roost.chunks.uploadUrls('site-1', missing);
for (const [hash, url] of Object.entries(urls)) {
  await fetch(url, { method: 'PUT', body: await chunkBytes(hash) });
}

// mint signed r2 get urls (15 min ttl) — same { urls, expiresAt } shape
const { urls: downloadUrls } = await roost.chunks.downloadUrls('site-1', ['sha256:ab12...']);

// mount an existing chunk from one roost into another (no re-upload)
await roost.chunks.mount('sha256:ab12...', 'site-1', 'rst_source', 'rst_target');

// which roosts reference this chunk?
const refs = await roost.chunks.referrers('sha256:ab12...', 'site-1');
```

### versions

```ts
// list versions for a roost (paged — cursor-based, newest first)
const page = await roost.versions.list('rst_abc', { siteId: 'site-1', limit: 20 });
for (const v of page.versions) console.log(`v${v.versionNumber}`, v.versionId, v.description, v.createdAt);

// fetch one — `versionRef` accepts the same forms as rollback's targetVersion:
//   a number (3), "#3" / "v3", a "vrs_*" id, or "current" / "previous" / "first"
const v = await roost.versions.get('rst_abc', 'current', { siteId: 'site-1' });

// edit the description only (everything else on a published version is immutable)
await roost.versions.patch('rst_abc', v.versionId, {
  siteId: 'site-1',
  description: 'updated release notes',
});

// file listing (paths + per-file digests, paged)
const files = await roost.versions.files('rst_abc', 3, {
  siteId: 'site-1',
  limit: 500,
});

// diff two versions — `against` is the baseline; both sides accept any versionRef form
const diff = await roost.versions.diff('rst_abc', 'current', {
  siteId: 'site-1',
  against: 'previous',
});
```

### keys

```ts
// create a scoped key (response contains `key` once — store it now)
const created = await roost.keys.create({
  name: 'ci publisher',
  scopes: [
    { resource: 'site', id: 'site-1', permissions: ['read'] },
    { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy'] },
  ],
  ttlDays: 90,
});
console.log(created.key);              // owk_live_...  <-- shown exactly once

// list, rotate (24h grace), revoke
const all = await roost.keys.list();
await roost.keys.rotate(created.keyId, 90);
await roost.keys.revoke(created.keyId);
```

### sites / machines / quotas

```ts
const sites = await roost.sites.list();                 // Site[]
const site = await roost.sites.get('site-1');           // Site

const machines = await roost.machines.list('site-1');   // MachineSummary[]
const machine = await roost.machines.get('site-1', 'machine-a7f3');
const deploys = await roost.machines.deployments('site-1', 'machine-a7f3');

const quota = await roost.quotas.current('site-1');     // QuotaSnapshot
const history = await roost.quotas.history('site-1', '30d');  // '7d' | '14d' | '30d' | '60d' | '90d'
```

### webhooks

```ts
// subscribe — signing secret is returned ONCE; store it now
const hook = await roost.webhooks.subscribe(
  'site-1',
  'https://example.com/hooks/roost',
  ['version.published', 'deploy.failed'],
);
console.log(hook.signingSecret);

// crud + send a test event
await roost.webhooks.list('site-1');
await roost.webhooks.get(hook.id, 'site-1');
await roost.webhooks.update(hook.id, 'site-1', { events: ['version.published'] });
await roost.webhooks.rotateSecret(hook.id, 'site-1');
await roost.webhooks.remove(hook.id, 'site-1');

// probe fires a signed test delivery — `kind` must be a known event name
await roost.webhooks.probe('site-1', 'version.published', {
  roostId: 'rst_abc',
  versionId: 'vrs_xyz',
  versionNumber: 7,
});
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
      case 'discover':      console.log(`found ${evt.fileCount} files (${evt.totalBytes} bytes)`); break;
      case 'hash':          console.log(`hashing ${evt.file} (${evt.filesDone}/${evt.filesTotal})`); break;
      case 'check-missing': console.log(`${evt.missing} of ${evt.total} chunks need upload`); break;
      case 'upload':        console.log(`${evt.uploaded}/${evt.total} chunks uploaded`); break;
      case 'publish':       console.log(`publishing version (attempt ${evt.attempt})`); break;
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
  siteId: string;                      // required — the site the roost belongs to
  name?: string;                       // optional — overrides the roost's name on publish
  targets?: string[];                  // optional — machine ids to retarget to on publish
  extractPath?: string;                // optional — on-disk extract root for the agent
  description?: string;                // optional — plaintext ≤500 chars, stored on the version doc
  onProgress?: (evt: PushProgressEvent) => void;
  ignore?: readonly string[];          // extra names to skip during the file walk
}
```

**retry on concurrent publish.** if another writer publishes between your `push()` starting and the version post, the sdk re-reads the current version, re-diffs, and retries before surfacing `RoostApiError`. your chunk uploads never re-run — they're already addressed by hash.

---

## webhook signature verification

roost signs every webhook with `Roost-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>`. the sdk ships a verifier that enforces a 5-minute replay window and uses `crypto.timingSafeEqual`:

```ts
import { verifySignature, isSignatureValid } from '@owlette/sdk';

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
// safe to process — result.event is the parsed payload (e.g. event === 'version.published')
handleEvent(result.event);

// boolean shortcut for quick paths
if (!isSignatureValid(sig, raw, secret)) return res.status(401).end();
```

**tolerance window** defaults to 300 seconds; override via `verifySignature(sig, body, secret, { toleranceSeconds: 600 })`. more than 15 minutes is almost always a bug — either your clock is wrong or you're replaying.

### signing outbound (for tests)

```ts
import { signBody } from '@owlette/sdk';

const sig = signBody(JSON.stringify({ event: 'version.published' }), 'whsec_...');
// → 't=1735689600,v1=ab12...'
```

---

## errors

every non-2xx response throws `RoostApiError` with structured fields pulled from the rfc 7807 problem+json body:

```ts
import { Roost, RoostApiError } from '@owlette/sdk';

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
| `version_stale`            | 412    | someone else published between your read and write — re-push           |
| `version_not_found`        | 404    | `targetVersion` / `versionRef` didn't resolve against the roost        |
| `rate_limited`             | 429    | see `retry_after` — the sdk already honors it                          |
| `unsupported_version`      | 400    | `roostVersion` older than the minimum — update this package            |

---

## cancellation

the low-level `roost.http.request()` accepts an `AbortSignal`:

```ts
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 30_000);
await roost.http.request('/api/sites', { signal: ctl.signal });
```

high-level resource methods don't yet surface the signal parameter — wrap the promise in `Promise.race()` against a timeout if you need to bound list/get calls. for `push()`, throwing inside the `onProgress` callback is the current cooperative-cancel mechanism.

---

## typescript

the package is written in typescript and ships `.d.ts` for every public export. strict mode + `exactOptionalPropertyTypes` clean. all request/response shapes are typed from the same contract the api surface uses — no hand-rolled types to drift.

```ts
import type {
  RoostSummary, RoostDetail, VersionSummary, VersionDetail,
  PushOptions, PushProgressEvent, PushResult,
  ApiKeyScope, WebhookEvent, VersionRef,
} from '@owlette/sdk';
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
