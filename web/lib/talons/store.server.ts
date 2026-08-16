/**
 * Talon store — the one write path for `sites/{siteId}/talons/{talonId}`.
 *
 * Every talon mutation (UI route, hoot tool call, admin tooling) goes
 * through these functions so that validation, the privileged-output gate,
 * the SSRF check on webhook outputs, the author-LLM-key precondition,
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
 * never passed through the validator. `createdBy` can later be moved to a
 * successor by `reassignTalons`, which resolves that successor against the
 * capability matrix rather than trusting the request body (see its doc).
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
import { Capability, hasCapability, type Actor, type UserActor } from '@/lib/capabilities';
import { assertLlmKeyAvailable } from '@/lib/hoot-utils.server';
import logger from '@/lib/logger';
import { validateWebhookUrl } from '@/lib/webhookUrl';
import { computeNextRunAt } from './schedule.server';
import { isCreatorDisabledReason } from './types';
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

/**
 * `createdBy` prefix for a non-user author. Such a talon has no uid, so it can
 * never satisfy the llm-key precondition — nothing whose key it could spend.
 */
const SYSTEM_AUTHOR_PREFIX = 'system:';

/**
 * Firestore auto-ids are 20 alphanumeric chars; both bounds are deliberately
 * looser and match the route-level regexes. Their real job is rejecting ids
 * that would escape the document path.
 */
const TALON_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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
  | 'talon.disable'
  | 'talon.reassign';

const METHOD_BY_VERB: Readonly<Record<TalonAuditVerb, string>> = {
  'talon.create': 'POST',
  'talon.update': 'PATCH',
  'talon.delete': 'DELETE',
  'talon.enable': 'PATCH',
  'talon.disable': 'PATCH',
  'talon.reassign': 'POST',
};

export type TalonStoreErrorCode =
  | 'invalid_talon'
  | 'talon_limit_reached'
  | 'command_output_forbidden'
  | 'hoot_actions_forbidden'
  | 'invalid_webhook_url'
  | 'llm_key_required'
  | 'talon_not_found'
  | 'pro_required'
  | 'invalid_reassign'
  | 'successor_invalid';

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
  /** Decides whether privileged outputs may be authored — see {@link assertPrivilegedOutputsAllowed}. */
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
 * Two outputs put process control on a real machine, and both take the same
 * privilege as issuing that command by hand (`MACHINE_EXEC_COMMAND` — site
 * admins and superadmins):
 *
 *   - a `command` output, which queues the command directly;
 *   - a hoot output with `allowActions`, which hands an unattended turn the
 *     tier-2 tool set — process control, service management, screenshots. The
 *     mechanism differs; the power class does not, so neither does the gate.
 *
 * Site-scoped: an admin of another site is a member here and is refused.
 * Checked on create AND update, so a talon can never acquire either through an
 * edit either.
 */
function hasCommandOutput(outputs: TalonOutput[]): boolean {
  return outputs.some((output) => output.type === 'command');
}

function hasHootActionOutput(outputs: TalonOutput[]): boolean {
  return outputs.some((output) => output.type === 'cortex' && output.allowActions === true);
}

/** True when either privileged output class is present — see the doc above. */
function hasPrivilegedOutput(outputs: TalonOutput[]): boolean {
  return hasCommandOutput(outputs) || hasHootActionOutput(outputs);
}

