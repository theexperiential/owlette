/**
 * Remove per-run e2e cloud state. Pass --full to also delete the persistent
 * site + owner (a hard reset). Prints JSON of what was removed.
 *   node e2e-machine/lib/teardown.mjs [--full]
 */
import { teardown } from './admin.mjs';

try {
  const removed = await teardown({ fullReset: process.argv.includes('--full') });
  process.stdout.write(JSON.stringify({ ok: true, removed }));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
