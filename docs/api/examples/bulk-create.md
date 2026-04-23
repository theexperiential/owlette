# bulk roost creation from csv

a node script that reads a csv of `siteId,roostName,targets` rows and calls `POST /api/roosts` for each one. every row uses a deterministic `Idempotency-Key: bulk-<sha256(row)>` so re-runs after fixing typos only create the corrected rows — every good row replays its cached 201 response. partial failure is the default: one bad row doesn't halt the rest, transient 5xx are retried with backoff, permanent 4xx are logged and skipped. the script ends with a summary of created / skipped-existing / failed counts and a non-zero exit code if anything failed.

## required env vars

- `ROOST_TOKEN` — api key with `site:<id>:write` scope on every site referenced in the csv.
- `ROOST_BASE` — `https://owlette.app` or `https://dev.owlette.app`.

## sample input — `roosts.csv`

```csv
siteId,roostName,targets
kiosk-fleet-01,lobby-display,machine-a7f3|machine-b2c1
kiosk-fleet-01,cafeteria-menu,machine-c3d4
kiosk-fleet-01,reception-loop,machine-e5f6|machine-g7h8|machine-i9j0
kiosk-fleet-02,west-wing-signage,machine-k1l2|machine-m3n4
kiosk-fleet-02,parking-kiosk,machine-o5p6
```

rules:
- header row required; exact column names `siteId,roostName,targets`.
- `targets` is pipe-separated machine ids (`|`), each optionally whitespace-padded.
- comma inside fields is not supported (keep roost names and site ids to `[a-z0-9-]`).
- blank lines and `#`-prefixed comment lines are ignored.

## `bulk-create-roosts.mjs`

```js
#!/usr/bin/env node
// bulk-create-roosts.mjs
// usage: node bulk-create-roosts.mjs ./roosts.csv
// exits: 0 = all created/skipped cleanly, 1 = one or more permanent failures

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const ROOST_VERSION = '2026-04-22';
const { ROOST_TOKEN, ROOST_BASE } = process.env;
const csvPath = process.argv[2];

if (!ROOST_TOKEN || !ROOST_BASE) {
  console.error('error: ROOST_TOKEN and ROOST_BASE must be set');
  process.exit(1);
}
if (!csvPath) {
  console.error('usage: node bulk-create-roosts.mjs <csvPath>');
  process.exit(1);
}

const H = {
  authorization: `Bearer ${ROOST_TOKEN}`,
  'roost-version': ROOST_VERSION,
  'content-type': 'application/json',
};

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (i === 0 && line.toLowerCase().startsWith('siteid')) continue; // header
    const [siteId, name, rawTargets] = line.split(',');
    if (!siteId || !name || rawTargets === undefined) {
      rows.push({ lineNo: i + 1, error: 'malformed row', raw: line });
      continue;
    }
    const targets = rawTargets.split('|').map(t => t.trim()).filter(Boolean);
    rows.push({
      lineNo: i + 1,
      siteId: siteId.trim(),
      name: name.trim(),
      targets,
    });
  }
  return rows;
}

function idempotencyKey(row) {
  return 'bulk-' + createHash('sha256')
    .update(`${row.siteId}|${row.name}|${row.targets.join(',')}`)
    .digest('hex')
    .slice(0, 32);
}

async function createRoost(row, { maxAttempts = 4 } = {}) {
  const idem = idempotencyKey(row);
  const body = JSON.stringify({
    siteId: row.siteId,
    name: row.name,
    targets: row.targets,
  });

  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(`${ROOST_BASE}/api/roosts`, {
      method: 'POST',
      headers: { ...H, 'idempotency-key': idem },
      body,
    });
    const text = await res.text();
    let responseBody = {};
    try { responseBody = text ? JSON.parse(text) : {}; } catch { responseBody = { detail: text }; }

    if (res.ok) return { outcome: 'created', id: responseBody.id, row, attempts: attempt };

    if (res.status === 409 && responseBody.code === 'roost_name_taken') {
      return { outcome: 'skipped', reason: 'already exists', row, attempts: attempt };
    }

    // transient: retry with jittered backoff
    const retryable = res.status >= 500 || res.status === 429;
    if (retryable && attempt < maxAttempts) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
      const backoffMs = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: 'transient failure, retrying',
        row: { siteId: row.siteId, name: row.name },
        attempt, status: res.status, code: responseBody.code, backoffMs,
      }));
      await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }

    // permanent 4xx (or retries exhausted) — log and move on
    return {
      outcome: 'failed',
      row,
      attempts: attempt,
      status: res.status,
      code: responseBody.code,
      detail: responseBody.detail,
      param: responseBody.param,
    };
  }
}

async function main() {
  const csv = await readFile(csvPath, 'utf8');
  const rows = parseCsv(csv);
  const summary = { created: [], skipped: [], failed: [], malformed: [] };

  for (const row of rows) {
    if (row.error) {
      summary.malformed.push({ lineNo: row.lineNo, error: row.error, raw: row.raw });
      continue;
    }
    const result = await createRoost(row);
    if (result.outcome === 'created') {
      summary.created.push({ lineNo: row.lineNo, name: row.name, id: result.id });
    } else if (result.outcome === 'skipped') {
      summary.skipped.push({ lineNo: row.lineNo, name: row.name, reason: result.reason });
    } else {
      summary.failed.push({
        lineNo: row.lineNo,
        name: row.name,
        status: result.status,
        code: result.code,
        detail: result.detail,
        param: result.param,
      });
    }
    // naive pacing — stay well under 60 req/min per key for creates
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(JSON.stringify({
    createdCount: summary.created.length,
    skippedExistingCount: summary.skipped.length,
    failedCount: summary.failed.length,
    malformedCount: summary.malformed.length,
    details: summary,
  }, null, 2));

  if (summary.failed.length > 0 || summary.malformed.length > 0) process.exit(1);
}

await main();
```

