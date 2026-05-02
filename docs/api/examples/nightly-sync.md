# nightly directory sync

a node script that runs nightly on a build box, walks a local directory, diffs against the roost's currently published version, and publishes a new version only if something actually changed. most nights nothing has changed — the script must not publish empty versions or burn quota. on `quota_exceeded` it emails an alert; structured logs go to stdout for systemd journald / windows event log capture.

## required env vars

- `OWLETTE_TOKEN` — api key with `roost=<id>:read,write` and `site=<id>:write` scopes.
- `OWLETTE_API_URL` — `https://owlette.app` (prod) or `https://dev.owlette.app`.
- `ROOST_ID` — target roost id.
- `ROOST_SITE_ID` — site id hosting the roost.
- `WATCH_DIR` — absolute path to the local tree to sync (e.g. `/mnt/creative/latest`).
- `ALERT_EMAIL_TO` — comma-separated recipients for the quota alert.
- `ALERT_EMAIL_FROM` — sender address configured in your mail relay.
- `MAIL_RELAY_URL` — http endpoint of your internal mail service (e.g. `https://mail.internal/send`).

## `nightly-sync.mjs`

```js
#!/usr/bin/env node
// nightly-sync.mjs — node >=20
// usage: node nightly-sync.mjs
// exits: 0 = ok (published or no-op), 1 = recoverable failure, 2 = quota exceeded

import { readdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const {
  OWLETTE_TOKEN, OWLETTE_API_URL, ROOST_ID, ROOST_SITE_ID, WATCH_DIR,
  ALERT_EMAIL_TO, ALERT_EMAIL_FROM, MAIL_RELAY_URL,
} = process.env;

for (const k of ['OWLETTE_TOKEN', 'OWLETTE_API_URL', 'ROOST_ID', 'ROOST_SITE_ID', 'WATCH_DIR']) {
  if (!process.env[k]) { log('fatal', 'missing env var', { var: k }); process.exit(1); }
}

const ROOST_VERSION = '2026-04-22';
const H = {
  authorization: `Bearer ${OWLETTE_TOKEN}`,
  'roost-version': ROOST_VERSION,
  'content-type': 'application/json',
};

function log(level, msg, extra = {}) {
  // structured one-line json for journald / event-log ingestion
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(), level, msg,
    component: 'nightly-sync', roostId: ROOST_ID, ...extra,
  }) + '\n');
}

async function api(pathAndQuery, init = {}) {
  const res = await fetch(`${OWLETTE_API_URL}${pathAndQuery}`, {
    ...init,
    headers: { ...H, ...(init.headers || {}) },
  });
  const bodyText = await res.text();
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (!res.ok) {
    const err = new Error(`${res.status} ${body.code || res.statusText}`);
    err.status = res.status;
    err.code = body.code;
    err.detail = body.detail;
    err.body = body;
    throw err;
  }
  return body;
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await walk(p));
    } else if (ent.isFile()) {
      const buf = await readFile(p);
      const hash = createHash('sha256').update(buf).digest('hex');
      const size = buf.length;
      out.push({
        path: path.relative(WATCH_DIR, p).replaceAll(path.sep, '/'),
        hash,
        size,
        chunks: size > 0 ? [{ hash, size }] : [],
        abs: p,
      });
    }
  }
  return out;
}

async function emailAlert(subject, body) {
  if (!MAIL_RELAY_URL || !ALERT_EMAIL_TO) {
    log('warn', 'mail relay not configured, cannot send alert', { subject });
    return;
  }
  try {
    await fetch(MAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: ALERT_EMAIL_FROM,
        to: ALERT_EMAIL_TO.split(',').map(s => s.trim()),
        subject, text: body,
      }),
    });
    log('info', 'alert email sent', { subject });
  } catch (e) {
    log('error', 'alert email failed', { error: String(e) });
  }
}

function buildOciVersion(files) {
  const configBody = JSON.stringify({ syncedAt: new Date().toISOString(), source: WATCH_DIR });
  const configDigest = createHash('sha256').update(configBody).digest('hex');
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {
      mediaType: 'application/vnd.owlette.roost.config.v1+json',
      digest: configDigest,
      size: Buffer.byteLength(configBody),
    },
    files: files.map(f => ({
      path: f.path,
      size: f.size,
      chunks: f.chunks.map(c => ({ hash: c.hash, size: c.size })),
    })),
  };
}

function fileSignature(file) {
  return `${file.size}:${(file.chunks || []).map(c => `${c.hash}:${c.size}`).join(',')}`;
}

async function main() {
  log('info', 'nightly sync started', { watchDir: WATCH_DIR });

  // 1. fetch current roost head
  const siteQuery = `siteId=${encodeURIComponent(ROOST_SITE_ID)}`;
  const roost = await api(`/api/roosts/${ROOST_ID}?${siteQuery}`);
  const currentVersionId = roost.currentVersionId;

  // 2. fetch current version file list (paginated) — use the "current" alias
  //    so the resolver picks up the head we just read.
  const currentMap = new Map();
  if (currentVersionId) {
    let pageToken = '';
    do {
      const url = `/api/roosts/${ROOST_ID}/versions/current/files?${siteQuery}&page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
      const page = await api(url);
      for (const f of page.files ?? page.items ?? []) currentMap.set(f.path, fileSignature(f));
      pageToken = page.next_page_token;
    } while (pageToken);
  }

  // 3. walk local tree + compute diff
  const local = await walk(WATCH_DIR);
  const localPaths = new Set(local.map(f => f.path));
  const changed = local.filter(f => currentMap.get(f.path) !== fileSignature(f));
  const removed = [...currentMap.keys()].filter(p => !localPaths.has(p));

  if (local.length === 0 && currentMap.size > 0) {
    log('error', 'local tree is empty; refusing to publish an empty version', {
      currentFiles: currentMap.size,
    });
    process.exit(1);
  }

  if (changed.length === 0 && removed.length === 0) {
    log('info', 'no changes, skipping publish', {
      localFiles: local.length, currentFiles: currentMap.size,
    });
    process.exit(0);
  }
  log('info', 'diff computed', {
    changed: changed.length, removed: removed.length, totalLocal: local.length,
  });

  // 4. dedup-check changed chunks (batches of 1000)
  const changedHashes = [...new Set(changed.flatMap(c => c.chunks.map(chunk => chunk.hash)))];
  const missing = [];
  for (let i = 0; i < changedHashes.length; i += 1000) {
    const batch = changedHashes.slice(i, i + 1000);
    const { missing: batchMissing } = await api('/api/chunks/check', {
      method: 'POST',
      body: JSON.stringify({ siteId: ROOST_SITE_ID, hashes: batch }),
    });
    missing.push(...batchMissing);
  }
  log('info', 'dedup check', {
    changedHashes: changedHashes.length, missing: missing.length,
  });

  // 5. upload missing chunks
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 1000) {
      const batch = missing.slice(i, i + 1000);
      const { urls } = await api('/api/chunks/upload-urls', {
        method: 'POST',
        body: JSON.stringify({ siteId: ROOST_SITE_ID, hashes: batch }),
      });
      for (const h of batch) {
        const file = changed.find(c => c.chunks.some(chunk => chunk.hash === h));
        const put = await fetch(urls[h], {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: await readFile(file.abs),
        });
        if (!put.ok) throw new Error(`r2 put failed for ${h}: ${put.status}`);
      }
      log('info', 'uploaded batch', { count: batch.length });
    }
  }

  // 6. publish new version (cas-guarded via expectedCurrentVersionId)
  const version = buildOciVersion(local);
  const description = `nightly sync: +${changed.length} changed, -${removed.length} removed`;
  const publish = await api(`/api/roosts/${ROOST_ID}/versions`, {
    method: 'POST',
    headers: {
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      siteId: ROOST_SITE_ID,
      version,
      description,
      ...(currentVersionId ? { expectedCurrentVersionId: currentVersionId } : {}),
    }),
  });
  log('info', 'version published', {
    versionId: publish.versionId,
    versionNumber: publish.versionNumber,
    totalFiles: local.length,
    changed: changed.length,
    removed: removed.length,
  });
}

