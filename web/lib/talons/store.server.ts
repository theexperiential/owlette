/**
 * Talon store — the one write path for `sites/{siteId}/talons/{talonId}`.
 *
 * Every talon mutation (UI route, hoot tool call, admin tooling) goes
 * through these functions so that validation, the command-output privilege
 * gate, the SSRF check on webhook outputs, the site-LLM-key precondition,
 * `nextRunAt` stamping and the audit emit can never be sidestepped by adding
 * a new caller.
 *
 * Storage shape: ONE DOCUMENT PER TALON, never an array on a settings doc.
 * Talons are edited concurrently by the dashboard and by hoot; a whole-array
 * write would silently clobber the other writer's edit. Per-doc writes also
 * let the cron sweep query `enabled == true && nextRunAt <= now` across the
 * `talons` collection group (see the composite index in firestore.indexes.json).
 *
 * Field ownership: `validateTalonInput` owns the caller-supplied half and
 * normalizes it (trims, de-dupes, defaults); it REJECTS unknown top-level
 * fields, so every server-owned field (`schemaVersion`, `createdBy`,
 * `createdVia`, `createdAt`, `nextRunAt`, `consecutiveFailures`, run
 * bookkeeping) is stamped here, after validation, from trusted context —
 * never passed through the validator.
 *
 * Secrets: a talon with a webhook output gets a `whsec_` signing secret in
 * `sites/{siteId}/talon_secrets/{talonId}`, a collection no client can read
 * (firestore.rules 2.7.0). The secret never appears on the talon document and
 * is never part of a return value — deliberately unlike the `webhooks`
 * collection, whose `signingSecret` is readable by any site member.
 */
import { randomBytes } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import { requirePro } from '@/lib/billingGate.server';
import { Capability, hasCapability, type Actor } from '@/lib/capabilities';
import { resolveLlmConfig } from '@/lib/hoot-utils.server';
import logger from '@/lib/logger';
import { validateWebhookUrl } from '@/lib/webhookUrl';
import { computeNextRunAt } from './schedule.server';
import type {
  TalonCondition,
  TalonCreatedVia,
  TalonDoc,
  TalonOutput,
} from './types';
import {
  MAX_TALONS_PER_SITE,
  validateTalonInput,
  type TalonFieldError,
  type ValidatedTalonInput,
} from './validation';

/** 32 random bytes → 64 hex chars, `whsec_`-prefixed like the webhooks API. */
const SIGNING_SECRET_BYTES = 32;

/** Talon fields a caller can change — the diff basis for audit `changedFields`. */
const CALLER_OWNED_FIELDS = [
  'name',
  'description',
  'enabled',
  'trigger',
  'condition',
  'outputs',
  'scope',
  'cooldownMinutes',
] as const;

export type TalonAuditVerb =
  | 'talon.create'
  | 'talon.update'
  | 'talon.delete'
  | 'talon.enable'
  | 'talon.disable';

const METHOD_BY_VERB: Readonly<Record<TalonAuditVerb, string>> = {
  'talon.create': 'POST',
  'talon.update': 'PATCH',
  'talon.delete': 'DELETE',
  'talon.enable': 'PATCH',
  'talon.disable': 'PATCH',
};

export type TalonStoreErrorCode =
  | 'invalid_talon'
  | 'talon_limit_reached'
  | 'command_output_forbidden'
  | 'invalid_webhook_url'
  | 'site_llm_key_required'
  | 'talon_not_found'
  | 'pro_required';

/**
 * Store rejection carrying the HTTP status the route should return. Mirrors
 * `ActionInputError` in `@/lib/actions/createProcess.server`, plus the field
 * error list so the editor can render inline messages instead of one string.
 */
export class TalonStoreError extends Error {
  readonly status: number;
  readonly code: TalonStoreErrorCode;
  readonly fieldErrors?: TalonFieldError[];

