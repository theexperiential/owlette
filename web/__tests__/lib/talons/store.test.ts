/** @jest-environment node */

/**
 * Unit tests for the talon store (talons wave 1, task 1.1).
 *
 * Firestore is a small in-memory fake rather than a chain of `jest.fn()`s:
 * the store writes to two collections, reads back through batches, and
 * deletes fields with a `FieldValue.delete()` sentinel, so the tests need a
 * store that actually holds state to assert "the secret is in talon_secrets
 * and nowhere else" or "nextRunAt was removed, not nulled".
 *
 * `firebase-admin/firestore` is mocked down to `FieldValue` alone so the suite
 * never loads the real Admin SDK; the collaborators with I/O or crypto cost
 * (`resolveLlmConfig`, `validateWebhookUrl`, the audit emitter) are mocked the
 * way the `__tests__/lib/actions/*` suites mock theirs.
 */

const mockDeleteSentinel = { __fieldValue: 'delete' } as const;
const mockEmitMutation = jest.fn();
const mockResolveLlmConfig = jest.fn();
const mockValidateWebhookUrl = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => mockDeleteSentinel },
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/cortex-utils.server', () => ({
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
}));
jest.mock('@/lib/webhookUrl', () => ({
  validateWebhookUrl: (...args: unknown[]) => mockValidateWebhookUrl(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import type { Actor } from '@/lib/capabilities';
import {
  TalonStoreError,
  createTalon,
  deleteTalon,
  getTalon,
  listTalons,
  setTalonEnabled,
  updateTalon,
  type TalonStoreContext,
  type TalonStoreErrorCode,
} from '@/lib/talons/store.server';
import { MAX_TALONS_PER_SITE } from '@/lib/talons/validation';
import type { TalonDoc } from '@/lib/talons/types';

/* ------------------------------------------------------------------------- */
/*  In-memory Firestore                                                       */
/* ------------------------------------------------------------------------- */

type DocData = Record<string, unknown>;
type BatchOp = { kind: 'set' | 'update' | 'delete'; path: string; data?: DocData };

class FakeFirestore {
  readonly docs = new Map<string, DocData>();
  private idCounter = 0;

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  batch() {
    const ops: BatchOp[] = [];
    return {
      set: (ref: FakeDocRef, data: DocData) => ops.push({ kind: 'set', path: ref.path, data }),
      update: (ref: FakeDocRef, data: DocData) =>
        ops.push({ kind: 'update', path: ref.path, data }),
      delete: (ref: FakeDocRef) => ops.push({ kind: 'delete', path: ref.path }),
      commit: async () => {
        for (const op of ops) {
          if (op.kind === 'set') this.docs.set(op.path, { ...op.data });
          else if (op.kind === 'delete') this.docs.delete(op.path);
          else this.applyUpdate(op.path, op.data ?? {});
        }
      },
    };
  }

  applyUpdate(path: string, data: DocData): void {
    const current = this.docs.get(path);
    if (!current) throw new Error(`update on missing document ${path}`);
    const next: DocData = { ...current };
    for (const [key, value] of Object.entries(data)) {
      if (value === mockDeleteSentinel) delete next[key];
      else next[key] = value;
    }
    this.docs.set(path, next);
  }

  childPaths(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    return [...this.docs.keys()].filter(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
  }

  nextId(): string {
    this.idCounter += 1;
    return `generated-${this.idCounter}`;
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id ?? this.db.nextId()}`);
  }

  count() {
    return {
      get: async () => ({ data: () => ({ count: this.db.childPaths(this.path).length }) }),
    };
  }

  orderBy(field: string) {
    return {
      get: async () => ({
        docs: this.db
          .childPaths(this.path)
          .map((path) => new FakeDocRef(this.db, path))
          .sort((a, b) =>
            String(this.db.docs.get(a.path)?.[field] ?? '').localeCompare(
              String(this.db.docs.get(b.path)?.[field] ?? ''),
            ),
          )
          .map((ref) => ({ id: ref.id, data: () => ({ ...this.db.docs.get(ref.path) }) })),
      }),
    };
  }
}

class FakeDocRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  async get() {
    const data = this.db.docs.get(this.path);
    return {
      exists: data !== undefined,
      id: this.id,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  async set(data: DocData): Promise<void> {
    this.db.docs.set(this.path, { ...data });
  }

  async update(data: DocData): Promise<void> {
    this.db.applyUpdate(this.path, data);
  }

  async delete(): Promise<void> {
    this.db.docs.delete(this.path);
  }
}

/* ------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

const SITE = 'site-a';
const TALONS_PATH = `sites/${SITE}/talons`;
const SECRETS_PATH = `sites/${SITE}/talon_secrets`;

const ADMIN: Actor = { type: 'user', userId: 'admin-uid', role: 'admin', sites: [SITE] };
const MEMBER: Actor = { type: 'user', userId: 'member-uid', role: 'member', sites: [SITE] };

let fake: FakeFirestore;
let db: Firestore;

function ctxFor(actor: Actor = ADMIN, overrides: Partial<TalonStoreContext> = {}): TalonStoreContext {
  return {
    siteId: SITE,
    actor,
    auditActor: `user:${actor.type === 'user' ? actor.userId : actor.name}`,
    via: 'ui',
    ...overrides,
  };
}

function talonInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'nightly check',
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    ...overrides,
  };
}

function storedTalon(id: string): TalonDoc {
  return fake.docs.get(`${TALONS_PATH}/${id}`) as unknown as TalonDoc;
}

function seedTalon(id: string, overrides: Partial<TalonDoc> = {}): void {
  const now = new Date('2026-08-01T00:00:00Z');
  fake.docs.set(`${TALONS_PATH}/${id}`, {
    schemaVersion: 1,
    name: id,
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    ...overrides,
  } as unknown as DocData);
}

async function expectStoreError(
  promise: Promise<unknown>,
  code: TalonStoreErrorCode,
  status: number,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TalonStoreError);
  await promise.catch((error: TalonStoreError) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });
}

function auditAttributes(callIndex = 0): Record<string, unknown> {
  return mockEmitMutation.mock.calls[callIndex][0].attributes as Record<string, unknown>;
}

beforeEach(() => {
  fake = new FakeFirestore();
  db = fake as unknown as Firestore;
  mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-test' });
  mockValidateWebhookUrl.mockResolvedValue({
    ok: true,
    url: 'https://hooks.example.com/t',
    hostname: 'hooks.example.com',
  });
});

afterEach(() => {
  jest.useRealTimers();
});

/* ------------------------------------------------------------------------- */
/*  createTalon                                                               */
/* ------------------------------------------------------------------------- */

describe('createTalon', () => {
  it('persists the normalized input plus the server-owned fields', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        name: '  morning check  ',
        description: '  keeps the lobby wall alive  ',
        trigger: {
          type: 'schedule',
          entries: [{ id: 'e1', days: ['wed', 'mon', 'mon'], time: '09:00' }],
        },
      }),
    );

    const doc = storedTalon(created.id);
    // Normalization is the validator's — the store must persist its output.
    expect(doc.name).toBe('morning check');
    expect(doc.description).toBe('keeps the lobby wall alive');
    expect(doc.trigger).toEqual({
      type: 'schedule',
      entries: [{ id: 'e1', days: ['mon', 'wed'], time: '09:00' }],
    });
    // Defaults the caller never sent.
    expect(doc.enabled).toBe(true);
    expect(doc.cooldownMinutes).toBe(60);
    expect(doc.scope).toEqual({ machineIds: null });
    // Server-stamped fields.
    expect(doc.schemaVersion).toBe(1);
    expect(doc.createdBy).toBe('admin-uid');
    expect(doc.createdVia).toBe('ui');
    expect(doc.consecutiveFailures).toBe(0);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(created).toEqual({ id: created.id, ...doc });
  });

  it('rejects server-owned fields sent by the caller', async () => {
    await expectStoreError(
      createTalon(db, ctxFor(), talonInput({ createdBy: 'someone-else', schemaVersion: 9 })),
      'invalid_talon',
      400,
    );
    expect(fake.docs.size).toBe(0);
  });

  it('reports every field error on invalid input', async () => {
    const error = await createTalon(db, ctxFor(), { name: '' }).catch(
      (caught: TalonStoreError) => caught,
    );
    expect(error).toBeInstanceOf(TalonStoreError);
    expect((error as TalonStoreError).fieldErrors?.length).toBeGreaterThan(1);
  });

  it('stamps nextRunAt for a schedule trigger', async () => {
    const before = Date.now();
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({ trigger: { type: 'schedule', intervalMinutes: 30 } }),
    );
    const nextRunAt = created.nextRunAt as Date;
    expect(nextRunAt).toBeInstanceOf(Date);
    expect(nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  it('resolves clock-time entries against the site timezone', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-10T12:00:00Z') });
    fake.docs.set(`sites/${SITE}`, { timezone: 'America/New_York' });

    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        trigger: { type: 'schedule', entries: [{ id: 'e1', days: ['mon'], time: '09:00' }] },
      }),
    );

    // 09:00 EDT on the same Monday — 13:00Z, not 09:00Z.
    expect((created.nextRunAt as Date).toISOString()).toBe('2026-08-10T13:00:00.000Z');
  });

  it('falls back to UTC when the site has no timezone', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-10T12:00:00Z') });

    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        trigger: { type: 'schedule', entries: [{ id: 'e1', days: ['mon'], time: '09:00' }] },
      }),
    );

    // 09:00 UTC has already passed, so the next fire is the following Monday.
    expect((created.nextRunAt as Date).toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('omits nextRunAt entirely for non-schedule triggers', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
      }),
    );
    // Absent, not null: null would satisfy the sweep's `nextRunAt <= now` filter.
    expect('nextRunAt' in storedTalon(created.id)).toBe(false);
    expect('nextRunAt' in created).toBe(false);
  });

  it('mints a webhook signing secret in talon_secrets and keeps it off the talon', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({ outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] }),
    );

    const secretDoc = fake.docs.get(`${SECRETS_PATH}/${created.id}`);
    expect(secretDoc).toBeDefined();
    expect(secretDoc?.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(secretDoc?.talonId).toBe(created.id);

    // The secret must not leak onto the talon document or the return value.
    expect(JSON.stringify(storedTalon(created.id))).not.toContain('whsec_');
    expect(JSON.stringify(created)).not.toContain('whsec_');
    expect(Object.keys(storedTalon(created.id))).not.toContain('secret');
  });

  it('does not mint a secret when there is no webhook output', async () => {
    const created = await createTalon(db, ctxFor(), talonInput());
    expect(fake.docs.has(`${SECRETS_PATH}/${created.id}`)).toBe(false);
  });

  it('runs the full SSRF check on webhook urls', async () => {
    mockValidateWebhookUrl.mockResolvedValue({
      ok: false,
      reason: 'private_ip',
      detail: 'hooks.internal resolves to private ipv4 10.0.0.5',
    });

    await expectStoreError(
      createTalon(
        db,
        ctxFor(),
        talonInput({ outputs: [{ type: 'webhook', url: 'https://hooks.internal/t' }] }),
      ),
      'invalid_webhook_url',
      400,
    );
    expect(mockValidateWebhookUrl).toHaveBeenCalledWith('https://hooks.internal/t');
    expect(fake.docs.size).toBe(0);
  });

  it('enforces the per-site talon cap', async () => {
    for (let index = 0; index < MAX_TALONS_PER_SITE; index++) seedTalon(`talon-${index}`);

    await expectStoreError(createTalon(db, ctxFor(), talonInput()), 'talon_limit_reached', 409);
    expect(fake.childPaths(TALONS_PATH)).toHaveLength(MAX_TALONS_PER_SITE);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('allows a create that fills the last slot', async () => {
    for (let index = 0; index < MAX_TALONS_PER_SITE - 1; index++) seedTalon(`talon-${index}`);
    await expect(createTalon(db, ctxFor(), talonInput())).resolves.toBeDefined();
  });

  it('refuses command outputs authored by a non-admin', async () => {
    await expectStoreError(
      createTalon(
        db,
        ctxFor(MEMBER),
        talonInput({ outputs: [{ type: 'command', commandType: 'restart_process' }] }),
      ),
      'command_output_forbidden',
      403,
    );
    expect(fake.docs.size).toBe(0);
  });

  it('allows command outputs authored by a site admin', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
      }),
    );
    expect(storedTalon(created.id).outputs).toEqual([
      { type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' },
    ]);
  });

  it('refuses command outputs from an admin of a different site', async () => {
    const otherSiteAdmin: Actor = {
      type: 'user',
      userId: 'admin-elsewhere',
      role: 'admin',
      sites: ['site-b'],
    };
    await expectStoreError(
      createTalon(
        db,
        ctxFor(otherSiteAdmin),
        talonInput({ outputs: [{ type: 'command', commandType: 'stop_process' }] }),
      ),
      'command_output_forbidden',
      403,
    );
  });

  it('requires a usable site llm key for a visual_check condition', async () => {
    mockResolveLlmConfig.mockRejectedValue(
      new Error('No site-level LLM API key configured. Autonomous cortex requires a site-level key.'),
    );

    await expectStoreError(
      createTalon(
        db,
        ctxFor(),
        talonInput({
          condition: { type: 'visual_check', expectation: 'the wall shows the show loop' },
          trigger: { type: 'schedule', intervalMinutes: 30 },
        }),
      ),
      'site_llm_key_required',
      400,
    );
    expect(mockResolveLlmConfig).toHaveBeenCalledWith(db, null, SITE, { autonomous: true });
    expect(fake.docs.size).toBe(0);
  });

  it('requires a usable site llm key for a cortex output', async () => {
    mockResolveLlmConfig.mockRejectedValue(new Error('Failed to decrypt site-level LLM API key.'));

    await expectStoreError(
      createTalon(
        db,
        ctxFor(),
        talonInput({ outputs: [{ type: 'cortex', directive: 'investigate the black screen' }] }),
      ),
      'site_llm_key_required',
      400,
    );
  });

  it('does not consult the llm config for talons that never call the model', async () => {
    await createTalon(db, ctxFor(), talonInput());
    expect(mockResolveLlmConfig).not.toHaveBeenCalled();
  });

  it('emits a talon.create audit', async () => {
    const created = await createTalon(db, ctxFor(), talonInput());

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'talon_mutated',
        siteId: SITE,
        actor: 'user:admin-uid',
        targetId: created.id,
      }),
    );
    expect(auditAttributes()).toEqual({
      verb: 'talon.create',
      endpoint: `/api/sites/${SITE}/talons`,
      method: 'POST',
      via: 'ui',
    });
  });

  it('records the cortex provenance when cortex authors the talon', async () => {
    const created = await createTalon(
      db,
      ctxFor(ADMIN, { via: 'cortex', chatId: 'chat-7', auditActor: 'cortex:user_admin-uid' }),
      talonInput(),
    );

    expect(storedTalon(created.id).createdVia).toBe('cortex');
    expect(storedTalon(created.id).chatId).toBe('chat-7');
    expect(auditAttributes()).toMatchObject({ via: 'cortex', chatId: 'chat-7' });
  });
});

/* ------------------------------------------------------------------------- */
/*  updateTalon                                                               */
/* ------------------------------------------------------------------------- */

describe('updateTalon', () => {
  it('rejects an unknown talon', async () => {
    await expectStoreError(
      updateTalon(db, ctxFor(), 'missing', talonInput()),
      'talon_not_found',
      404,
    );
  });

  it('replaces the caller-owned fields and bumps updatedAt', async () => {
    seedTalon('t1');
    const updated = await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({ name: 'renamed', cooldownMinutes: 15 }),
    );

    expect(updated.name).toBe('renamed');
    expect(updated.cooldownMinutes).toBe(15);
    expect(updated.id).toBe('t1');
    // Run bookkeeping and creation provenance survive an edit.
    expect(updated.createdBy).toBe('admin-uid');
    expect(updated.consecutiveFailures).toBe(0);
    expect((updated.updatedAt as Date).getTime()).toBeGreaterThan(
      new Date('2026-08-01T00:00:00Z').getTime(),
    );
  });

  it('recomputes nextRunAt when the trigger changes', async () => {
    seedTalon('t1', { nextRunAt: new Date('2020-01-01T00:00:00Z') });

    const before = Date.now();
    const updated = await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({ trigger: { type: 'schedule', intervalMinutes: 120 } }),
    );

    expect((updated.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 120 * 60_000);
  });

  it('leaves nextRunAt alone when the trigger is unchanged', async () => {
    const stale = new Date('2026-08-09T00:00:00Z');
    seedTalon('t1', { nextRunAt: stale });

    const updated = await updateTalon(db, ctxFor(), 't1', talonInput({ name: 'renamed' }));

    expect(updated.nextRunAt).toEqual(stale);
  });

  it('removes nextRunAt when the trigger stops being a schedule', async () => {
    seedTalon('t1', { nextRunAt: new Date('2026-08-09T00:00:00Z') });

    await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({
        trigger: { type: 'event', eventTypes: ['process_crash'] },
      }),
    );

    expect('nextRunAt' in storedTalon('t1')).toBe(false);
  });

  it('clears a description that was removed', async () => {
    seedTalon('t1', { description: 'old copy' });
    await updateTalon(db, ctxFor(), 't1', talonInput());
    expect('description' in storedTalon('t1')).toBe(false);
  });

  it('emits a talon.update audit listing only the changed fields', async () => {
    seedTalon('t1');
    await updateTalon(db, ctxFor(), 't1', talonInput({ name: 'renamed', cooldownMinutes: 15 }));

    expect(auditAttributes()).toEqual({
      verb: 'talon.update',
      endpoint: `/api/sites/${SITE}/talons/t1`,
      method: 'PATCH',
      changedFields: ['name', 'cooldownMinutes'],
      via: 'ui',
    });
  });

  it('reports an empty changed-field list for a no-op edit', async () => {
    seedTalon('t1', { name: 'nightly check' });
    await updateTalon(db, ctxFor(), 't1', talonInput());
    expect(auditAttributes().changedFields).toEqual([]);
  });

  it('mints a secret when a webhook output is added later', async () => {
    seedTalon('t1');
    await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({ outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] }),
    );

    expect(fake.docs.get(`${SECRETS_PATH}/t1`)?.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(JSON.stringify(storedTalon('t1'))).not.toContain('whsec_');
  });

  it('keeps an existing secret stable across edits', async () => {
    seedTalon('t1', { outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] });
    fake.docs.set(`${SECRETS_PATH}/t1`, { talonId: 't1', secret: `whsec_${'a'.repeat(64)}` });

    await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({
        name: 'renamed',
        outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
      }),
    );

    expect(fake.docs.get(`${SECRETS_PATH}/t1`)?.secret).toBe(`whsec_${'a'.repeat(64)}`);
  });

  it('refuses to add a command output as a non-admin', async () => {
    seedTalon('t1');
    await expectStoreError(
      updateTalon(
        db,
        ctxFor(MEMBER),
        't1',
        talonInput({ outputs: [{ type: 'command', commandType: 'restart_process' }] }),
      ),
      'command_output_forbidden',
      403,
    );
    expect(storedTalon('t1').outputs).toEqual([{ type: 'email' }]);
  });

  it('refuses an edit that adds a cortex output without a site llm key', async () => {
    seedTalon('t1');
    mockResolveLlmConfig.mockRejectedValue(new Error('No site-level LLM API key configured.'));

    await expectStoreError(
      updateTalon(
        db,
        ctxFor(),
        't1',
        talonInput({ outputs: [{ type: 'cortex', directive: 'restart the show' }] }),
      ),
      'site_llm_key_required',
      400,
    );
    expect(storedTalon('t1').outputs).toEqual([{ type: 'email' }]);
  });
});

/* ------------------------------------------------------------------------- */
/*  setTalonEnabled                                                           */
/* ------------------------------------------------------------------------- */

describe('setTalonEnabled', () => {
  it('rejects an unknown talon', async () => {
    await expectStoreError(
      setTalonEnabled(db, ctxFor(), 'missing', true),
      'talon_not_found',
      404,
    );
  });

  it('re-arms a stale nextRunAt when enabling', async () => {
    seedTalon('t1', { enabled: false, nextRunAt: new Date('2020-01-01T00:00:00Z') });

    const before = Date.now();
    const updated = await setTalonEnabled(db, ctxFor(), 't1', true);

    expect(updated.enabled).toBe(true);
    expect((updated.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000);
  });

  it('removes nextRunAt when enabling a non-schedule talon', async () => {
    seedTalon('t1', {
      enabled: false,
      trigger: { type: 'event', eventTypes: ['machine_offline'] },
      nextRunAt: new Date('2020-01-01T00:00:00Z'),
    });

    await setTalonEnabled(db, ctxFor(), 't1', true);

    expect('nextRunAt' in storedTalon('t1')).toBe(false);
  });

  it('leaves nextRunAt untouched when disabling', async () => {
    const stale = new Date('2020-01-01T00:00:00Z');
    seedTalon('t1', { nextRunAt: stale });

    const updated = await setTalonEnabled(db, ctxFor(), 't1', false);

    expect(updated.enabled).toBe(false);
    expect(updated.nextRunAt).toEqual(stale);
    expect(mockResolveLlmConfig).not.toHaveBeenCalled();
  });

  it('refuses to enable a talon whose site llm key is gone', async () => {
    seedTalon('t1', {
      enabled: false,
      condition: { type: 'visual_check', expectation: 'the loop is playing' },
    });
    mockResolveLlmConfig.mockRejectedValue(new Error('No site-level LLM API key configured.'));

    await expectStoreError(
      setTalonEnabled(db, ctxFor(), 't1', true),
      'site_llm_key_required',
      400,
    );
    expect(storedTalon('t1').enabled).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('emits talon.enable and talon.disable audits', async () => {
    seedTalon('t1');

    await setTalonEnabled(db, ctxFor(), 't1', true);
    expect(auditAttributes()).toEqual({
      verb: 'talon.enable',
      endpoint: `/api/sites/${SITE}/talons/t1`,
      method: 'PATCH',
      changedFields: ['enabled'],
      via: 'ui',
    });

    await setTalonEnabled(db, ctxFor(), 't1', false);
    expect(auditAttributes(1)).toMatchObject({ verb: 'talon.disable' });
  });
});

/* ------------------------------------------------------------------------- */
/*  deleteTalon                                                               */
/* ------------------------------------------------------------------------- */

describe('deleteTalon', () => {
  it('rejects an unknown talon', async () => {
    await expectStoreError(deleteTalon(db, ctxFor(), 'missing'), 'talon_not_found', 404);
  });

  it('deletes the talon and its signing secret', async () => {
    seedTalon('t1', { outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] });
    fake.docs.set(`${SECRETS_PATH}/t1`, { talonId: 't1', secret: `whsec_${'b'.repeat(64)}` });
    seedTalon('t2');

    await deleteTalon(db, ctxFor(), 't1');

    expect(fake.docs.has(`${TALONS_PATH}/t1`)).toBe(false);
    expect(fake.docs.has(`${SECRETS_PATH}/t1`)).toBe(false);
    expect(fake.docs.has(`${TALONS_PATH}/t2`)).toBe(true);
    expect(auditAttributes()).toEqual({
      verb: 'talon.delete',
      endpoint: `/api/sites/${SITE}/talons/t1`,
      method: 'DELETE',
      via: 'ui',
    });
  });

  it('deletes a secretless talon without complaining', async () => {
    seedTalon('t1');
    await expect(deleteTalon(db, ctxFor(), 't1')).resolves.toBeUndefined();
    expect(fake.docs.has(`${TALONS_PATH}/t1`)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/*  reads                                                                     */
/* ------------------------------------------------------------------------- */

describe('getTalon / listTalons', () => {
  it('returns null for a talon that does not exist', async () => {
    await expect(getTalon(db, SITE, 'missing')).resolves.toBeNull();
  });

  it('returns the talon with its id', async () => {
    seedTalon('t1', { name: 'lobby watch' });
    await expect(getTalon(db, SITE, 't1')).resolves.toMatchObject({
      id: 't1',
      name: 'lobby watch',
    });
  });

  it('lists the site talons ordered by name', async () => {
    seedTalon('t1', { name: 'zebra' });
    seedTalon('t2', { name: 'alpha' });
    seedTalon('t3', { name: 'mango' });

    const talons = await listTalons(db, SITE);

    expect(talons.map((talon) => talon.name)).toEqual(['alpha', 'mango', 'zebra']);
    expect(talons.map((talon) => talon.id)).toEqual(['t2', 't3', 't1']);
  });

  it('returns an empty list for a site with no talons', async () => {
    await expect(listTalons(db, SITE)).resolves.toEqual([]);
  });
});
