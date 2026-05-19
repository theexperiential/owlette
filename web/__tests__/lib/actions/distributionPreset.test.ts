/** @jest-environment node */

/**
 * Unit tests for the distribution preset action cores
 * (`web/lib/actions/{create,update,delete}DistributionPreset.server.ts`).
 *
 * security-boundary-migration wave 3.7. Mirrors 3.6 schedule/reboot preset
 * tests — only the firestore path differs.
 *
 * Coverage:
 *   - createDistributionPreset
 *     - happy path: writes to config/{siteId}/project_distribution_presets/<id>
 *     - generates id from name slug + timestamp
 *     - strips undefined optional fields before write
 *     - stamps createdBy from actor + serverTimestamp createdAt
 *     - validation: empty name, oversized name, non-string fields, bad
 *       verify_files array, non-finite order, name with no alphanumerics
 *   - updateDistributionPreset
 *     - built-in override: setDoc merge with isBuiltIn forced to true
 *     - custom edit: update() with serverTimestamp updatedAt
 *     - custom edit on missing doc → DistributionPresetNotFoundError
 *     - validation: invalid presetId, bad partial fields
 *   - deleteDistributionPreset
 *     - calls delete() on the doc
 *     - validation: invalid presetId
 */

import {
  createDistributionPreset,
  DistributionPresetValidationError,
} from '@/lib/actions/createDistributionPreset.server';
import {
  updateDistributionPreset,
  DistributionPresetNotFoundError,
} from '@/lib/actions/updateDistributionPreset.server';
import { deleteDistributionPreset } from '@/lib/actions/deleteDistributionPreset.server';
import type { UserActor } from '@/lib/capabilities';

interface RecordedSet {
  path: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}
interface RecordedUpdate {
  path: string;
  payload: Record<string, unknown>;
}

const setCalls: RecordedSet[] = [];
const updateCalls: RecordedUpdate[] = [];
const deleteCalls: { path: string }[] = [];

let updateShouldThrow: { code?: number | string } | Error | null = null;

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
  },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => buildCollectionRoot(),
}));

function buildCollectionRoot() {
  return {
    collection: (name: string) => buildCollection(name),
  };
}

function buildCollection(path: string): unknown {
  return {
    doc: (id: string) => buildDoc(`${path}/${id}`),
  };
}

function buildDoc(path: string): unknown {
  return {
    collection: (sub: string) => buildCollection(`${path}/${sub}`),
    set: (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
      setCalls.push({ path, payload, options });
      return Promise.resolve();
    },
    update: (payload: Record<string, unknown>) => {
      updateCalls.push({ path, payload });
      if (updateShouldThrow) {
        return Promise.reject(updateShouldThrow);
      }
      return Promise.resolve();
    },
    delete: () => {
      deleteCalls.push({ path });
      return Promise.resolve();
    },
  };
}

const ACTOR: UserActor = {
  type: 'user',
  userId: 'uid_alice',
  role: 'admin',
  sites: ['site-a'],
};

beforeEach(() => {
  setCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  updateShouldThrow = null;
});

/* ------------------------------------------------------------------------- */
/*  createDistributionPreset                                                 */
/* ------------------------------------------------------------------------- */

