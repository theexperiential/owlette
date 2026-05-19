/**
 * Security-boundary observability shim (migration W8.2).
 *
 * The app does not have a dedicated metrics backend in-repo. This helper
 * emits stable, parseable log events and mirrors alert-worthy events into
 * Sentry messages. A log drain can translate the `[security-boundary-metric]`
 * lines into Prometheus/Grafana/Datadog counters without changing call sites.
 */

import * as Sentry from '@sentry/nextjs';

export type SecurityBoundaryMetricName =
  | 'capability_decision_total'
  | 'audit_write_failures_total'
  | 'authorization_enforcement_bypass_total'
  | 'rate_limit_hits_total'
  | 'kill_switch_state'
  | 'system_invoker_unexpected_caller_total'
  | 'cortex_events_incoming_total'
  | 'cortex_events_processed_total';

type MetricSeverity = 'info' | 'warning' | 'error';
type LabelValue = string | number | boolean | null | undefined;

export interface SecurityBoundaryMetricOptions {
  labels?: Record<string, LabelValue>;
  fields?: Record<string, unknown>;
  severity?: MetricSeverity;
}

function normalizeLabels(labels: Record<string, LabelValue> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function shouldSendToSentry(severity: MetricSeverity): boolean {
  if (process.env.NODE_ENV === 'test') return false;

  const flag = process.env.SECURITY_BOUNDARY_SENTRY_METRICS;
  if (flag === 'true') return true;
  if (flag === 'false') return false;

  // Avoid sending every allow decision to Sentry by default. Warning/error
  // metrics are low-volume alert signals and should reach Sentry out of box.
  return severity !== 'info';
}

export function emitSecurityBoundaryMetric(
  name: SecurityBoundaryMetricName,
  value: number,
  options: SecurityBoundaryMetricOptions = {},
): void {
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.SECURITY_BOUNDARY_TEST_METRICS !== '1'
  ) {
    return;
  }

  const severity = options.severity ?? 'info';
  const labels = normalizeLabels(options.labels);
  const payload = {
    metric: name,
    value,
    labels,
    fields: options.fields ?? {},
    observedAt: new Date().toISOString(),
  };
  const line = `[security-boundary-metric] ${name}`;

  if (severity === 'error') console.error(line, payload);
  else if (severity === 'warning') console.warn(line, payload);
  else console.info(line, payload);

  if (!shouldSendToSentry(severity)) return;

  Sentry.captureMessage(`security_boundary.${name}`, {
    level: severity,
    tags: {
      security_boundary_metric: name,
      ...labels,
    },
    extra: {
      value,
      fields: options.fields ?? {},
    },
  });
}
