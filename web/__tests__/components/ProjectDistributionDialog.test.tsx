/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for ProjectDistributionDialog (roost wave 3.5 revised).
 *
 * Structure:
 *   - top-level tabs: `new deploy` | `history`
 *   - inside `new deploy`: preset bar + name + source picker (url/upload)
 *     + extract path + verify files + target machines (all shared across
 *     sources; source picker only swaps the URL input / upload dropzone).
 *   - `history`: standalone stub (different mental model — past deploys)
 *
 * The distribute button is enabled only on `deploy` + `url` source for
 * now. Upload-source goes live with wave 3.1 (uppy + tus wiring).
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectDistributionDialog from '@/components/ProjectDistributionDialog';

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: () => ({
    machines: [
      { machineId: 'lobby-01', online: true },
      { machineId: 'gallery-02', online: false },
    ],
  }),
}));

jest.mock('@/hooks/useProjectDistributionPresets', () => ({
  useProjectDistributionPresets: () => ({
    presets: [],
    createPreset: jest.fn(),
    updatePreset: jest.fn(),
    deletePreset: jest.fn(),
  }),
}));

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

function renderDialog() {
  return render(
    <ProjectDistributionDialog
      open
      onOpenChange={jest.fn()}
      siteId="site-a"
      onCreateDistribution={jest.fn(async () => 'dist-id')}
    />,
  );
}

describe('ProjectDistributionDialog — shell', () => {
  it('renders the "new roost" title', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: /new roost/i })).toBeInTheDocument();
  });

  it('has no history tab — the main /roosts page is the history', () => {
    renderDialog();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
  });
});

describe('ProjectDistributionDialog — source picker (inside deploy)', () => {
  it('renders a two-option source radiogroup: by url + upload files', () => {
    renderDialog();
    const group = screen.getByRole('radiogroup', { name: /source/i });
    const options = within(group).getAllByRole('radio');
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.textContent?.trim().toLowerCase())).toEqual(
      expect.arrayContaining([expect.stringContaining('by url'), expect.stringContaining('upload files')]),
    );
  });

  it('defaults to "upload files" — shows the folder dropzone by default', () => {
    renderDialog();
    const group = screen.getByRole('radiogroup', { name: /source/i });
    const uploadRadio = within(group).getByRole('radio', { name: /upload files/i });
    expect(uploadRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('region', { name: /folder drop zone/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/project URL/i)).not.toBeInTheDocument();
  });

  it('switching source to "by url" hides the folder dropzone + shows URL input', async () => {
    const user = userEvent.setup();
    renderDialog();
    const urlRadio = within(
      screen.getByRole('radiogroup', { name: /source/i }),
    ).getByRole('radio', { name: /by url/i });
    await user.click(urlRadio);
    expect(urlRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/project URL/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /folder drop zone/i })).not.toBeInTheDocument();
  });

  it('shared fields stay visible regardless of source choice', async () => {
    const user = userEvent.setup();
    renderDialog();
    // shared fields visible under the default upload source.
    // `verify_files` was dropped in the v2 clean-cutover — version is
    // authoritative, spot-check is dead weight.
    expect(screen.getByLabelText(/roost name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/extract to/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/verify critical files/i)).not.toBeInTheDocument();
    expect(screen.getByText(/target machines/i)).toBeInTheDocument();

    // flip to url; shared fields should STILL be visible.
    const urlRadio = within(
      screen.getByRole('radiogroup', { name: /source/i }),
    ).getByRole('radio', { name: /by url/i });
    await user.click(urlRadio);

    expect(screen.getByLabelText(/roost name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/extract to/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/verify critical files/i)).not.toBeInTheDocument();
    expect(screen.getByText(/target machines/i)).toBeInTheDocument();
  });
});

describe('ProjectDistributionDialog — distribute button gating', () => {
  it('disabled on fresh url dialog until name + url + target are filled', async () => {
    const user = userEvent.setup();
    renderDialog();
    // dialog now defaults to upload mode; flip to url to exercise url gating.
    const urlRadio = within(
      screen.getByRole('radiogroup', { name: /source/i }),
    ).getByRole('radio', { name: /by url/i });
    await user.click(urlRadio);
    const btn = screen.getByRole('button', { name: /distribute to/i });
    expect(btn).toBeDisabled();
    // title should itemise what's still missing so the user knows what to fill.
    const title = btn.getAttribute('title') ?? '';
    expect(title).toMatch(/name/);
    expect(title).toMatch(/project URL/);
    expect(title).toMatch(/target machine/);
  });

  it('disabled on deploy+upload with no folder, no name, no target', () => {
    // upload is now the default — no mode-flip needed.
    renderDialog();
    const btn = screen.getByRole('button', { name: /distribute to/i });
    expect(btn).toBeDisabled();
    const title = btn.getAttribute('title') ?? '';
    expect(title).toMatch(/folder/);
    expect(title).toMatch(/name/);
    expect(title).toMatch(/target machine/);
  });
});

describe('ProjectDistributionDialog — reopen resets state', () => {
  it('re-opening the dialog defaults back to upload-files source', () => {
    const { rerender } = render(
      <ProjectDistributionDialog
        open={false}
        onOpenChange={jest.fn()}
        siteId="site-a"
        onCreateDistribution={jest.fn()}
      />,
    );
    rerender(
      <ProjectDistributionDialog
        open
        onOpenChange={jest.fn()}
        siteId="site-a"
        onCreateDistribution={jest.fn()}
      />,
    );
    const sourceSelected = within(
      screen.getByRole('radiogroup', { name: /source/i }),
    )
      .getAllByRole('radio')
      .find((r) => r.getAttribute('aria-checked') === 'true');
    expect(sourceSelected?.textContent).toMatch(/upload files/i);
  });
});
