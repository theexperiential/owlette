/**
 * Bulk-create roosts from a CSV.
 *
 * Required env vars:
 *   ROOST_TOKEN - site:<id>:write scope on every site referenced in the CSV
 *
 * Usage:
 *   node bulk-create.js path/to/roosts.csv
 *
 * CSV shape:
 *   siteId,roostName,targets
 *   kiosk-01,lobby-display,machine-a|machine-b
 */

import { readFile } from 'node:fs/promises';
import { Owlette, OwletteApiError } from '@owlette/sdk';

const { ROOST_TOKEN, ROOST_BASE = 'https://owlette.app' } = process.env;
const csvPath = process.argv[2];

interface Row {
  siteId: string;
  name: string;
  targets: string[];
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  const [header, ...rows] = lines;
  if (!header || header.toLowerCase() !== 'siteid,roostname,targets') {
    throw new Error('csv must start with header: siteId,roostName,targets');
  }
  return rows.map((line) => {
    const [siteId, name, targets] = line.split(',');
    if (!siteId || !name || !targets) throw new Error(`malformed row: ${line}`);
    return {
      siteId: siteId.trim(),
      name: name.trim(),
      targets: targets.split('|').map((target) => target.trim()),
    };
  });
}

async function main(): Promise<number> {
  if (!ROOST_TOKEN || !csvPath) {
    console.error('usage: ROOST_TOKEN=... node bulk-create.js <roosts.csv>');
    return 1;
  }

  const owlette = new Owlette({ token: ROOST_TOKEN, apiUrl: ROOST_BASE });
  const rows = parseCsv(await readFile(csvPath, 'utf8'));
  const counts = { created: 0, failed: 0 };

  for (const row of rows) {
    try {
      const res = await owlette.roosts.create(row);
      console.log(`[bulk-create] ok site=${row.siteId} roost=${res.roostId} name=${row.name}`);
      counts.created += 1;
    } catch (err) {
      counts.failed += 1;
      if (err instanceof OwletteApiError) {
        console.error(
          `[bulk-create] fail site=${row.siteId} name=${row.name} ` +
            `${err.status} ${err.code}: ${err.problem.detail}`,
        );
      } else {
        console.error(`[bulk-create] fail site=${row.siteId} name=${row.name} ${err}`);
      }
    }
  }

  console.log(`[bulk-create] done created=${counts.created} failed=${counts.failed} total=${rows.length}`);
  return counts.failed > 0 ? 1 : 0;
}

main().then((code) => process.exit(code));
