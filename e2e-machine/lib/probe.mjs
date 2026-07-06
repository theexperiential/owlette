/**
 * Print the e2e machine's heartbeat/token state as JSON (an oracle source).
 *   node e2e-machine/lib/probe.mjs <machineId>            # heartbeat/token only
 *   node e2e-machine/lib/probe.mjs <machineId> --config   # + synced config processes
 *
 * The --config flag also reads config/{siteId}/machines/{machineId} and adds
 * configExists / processCount / processNames — the Wave 2 add-process oracle.
 * Default output is unchanged (Wave 1 stage 3 does not pass --config).
 */
import { probe, probeConfig } from './admin.mjs';

const machineId = process.argv[2];
const withConfig = process.argv.includes('--config');
if (!machineId) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'usage: probe.mjs <machineId> [--config]' }));
  process.exit(1);
}
try {
  const base = await probe(machineId);
  const extra = withConfig ? await probeConfig(machineId) : {};
  process.stdout.write(JSON.stringify({ ok: true, ...base, ...extra }));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
}
