/**
 * setAlertRules action core — replaces the whole `rules` array on
 * `sites/{siteId}/settings/alerts`. Whole-document semantics (the client
 * fetches, mutates and re-uploads the array); no field-level rule edits.
 *
 * KNOWN capability mis-classification (route-audit.md §3.11): this writes a
 * SITE-scoped doc but is gated by `authorizedPlatformHandler` +
 * `GLOBAL_SETTINGS_WRITE` (superadmin) and takes `siteId` in the BODY, not the
 * URL — the only place that does. Follow-up: a per-site `ALERT_RULES_MANAGE`
 * capability, or split into `/api/sites/{siteId}/alerts`.
 */

import type { DocumentReference } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import type { UserActor } from '@/lib/capabilities';

const VALID_OPERATORS = new Set(['>', '<', '>=', '<=']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);
const VALID_CHANNELS = new Set(['email', 'webhook']);
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface AlertRuleInput {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  severity: 'info' | 'warning' | 'critical';
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

export interface SetAlertRulesContext {
  actor: UserActor;
  siteId: string;
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
}

export interface SetAlertRulesInput {
  rules: AlertRuleInput[];
}

export interface SetAlertRulesResult {
  siteId: string;
  ruleCount: number;
}

export class AlertRulesValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'AlertRulesValidationError';
    this.field = field;
  }
}

function validateRule(rule: unknown, idx: number): AlertRuleInput {
  if (!rule || typeof rule !== 'object') {
    throw new AlertRulesValidationError(`rules[${idx}]`, 'rule must be an object');
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) {
    throw new AlertRulesValidationError(`rules[${idx}].id`, 'id must be a non-empty string');
  }
  if (typeof r.name !== 'string' || r.name.trim().length === 0) {
    throw new AlertRulesValidationError(`rules[${idx}].name`, 'name must be a non-empty string');
  }
  if (typeof r.metric !== 'string' || r.metric.trim().length === 0) {
    throw new AlertRulesValidationError(`rules[${idx}].metric`, 'metric must be a non-empty string');
  }
  if (typeof r.operator !== 'string' || !VALID_OPERATORS.has(r.operator)) {
    throw new AlertRulesValidationError(
      `rules[${idx}].operator`,
      `operator must be one of: ${Array.from(VALID_OPERATORS).join(', ')}`,
    );
  }
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
    throw new AlertRulesValidationError(`rules[${idx}].value`, 'value must be a finite number');
  }
  if (typeof r.severity !== 'string' || !VALID_SEVERITIES.has(r.severity)) {
    throw new AlertRulesValidationError(
      `rules[${idx}].severity`,
      `severity must be one of: ${Array.from(VALID_SEVERITIES).join(', ')}`,
    );
  }
  if (!Array.isArray(r.channels)) {
    throw new AlertRulesValidationError(`rules[${idx}].channels`, 'channels must be an array');
  }
  for (let c = 0; c < r.channels.length; c++) {
    const ch = r.channels[c];
    if (typeof ch !== 'string' || !VALID_CHANNELS.has(ch)) {
      throw new AlertRulesValidationError(
        `rules[${idx}].channels[${c}]`,
        `channel must be one of: ${Array.from(VALID_CHANNELS).join(', ')}`,
      );
    }
  }
  if (typeof r.enabled !== 'boolean') {
    throw new AlertRulesValidationError(`rules[${idx}].enabled`, 'enabled must be a boolean');
  }
  if (typeof r.cooldownMinutes !== 'number' || !Number.isFinite(r.cooldownMinutes) || r.cooldownMinutes < 0) {
    throw new AlertRulesValidationError(
      `rules[${idx}].cooldownMinutes`,
      'cooldownMinutes must be a non-negative finite number',
    );
  }
  return {
    id: r.id,
    name: r.name.trim(),
    metric: r.metric.trim(),
    operator: r.operator as AlertRuleInput['operator'],
    value: r.value,
    severity: r.severity as AlertRuleInput['severity'],
    channels: r.channels as string[],
    enabled: r.enabled,
    cooldownMinutes: r.cooldownMinutes,
  };
}

export async function setAlertRules(
  ctx: SetAlertRulesContext,
  input: SetAlertRulesInput,
): Promise<SetAlertRulesResult> {
  if (typeof ctx.siteId !== 'string' || !SITE_ID_RE.test(ctx.siteId)) {
    throw new AlertRulesValidationError(
      'siteId',
      'siteId must be 1-128 chars: letters, digits, underscore, hyphen',
    );
  }
  if (!Array.isArray(input.rules)) {
    throw new AlertRulesValidationError('rules', 'rules must be an array');
  }
  const validatedRules = input.rules.map((r, i) => validateRule(r, i));

  // Stored as an array, but the client treats id as a stable edit/delete key.
  const seen = new Set<string>();
  for (const r of validatedRules) {
    if (seen.has(r.id)) {
      throw new AlertRulesValidationError('rules', `duplicate rule id: ${r.id}`);
    }
    seen.add(r.id);
  }

  const db = getAdminDb();
  const alertsRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('settings')
    .doc('alerts');

  // Snapshot existing ids so the audit row can name what changed. Best-effort:
  // a failed read degrades to "no diff recorded", never a 500.
  const previousRuleIds = await readExistingRuleIds(alertsRef, ctx.siteId);

  // merge:true so sibling fields the evaluator writes (digest hashes,
  // last-fired markers) survive. Only `rules` is replaced.
  await alertsRef.set({ rules: validatedRules }, { merge: true });

  const attributes: Record<string, unknown> = {
    verb: 'alert_rules.update',
    endpoint: 'alerts',
    method: 'PUT',
    ruleCount: validatedRules.length,
  };
  if (previousRuleIds !== null) {
    const before = new Set(previousRuleIds);
    const after = new Set(validatedRules.map((r) => r.id));
    attributes.addedRuleIds = [...after].filter((id) => !before.has(id));
    attributes.removedRuleIds = [...before].filter((id) => !after.has(id));
  }

  emitMutation({
    kind: 'site_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: ctx.siteId,
    attributes,
  });

  return { siteId: ctx.siteId, ruleCount: validatedRules.length };
}

/**
 * Rule ids currently stored on the alerts doc, or `null` when they could not
 * be determined (doc absent, malformed `rules` field, or a failed read).
 */
async function readExistingRuleIds(
  alertsRef: DocumentReference,
  siteId: string,
): Promise<string[] | null> {
  try {
    const snap = await alertsRef.get();
    if (!snap.exists) return null;
    const existing = snap.data()?.rules;
    if (!Array.isArray(existing)) return null;
    return existing
      .map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
  } catch (err) {
    logger.warn('setAlertRules: existing rule-id read failed (audit detail only)', {
      context: 'setAlertRules',
      data: { siteId, err: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
