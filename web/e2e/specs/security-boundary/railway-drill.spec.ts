import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import {
  loadLocalEnv,
  pushCheck,
  resolveBaseUrl,
  type CheckResult,
  writeReport,
} from './helpers';

type RailwayCommandResult = {
  stdout: string;
  stderr: string;
  ms: number;
};

type RailwayServiceStatus = {
  id: string;
  name: string;
  deploymentId?: string;
  status: string;
  stopped?: boolean;
};

type RailwayDeployment = {
  id: string;
  status: string;
  createdAt: string;
  meta?: {
    commitHash?: string;
    commitMessage?: string;
    serviceManifest?: {
      deploy?: {
        numReplicas?: number;
        multiRegionConfig?: Record<string, { numReplicas?: number }>;
      };
    };
  };
};

const REPO_ROOT = resolve(process.cwd(), '..');
const SERVICE_NAME = process.env.SECURITY_BOUNDARY_RAILWAY_SERVICE || 'owlette-dev';

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function quoteCmdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=,@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

async function railway(args: string[]): Promise<RailwayCommandResult> {
  const startedAt = Date.now();
  return new Promise((resolveCommand, reject) => {
    const onComplete = (
      err: Error | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => {
      const result = {
        stdout: String(stdout),
        stderr: String(stderr),
        ms: Date.now() - startedAt,
      };
      if (err) {
        reject(
          new Error(
            `railway ${args[0] ?? ''} failed: ${result.stderr.trim() || err.message}`,
          ),
        );
        return;
      }
      resolveCommand(result);
    };

    if (process.platform === 'win32') {
      const command = ['railway.cmd', ...args].map(quoteCmdArg).join(' ');
      execFile('cmd.exe', ['/d', '/s', '/c', command], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }, onComplete);
      return;
    }

    execFile('railway', args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }, onComplete);
  });
}

async function railwayJson<T>(args: string[]): Promise<{ value: T; ms: number }> {
  const result = await railway(args);
  try {
    return { value: JSON.parse(result.stdout) as T, ms: result.ms };
  } catch (err) {
    throw new Error(
      `railway ${args[0] ?? ''} returned non-json output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function variableValue(payload: unknown, key: string): string | undefined {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const rowKey = row.name ?? row.key ?? row.variable;
      if (rowKey === key && typeof row.value === 'string') return row.value;
    }
    return undefined;
  }

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const direct = obj[key];
    if (typeof direct === 'string') return direct;
    const variables = obj.variables;
    if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
      const nested = (variables as Record<string, unknown>)[key];
      if (typeof nested === 'string') return nested;
    }
  }

  return undefined;
}

async function pollVariable(key: string, expectedValue: string): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  while (Date.now() < deadline) {
    const { value } = await railwayJson<unknown>(['variable', 'list', '--json']);
    if (variableValue(value, key) === expectedValue) {
      return Date.now() - startedAt;
    }
    await delay(2_000);
  }
  throw new Error(`Railway variable ${key} did not propagate within 60s`);
}

async function pollServiceSuccess(): Promise<{ status: RailwayServiceStatus; ms: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + 10 * 60_000;
  let lastStatus: RailwayServiceStatus | undefined;
  while (Date.now() < deadline) {
    const { value } = await railwayJson<RailwayServiceStatus>([
      'service',
      'status',
      '--json',
    ]);
    lastStatus = value;
    if (value.status === 'SUCCESS' && value.stopped !== true) {
      return { status: value, ms: Date.now() - startedAt };
    }
    if (value.status === 'FAILED' || value.status === 'CRASHED') {
      throw new Error(`Railway deployment ${value.deploymentId ?? ''} ended as ${value.status}`);
    }
    await delay(5_000);
  }
  throw new Error(`Railway service did not become healthy within 10m; last=${lastStatus?.status}`);
}

function replicaCount(deployment: RailwayDeployment | undefined): number | undefined {
  const deploy = deployment?.meta?.serviceManifest?.deploy;
  if (!deploy) return undefined;
  if (typeof deploy.numReplicas === 'number') return deploy.numReplicas;
  const regions = deploy.multiRegionConfig ? Object.values(deploy.multiRegionConfig) : [];
  const total = regions.reduce((sum, region) => sum + (region.numReplicas ?? 0), 0);
  return total > 0 ? total : undefined;
}

async function appBurst(baseUrl: string): Promise<{
  count: number;
  okCount: number;
  statusCounts: Record<string, number>;
  maxLatencyMs: number;
}> {
  const requests = Array.from({ length: 30 }, async () => {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/whoami`, {
      headers: { Accept: 'application/json' },
    });
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status, latencyMs: Date.now() - startedAt };
  });
  const results = await Promise.all(requests);
  const statusCounts: Record<string, number> = {};
  let okCount = 0;
  let maxLatencyMs = 0;
  for (const result of results) {
    statusCounts[String(result.status)] = (statusCounts[String(result.status)] ?? 0) + 1;
    if (result.status < 500) okCount += 1;
    maxLatencyMs = Math.max(maxLatencyMs, result.latencyMs);
  }
  return { count: results.length, okCount, statusCounts, maxLatencyMs };
}

