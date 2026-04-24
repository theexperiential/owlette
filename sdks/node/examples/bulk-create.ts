/**
 * bulk-create roosts from a csv.
 *
 * Mirrors docs/api/examples/bulk-create.md. Idempotency is automatic — the
 * SDK generates one `Idempotency-Key` per create() call; re-runs replay
 * cached responses for already-created rows. Transient 5xx + 429 are
 * retried by the SDK's default policy; permanent 4xx bubble.
 *
 * Required env vars:
 *   ROOST_TOKEN — site:<id>:write scope on every site referenced in the csv
 * Usage:
 *   node bulk-create.js path/to/roosts.csv
 * CSV shape (header required):
 *   siteId,roostName,targets
 *   kiosk-01,lobby-display,machine-a|machine-b
 */

import { readFile } from 'node:fs/promises';
import { Roost, RoostApiError } from '../src/index.js';

const { ROOST_TOKEN, ROOST_BASE = 'https://owlette.app' } = process.env;
const csvPath = process.argv[2];

if (!ROOST_TOKEN || !csvPath) {
  console.error('usage: ROOST_TOKEN=... node bulk-create.js <roosts.csv>');
  process.exit(1);
}

const roost = new Roost({ token: ROOST_TOKEN, apiUrl: ROOST_BASE });

interface Row { siteId: string; name: string; targets: string[] }

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const [header, ...rows] = lines;
  if (!header || header.toLowerCase() !== 'siteid,roostname,targets') {
    throw new Error('csv must start with header: siteId,roostName,targets');
  }
  return rows.map((line) => {
    const [siteId, name, targets] = line.split(',');
    if (!siteId || !name || !targets) throw new Error(`malformed row: ${line}`);
    return { siteId: siteId.trim(), name: name.trim(), targets: targets.split('|').map((t) => t.trim()) };
  });
}

const rows = parseCsv(await readFile(csvPath, 'utf8'));
const counts = { created: 0, failed: 0 };

for (const row of rows) {
  try {
    const res = await roost.roosts.create(row);
    console.log(`[bulk-create] ok  site=${row.siteId} roost=${res.roostId} name=${row.name}`);
    counts.created++;
  } catch (err) {
    counts.failed++;
    if (err instanceof RoostApiError) {
      console.error(`[bulk-create] fail site=${row.siteId} name=${row.name}  ${err.status} ${err.code}: ${err.problem.detail}`);
    } else {
      console.error(`[bulk-create] fail site=${row.siteId} name=${row.name}  ${err}`);
    }
  }
}

console.log(`[bulk-create] done — created=${counts.created} failed=${counts.failed} total=${rows.length}`);
process.exit(counts.failed > 0 ? 1 : 0);