describe('createDistributionPreset', () => {
  it('writes a preset to config/{siteId}/project_distribution_presets/<id>', async () => {
    const result = await createDistributionPreset(
      { actor: ACTOR, siteId: 'site-a' },
      {
        name: 'My Custom Preset',
        description: 'a thing',
        project_url: 'https://example.com/project.zip',
        extract_path: 'C:\\Projects',
        verify_files: ['main.toe'],
        order: 1,
      },
    );

    expect(result.presetId).toMatch(/^projdist-my-custom-preset-\d+$/);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe(
      `config/site-a/project_distribution_presets/${result.presetId}`,
    );
    expect(setCalls[0].payload).toMatchObject({
      name: 'My Custom Preset',
      description: 'a thing',
      project_url: 'https://example.com/project.zip',
      extract_path: 'C:\\Projects',
      verify_files: ['main.toe'],
      order: 1,
      isBuiltIn: false,
      createdBy: 'uid_alice',
      createdAt: '__SERVER_TS__',
    });
  });

  it('strips undefined optional fields before writing', async () => {
    await createDistributionPreset(
      { actor: ACTOR, siteId: 'site-a' },
      { name: 'Bare', order: 0 },
    );
    expect(setCalls).toHaveLength(1);
    const payload = setCalls[0].payload;
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('project_url');
    expect(payload).not.toHaveProperty('extract_path');
    expect(payload).not.toHaveProperty('verify_files');
    expect(payload).toMatchObject({
      name: 'Bare',
      order: 0,
      isBuiltIn: false,
      createdBy: 'uid_alice',
    });
  });

  it('trims the preset name', async () => {
    await createDistributionPreset(
      { actor: ACTOR, siteId: 'site-a' },
      { name: '  Padded  ', order: 0 },
    );
    expect(setCalls[0].payload.name).toBe('Padded');
  });

  it('honors isBuiltIn=true when caller passes it', async () => {
    await createDistributionPreset(
      { actor: ACTOR, siteId: 'site-a' },
      { name: 'BuiltIn-ish', order: 0, isBuiltIn: true },
    );
    expect(setCalls[0].payload.isBuiltIn).toBe(true);
  });

  describe('validation', () => {
    it('rejects empty name', async () => {
      await expect(
        createDistributionPreset({ actor: ACTOR, siteId: 'site-a' }, { name: '', order: 0 }),
      ).rejects.toThrow(DistributionPresetValidationError);
    });

    it('rejects whitespace-only name', async () => {
      await expect(
        createDistributionPreset({ actor: ACTOR, siteId: 'site-a' }, { name: '   ', order: 0 }),
      ).rejects.toThrow(DistributionPresetValidationError);
    });

    it('rejects oversized name', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'x'.repeat(101), order: 0 },
        ),
      ).rejects.toThrow(/100 chars/);
    });

    it('rejects name with no alphanumerics', async () => {
      await expect(
        createDistributionPreset({ actor: ACTOR, siteId: 'site-a' }, { name: '---', order: 0 }),
      ).rejects.toThrow(/alphanumeric/);
    });

    it('rejects non-string description', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok', order: 0, description: 123 as unknown as string },
        ),
      ).rejects.toThrow(/description/);
    });

    it('rejects non-string project_url', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok', order: 0, project_url: 5 as unknown as string },
        ),
      ).rejects.toThrow(/project_url/);
    });

    it('rejects non-string extract_path', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok', order: 0, extract_path: {} as unknown as string },
        ),
      ).rejects.toThrow(/extract_path/);
    });

    it('rejects non-array verify_files', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok', order: 0, verify_files: 'main.toe' as unknown as string[] },
        ),
      ).rejects.toThrow(/verify_files/);
    });

    it('rejects verify_files with non-string entries', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok', order: 0, verify_files: ['main.toe', 1 as unknown as string] },
        ),
      ).rejects.toThrow(/verify_files/);
    });

    it('rejects non-finite order', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok', order: Infinity },
        ),
      ).rejects.toThrow(/order/);
    });

    it('rejects missing order', async () => {
      await expect(
        createDistributionPreset(
          { actor: ACTOR, siteId: 'site-a' },
          { name: 'ok' } as unknown as { name: string; order: number },
        ),
      ).rejects.toThrow(/order/);
    });
  });
});

/* ------------------------------------------------------------------------- */
/*  updateDistributionPreset                                                 */
/* ------------------------------------------------------------------------- */