the script parses the csv tolerantly (blank lines, comments, header row all handled), computes a content-derived idempotency key for each row, then calls `POST /api/roosts` with `Idempotency-Key: bulk-<sha256>`. a 201 response is recorded as `created`; a `409 roost_name_taken` is recorded as `skipped` (treated as desired state, not an error); `5xx` and `429` retry up to 4 times with jittered backoff capped at 30s (or `Retry-After` if the server supplies one); all other `4xx` become `failed` entries with the server's `code`, `detail`, and `param` so the operator sees exactly which column or value was bad. the 1.1s sleep between rows keeps creates well under the default 60 req/min budget.

## rerun safety

because the idempotency key is `bulk-<sha256(siteId|name|targets)>`, a re-run after fixing one typo replays the 24h-cached 201 for every unchanged row and only hits the database for the edited row. if you change `targets` for a row (even just reordering), the key changes and the request is treated as new — so use the dashboard or `PATCH /api/roosts/{id}` to update `targets` on an existing roost rather than rerunning this script.

## sample output

```json
{
  "createdCount": 4,
  "skippedExistingCount": 1,
  "failedCount": 0,
  "malformedCount": 0,
  "details": {
    "created": [
      { "lineNo": 2, "name": "lobby-display", "id": "roost_lobby_display" },
      { "lineNo": 4, "name": "reception-loop", "id": "roost_reception_loop" },
      { "lineNo": 5, "name": "west-wing-signage", "id": "roost_west_wing_signage" },
      { "lineNo": 6, "name": "parking-kiosk", "id": "roost_parking_kiosk" }
    ],
    "skipped": [
      { "lineNo": 3, "name": "cafeteria-menu", "reason": "already exists" }
    ],
    "failed": [],
    "malformed": []
  }
}
```

## error handling summary

- `409 roost_name_taken` — treated as `skipped`, not `failed`. the csv is declarative; existing roosts are the desired state.
- `400 validation_failed` — logged to `failed[]` with `param` so the operator knows which column broke (e.g. `{"param":"targets[0]","detail":"machine-xxx not in site"}`). halts nothing.
- `403 scope_insufficient` — logged to `failed[]`. doesn't halt the run because different rows may reference different sites; a key missing scope on one site can still succeed on another.
- `404 site_not_found` — logged to `failed[]`. same reasoning as above.
- `429 rate_limited` — honours `Retry-After` and retries. if the header is missing, falls back to exponential backoff.
- `5xx` — retries up to 4 times with jittered exponential backoff.
- malformed csv rows — recorded in `malformed[]` and counted toward the non-zero exit code, but don't halt processing of later rows.
