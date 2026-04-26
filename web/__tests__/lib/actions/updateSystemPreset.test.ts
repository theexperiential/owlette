/** @jest-environment node */

const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDoc = jest.fn(() => ({ update: mockUpdate }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockCollection }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__server_timestamp__' },
}));

import {
  updateSystemPreset,
  SystemPresetNotFoundError,
} from '@/lib/actions/updateSystemPreset.server';
import { SystemPresetValidationError } from '@/lib/actions/createSystemPreset.server';
import type { UserActor } from '@/lib/capabilities';

const actor: UserActor = {
  type: 'user',
  userId: 'user-admin',
  role: 'superadmin',
  sites: [],
};

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockDoc.mockClear();
  mockCollection.mockClear();
});

describe('updateSystemPreset — validation', () => {
  it('rejects malformed presetId', async () => {
    await expect(
      updateSystemPreset(
        { actor, presetId: 'has spaces!' },
        { name: 'whatever' },
      ),
    ).rejects.toThrow(SystemPresetValidationError);
  });

  it.each([
    ['name empty string', { name: '   ' }],
    ['software_name empty string', { software_name: '' }],
    ['category empty string', { category: '' }],
    ['installer_name empty string', { installer_name: '' }],
    ['installer_url wrong type', { installer_url: 5 as unknown as string }],
    ['silent_flags wrong type', { silent_flags: 5 as unknown as string }],
    ['is_owlette_agent wrong type', { is_owlette_agent: 'no' as unknown as boolean }],
    ['order non-finite', { order: NaN }],
    ['description wrong type', { description: 5 as unknown as string }],
    ['close_processes mixed', { close_processes: ['ok', 1 as unknown as string] }],
    [
      'parallel_install wrong type',
      { parallel_install: 1 as unknown as boolean },
    ],
    ['timeout_seconds non-finite', { timeout_seconds: Infinity }],
  ])('rejects when %s', async (_label, partial) => {
    await expect(
      updateSystemPreset({ actor, presetId: 'preset-x' }, partial),
    ).rejects.toThrow(SystemPresetValidationError);
  });
});

describe('updateSystemPreset — firestore write', () => {
  it('writes only provided fields plus updatedAt', async () => {
    await updateSystemPreset(
      { actor, presetId: 'preset-td' },
      { name: '  TD  ', order: 3 },
    );
    expect(mockCollection).toHaveBeenCalledWith('system_presets');
    expect(mockDoc).toHaveBeenCalledWith('preset-td');
    const written = mockUpdate.mock.calls[0][0];
    expect(written).toEqual({
      name: 'TD',
      order: 3,
      updatedAt: '__server_timestamp__',
    });
  });

  it('translates firebase NOT_FOUND into SystemPresetNotFoundError', async () => {
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 5 }));
    await expect(
      updateSystemPreset({ actor, presetId: 'preset-missing' }, { name: 'x' }),
    ).rejects.toBeInstanceOf(SystemPresetNotFoundError);
  });

  it('rethrows non-NOT_FOUND firestore errors', async () => {
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 13 }));
    await expect(
      updateSystemPreset({ actor, presetId: 'preset-x' }, { name: 'y' }),
    ).rejects.toThrow('boom');
  });
});