  constructor(
    status: number,
    code: TalonStoreErrorCode,
    message: string,
    fieldErrors?: TalonFieldError[],
  ) {
    super(message);
    this.name = 'TalonStoreError';
    this.status = status;
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

/** A stored talon, with the document id the collection keys it by. */
export interface StoredTalon extends TalonDoc {
  id: string;
}

/** Trusted caller context. Authorization (TALON_MANAGE) is the wrapper's job. */
export interface TalonStoreContext {
  siteId: string;
  /** Decides whether `command` outputs may be authored — see {@link assertCommandOutputsAllowed}. */
  actor: Actor;
  /** Audit actor string ("user:<uid>", "cortex:user_<uid>", "apiKey:<keyId>"). */
  auditActor: string;
  /** How the talon is being authored. Persisted as `createdVia` on create. */
  via: TalonCreatedVia;
  /** Hoot-authored talons only — the chat the talon came from. */
  chatId?: string;
  /** Audit `endpoint` attribute. Defaults to the canonical talons path. */
  endpoint?: string;
  /** Audit `method` attribute. Defaults to the verb's HTTP method. */
  method?: string;
}

function talonsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talons');
}

function talonSecretsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talon_secrets');
}

/**
 * The site's configured IANA timezone, or `'UTC'` when the site predates the
 * field or stores something unusable. Fixed clock-time entries are resolved
 * against this — the site zone, not the machine zone, because one talon can
 * span machines in several zones and its schedule must have one meaning.
 */
