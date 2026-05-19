#!/usr/bin/env node
/**
 * Generate the Wave 8.0 rate-limit calibration report from observe-only data.
 *
 * Usage:
 *   node scripts/generate-rate-limit-calibration.mjs --since=2026-04-20 --until=2026-04-27
 *
 * The script reads top-level `rate_limit_observations` documents written by
 * RATE_LIMIT_OBSERVE_ONLY=true and writes the markdown file consumed by
 * scripts/check-lockdown-ready.mjs. It exits non-zero when the report is still
 * incomplete, so it is safe to use in automation.
 */

import admin from 'firebase-admin';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DEFAULT_OUTPUT_PATH = join(
  ROOT,
  'dev',
  'active',
  'security-boundary-migration',
  'reference',
  'rate-limit-calibration.md',
);

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    sinceMs: null,
    untilMs: null,
    minDays: 7,
    outputPath: DEFAULT_OUTPUT_PATH,
    stdoutOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--stdout') {
      args.stdoutOnly = true;
      continue;
    }
    if (arg.startsWith('--since=')) {
      args.sinceMs = parseDateArg(arg.slice('--since='.length), 'since');
      continue;
    }
    if (arg.startsWith('--until=')) {
      args.untilMs = parseDateArg(arg.slice('--until='.length), 'until');
      continue;
    }
    if (arg.startsWith('--min-days=')) {
      args.minDays = parsePositiveNumber(arg.slice('--min-days='.length), 'min-days');
      continue;
    }
    if (arg.startsWith('--output=')) {
      args.outputPath = arg.slice('--output='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/generate-rate-limit-calibration.mjs --since=2026-04-20 --until=2026-04-27

Options:
  --since=<date>     Start of the shadow window. Date-only values are UTC midnight.
  --until=<date>     End of the shadow window. Defaults to now; date-only values are UTC midnight.
  --min-days=<n>     Required duration for a complete report. Defaults to 7.
  --output=<path>    Markdown output path. Defaults to the Wave 8.0 reference file.
  --stdout           Print the report instead of writing it.
`);
}

function parseDateArg(value, name) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid --${name} date: ${value}`);
  }
  return ms;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name} value: ${value}`);
  }
  return parsed;
}

function initializeAdmin() {
  if (admin.apps.length === 0) {
    const projectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      undefined;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const isEmulator =
      Boolean(process.env.FIRESTORE_EMULATOR_HOST) ||
      Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

    if (isEmulator) {
      admin.initializeApp({ projectId: projectId || 'demo-playwright-e2e' });
    } else if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        projectId,
      });
    } else {
      const options = {
        credential: admin.credential.applicationDefault(),
      };
      if (projectId) options.projectId = projectId;
      admin.initializeApp(options);
    }
  }

  return admin.firestore();
}

async function fetchObservations(args) {
  const db = initializeAdmin();
  let query = db
    .collection('rate_limit_observations')
    .orderBy('observedMinuteMs', 'asc');

  if (args.sinceMs !== null) {
    query = query.where('observedMinuteMs', '>=', args.sinceMs);
  }
  if (args.untilMs !== null) {
    query = query.where('observedMinuteMs', '<=', args.untilMs);
  }

  const snapshot = await query.get();
  const observations = [];
  let invalidDocs = 0;

  snapshot.forEach((doc) => {
    const normalized = normalizeObservation(doc.data());
    if (normalized) {
      observations.push(normalized);
    } else {
      invalidDocs += 1;
    }
  });

  return { observations, invalidDocs };
}

function normalizeObservation(data) {
  const siteId = asNonEmptyString(data.siteId);
  const bucket = asBucket(data.bucket);
  const capability = asNonEmptyString(data.capability);
  const actorType = asActorType(data.actorType);
  const actorId = asNonEmptyString(data.actorId);
  const rateLimitSubject = asNonEmptyString(data.rateLimitSubject);
  const source = asObservationSource(data.source);
  const configuredLimitPerMinute = asFiniteNumber(data.configuredLimitPerMinute);
  const windowSec = asFiniteNumber(data.windowSec);
  const retryAfterSec = asFiniteNumber(data.retryAfterSec);
  const observedMinuteMs = asFiniteNumber(data.observedMinuteMs);

  if (
    !siteId ||
    !bucket ||
    !capability ||
    !actorType ||
    !actorId ||
    !source ||
    configuredLimitPerMinute === null ||
    windowSec === null ||
    retryAfterSec === null ||
    observedMinuteMs === null
  ) {
    return null;
  }

  return {
    siteId,
    bucket,
    capability,
    actorType,
    actorId,
    rateLimitSubject: rateLimitSubject ?? actorId,
    source,
    configuredLimitPerMinute,
    windowSec,
    retryAfterSec,
    observedMinuteMs,
  };
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBucket(value) {
  return value === 'user' || value === 'system' ? value : null;
}

function asActorType(value) {
  return value === 'user' || value === 'system' ? value : null;
}

function asObservationSource(value) {
  return value === 'in_memory' || value === 'firestore' ? value : null;
}

function buildReport(args, observations, invalidDocs) {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const minObservedMs =
    observations.length > 0
      ? Math.min(...observations.map((observation) => observation.observedMinuteMs))
      : null;
  const maxObservedMs =
    observations.length > 0
      ? Math.max(...observations.map((observation) => observation.observedMinuteMs))
      : null;
  const sinceMs = args.sinceMs ?? minObservedMs ?? nowMs;
  const untilMs = args.untilMs ?? maxObservedMs ?? nowMs;

  if (untilMs < sinceMs) {
    throw new Error('--until must be greater than or equal to --since');
  }

  const durationDays = (untilMs - sinceMs) / DAY_MS;
  const totalMinutes = Math.max(1, Math.floor((untilMs - sinceMs) / MINUTE_MS) + 1);
  const groups = groupObservations(observations, sinceMs, totalMinutes);
  const rows = [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((group) => summarizeGroup(group, totalMinutes));

  const hasRequiredDuration = durationDays >= args.minDays;
  const hasData = observations.length > 0 && rows.length > 0;
  const complete = hasRequiredDuration && hasData;
  const status = complete ? 'complete' : 'incomplete';
  const summary = complete
    ? 'calibration report includes duration, p99s, and calibrated limits'
    : 'shadow data is not ready for calibrated enforcement';

  const lines = [];
  lines.push('# rate-limit calibration');
  lines.push('');
  lines.push(`generated: ${generatedAt}`);
  lines.push(`status: ${status}`);
  lines.push(`shadow period: ${formatDuration(durationDays)} (${formatIso(sinceMs)} to ${formatIso(untilMs)})`);
  lines.push(`minimum required shadow period: >=${args.minDays} days`);
  lines.push('source collection: rate_limit_observations');
  lines.push(`documents analyzed: ${observations.length}`);
  lines.push(`invalid documents skipped: ${invalidDocs}`);
  lines.push('');
  lines.push('## summary');
  lines.push('');

  if (complete) {
    lines.push(
      'The observe-only shadow window covers the required duration. The table reports per-minute would-have-rejected counts by bucket, actor type, and capability. Post-calibration limits keep the current default unless observed p99 excess traffic requires more headroom.',
    );
  } else {
    lines.push(
      'Wave 8.0 is not complete. Keep `RATE_LIMIT_OBSERVE_ONLY=true` enabled until the shadow window has enough observation data, then regenerate this report.',
    );
  }

  lines.push('');
  lines.push('## percentile data');
  lines.push('');

  if (rows.length === 0) {
    lines.push('No rate-limit observation groups were found in the selected window.');
  } else {
    lines.push(
      '| bucket | actor.type | capability | current limit/min | observation docs | p50 excess/min | p95 excess/min | p99 excess/min | peak excess/min | post-calibration limit/min | sites | actors | sources |',
    );
    lines.push(
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const row of rows) {
      lines.push(
        `| ${row.bucket} | ${row.actorType} | ${row.capability} | ${row.currentLimitPerMinute} | ${row.docs} | ${row.p50} | ${row.p95} | ${row.p99} | ${row.peak} | ${row.postCalibrationLimitPerMinute} | ${row.sites} | ${row.actors} | ${row.sources} |`,
      );
    }
  }

  lines.push('');
  lines.push('## calibrated limits');
  lines.push('');
  lines.push(
    'Post-calibration limits are calculated as `currentLimit + ceil(p99_excess_per_minute * 1.5)`, so capabilities with no observed excess remain unchanged. Review the source observations for abuse or load-test traffic before copying recommendations into `web/lib/rateLimit.server.ts`.',
  );
  lines.push('');

  if (!hasRequiredDuration) {
    lines.push('## remaining blocker');
    lines.push('');
    lines.push(
      `The selected shadow window is ${formatDuration(durationDays)}, which is below the >=${args.minDays} days requirement.`,
    );
    lines.push('');
  } else if (!hasData) {
    lines.push('## remaining blocker');
    lines.push('');
    lines.push('No observe-only rejection data was found for the selected shadow window.');
    lines.push('');
  }

  return {
    body: `${lines.join('\n')}\n`,
    complete,
    summary,
  };
}

function groupObservations(observations, sinceMs, totalMinutes) {
  const groups = new Map();

  for (const observation of observations) {
    const minuteIndex = Math.floor((observation.observedMinuteMs - sinceMs) / MINUTE_MS);
    if (minuteIndex < 0 || minuteIndex >= totalMinutes) continue;

    const key = [
      observation.bucket,
      observation.actorType,
      observation.capability,
    ].join('|');
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        bucket: observation.bucket,
        actorType: observation.actorType,
        capability: observation.capability,
        currentLimitPerMinute: observation.configuredLimitPerMinute,
        siteIds: new Set(),
        actorIds: new Set(),
        subjects: new Set(),
        sources: new Set(),
        docs: 0,
        minuteCounts: new Map(),
      };
      groups.set(key, group);
    }

    group.currentLimitPerMinute = Math.max(
      group.currentLimitPerMinute,
      observation.configuredLimitPerMinute,
    );
    group.siteIds.add(observation.siteId);
    group.actorIds.add(observation.actorId);
    group.subjects.add(observation.rateLimitSubject);
    group.sources.add(observation.source);
    group.docs += 1;
    group.minuteCounts.set(minuteIndex, (group.minuteCounts.get(minuteIndex) ?? 0) + 1);
  }

  return groups;
}

function summarizeGroup(group, totalMinutes) {
  const counts = Array.from(
    { length: totalMinutes },
    (_, index) => group.minuteCounts.get(index) ?? 0,
  );
  const sortedCounts = [...counts].sort((a, b) => a - b);
  const p50 = percentile(sortedCounts, 0.5);
  const p95 = percentile(sortedCounts, 0.95);
  const p99 = percentile(sortedCounts, 0.99);
  const peak = sortedCounts[sortedCounts.length - 1] ?? 0;
  const postCalibrationLimitPerMinute =
    group.currentLimitPerMinute + Math.ceil(p99 * 1.5);

  return {
    bucket: group.bucket,
    actorType: group.actorType,
    capability: group.capability,
    currentLimitPerMinute: group.currentLimitPerMinute,
    docs: group.docs,
    p50,
    p95,
    p99,
    peak,
    postCalibrationLimitPerMinute,
    sites: group.siteIds.size,
    actors: group.actorIds.size,
    sources: [...group.sources].sort().join(', '),
  };
}

function percentile(sortedCounts, percentileValue) {
  if (sortedCounts.length === 0) return 0;
  const index = Math.min(
    sortedCounts.length - 1,
    Math.max(0, Math.ceil(sortedCounts.length * percentileValue) - 1),
  );
  return sortedCounts[index] ?? 0;
}

function formatDuration(days) {
  if (days >= 1) return `${days.toFixed(2)} days`;
  const hours = days * 24;
  return `${hours.toFixed(2)} hours`;
}

function formatIso(ms) {
  return new Date(ms).toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { observations, invalidDocs } = await fetchObservations(args);
  const report = buildReport(args, observations, invalidDocs);

  if (args.stdoutOnly) {
    process.stdout.write(report.body);
  } else {
    mkdirSync(dirname(args.outputPath), { recursive: true });
    writeFileSync(args.outputPath, report.body, 'utf8');
    process.stdout.write(`wrote ${relative(ROOT, args.outputPath)}\n`);
  }

  if (report.complete) {
    process.stdout.write(`rate-limit calibration: ${report.summary}\n`);
  } else {
    process.stderr.write(`rate-limit calibration: ${report.summary}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
