import type { RoostClient } from '../lib/client';

export interface MachineSummary {
  id: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  os: string | null;
  currentRoosts: Array<{ roostId: string; name: string; currentManifestId: string | null }>;
}

export interface MachineDetail extends Omit<MachineSummary, 'currentRoosts'> {
  siteId: string;
  hostname: string | null;
  metrics: unknown | null;
  processes: Array<Record<string, unknown>>;
}

export interface MachineDeployment {
  roostId: string;
  name: string;
  currentManifestId: string | null;
  previousManifestId: string | null;
  extractPath: string | null;
  reportedManifestId: string | null;
  reportedStatus: string | null;
  reportedAt: string | null;
}

export class Machines {
  constructor(private readonly client: RoostClient) {}

  async list(siteId: string): Promise<MachineSummary[]> {
    const res = await this.client.request<{ machines: MachineSummary[] }>(
      `/api/sites/${encodeURIComponent(siteId)}/machines`,
    );
    return res.data.machines;
  }

  async get(siteId: string, machineId: string): Promise<MachineDetail> {
    const res = await this.client.request<MachineDetail>(
      `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}`,
    );
    return res.data;
  }

  async deployments(siteId: string, machineId: string): Promise<MachineDeployment[]> {
    const res = await this.client.request<{ deployments: MachineDeployment[] }>(
      `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/deployments`,
    );
    return res.data.deployments;
  }
}
