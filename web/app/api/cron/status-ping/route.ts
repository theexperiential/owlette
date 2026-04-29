import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import {
  type HealthCheckResult,
  type StatusComponent,
  runStatusHealthChecks,
} from '@/lib/healthChecks.server';
import {
  type InstatusPublishResult,
  statusForHealth,
  setInstatusComponentStatus,
  validateInstatusConfig,
} from '@/lib/instatusClient';
import { getAdminDb } from '@/lib/firebase-admin';

interface StatusPingDoc {
  id: string;
  observedAtMs: number;
  checkedAt: string;
  results: HealthCheckResult[];
}

export interface ComponentStatusUpdate {
  component: StatusComponent;
  previousOk: boolean;
  currentOk: boolean;
  status: ReturnType<typeof statusForHealth>;
  reason: 'second_consecutive_failure' | 'recovered';
}

interface StatusPingResponseResult {
  component: StatusComponent;
  ok: boolean;
  latency_ms: number;
  status?: number;
  placeholder?: boolean;
}

function componentMap(results: HealthCheckResult[]): Map<StatusComponent, HealthCheckResult> {
  return new Map(results.map((entry) => [entry.component, entry]));
}

export function computeComponentStatusUpdates(
  current: HealthCheckResult[],
  previous?: HealthCheckResult[],
  prior?: HealthCheckResult[],
): ComponentStatusUpdate[] {
  if (!previous) return [];

  const previousByComponent = componentMap(previous);
  const priorByComponent = prior ? componentMap(prior) : new Map<StatusComponent, HealthCheckResult>();
  const updates: ComponentStatusUpdate[] = [];

  for (const currentResult of current) {
    const previousResult = previousByComponent.get(currentResult.component);
    if (!previousResult) continue;

    if (currentResult.ok && !previousResult.ok) {
      updates.push({
        component: currentResult.component,
        previousOk: previousResult.ok,
        currentOk: currentResult.ok,
        status: statusForHealth(true),
        reason: 'recovered',
      });
      continue;
    }

    if (!currentResult.ok && !previousResult.ok) {
      const priorResult = priorByComponent.get(currentResult.component);
      if (priorResult?.ok === false) continue;

      updates.push({
        component: currentResult.component,
        previousOk: previousResult.ok,
        currentOk: currentResult.ok,
        status: statusForHealth(false),
        reason: 'second_consecutive_failure',
      });
    }
  }

  return updates;
}

function normalizePingDoc(doc: {
  id: string;
  data: () => Record<string, unknown> | undefined;
}): StatusPingDoc | null {
  const data = doc.data() ?? {};
  if (!Array.isArray(data.results)) return null;

  return {
    id: doc.id,
    observedAtMs: typeof data.observedAtMs === 'number' ? data.observedAtMs : 0,
    checkedAt: typeof data.checkedAt === 'string' ? data.checkedAt : '',
    results: data.results as HealthCheckResult[],
  };
}

async function latestStatusPings(): Promise<StatusPingDoc[]> {
  const snapshot = await getAdminDb()
    .collection('status_pings')
    .orderBy('observedAtMs', 'desc')
    .limit(2)
    .get();

  return snapshot.docs
    .map(normalizePingDoc)
    .filter((doc): doc is StatusPingDoc => doc !== null);
}

async function writeStatusPing(
  results: HealthCheckResult[],
): Promise<{ pingId: string; checkedAt: string; observedAtMs: number }> {
  const observedAtMs = Date.now();
  const checkedAt = new Date(observedAtMs).toISOString();
  const pingId = String(observedAtMs);

  await getAdminDb()
    .collection('status_pings')
    .doc(pingId)
    .set({
      observedAtMs,
      checkedAt,
      ok: results.every((entry) => entry.ok),
      results,
      createdAt: FieldValue.serverTimestamp(),
    });

  return { pingId, checkedAt, observedAtMs };
}

async function publishStatusUpdates(
  updates: ComponentStatusUpdate[],
): Promise<InstatusPublishResult[]> {
  const attempts = updates.map((update) => ({
    update,
    promise: setInstatusComponentStatus(update.component, update.status),
  }));
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt.promise));

  return settled.map((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      if (!outcome.value.ok && !outcome.value.skipped) {
        console.warn('[cron/status-ping] Instatus publish failed', outcome.value);
      }
      return outcome.value;
    }

    const { update } = attempts[index];
    const result = {
      component: update.component,
      status: update.status,
      ok: false,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    };
    console.warn('[cron/status-ping] Instatus publish failed', result);
    return {
      ...result,
    };
  });
}

function summarizeHealthResults(results: HealthCheckResult[]): StatusPingResponseResult[] {
  return results.map((entry) => ({
    component: entry.component,
    ok: entry.ok,
    latency_ms: entry.latency_ms,
    ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
    ...(entry.metadata?.placeholder === true ? { placeholder: true } : {}),
  }));
}

function summarizePublishResults(results: InstatusPublishResult[]) {
  return {
    attempted: results.length,
    succeeded: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok && !entry.skipped).length,
    skipped: results.filter((entry) => entry.skipped).length,
    failedComponents: results
      .filter((entry) => !entry.ok && !entry.skipped)
      .map((entry) => entry.component),
    skippedComponents: results
      .filter((entry) => entry.skipped)
      .map((entry) => entry.component),
  };
}

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const previousPings = await latestStatusPings();
    const results = await runStatusHealthChecks({
      baseUrl: process.env.OWLETTE_STATUS_BASE_URL || request.nextUrl.origin,
    });
    const ping = await writeStatusPing(results);
    const updates = computeComponentStatusUpdates(
      results,
      previousPings[0]?.results,
      previousPings[1]?.results,
    );
    const publishResults = await publishStatusUpdates(updates);
    const configValidation = validateInstatusConfig();

    return NextResponse.json({
      ok: results.every((entry) => entry.ok),
      pingId: ping.pingId,
      checkedAt: ping.checkedAt,
      observedAtMs: ping.observedAtMs,
      results: summarizeHealthResults(results),
      updates: updates.map((update) => ({
        component: update.component,
        status: update.status,
        reason: update.reason,
      })),
      statusPage: {
        configured: configValidation.ok,
        missing: configValidation.missing,
        publish: summarizePublishResults(publishResults),
      },
    });
  } catch (error) {
    return apiError(error, 'cron/status-ping');
  }
}
