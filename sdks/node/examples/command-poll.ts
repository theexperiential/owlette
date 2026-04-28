/**
 * Machine command polling workflow.
 *
 * Safe default: poll an existing command when OWLETTE_COMMAND_ID is set.
 * To dispatch a new command, set OWLETTE_DISPATCH_COMMAND=1 explicitly.
 *
 * Required env:
 *   OWLETTE_TOKEN or ROOST_TOKEN
 *   OWLETTE_SITE_ID or ROOST_SITE_ID
 *   OWLETTE_MACHINE_ID or ROOST_MACHINE_ID
 *
 * Optional:
 *   OWLETTE_API_URL or ROOST_BASE defaults to https://owlette.app
 *   OWLETTE_COMMAND_ID polls an existing command instead of dispatching
 *   OWLETTE_COMMAND_TYPE defaults to capture_screenshot
 *   OWLETTE_MONITOR defaults to primary for capture_screenshot
 *   OWLETTE_POLL_SECONDS defaults to 1.5
 *   OWLETTE_TIMEOUT_SECONDS defaults to 60
 */

import {
  Roost,
  RoostApiError,
  type MachineCommandType,
} from '@owlette/sdk';

const token = process.env.OWLETTE_TOKEN ?? process.env.ROOST_TOKEN;
const apiUrl = process.env.OWLETTE_API_URL ?? process.env.ROOST_BASE ?? 'https://owlette.app';
const siteId = process.env.OWLETTE_SITE_ID ?? process.env.ROOST_SITE_ID;
const machineId = process.env.OWLETTE_MACHINE_ID ?? process.env.ROOST_MACHINE_ID;
const existingCommandId = process.env.OWLETTE_COMMAND_ID ?? process.env.ROOST_COMMAND_ID;
const rawCommandType = process.env.OWLETTE_COMMAND_TYPE ?? 'capture_screenshot';
const shouldDispatch = process.env.OWLETTE_DISPATCH_COMMAND === '1';
const pollSeconds = Number(process.env.OWLETTE_POLL_SECONDS ?? '1.5');
const timeoutSeconds = Number(process.env.OWLETTE_TIMEOUT_SECONDS ?? '60');

const allowedTypes = new Set(['capture_screenshot', 'reboot_machine', 'shutdown_machine']);

for (const [name, value] of [
  ['OWLETTE_TOKEN or ROOST_TOKEN', token],
  ['OWLETTE_SITE_ID or ROOST_SITE_ID', siteId],
  ['OWLETTE_MACHINE_ID or ROOST_MACHINE_ID', machineId],
]) {
  if (!value) {
    console.error(`missing env var: ${name}`);
    process.exit(1);
  }
}

if (!allowedTypes.has(rawCommandType)) {
  console.error(`unsupported OWLETTE_COMMAND_TYPE: ${rawCommandType}`);
  process.exit(1);
}

if (!existingCommandId && !shouldDispatch) {
  console.error('set OWLETTE_COMMAND_ID to poll, or OWLETTE_DISPATCH_COMMAND=1 to dispatch');
  process.exit(1);
}

if (!Number.isFinite(pollSeconds) || pollSeconds <= 0 || !Number.isFinite(timeoutSeconds)) {
  console.error('OWLETTE_POLL_SECONDS must be > 0 and OWLETTE_TIMEOUT_SECONDS must be numeric');
  process.exit(1);
}

const commandType = rawCommandType as MachineCommandType;
const roost = new Roost({ token: token!, apiUrl });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  try {
    let commandId = existingCommandId ?? '';
    if (!commandId) {
      const params: Record<string, unknown> = {};
      if (commandType === 'capture_screenshot') {
        params.monitor = process.env.OWLETTE_MONITOR ?? 'primary';
      }
      const queued = await roost.machines.dispatchCommand(
        siteId!,
        machineId!,
        commandType,
        params,
      );
      commandId = queued.commandId;
      console.log('queued', commandId, queued.status);
    }

    const maxPolls = Math.max(1, Math.ceil(timeoutSeconds / pollSeconds));
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const status = await roost.machines.getCommand(siteId!, machineId!, commandId);
      console.log('status', commandId, status.status);
      if (status.status === 'completed') {
        console.log(JSON.stringify(status.result ?? {}, null, 2));
        return 0;
      }
      if (status.status === 'failed') {
        console.error(status.error ?? 'command failed');
        return 2;
      }
      await sleep(pollSeconds * 1000);
    }

    console.error(`timed out waiting for ${commandId}`);
    return 3;
  } catch (err) {
    if (err instanceof RoostApiError) {
      console.error('api error', err.status, err.code, err.problem.detail ?? err.message);
      if (err.requestId) console.error('request_id', err.requestId);
    } else {
      console.error('unexpected error', err);
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
