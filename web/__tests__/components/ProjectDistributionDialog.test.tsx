/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for ProjectDistributionDialog. Uploading a folder is the only
 * source — the v1 by-url path (and its source picker) was removed in the v1
 * distribution cutover, so there is no mode to switch.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
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
    <ProjectDistributionDialog open onOpenChange={jest.fn()} siteId="site-a" />,
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

describe('ProjectDistributionDialog — upload is the only source', () => {
  // Inverted guard for the v1 removal: both assertions FAIL against the
  // pre-removal dialog, which rendered a `source` radiogroup with a `by url`
  // option and a `#project-url` input.
  it('has no source picker and no project URL input', () => {
    renderDialog();
    expect(screen.queryByRole('radiogroup', { name: /source/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /by url/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/project URL/i)).not.toBeInTheDocument();
  });

  it('always shows the folder dropzone', () => {
    renderDialog();
    expect(screen.getByRole('region', { name: /folder drop zone/i })).toBeInTheDocument();
  });

  it('renders the shared deploy fields', () => {
    renderDialog();
    // `verify_files` was dropped in the v2 cutover — the version is
    // authoritative, so a spot-check is dead weight.
    expect(screen.getByLabelText(/roost name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/extract to/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/verify critical files/i)).not.toBeInTheDocument();
    expect(screen.getByText(/target machines/i)).toBeInTheDocument();
  });
});

describe('ProjectDistributionDialog — target selection', () => {
  // Regression: the row div and the Checkbox BOTH toggle. Before the checkbox
  // stopped click propagation, clicking the box fired onCheckedChange AND
  // bubbled to the row's onClick — toggle twice, net zero, "(0 selected)".
  // This test fails against that behavior (it saw 0, expects 1).
  it('clicking the checkbox itself selects the machine exactly once', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('checkbox', { name: 'lobby-01' }));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });

  it('clicking the row also selects the machine exactly once', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText('gallery-02'));
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });
});

describe('ProjectDistributionDialog — distribute button gating', () => {
  it('disabled with no folder, no name, no target — title itemises all three', () => {
    renderDialog();
    const btn = screen.getByRole('button', { name: /distribute to/i });
    expect(btn).toBeDisabled();
    const title = btn.getAttribute('title') ?? '';
    expect(title).toMatch(/folder/);
    expect(title).toMatch(/name/);
    expect(title).toMatch(/target machine/);
  });

  it('upload-only button gates on name + folder, but not on a target', () => {
    renderDialog();
    const btn = screen.getByRole('button', { name: /^upload$/i });
    expect(btn).toBeDisabled();
    const title = btn.getAttribute('title') ?? '';
    expect(title).toMatch(/name/);
    expect(title).toMatch(/folder/);
    expect(title).not.toMatch(/target machine/);
  });
});

describe('ProjectDistributionDialog — reopen resets state', () => {
  it('re-opening the dialog still renders the folder dropzone', () => {
    const { rerender } = render(
      <ProjectDistributionDialog open={false} onOpenChange={jest.fn()} siteId="site-a" />,
    );
    rerender(
      <ProjectDistributionDialog open onOpenChange={jest.fn()} siteId="site-a" />,
    );
    expect(screen.getByRole('region', { name: /folder drop zone/i })).toBeInTheDocument();
  });
});
