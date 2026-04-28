import type { PublicProcessConfig } from '@/lib/processConfig.server';

export function lookupLiveProcessStatus(
  process: PublicProcessConfig,
  liveProcesses: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return (
    liveProcesses[process.processId] ||
    liveProcesses[process.id] ||
    liveProcesses[process.name] ||
    {}
  );
}