test('railway operational drill records variable, redeploy, and replica numbers', async () => {
  test.skip(
    process.env.SECURITY_BOUNDARY_RUN_RAILWAY_DRILL !== '1',
    'Set SECURITY_BOUNDARY_RUN_RAILWAY_DRILL=1 to run the Railway redeploy drill.',
  );
  test.setTimeout(12 * 60_000);
  loadLocalEnv();

  const checks: CheckResult[] = [];
  const baseUrl = resolveBaseUrl();
  const variableKey = 'W8_1_DRILL_TS';
  const variableValueForRun = String(Date.now());
  let baselineStatus: RailwayServiceStatus | undefined;
  let finalStatus: RailwayServiceStatus | undefined;
  let latestDeployment: RailwayDeployment | undefined;
  let variablePropagationMs = 0;
  let redeployCommandMs = 0;
  let redeployToHealthyMs = 0;
  let burst:
    | Awaited<ReturnType<typeof appBurst>>
    | undefined;

  try {
    baselineStatus = (
      await railwayJson<RailwayServiceStatus>(['service', 'status', '--json'])
    ).value;
    pushCheck(checks, {
      name: 'baseline service healthy',
      ok: baselineStatus.status === 'SUCCESS' && baselineStatus.stopped !== true,
      code: baselineStatus.status,
    });
    expect(baselineStatus.status).toBe('SUCCESS');
    expect(baselineStatus.stopped).not.toBe(true);

    await railway([
      'variable',
      'set',
      `${variableKey}=${variableValueForRun}`,
      '--skip-deploys',
      '--json',
    ]);
    variablePropagationMs = await pollVariable(variableKey, variableValueForRun);
    pushCheck(checks, {
      name: 'railway variable api propagation',
      ok: variablePropagationMs > 0,
      status: variablePropagationMs,
    });

    const redeploy = await railway([
      'redeploy',
      '--service',
      SERVICE_NAME,
      '--yes',
      '--json',
    ]);
    redeployCommandMs = redeploy.ms;
    const healthy = await pollServiceSuccess();
    finalStatus = healthy.status;
    redeployToHealthyMs = redeployCommandMs + healthy.ms;
    pushCheck(checks, {
      name: 'railway redeploy reached healthy status',
      ok: finalStatus.status === 'SUCCESS' && finalStatus.stopped !== true,
      status: redeployToHealthyMs,
      code: finalStatus.status,
    });
    expect(finalStatus.status).toBe('SUCCESS');
    expect(finalStatus.stopped).not.toBe(true);

    burst = await appBurst(baseUrl);
    pushCheck(checks, {
      name: 'app responds during post-redeploy burst',
      ok: burst.okCount === burst.count,
      status: burst.okCount,
      code: JSON.stringify(burst.statusCounts),
    });
    expect(burst.okCount).toBe(burst.count);

    const deployments = (
      await railwayJson<RailwayDeployment[]>(['deployment', 'list', '--limit', '3', '--json'])
    ).value;
    latestDeployment = deployments.find((deployment) => deployment.id === finalStatus?.deploymentId)
      ?? deployments[0];
    const replicas = replicaCount(latestDeployment);
    pushCheck(checks, {
      name: 'railway replica count recorded',
      ok: typeof replicas === 'number' && replicas >= 1,
      status: replicas,
    });
    expect(replicas).toBeGreaterThanOrEqual(1);
  } finally {
    writeReport(
      'railway-drill',
      'W8.1 Railway Operational Drill',
      {
        generatedAt: new Date().toISOString(),
        baseUrl,
        service: SERVICE_NAME,
        baselineDeploymentId: baselineStatus?.deploymentId ?? '',
        finalDeploymentId: finalStatus?.deploymentId ?? '',
        finalDeploymentStatus: finalStatus?.status ?? '',
        variableKey,
        variablePropagationMs,
        redeployCommandMs,
        redeployToHealthyMs,
        replicaCount: replicaCount(latestDeployment) ?? '',
        burstRequestCount: burst?.count ?? 0,
        burstOkCount: burst?.okCount ?? 0,
        burstMaxLatencyMs: burst?.maxLatencyMs ?? 0,
      },
      checks,
    );
  }
});
