#!/usr/bin/env node

const baseUrl = (process.env.OWLETTE_PROBE_BASE_URL || 'https://dev.owlette.app').replace(/\/+$/, '');
const token = process.env.OWLETTE_PROBE_TOKEN;
const siteId = process.env.OWLETTE_PROBE_SITE_ID;
const machineId = process.env.OWLETTE_PROBE_MACHINE_ID;
const intervalMs = Number(process.env.OWLETTE_PROBE_INTERVAL_MS || '60000');
const runOnce = process.env.OWLETTE_PROBE_ONCE === '1';

function requireEnv(name, value) {
  if (!value) {
    console.error(JSON.stringify({
      level: 'error',
      probe: 'security-boundary-privileged-read',
      message: `Missing ${name}`,
    }));
    process.exit(2);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeOnce() {
  requireEnv('OWLETTE_PROBE_TOKEN', token);
  requireEnv('OWLETTE_PROBE_SITE_ID', siteId);
  requireEnv('OWLETTE_PROBE_MACHINE_ID', machineId);

  const url = `${baseUrl}/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}`;
  const startedAt = Date.now();
  let status = 0;
  let ok = false;
  let error = '';

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    status = response.status;
    ok = status >= 200 && status < 300;
    await response.arrayBuffer().catch(() => undefined);
    if (status >= 500) error = `privileged read returned ${status}`;
    else if (!ok) error = `privileged read returned non-success ${status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const latencyMs = Date.now() - startedAt;
  const event = {
    level: ok ? 'info' : 'error',
    probe: 'security-boundary-privileged-read',
    success: ok,
    status,
    latencyMs,
    baseUrl,
    siteId,
    machineId,
    observedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
  console.log(JSON.stringify(event));

  if (!ok) process.exitCode = status >= 500 || status === 0 ? 1 : 2;
  return ok;
}

do {
  const ok = await probeOnce();
  if (runOnce || !ok) break;
  await sleep(Math.max(1000, intervalMs));
} while (true);
