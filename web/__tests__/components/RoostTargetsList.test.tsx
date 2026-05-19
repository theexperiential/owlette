/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Tests for the checkbox-list refactor of RoostTargetsList. Verifies the
 * interaction loop the user actually relies on: clicking a checkbox flips
 * it immediately (optimism), fires the right PATCH, and reverts cleanly
 * when the server rejects.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('@/hooks/useTargetStates', () => ({
  useTargetStates: () => ({ states: [] }),
}));

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

import { RoostTargetsList } from '@/components/RoostTargetRow';
import type { Machine } from '@/hooks/useFirestore';
import { toast } from 'sonner';

const toastErrorMock = toast.error as jest.Mock;

function makeMachine(machineId: string, online = true): Machine {
  return {
    machineId,
    lastHeartbeat: Date.now(),
    online,
  } as Machine;
}

const machines: Machine[] = [
  makeMachine('alpha', true),
  makeMachine('bravo', true),
  makeMachine('charlie', false),
];

beforeEach(() => {
  toastErrorMock.mockClear();
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({}),
    } as Response),
  );
});

afterEach(() => {
  delete (global as { fetch?: typeof fetch }).fetch;
});

describe('RoostTargetsList — checkbox list', () => {
  it('renders every site machine with a checkbox; only currently-targeted rows show a sync pill', () => {
    render(
      <RoostTargetsList
        siteId="site-a"
        roostId="roost-1"
        currentVersionId="v1"
        targets={['alpha']}
        machines={machines}
      />,
    );
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    expect(screen.getByLabelText('remove alpha as target')).toBeChecked();
    expect(screen.getByLabelText('add bravo as target')).not.toBeChecked();
    expect(screen.getByLabelText('add charlie as target')).not.toBeChecked();
    // Pill text appears only for the targeted row.
    expect(screen.getAllByText(/no report yet/i)).toHaveLength(1);
  });

  it('checking an untargeted row PATCHes targets then POSTs deploy for the new machine', async () => {
    const user = userEvent.setup();
    render(
      <RoostTargetsList
        siteId="site-a"
        roostId="roost-1"
        currentVersionId="v1"
        targets={['alpha']}
        machines={machines}
      />,
    );
    await user.click(screen.getByLabelText('add bravo as target'));
    expect(screen.getByLabelText('remove bravo as target')).toBeChecked();
    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
    });
    const [patchUrl, patchInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(patchUrl).toBe('/api/roosts/roost-1');
    expect((patchInit as RequestInit).method).toBe('PATCH');
    const patchBody = JSON.parse((patchInit as RequestInit).body as string);
    expect(new Set(patchBody.targets)).toEqual(new Set(['alpha', 'bravo']));

    const [deployUrl, deployInit] = (global.fetch as jest.Mock).mock.calls[1];
    expect(deployUrl).toBe('/api/roosts/roost-1/deploy');
    expect((deployInit as RequestInit).method).toBe('POST');
    const deployBody = JSON.parse((deployInit as RequestInit).body as string);
    expect(deployBody.siteId).toBe('site-a');
    expect(deployBody.machines).toEqual(['bravo']);
  });

  it('unchecking a targeted row PATCHes with that machine removed and skips the deploy POST', async () => {
    const user = userEvent.setup();
    render(
      <RoostTargetsList
        siteId="site-a"
        roostId="roost-1"
        currentVersionId="v1"
        targets={['alpha', 'bravo']}
        machines={machines}
      />,
    );
    await user.click(screen.getByLabelText('remove alpha as target'));
    const body = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string,
    );
    expect(body.targets).toEqual(['bravo']);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('reverts the optimistic flip and toasts on PATCH failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'server exploded' }),
    } as Response);
    const user = userEvent.setup();
    render(
      <RoostTargetsList
        siteId="site-a"
        roostId="roost-1"
        currentVersionId="v1"
        targets={[]}
        machines={machines}
      />,
    );
    await user.click(screen.getByLabelText('add alpha as target'));
    await waitFor(() => {
      expect(screen.getByLabelText('add alpha as target')).not.toBeChecked();
    });
    expect(toastErrorMock).toHaveBeenCalledWith(
      'failed to update targets',
      expect.objectContaining({ description: 'server exploded' }),
    );
  });

  it('renders an empty-state hint when the site has no machines', () => {
    render(
      <RoostTargetsList
        siteId="site-a"
        roostId="roost-1"
        currentVersionId="v1"
        targets={[]}
        machines={[]}
      />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(
      screen.getByText(/install the agent on one to add it as a target/i),
    ).toBeInTheDocument();
  });
});
