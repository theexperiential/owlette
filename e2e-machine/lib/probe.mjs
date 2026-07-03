/**
 * Print the e2e machine's heartbeat/token state as JSON (an oracle source).
 *   node e2e-machine/lib/probe.mjs <machineId>
 */
import { probe } from './admin.mjs';

const machineId = process.argv[2];
if (!machineId) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'usage: probe.mjs <machineId>' }));
  process.exit(1);
}
try {
  process.stdout.write(JSON.stringify({ ok: true, ...(await probe(machineId)) }));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