export async function getSiteTimezone(db: Firestore, siteId: string): Promise<string> {
  try {
    const snapshot = await db.collection('sites').doc(siteId).get();
    const timezone = snapshot.data()?.timezone;
    return typeof timezone === 'string' && timezone.trim().length > 0
      ? timezone.trim()
      : 'UTC';
  } catch {
    return 'UTC';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural equality over plain validated data — no Dates, no class instances. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

function validateOrThrow(input: unknown): ValidatedTalonInput {
  const result = validateTalonInput(input);
  if (result.ok) return result.value;
  const [first, ...rest] = result.errors;
  const summary = rest.length > 0 ? `${first.message} (+${rest.length} more)` : first.message;
  throw new TalonStoreError(400, 'invalid_talon', summary, result.errors);
}

/**
 * Talons are a pro-tier feature.
 *
 * The gate lives here, not only in `POST /api/sites/{siteId}/talons`, because
 * the hoot tool path calls `createTalon` directly and would otherwise mint
 * talons for a core-tier or locked-out site. The route keeps its own
 * pre-check so the http layer can answer before it parses a body; the second
 * call costs one more billing-snapshot read on a path that already does
 * several reads.
 *
 * Only creation is gated, matching the route: a downgraded site must still be
 * able to list, disable, and delete the talons it already has.
 */
async function assertProTier(siteId: string): Promise<void> {
  try {
    await requirePro(siteId);
  } catch (error) {
    // `requirePro` throws `ApiAuthError` — 402 when the account is locked out,
    // 403 when the site is core-tier, 404 when the site is gone. Carry the
    // status through so the response keeps its meaning, and re-code it as
    // `pro_required` so callers have a single code to branch on.
    const status = (error as { status?: unknown } | null)?.status;
    throw new TalonStoreError(
      typeof status === 'number' ? status : 403,
      'pro_required',
      error instanceof Error ? error.message : 'talons require a pro subscription.',
    );
  }
}

/**
 * `command` outputs queue process control on real machines, so authoring one
 * needs the same privilege as issuing the command by hand
 * (`MACHINE_EXEC_COMMAND` — site admins and superadmins). Site-scoped: an
 * admin of another site is a member here and is refused. Checked on create and
 * update so a talon can never gain a command output through an edit either.
 */
function assertCommandOutputsAllowed(ctx: TalonStoreContext, outputs: TalonOutput[]): void {
  if (!outputs.some((output) => output.type === 'command')) return;
  if (hasCapability(ctx.actor, Capability.MACHINE_EXEC_COMMAND, ctx.siteId)) return;
  throw new TalonStoreError(
    403,
    'command_output_forbidden',
    '`command` outputs may only be authored by a site admin.',
  );
}

/**
 * Full SSRF check on every webhook output. The shared validator only checks
 * that the URL is syntactically https (it also runs in the browser); this is
 * the DNS-resolving, private-range-rejecting pass. The dispatcher re-validates
 * at send time because DNS can change underneath us.
 */
async function assertWebhookUrlsAreSafe(outputs: TalonOutput[]): Promise<void> {
  for (const [index, output] of outputs.entries()) {
    if (output.type !== 'webhook') continue;
    const result = await validateWebhookUrl(output.url);
    if (result.ok) continue;
    throw new TalonStoreError(
      400,
      'invalid_webhook_url',
      `\`outputs[${index}].url\` was rejected: ${result.detail ?? result.reason}.`,
    );
  }
}

/**
 * Visual-check conditions and hoot outputs both call the model with no user
 * in the loop, which requires a site-level key (`autonomous: true` skips the
 * per-user key by design). `resolveLlmConfig` throws when the key is absent or
 * no longer decryptable — catching it here turns "the talon silently fails on
 * every run at 3am" into a rejection the author sees while editing.
 */
async function assertSiteLlmKeyAvailable(
  db: Firestore,
  siteId: string,
  condition: TalonCondition,
  outputs: TalonOutput[],
): Promise<void> {
  const needsLlm =
    condition.type === 'visual_check' || outputs.some((output) => output.type === 'cortex');
  if (!needsLlm) return;

  try {
    await resolveLlmConfig(db, null, siteId, { autonomous: true });
  } catch (error) {
    throw new TalonStoreError(
      400,
      'site_llm_key_required',
      `this talon needs a site llm key: ${
        error instanceof Error ? error.message : 'no site-level llm key is configured.'
      }`,
    );
  }
}

function hasWebhookOutput(outputs: TalonOutput[]): boolean {
  return outputs.some((output) => output.type === 'webhook');
}

function mintWebhookSecret(): string {
  return `whsec_${randomBytes(SIGNING_SECRET_BYTES).toString('hex')}`;
}

/**
 * `createdBy` is the authoring uid. System actors never author talons (the
 * runner only executes them), but the field is non-optional, so a system
 * caller is recorded under its actor name rather than left blank.
 */
function authorIdentifier(actor: Actor): string {
  return actor.type === 'user' ? actor.userId : `system:${actor.name}`;
}

function emitTalonAudit(
  ctx: TalonStoreContext,
  verb: TalonAuditVerb,
  talonId: string,
  changedFields?: string[],
): void {
  const basePath = `/api/sites/${ctx.siteId}/talons`;
  emitMutation({
    kind: 'talon_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: talonId,
    attributes: {
      verb,
      endpoint: ctx.endpoint ?? (verb === 'talon.create' ? basePath : `${basePath}/${talonId}`),
      method: ctx.method ?? METHOD_BY_VERB[verb],
      ...(changedFields ? { changedFields } : {}),
      via: ctx.via,
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    },
  });
}

async function requireTalon(
  db: Firestore,
  siteId: string,
  talonId: string,
): Promise<TalonDoc> {
  const snapshot = await talonsCollection(db, siteId).doc(talonId).get();
  const data = snapshot.exists ? (snapshot.data() as TalonDoc | undefined) : undefined;
  if (!data) {
    throw new TalonStoreError(404, 'talon_not_found', `talon \`${talonId}\` was not found.`);
  }
  return data;
}

/**
 * Validate, gate, and persist a new talon.
 *
 * @param input raw caller input — normalized by `validateTalonInput`; server
 *              fields are stamped here and rejected if the caller sends them.
 */
export async function createTalon(
  db: Firestore,
  ctx: TalonStoreContext,
  input: unknown,
): Promise<StoredTalon> {
  await assertProTier(ctx.siteId);

  const value = validateOrThrow(input);
  assertCommandOutputsAllowed(ctx, value.outputs);

  // Count-then-write rather than a transaction: the cap is a product limit,
  // not a security boundary, and two admins racing the twentieth create can at
  // worst land on 21. A transaction would have to read the whole collection to
  // count it, on every create, to close a gap nothing depends on.
  const collection = talonsCollection(db, ctx.siteId);
  const countSnapshot = await collection.count().get();
  const existingCount = countSnapshot.data().count;
  if (existingCount >= MAX_TALONS_PER_SITE) {
    throw new TalonStoreError(
      409,
      'talon_limit_reached',
      `this site already has ${existingCount} talons — the limit is ${MAX_TALONS_PER_SITE}.`,
    );
  }

  await assertWebhookUrlsAreSafe(value.outputs);
  await assertSiteLlmKeyAvailable(db, ctx.siteId, value.condition, value.outputs);

  const now = new Date();
  const timezone = await getSiteTimezone(db, ctx.siteId);
  const nextRunAt = computeNextRunAt(value.trigger, timezone, now);

  const doc: TalonDoc = {
    schemaVersion: 1,
    ...value,
    createdBy: authorIdentifier(ctx.actor),
    createdVia: ctx.via,
    ...(ctx.via === 'cortex' && ctx.chatId ? { chatId: ctx.chatId } : {}),
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    // Omitted, never null: the sweep filters `nextRunAt <= now`, and Firestore
    // sorts null BELOW every timestamp, so a null would match that range and
    // hand the runner talons that have no schedule at all.
    ...(nextRunAt ? { nextRunAt } : {}),
  };

  const ref = collection.doc();
  const batch = db.batch();
  batch.set(ref, doc);
  if (hasWebhookOutput(value.outputs)) {
    batch.set(talonSecretsCollection(db, ctx.siteId).doc(ref.id), {
      talonId: ref.id,
      secret: mintWebhookSecret(),
      createdAt: now,
    });
  }
  // One commit so a webhook talon can never exist without its signing secret.
  await batch.commit();

  emitTalonAudit(ctx, 'talon.create', ref.id);
  logger.info(`Talon created: ${value.name} (${ref.id}) on ${ctx.siteId} via ${ctx.via}`, {
    context: 'talons/store',
  });

  return { id: ref.id, ...doc };
}

/**
 * Replace a talon's caller-owned fields. Full-document semantics — the input
 * is a complete talon, matching what `validateTalonInput` accepts; run
 * bookkeeping (`lastRunAt`, `consecutiveFailures`, …) is untouched.
 */
export async function updateTalon(
  db: Firestore,
  ctx: TalonStoreContext,
  talonId: string,
  input: unknown,
): Promise<StoredTalon> {
  const existing = await requireTalon(db, ctx.siteId, talonId);

  const value = validateOrThrow(input);
  assertCommandOutputsAllowed(ctx, value.outputs);
  await assertWebhookUrlsAreSafe(value.outputs);
  await assertSiteLlmKeyAvailable(db, ctx.siteId, value.condition, value.outputs);

  const existingFields = existing as unknown as Record<string, unknown>;
  const changedFields = CALLER_OWNED_FIELDS.filter(
    (field) => !deepEqual(existingFields[field], value[field]),
  );

  const now = new Date();
  const updates: Record<string, unknown> = { ...value, updatedAt: now };
  // A cleared description must be removed, not left behind at its old value.
  if (value.description === undefined && existing.description !== undefined) {
    updates.description = FieldValue.delete();
  }

  if (changedFields.includes('trigger')) {
    const timezone = await getSiteTimezone(db, ctx.siteId);
    const nextRunAt = computeNextRunAt(value.trigger, timezone, now);
    // Switching a schedule talon to a threshold/event one must drop the field
    // entirely — see the null-sorting note in `createTalon`.
    updates.nextRunAt = nextRunAt ?? FieldValue.delete();
  }

  const ref = talonsCollection(db, ctx.siteId).doc(talonId);
  const secretRef = talonSecretsCollection(db, ctx.siteId).doc(talonId);
  // A talon that gains its first webhook output needs a secret minted now.
  // Losing one does NOT delete the secret: it stays the talon's stable signing
  // identity, so re-adding a webhook later doesn't silently rotate the key out
  // from under the receiver. Only deletion clears it.
  const needsSecret = hasWebhookOutput(value.outputs) && !(await secretRef.get()).exists;

  const batch = db.batch();
  batch.update(ref, updates);
  if (needsSecret) {
    batch.set(secretRef, { talonId, secret: mintWebhookSecret(), createdAt: now });
  }
  await batch.commit();

  emitTalonAudit(ctx, 'talon.update', talonId, changedFields);
  logger.info(
    `Talon updated: ${talonId} on ${ctx.siteId} (changed: ${changedFields.join(', ') || 'none'})`,
    { context: 'talons/store' },
  );

  const refreshed = await requireTalon(db, ctx.siteId, talonId);
  return { id: talonId, ...refreshed };
}

/**
 * Flip a talon on or off.
 *
 * Enabling re-arms `nextRunAt` from now: a talon that sat disabled for a month
 * would otherwise carry a month-old next-run and fire the instant the sweep
 * sees it. Disabling leaves the rest of the document alone — the stale
 * `nextRunAt` is harmless because the sweep filters on `enabled == true`.
 */
export async function setTalonEnabled(
  db: Firestore,
  ctx: TalonStoreContext,
  talonId: string,
  enabled: boolean,
): Promise<StoredTalon> {
  const existing = await requireTalon(db, ctx.siteId, talonId);

  const now = new Date();
  const updates: Record<string, unknown> = { enabled, updatedAt: now };

  if (enabled) {
    await assertSiteLlmKeyAvailable(db, ctx.siteId, existing.condition, existing.outputs);
    const timezone = await getSiteTimezone(db, ctx.siteId);
    const nextRunAt = computeNextRunAt(existing.trigger, timezone, now);
    updates.nextRunAt = nextRunAt ?? FieldValue.delete();
  }

  await talonsCollection(db, ctx.siteId).doc(talonId).update(updates);

  emitTalonAudit(ctx, enabled ? 'talon.enable' : 'talon.disable', talonId, ['enabled']);
  logger.info(`Talon ${enabled ? 'enabled' : 'disabled'}: ${talonId} on ${ctx.siteId}`, {
    context: 'talons/store',
  });

  const refreshed = await requireTalon(db, ctx.siteId, talonId);
  return { id: talonId, ...refreshed };
}

/**
 * Delete a talon and its signing secret. Run history in `talon_runs` is kept
 * on purpose — it is an audit surface and outlives the talon it describes.
 */
export async function deleteTalon(
  db: Firestore,
  ctx: TalonStoreContext,
  talonId: string,
): Promise<void> {
  await requireTalon(db, ctx.siteId, talonId);

  const batch = db.batch();
  batch.delete(talonsCollection(db, ctx.siteId).doc(talonId));
  // Unconditional: deleting a document that does not exist is a no-op, and a
  // secret must never outlive the talon it signs for.
  batch.delete(talonSecretsCollection(db, ctx.siteId).doc(talonId));
  await batch.commit();

  emitTalonAudit(ctx, 'talon.delete', talonId);
  logger.info(`Talon deleted: ${talonId} on ${ctx.siteId}`, { context: 'talons/store' });
}

/** One talon, or `null` when the site has no talon with that id. */
export async function getTalon(
  db: Firestore,
  siteId: string,
  talonId: string,
): Promise<StoredTalon | null> {
  const snapshot = await talonsCollection(db, siteId).doc(talonId).get();
  const data = snapshot.exists ? (snapshot.data() as TalonDoc | undefined) : undefined;
  return data ? { id: talonId, ...data } : null;
}

/** Every talon on the site, ordered by name — the order the editor lists them in. */
export async function listTalons(db: Firestore, siteId: string): Promise<StoredTalon[]> {
  const snapshot = await talonsCollection(db, siteId).orderBy('name').get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TalonDoc) }));
}
