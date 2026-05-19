/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Smoke tests for MinimizedUploadCard.
 *
 * The card is driven entirely off a `useRoostUpload` API object — we
 * pass a hand-rolled fake here so each test can pin the exact state it
 * needs without standing up the full orchestrator.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MinimizedUploadCard } from '@/components/MinimizedUploadCard';
import type { UseRoostUploadApi, UploadState } from '@/hooks/useRoostUpload';

function makeUpload(state: UploadState): UseRoostUploadApi & {
  start: jest.Mock;
  cancel: jest.Mock;
  reset: jest.Mock;
} {
  return {
    state,
    start: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
  };
}

describe('MinimizedUploadCard', () => {
  it('renders nothing when idle', () => {
    const upload = makeUpload({ status: 'idle' });
    const { container } = render(
      <MinimizedUploadCard upload={upload} onRestore={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows phase + percentage during uploading', () => {
    const upload = makeUpload({
      status: 'uploading',
      inputs: {
        siteId: 's',
        roostId: 'r',
        name: 'my-roost',
        files: [],
        targets: [],
        totalBytes: 0,
        fileCount: 0,
      },
      progress: { phase: 'hashing', hashFraction: 0.42 },
    });
    render(<MinimizedUploadCard upload={upload} onRestore={jest.fn()} />);
    expect(screen.getByText('my-roost')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('hashing')).toBeInTheDocument();
  });

  it('clicking the card body calls onRestore', async () => {
    const user = userEvent.setup();
    const onRestore = jest.fn();
    const upload = makeUpload({
      status: 'uploading',
      inputs: {
        siteId: 's',
        roostId: 'r',
        name: 'resume-me',
        files: [],
        targets: [],
        totalBytes: 0,
        fileCount: 0,
      },
      progress: { phase: 'uploading', uploadFraction: 0.1 },
    });
    render(<MinimizedUploadCard upload={upload} onRestore={onRestore} />);
    await user.click(screen.getByRole('button', { name: /restore upload/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('cancel X requires a second click to actually cancel', async () => {
    const user = userEvent.setup();
    const upload = makeUpload({
      status: 'uploading',
      inputs: {
        siteId: 's',
        roostId: 'r',
        name: 'r',
        files: [],
        targets: [],
        totalBytes: 0,
        fileCount: 0,
      },
      progress: { phase: 'hashing', hashFraction: 0.1 },
    });
    render(<MinimizedUploadCard upload={upload} onRestore={jest.fn()} />);

    await user.click(screen.getByRole('button', { name: /cancel upload/i }));
    // First click opens the confirm; cancel() should NOT have been called yet.
    expect(upload.cancel).not.toHaveBeenCalled();
    const yes = await screen.findByRole('button', { name: /^yes$/i });
    await user.click(yes);
    expect(upload.cancel).toHaveBeenCalledTimes(1);
  });

  it('error state shows the message and dismiss button', async () => {
    const user = userEvent.setup();
    const upload = makeUpload({
      status: 'error',
      error: 'disk full',
    });
    render(<MinimizedUploadCard upload={upload} onRestore={jest.fn()} />);
    expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
    expect(screen.getByText(/disk full/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(upload.reset).toHaveBeenCalledTimes(1);
  });
});
