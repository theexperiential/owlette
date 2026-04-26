/** @jest-environment node */

/**
 * Tests for the deployment template action cores
 * (web/lib/actions/{create,update,delete}DeploymentTemplate.server.ts).
 *
 * Note the firestore path is `sites/{siteId}/installer_templates`, not
 * the `config/{siteId}/...` path used by schedule + reboot presets.
 *
 * security-boundary-migration wave 3.6.
 */

interface MockDoc {
  exists: boolean;
  data: () => Record<string, unknown>;
}

const setCalls: Array<{ path: string; payload: Record<string, unknown>; merge?: boolean }> = [];
const deleteCalls: Array<{ path: string }> = [];
const docState: Map<string, MockDoc> = new Map();

function makeDoc(path: string) {
  return {
    get: async () => docState.get(path) ?? { exists: false, data: () => ({}) },
    set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
      setCalls.push({ path, payload, merge: opts?.merge });
      docState.set(path, { exists: true, data: () => payload });
    },
    delete: async () => {
      deleteCalls.push({ path });
      docState.delete(path);
    },
  };
}

function makeCollection(path: string) {
  return { doc: (id: string) => makeDoc(`${path}/${id}`) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => ({
      doc: (siteId: string) => ({
        collection: (sub: string) => makeCollection(`${top}/${siteId}/${sub}`),
      }),
    }),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

import {
  createDeploymentTemplate,
  DeploymentTemplateValidationError,
} from '@/lib/actions/createDeploymentTemplate.server';
import {
  updateDeploymentTemplate,
  DeploymentTemplateNotFoundError,
} from '@/lib/actions/updateDeploymentTemplate.server';
import { deleteDeploymentTemplate } from '@/lib/actions/deleteDeploymentTemplate.server';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

const ctx: SiteHandlerContext = {
  actor: { type: 'user', userId: 'uid_alice', role: 'admin', sites: ['site-a'] },
  siteId: 'site-a',
  correlationId: 'cid_1',
  auth: { userId: 'uid_alice', keyContext: null },
  scopeCheck: { isLegacy: false },
};

beforeEach(() => {
  setCalls.length = 0;
  deleteCalls.length = 0;
  docState.clear();
});

describe('createDeploymentTemplate', () => {
  it('creates a template under sites/{siteId}/installer_templates', async () => {
    const result = await createDeploymentTemplate(ctx, {
      name: 'TouchDesigner 2023',
      installer_name: 'TouchDesigner.exe',
      installer_url: 'https://example.com/installer.exe',
      silent_flags: '/S',
    });
    expect(result.siteId).toBe('site-a');
    expect(result.templateId).toMatch(/^template-\d+$/);
    expect(setCalls).toHaveLength(1);
    const call = setCalls[0];
    expect(call.path.startsWith('sites/site-a/installer_templates/template-')).toBe(true);
    expect(call.merge).toBeUndefined();
    expect(call.payload.installer_url).toBe('https://example.com/installer.exe');
    expect(call.payload.createdAt).toBe('__SERVER_TS__');
  });

  it('rejects non-https installer_url', async () => {
    await expect(
      createDeploymentTemplate(ctx, {
        name: 'x',
        installer_name: 'x.exe',
        installer_url: 'http://example.com/x.exe',
        silent_flags: '/S',
      }),
    ).rejects.toBeInstanceOf(DeploymentTemplateValidationError);
  });

  it('rejects malformed installer_url', async () => {
    await expect(
      createDeploymentTemplate(ctx, {
        name: 'x',
        installer_name: 'x.exe',
        installer_url: 'not a url',
        silent_flags: '/S',
      }),
    ).rejects.toBeInstanceOf(DeploymentTemplateValidationError);
  });

  it('rejects bad close_processes', async () => {
    await expect(
      createDeploymentTemplate(ctx, {
        name: 'x',
        installer_name: 'x.exe',
        installer_url: 'https://example.com/x.exe',
        silent_flags: '/S',
        // @ts-expect-error — testing runtime rejection of bad type
        close_processes: [123],
      }),
    ).rejects.toBeInstanceOf(DeploymentTemplateValidationError);
  });
});

describe('updateDeploymentTemplate', () => {
  it('uses setDoc({merge: true}) when the template exists', async () => {
    docState.set('sites/site-a/installer_templates/template-1', {
      exists: true,
      data: () => ({ name: 'old' }),
    });
    const result = await updateDeploymentTemplate(ctx, 'template-1', {
      name: 'new name',
    });
    expect(result.templateId).toBe('template-1');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.name).toBe('new name');
    expect(setCalls[0].payload.updatedAt).toBe('__SERVER_TS__');
  });

  it('throws DeploymentTemplateNotFoundError when missing', async () => {
    await expect(
      updateDeploymentTemplate(ctx, 'template-missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(DeploymentTemplateNotFoundError);
  });

  it('rejects empty body', async () => {
    await expect(
      updateDeploymentTemplate(ctx, 'template-1', {}),
    ).rejects.toBeInstanceOf(DeploymentTemplateValidationError);
  });

  it('rejects invalid templateId', async () => {
    await expect(
      updateDeploymentTemplate(ctx, 'bad id', { name: 'x' }),
    ).rejects.toBeInstanceOf(DeploymentTemplateValidationError);
  });
});

describe('deleteDeploymentTemplate', () => {
  it('deletes an existing template', async () => {
    docState.set('sites/site-a/installer_templates/template-1', {
      exists: true,
      data: () => ({ name: 'x' }),
    });
    const result = await deleteDeploymentTemplate(ctx, 'template-1');
    expect(result.templateId).toBe('template-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('treats missing docs as a successful idempotent delete', async () => {
    const result = await deleteDeploymentTemplate(ctx, 'template-missing');
    expect(result.templateId).toBe('template-missing');
    expect(deleteCalls).toHaveLength(1);
  });

  it('rejects invalid template id', async () => {
    await expect(
      deleteDeploymentTemplate(ctx, 'bad id'),
    ).rejects.toBeInstanceOf(DeploymentTemplateValidationError);
  });
});
