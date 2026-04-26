# @owlette/api — node sdk

Programmatic access to the [roost](https://owlette.app) public api from
Node 20+. Zero runtime dependencies — uses the built-in `fetch`, `crypto`,
and `fs` modules.

## install

```bash
npm install @owlette/api
```

## quickstart

```ts
import { Roost } from '@owlette/api';

const roost = new Roost({
  token: process.env.ROOST_TOKEN!,
  apiUrl: 'https://owlette.app',
});

// publish a directory as a new version
const result = await roost.roosts.push('./dist', 'rst_abc', {
  siteId: 'site-1',
  description: 'fixed broken video',
  onProgress: (evt) => console.log(evt),
});

console.log('published', result.versionId, `#${result.versionNumber}`);
console.log('uploaded', result.stats.uploadedChunks, 'chunks');
```

## client options

```ts
new Roost({
  token: 'owk_live_...',          // required
  apiUrl: 'https://owlette.app',  // default
  environment: 'live',            // optional — 'live' | 'test'
  roostVersion: '2026-04-22',     // default, sent as Roost-Version header
  fetch: customFetch,             // optional — drop-in override for proxy / mtls
  retry: { maxAttempts: 3 },      // optional — overrides default policy
});
```

The sdk auto-generates an `Idempotency-Key` header on every mutating
request so transparent retries can't create duplicate rollouts, roosts,
or api keys.

## resources

| resource        | methods                                                            |
|-----------------|--------------------------------------------------------------------|
| `roost.roosts`  | `list`, `get`, `create`, `patch`, `remove`, `push`, `rollback`, `deploy` |
| `roost.chunks`  | `check`, `uploadUrls`, `downloadUrls`, `mount`, `referrers`        |
| `roost.versions` | `list`, `get`, `files`, `diff`                                    |
| `roost.deployments` | `list`, `get`                                                  |
| `roost.keys`    | `create`, `list`, `rotate`, `revoke`                               |
| `roost.webhooks` | `subscribe`, `list`, `get`, `update`, `remove`, `rotateSecret`, `probe` |
| `roost.sites`   | `list`, `get`                                                      |
| `roost.machines` | `list`, `get`, `deployments`                                      |
| `roost.quotas`  | `current`, `history`                                               |

## push progress

`roost.roosts.push()` exposes progress two ways:

```ts
// Callback
await roost.roosts.push('./dist', 'rst_abc', {
  siteId: 'site-1',
  onProgress: (evt) => {
    if (evt.phase === 'hash') console.log(`hashing ${evt.file}`);
    if (evt.phase === 'upload') console.log(`${evt.uploaded}/${evt.total}`);
  },
});

// EventEmitter on the resolved result
const result = await roost.roosts.push('./dist', 'rst_abc', { siteId: 'site-1' });
result.events.on('progress', (evt) => console.log(evt));
```

## webhook signature verification

```ts
import { verifySignature } from '@owlette/api';

// In your raw-body webhook handler:
const result = verifySignature(
  req.headers['roost-signature'],
  req.rawBody,
  process.env.WEBHOOK_SECRET!,
);
if (!result.ok) {
  return res.status(401).json({ error: result.reason });
}
```

The verifier enforces a default replay-tolerance window of 5 minutes
(configurable via `toleranceSeconds`) and uses `crypto.timingSafeEqual`
to compare hashes.

## errors

All non-2xx api responses throw `RoostApiError`:

```ts
import { Roost, RoostApiError } from '@owlette/api';

try {
  await roost.roosts.get('rst_missing', { siteId: 'site-1' });
} catch (err) {
  if (err instanceof RoostApiError) {
    console.log(err.status, err.code, err.requestId);
  }
  throw err;
}
```

The sdk auto-retries `429` and `5xx` errors with exponential backoff +
jitter. `401`, `403`, `404`, `412`, `422`, etc. bubble immediately.

## license

FSL-1.1-Apache-2.0 (same as Owlette core).
