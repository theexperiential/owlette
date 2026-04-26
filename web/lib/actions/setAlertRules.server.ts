/**
 * setAlertRules action core (security-boundary-migration wave 3.11).
 *
 * Mirrors the `saveRules` callback in `web/app/admin/alerts/page.tsx:220-233`
 * — replaces the entire `rules` array on `sites/{siteId}/settings/alerts`
 * with the supplied list. Whole-document semantics: the client fetches,
 * mutates, and re-uploads the whole array, so this action core does the
 * same. Field-level rule edits are NOT supported here.
 *
 * Capability mis-classification (flagged in route-audit.md §3.11):
 *   The legacy admin alerts page is admin-only in the UI but writes a
 *   *site-scoped* document (`sites/{siteId}/settings/alerts`). For wave
 *   3.11 we route this through `authorizedPlatformHandler` with
 *   `GLOBAL_SETTINGS_WRITE` (superadmin) per the audit's recommendation,
 *   accepting a `siteId` in the BODY rather than the URL — the only place
 *   in this wave that does so. Wave 1.2 follow-up should either add a
 *   per-site `ALERT_RULES_MANAGE` capability or split this into a
 *   `/api/sites/{siteId}/alerts` route gated by `authorizedSiteHandler`.
 *
 * firestore path: `sites/{siteId}/settings/alerts` (site-scoped — but
 * superadmin-only at this surface).
 */

import { getAdminDb } from '@/lib/firebase-admin';
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

  // Detect duplicate ids — stored as an array, but the client treats id as
  // a stable key for edit/delete operations.
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

  // Whole-document semantics matching the legacy `setDoc(..., { merge: true })`
  // call in admin/alerts/page.tsx:225. Using merge:true preserves any sibling
  // fields the legacy doc may carry (rule digest hashes, last-fired markers
  // written by the alert evaluator). Only `rules` is replaced.
  await alertsRef.set({ rules: validatedRules }, { merge: true });

  return { siteId: ctx.siteId, ruleCount: validatedRules.length };
}