describe('updateDistributionPreset', () => {
  it('built-in override: setDoc merge with isBuiltIn=true forced', async () => {
    await updateDistributionPreset(
      { actor: ACTOR, siteId: 'site-a', presetId: 'builtin-touchdesigner-project' },
      { name: 'TD overridden', order: 0, project_url: 'https://x' },
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].path).toBe(
      'config/site-a/project_distribution_presets/builtin-touchdesigner-project',
    );
    expect(setCalls[0].options).toEqual({ merge: true });
    expect(setCalls[0].payload).toMatchObject({
      name: 'TD overridden',
      order: 0,
      project_url: 'https://x',
      isBuiltIn: true,
      updatedAt: '__SERVER_TS__',
    });
  });

  it('custom edit: update() with serverTimestamp updatedAt', async () => {
    await updateDistributionPreset(
      { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-mine-12345' },
      { name: 'renamed' },
    );
    expect(updateCalls).toHaveLength(1);
    expect(setCalls).toHaveLength(0);
    expect(updateCalls[0].path).toBe(
      'config/site-a/project_distribution_presets/projdist-mine-12345',
    );
    expect(updateCalls[0].payload).toMatchObject({
      name: 'renamed',
      updatedAt: '__SERVER_TS__',
    });
    // partial update should not include unspecified fields
    expect(updateCalls[0].payload).not.toHaveProperty('order');
    expect(updateCalls[0].payload).not.toHaveProperty('isBuiltIn');
  });

  it('custom edit: throws DistributionPresetNotFoundError when doc missing', async () => {
    updateShouldThrow = { code: 5 };
    await expect(
      updateDistributionPreset(
        { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-ghost' },
        { name: 'renamed' },
      ),
    ).rejects.toThrow(DistributionPresetNotFoundError);
  });

  it('custom edit: maps NOT_FOUND string code as well', async () => {
    updateShouldThrow = { code: 'not-found' };
    await expect(
      updateDistributionPreset(
        { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-ghost' },
        { name: 'renamed' },
      ),
    ).rejects.toThrow(DistributionPresetNotFoundError);
  });

  it('custom edit: re-throws non-NOT_FOUND firestore errors verbatim', async () => {
    updateShouldThrow = new Error('connection lost');
    await expect(
      updateDistributionPreset(
        { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-real' },
        { name: 'renamed' },
      ),
    ).rejects.toThrow('connection lost');
  });

  it('strips undefined fields from partial update', async () => {
    await updateDistributionPreset(
      { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-mine-12345' },
      { project_url: 'https://x' },
    );
    expect(updateCalls[0].payload).not.toHaveProperty('name');
    expect(updateCalls[0].payload).not.toHaveProperty('description');
    expect(updateCalls[0].payload).not.toHaveProperty('verify_files');
    expect(updateCalls[0].payload).toMatchObject({ project_url: 'https://x' });
  });

  describe('validation', () => {
    it('rejects malformed presetId', async () => {
      await expect(
        updateDistributionPreset(
          { actor: ACTOR, siteId: 'site-a', presetId: 'bad id with spaces' },
          { name: 'ok' },
        ),
      ).rejects.toThrow(/presetId/);
    });

    it('rejects empty-string name on partial update', async () => {
      await expect(
        updateDistributionPreset(
          { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-x-1' },
          { name: '' },
        ),
      ).rejects.toThrow(/name/);
    });

    it('rejects bad verify_files on partial update', async () => {
      await expect(
        updateDistributionPreset(
          { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-x-1' },
          { verify_files: [1 as unknown as string] },
        ),
      ).rejects.toThrow(/verify_files/);
    });

    it('rejects non-finite order on partial update', async () => {
      await expect(
        updateDistributionPreset(
          { actor: ACTOR, siteId: 'site-a', presetId: 'projdist-x-1' },
          { order: NaN },
        ),
      ).rejects.toThrow(/order/);
    });
  });
});

/* ------------------------------------------------------------------------- */
/*  deleteDistributionPreset                                                 */
/* ------------------------------------------------------------------------- */

describe('deleteDistributionPreset', () => {
  it('calls delete on the preset doc', async () => {
    await deleteDistributionPreset({
      actor: ACTOR,
      siteId: 'site-a',
      presetId: 'projdist-mine-12345',
    });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].path).toBe(
      'config/site-a/project_distribution_presets/projdist-mine-12345',
    );
  });

  it('also handles built-in preset ids (deleting an override)', async () => {
    await deleteDistributionPreset({
      actor: ACTOR,
      siteId: 'site-a',
      presetId: 'builtin-touchdesigner-project',
    });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].path).toBe(
      'config/site-a/project_distribution_presets/builtin-touchdesigner-project',
    );
  });

  it('rejects malformed presetId', async () => {
    await expect(
      deleteDistributionPreset({
        actor: ACTOR,
        siteId: 'site-a',
        presetId: 'bad id with spaces',
      }),
    ).rejects.toThrow(/presetId/);
  });
});