function assertPrivilegedOutputsAllowed(ctx: TalonStoreContext, outputs: TalonOutput[]): void {
  const isAllowed = () => hasCapability(ctx.actor, Capability.MACHINE_EXEC_COMMAND, ctx.siteId);

  if (hasCommandOutput(outputs) && !isAllowed()) {
    throw new TalonStoreError(
      403,
      'command_output_forbidden',
      '`command` outputs may only be authored by a site admin.',
    );
  }

  if (hasHootActionOutput(outputs) && !isAllowed()) {
    throw new TalonStoreError(
      403,
      'hoot_actions_forbidden',
      'letting hoot act on a machine may only be authored by a site admin.',
    );
  }
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
 * Visual-check conditions and hoot outputs both call the model with no user in
 * the loop, and every unattended run spends the key of the talon's AUTHOR —
 * there is no shared site key to fall back to (see `resolveLlmConfig`). So the
 * precondition is "does this talon have an author with a key", checked here at
 * authoring time: it turns "the talon silently fails on every run at 3am" into
 * a rejection the author sees while editing, naming the one place to fix it.
 *
 * `authorId` is `undefined` for a system actor, which can never satisfy the
 * requirement — nothing whose key could be spent.
 */
async function assertAuthorLlmKeyAvailable(
  authorId: string | undefined,
  db: Firestore,
  condition: TalonCondition,
  outputs: TalonOutput[],
): Promise<void> {
  const needsLlm =
    condition.type === 'visual_check' || outputs.some((output) => output.type === 'cortex');
  if (!needsLlm) return;

  if (!authorId) {
    throw new TalonStoreError(
      400,
      'llm_key_required',
      'this talon uses ai, so it has to belong to a person whose ai key it can run with.',
    );
  }

  try {
    await assertLlmKeyAvailable(db, authorId);
  } catch {
    // The underlying message names the encryption key or the storage path —
    // neither helps the operator, and one of them is infrastructure detail.
    throw new TalonStoreError(
      400,
      'llm_key_required',
      'this talon uses ai, so it needs an ai key. add one in settings → hoot, then save again.',
    );
  }
}

/** The uid a new talon would be authored by, or `undefined` for a system actor. */
function actorAuthorUid(actor: Actor): string | undefined {
  return actor.type === 'user' ? actor.userId : undefined;
}

/**
 * The uid whose key an EXISTING talon runs on, or `undefined` when it has no
 * user author. Mirrors {@link authorIdentifier}, which writes the
 * {@link SYSTEM_AUTHOR_PREFIX} for the non-user case.
 */
function talonAuthorUid(talon: Pick<TalonDoc, 'createdBy'>): string | undefined {
  const createdBy = talon.createdBy;
  if (!createdBy || createdBy.startsWith(SYSTEM_AUTHOR_PREFIX)) return undefined;
  return createdBy;
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
  return actor.type === 'user' ? actor.userId : `${SYSTEM_AUTHOR_PREFIX}${actor.name}`;
}

function emitTalonAudit(
  ctx: TalonStoreContext,
  verb: TalonAuditVerb,
  talonId: string,
  changedFields?: string[],
  /** Verb-specific delta, e.g. the previous/new author on a reassign. */
  extraAttributes?: Record<string, unknown>,
): void {
  const basePath = `/api/sites/${ctx.siteId}/talons`;
  const collectionScoped = verb === 'talon.create' || verb === 'talon.reassign';
  emitMutation({
    kind: 'talon_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: talonId,
    attributes: {
      verb,
      endpoint: ctx.endpoint ?? (collectionScoped ? basePath : `${basePath}/${talonId}`),
      method: ctx.method ?? METHOD_BY_VERB[verb],
      ...(changedFields ? { changedFields } : {}),
      via: ctx.via,
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
      ...extraAttributes,
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
  assertPrivilegedOutputsAllowed(ctx, value.outputs);

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
  await assertAuthorLlmKeyAvailable(
    actorAuthorUid(ctx.actor),
    db,
    value.condition,
    value.outputs,
  );

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
  assertPrivilegedOutputsAllowed(ctx, value.outputs);
  await assertWebhookUrlsAreSafe(value.outputs);
  // The AUTHOR's key, not the editor's: `createdBy` never changes on an update,
  // so a second admin adding an ai output is adding it to a talon that will
  // still run on the original author's key.
  await assertAuthorLlmKeyAvailable(
    talonAuthorUid(existing),
    db,
    value.condition,
    value.outputs,
  );

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
  // A human moved the switch, so whatever the system had to say about the last
  // time it moved it is history — on either edge. Leaving a stale reason behind
  // would have a freshly re-armed talon still claiming it was switched off.
  const updates: Record<string, unknown> = {
    enabled,
    updatedAt: now,
    ...(existing.disabledReason !== undefined ? { disabledReason: FieldValue.delete() } : {}),
  };

  if (enabled) {
    await assertAuthorLlmKeyAvailable(
      talonAuthorUid(existing),
      db,
      existing.condition,
      existing.outputs,
    );
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

/* -------------------------------------------------------------------------- */
/*  reassign — hand authorship to a successor                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why this exists: `createdBy` is provenance for most of a talon, but a hoot
 * output re-resolves the AUTHOR's site access on every unattended run
 * (`hootOutput.server.ts`), and a throw there is a hard run failure. So when
 * the person who wrote a talon loses access — removed from the site, or
 * soft-deleted — every AI talon they authored stops running, silently, at
 * whatever hour it was scheduled for. Reassignment is how an operator moves
 * that dependency to somebody who is still here, before the departure rather
 * than after the 3am failure.
 *
 * The author's fire-time access check is deliberately NOT weakened; this
 * changes who the author *is*.
 */
export type TalonSuccessorRejection =
  | 'not_found'
  | 'soft_deleted'
  | 'insufficient_role'
  | 'insufficient_privilege';

const SUCCESSOR_REJECTION_DETAIL: Readonly<Record<TalonSuccessorRejection, string>> = {
  not_found: 'the successor does not match an existing user.',
  soft_deleted: 'the successor is a deleted account.',
  insufficient_role:
    'the successor must be a site admin (or superadmin) with access to this site — the same bar the talon store holds every author to.',
  insufficient_privilege:
    'at least one talon runs commands or lets hoot act on a machine, which only a site admin may author.',
};

/** Which talons to move. Exactly one selector must be supplied. */
export interface TalonReassignSelection {
  /** Every talon on the site currently authored by this uid. */
  fromUid?: string;
  /** An explicit list of talon ids on the site. */
  talonIds?: string[];
}

export interface TalonReassignResult {
  siteId: string;
  toUid: string;
  /** Talons whose `createdBy` was rewritten by this call. */
  reassignedTalonIds: string[];
  /** Talons that were already authored by `toUid` — no write, no audit row. */
  skippedTalonIds: string[];
}

/**
 * Resolve a uid to the actor the capability matrix understands.
 *
 * Reads `users/{uid}` directly rather than taking a caller-supplied role: the
 * successor is named in a request body, and trusting that would let anyone
 * with TALON_MANAGE hand a privileged talon to an account that cannot hold it.
 */
async function loadSuccessorActor(
  db: Firestore,
  uid: string,
): Promise<{ ok: true; actor: UserActor } | { ok: false; reason: TalonSuccessorRejection }> {
  const snapshot = await db.collection('users').doc(uid).get();
  const data = snapshot.exists ? snapshot.data() : undefined;
  if (!data) return { ok: false, reason: 'not_found' };
  // Soft-deleted accounts keep their user doc (it is an audit surface), so
  // `deletedAt` — not document existence — is what "still here" means.
  if (data.deletedAt != null) return { ok: false, reason: 'soft_deleted' };

  const role = data.role === 'admin' || data.role === 'superadmin' ? data.role : 'member';
  const sites = Array.isArray(data.sites)
    ? (data.sites as unknown[]).filter((site): site is string => typeof site === 'string')
    : [];

  return { ok: true, actor: { type: 'user', userId: uid, role, sites } };
}

/**
 * The successor must clear the same two gates the store holds an author to:
 * TALON_MANAGE on this site to author a talon at all, and
 * MACHINE_EXEC_COMMAND when any of the talons carries a privileged output.
 *
 * Both are checked even though the current matrix grants them to the same
 * roles — they are separate gates on the create/update path, and collapsing
 * them here would silently re-open the privileged-output hole if the matrix
 * ever diverges.
 */
function successorRejection(
  siteId: string,
  successor: UserActor,
  talons: StoredTalon[],
): TalonSuccessorRejection | null {
  if (!hasCapability(successor, Capability.TALON_MANAGE, siteId)) {
    return 'insufficient_role';
  }
  if (
    talons.some((talon) => hasPrivilegedOutput(talon.outputs)) &&
    !hasCapability(successor, Capability.MACHINE_EXEC_COMMAND, siteId)
  ) {
    return 'insufficient_privilege';
  }
  return null;
}

/** Every talon on the site authored by `uid`, ordered by name. */
export async function listTalonsAuthoredBy(
  db: Firestore,
  siteId: string,
  uid: string,
): Promise<StoredTalon[]> {
  const snapshot = await talonsCollection(db, siteId)
    .where('createdBy', '==', uid)
    .orderBy('name')
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TalonDoc) }));
}

/**
 * How many talons on the site `uid` authored.
 *
 * An aggregate — the departure surfaces call this to warn before the damage,
 * and a preview must never cost a document read per talon. Single-field
 * equality, so Firestore's automatic collection-scoped index covers it.
 */
export async function countTalonsAuthoredBy(
  db: Firestore,
  siteId: string,
  uid: string,
): Promise<number> {
  const snapshot = await talonsCollection(db, siteId)
    .where('createdBy', '==', uid)
    .count()
    .get();
  return snapshot.data().count;
}

/** One authored talon, with the site it lives on — the cross-site preview row. */
export interface AuthoredTalonRef {
  siteId: string;
  talonId: string;
  name: string;
  enabled: boolean;
}

/**
 * Every talon `uid` authored, across every site, in one collection-group
 * query. The user soft-delete flow needs this: a superadmin's `sites[]` can be
 * empty while they still author talons anywhere, so walking the membership
 * array would under-report exactly the accounts whose departure hurts most.
 *
 * The `orderBy('name')` is load-bearing — it is what the composite
 * collection-group index in `firestore.indexes.json` is declared over
 * (`createdBy ASC, name ASC`).
 */
export async function listTalonsAuthoredByAcrossSites(
  db: Firestore,
  uid: string,
): Promise<AuthoredTalonRef[]> {
  const snapshot = await db
    .collectionGroup('talons')
    .where('createdBy', '==', uid)
    .orderBy('name')
    .get();

  const refs: AuthoredTalonRef[] = [];
  for (const doc of snapshot.docs) {
    // `sites/{siteId}/talons/{talonId}` — the grandparent is the site document.
    const siteId = doc.ref.parent.parent?.id;
    if (!siteId) continue;
    const data = doc.data() as TalonDoc;
    refs.push({
      siteId,
      talonId: doc.id,
      name: typeof data.name === 'string' ? data.name : doc.id,
      enabled: data.enabled === true,
    });
  }
  return refs;
}

/**
 * Move authorship of one or more talons to `toUid`.
 *
 * Selection is either every talon authored by `fromUid` (the departure case)
 * or an explicit `talonIds` list (the "fix this one" case) — never both, so a
 * caller can't half-express what they meant and get a superset.
 *
 * One batch: MAX_TALONS_PER_SITE (20) is far under the 500-op batch limit, so
 * a site's whole talon set always fits in a single atomic commit. Nothing is
 * written unless every selected talon exists and the successor clears both
 * author gates — a partial reassignment would leave some automations pointing
 * at someone who has left and give no signal which.
 *
 * Deliberately NOT recorded on the document: the previous author. The audit
 * row carries `previousCreatedBy`, and the audit log is the system of record
 * for "who used to own this" — a second copy on the talon would drift.
 */
export async function reassignTalons(
  db: Firestore,
  ctx: TalonStoreContext,
  toUid: string,
  selection: TalonReassignSelection,
): Promise<TalonReassignResult> {
  if (typeof toUid !== 'string' || !UID_RE.test(toUid)) {
    throw new TalonStoreError(400, 'invalid_reassign', '`toUid` must be a valid user id.');
  }

  const { fromUid, talonIds } = selection;
  const hasFromUid = fromUid !== undefined;
  const hasTalonIds = talonIds !== undefined;
  if (hasFromUid === hasTalonIds) {
    throw new TalonStoreError(
      400,
      'invalid_reassign',
      'supply exactly one of `fromUid` or `talonIds`.',
    );
  }

  let selected: StoredTalon[];
  if (hasFromUid) {
    if (typeof fromUid !== 'string' || !UID_RE.test(fromUid)) {
      throw new TalonStoreError(400, 'invalid_reassign', '`fromUid` must be a valid user id.');
    }
    if (fromUid === toUid) {
      throw new TalonStoreError(
        400,
        'invalid_reassign',
        '`fromUid` and `toUid` are the same user.',
      );
    }
    selected = await listTalonsAuthoredBy(db, ctx.siteId, fromUid);
  } else {
    const ids = talonIds ?? [];
    if (ids.length === 0) {
      throw new TalonStoreError(400, 'invalid_reassign', '`talonIds` must not be empty.');
    }
    if (ids.some((id) => typeof id !== 'string' || !TALON_ID_RE.test(id))) {
      throw new TalonStoreError(400, 'invalid_reassign', '`talonIds` contains a malformed id.');
    }
    const unique = Array.from(new Set(ids));
    if (unique.length > MAX_TALONS_PER_SITE) {
      throw new TalonStoreError(
        400,
        'invalid_reassign',
        `\`talonIds\` may name at most ${MAX_TALONS_PER_SITE} talons.`,
      );
    }
    // All-or-nothing: `requireTalon` throws 404 for the first missing id.
    selected = await Promise.all(
      unique.map(async (id) => ({ id, ...(await requireTalon(db, ctx.siteId, id)) })),
    );
  }

  const successor = await loadSuccessorActor(db, toUid);
  if (!successor.ok) {
    throw new TalonStoreError(
      400,
      'successor_invalid',
      SUCCESSOR_REJECTION_DETAIL[successor.reason],
    );
  }

  const rejection = successorRejection(ctx.siteId, successor.actor, selected);
  if (rejection) {
    throw new TalonStoreError(400, 'successor_invalid', SUCCESSOR_REJECTION_DETAIL[rejection]);
  }

  const moving = selected.filter((talon) => talon.createdBy !== toUid);
  const skippedTalonIds = selected
    .filter((talon) => talon.createdBy === toUid)
    .map((talon) => talon.id);

  if (moving.length === 0) {
    return { siteId: ctx.siteId, toUid, reassignedTalonIds: [], skippedTalonIds };
  }

  // A successor who cannot run these talons is not a successor. The authoring
  // bar already demands a key for ai talons (`assertAuthorLlmKeyAvailable`), and
  // reassignment is authoring by another name — without this, handing over a
  // wall check re-enables it straight into `creator_missing_llm_key` on the next
  // run, which is the exact silent rot this feature exists to stop.
  // Optional-chained on purpose: this is the one talon read path that runs over
  // documents it did not just validate, and a talon written before a field
  // existed must be movable rather than crash the whole handover. A doc with no
  // condition cannot be a visual check, so treating absent as "no ai" is also
  // the correct answer, not just the safe one.
  const movingNeedsLlm = moving.some(
    (talon) =>
      talon.condition?.type === 'visual_check' ||
      talon.outputs?.some((output) => output.type === 'cortex'),
  );
  if (movingNeedsLlm) {
    try {
      await assertLlmKeyAvailable(db, toUid);
    } catch {
      throw new TalonStoreError(
        400,
        'successor_invalid',
        'some of these talons use ai, so the person taking them over needs an ai key of their own. they can add one in settings → hoot.',
      );
    }
  }

  const now = new Date();
  const collection = talonsCollection(db, ctx.siteId);
  const batch = db.batch();
  for (const talon of moving) {
    batch.update(collection.doc(talon.id), {
      createdBy: toUid,
      updatedAt: now,
      // Reassignment RESOLVES the creator reasons — the talon was switched off
      // because its author was gone, deleted, or keyless, and it now has one who
      // is none of those. Leaving it disabled behind a reason naming the old
      // author's problem would make the handover a no-op the operator has to
      // finish by hand, staring at a sentence that is no longer true.
      //
      // Only the creator reasons. `repeated_failures` describes the talon, not
      // its author, and reassignment fixes nothing about it; a talon a HUMAN
      // switched off carries no reason at all and must stay off.
      ...(isCreatorDisabledReason(talon.disabledReason)
        ? { enabled: true, disabledReason: FieldValue.delete(), consecutiveFailures: 0 }
        : {}),
    });
  }
  await batch.commit();

  // One audit row per talon: `targetId` has to name the resource that changed,
  // so "did this talon change?" queries stay answerable.
  for (const talon of moving) {
    const rearmed = isCreatorDisabledReason(talon.disabledReason);
    emitTalonAudit(
      ctx,
      'talon.reassign',
      talon.id,
      rearmed ? ['createdBy', 'enabled', 'disabledReason'] : ['createdBy'],
      {
        previousCreatedBy: talon.createdBy,
        newCreatedBy: toUid,
        ...(rearmed ? { rearmedFrom: talon.disabledReason } : {}),
      },
    );
  }

  logger.info(
    `Talons reassigned to ${toUid} on ${ctx.siteId}: ${moving.map((t) => t.id).join(', ')}`,
    { context: 'talons/store' },
  );

  return {
    siteId: ctx.siteId,
    toUid,
    reassignedTalonIds: moving.map((talon) => talon.id),
    skippedTalonIds,
  };
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