try {
  await main();
  process.exit(0);
} catch (e) {
  if (e.code === 'quota_exceeded') {
    log('error', 'quota exceeded', { detail: e.detail });
    await emailAlert(
      `[roost] quota exceeded on ${ROOST_SITE_ID}`,
      `the nightly sync for roost ${ROOST_ID} hit a storage/bandwidth quota limit.\n\n` +
      `detail: ${e.detail}\nsite: ${ROOST_SITE_ID}\n\nsee ${OWLETTE_API_URL}/sites/${ROOST_SITE_ID}/quota`,
    );
    process.exit(2);
  }
  if (e.code === 'precondition_failed' || e.code === 'version_stale') {
    log('warn', 'cas miss — another publish happened concurrently, will retry tomorrow', { detail: e.detail });
    process.exit(1);
  }
  log('error', 'sync failed', { status: e.status, code: e.code, detail: e.detail });
  process.exit(1);
}
```

the script is structured as six sequential api interactions: read roost head, enumerate current version, walk local, dedup-check, upload missing, publish. every step emits a structured json log line with `ts`, `level`, `msg`, and relevant metadata, so journald's default json detector indexes each field for `journalctl -o json -u roost-nightly-sync.service`-style queries. a no-op night logs two lines (`started`, `no changes`) and exits 0 — cheap enough to run without rate-limit worries.

## systemd timer (linux)

drop these two unit files under `/etc/systemd/system/` and enable with `sudo systemctl enable --now roost-nightly-sync.timer`.

### `/etc/systemd/system/roost-nightly-sync.service`

```ini
[Unit]
Description=roost nightly sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=roost
WorkingDirectory=/opt/roost-sync
EnvironmentFile=/etc/roost-sync.env
ExecStart=/usr/bin/node /opt/roost-sync/nightly-sync.mjs
StandardOutput=journal
StandardError=journal
TimeoutStartSec=30min
```

### `/etc/systemd/system/roost-nightly-sync.timer`

```ini
[Unit]
Description=run roost nightly sync at 03:00 local time

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=15min
Persistent=true
Unit=roost-nightly-sync.service

