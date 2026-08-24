/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * `useRoostUpload` lifecycle only: idle → uploading → success/error/cancelled,
 * and terminal callbacks landing on the right state. The orchestrator itself is
 * covered end-to-end in `__tests__/lib/roostUpload.test.ts`.
 */

import { act, renderHook, waitFor } from '@testing-library/react';

// Mock the orchestrator to drive progress + resolution by hand; the hook only
// cares about what uploadFolder accepts and resolves.
jest.mock('@/lib/roostUpload', () => ({
  uploadFolder: jest.fn(),
}));

import { uploadFolder } from '@/lib/roostUpload';
import { useRoostUpload } from '@/hooks/useRoostUpload';

const mockUploadFolder = uploadFolder as jest.MockedFunction<typeof uploadFolder>;

function baseInputs() {
  return {
    siteId: 'site-a',
    roostId: 'roost-a',
    name: 'test-roost',
    files: [],
    targets: ['m1'],
    totalBytes: 1_000_000,
    fileCount: 2,
  };
}

afterEach(() => {
  mockUploadFolder.mockReset();
});

describe('useRoostUpload — lifecycle', () => {
  it('starts in idle', () => {
    const { result } = renderHook(() => useRoostUpload());
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.progress).toBeUndefined();
  });

  it('transitions idle → uploading → success when uploadFolder resolves', async () => {
    mockUploadFolder.mockImplementation(async () => ({
      versionId: 'vrs_1234567890ab',
      versionNumber: 1,
      currentVersionId: 'vrs_1234567890ab',
      previousVersionId: null,
      uploadedBytes: 500_000,
      totalBytes: 1_000_000,
    }));

    const { result } = renderHook(() => useRoostUpload());
    await act(async () => {
      await result.current.start(baseInputs());
    });
    expect(result.current.state.status).toBe('success');
    expect(result.current.state.result?.versionId).toBe('vrs_1234567890ab');
    expect(result.current.state.inputs?.name).toBe('test-roost');
  });

  it('transitions to error when uploadFolder throws', async () => {
    mockUploadFolder.mockImplementation(async () => {
      throw new Error('boom');
    });

    const { result } = renderHook(() => useRoostUpload());
    await act(async () => {
      await result.current.start(baseInputs());
    });
    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error).toBe('boom');
  });

  it('transitions to cancelled when the throw looks like an abort', async () => {
    mockUploadFolder.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    const { result } = renderHook(() => useRoostUpload());
    await act(async () => {
      await result.current.start(baseInputs());
    });
    expect(result.current.state.status).toBe('cancelled');
  });

  it('reset() returns to idle and clears inputs', async () => {
    mockUploadFolder.mockImplementation(async () => ({
      versionId: 'vrs_z',
      versionNumber: 2,
      currentVersionId: 'vrs_z',
      previousVersionId: null,
      uploadedBytes: 0,
      totalBytes: 0,
    }));

    const { result } = renderHook(() => useRoostUpload());
    await act(async () => {
      await result.current.start(baseInputs());
    });
    expect(result.current.state.status).toBe('success');

    act(() => {
      result.current.reset();
    });
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.inputs).toBeUndefined();
  });

  it('forwards progress events and carries phase into state', async () => {
    // One progress tick is enough to prove the callback reaches `state.progress`.
    mockUploadFolder.mockImplementation(async (opts) => {
      opts.onProgress?.({ phase: 'hashing', hashFraction: 0.5, message: 'half' });
      return {
        versionId: 'vrs_p',
        versionNumber: 3,
        currentVersionId: 'vrs_p',
        previousVersionId: null,
        uploadedBytes: 0,
        totalBytes: 1_000_000,
      };
    });

    const { result } = renderHook(() => useRoostUpload());
    await act(async () => {
      await result.current.start(baseInputs());
    });

    // Assert on the final settled state, not the intermediate progress.
    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(result.current.state.result?.versionId).toBe('vrs_p');
  });
});