[Install]
WantedBy=timers.target
```

`EnvironmentFile=/etc/roost-sync.env` holds the `OWLETTE_TOKEN=...` etc. lock that file down to `chmod 0600`. `RandomizedDelaySec=15min` spreads load for operators running this on many boxes.

## windows scheduled task (alternative)

save as `roost-nightly-sync.xml` and import with `schtasks /create /tn "roost nightly sync" /xml roost-nightly-sync.xml`.

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>roost nightly sync</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-04-22T03:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
      <RandomDelay>PT15M</RandomDelay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\nodejs\node.exe</Command>
      <Arguments>C:\roost-sync\nightly-sync.mjs</Arguments>
      <WorkingDirectory>C:\roost-sync</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

set the env vars machine-wide via `setx /M` or inject them through a small wrapper `.cmd` if you prefer keeping secrets out of the registry. task scheduler captures stdout/stderr to the event log when you run under `S-1-5-18` (local system) — the json lines are searchable via `Get-WinEvent -LogName "Microsoft-Windows-TaskScheduler/Operational"`.

## error handling summary

- `precondition_failed` / `version_stale` (412) on publish — someone else published between the `GET /api/roosts/{id}` and the `POST .../versions`. script exits 1, the operator's alerting picks up the failed unit, next night's run tries again against the new head.
- `quota_exceeded` (402) — script emails ops with a direct link to the quota dashboard. exit code 2 is distinct from 1 so an operator's `OnFailure=` unit can escalate differently.
- `rate_limited` (429) — not explicitly handled; at this endpoint volume (1 roost/night) it won't trigger. for fleets syncing hundreds of roosts from one host, add a `Retry-After`-aware retry loop around `api()`.
- `chunk_not_found` during a later download (not this script's concern) — gc ran on an orphan; safe because the next nightly run re-uploads missing chunks.
