/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ProcessDialog — the schedule is editable in EVERY launch mode, matching the desktop app's
 * always-available schedule pencil. Editing windows from `off` / `always on` pre-configures:
 * blocks are written on save and the mode stays put. Only the segments change the mode.
 *
 * app/dashboard/page.tsx renders its own inline copy of this dialog, kept in sync by
 * convention, so the contract asserted here is the one that ships.
 */

import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults';
import { ProcessDialog, type ProcessFormData } from '@/app/dashboard/components/ProcessDialog';

// jsdom has no matchMedia. `matches: false` = coarse pointer, which puts DayPillSelector on
// its click-to-toggle path rather than drag-select.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

const BASE_FORM: ProcessFormData = {
  name: 'lobby display',
  exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe',
  file_path: '',
  cwd: '',
  priority: 'Normal',
  visibility: 'Normal',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '3',
  autolaunch: false,
  launch_mode: 'off',
  schedules: null,
};

/** Fully controlled, so the harness holds the form like the dashboard does and hands the
 * current form to onSave — what the save button would persist. */
function Harness({
  initial,
  onSave,
}: {
  initial: ProcessFormData;
  onSave?: (form: ProcessFormData) => void;
}) {
  const [form, setForm] = useState<ProcessFormData>(initial);
  return (
    <TooltipProvider>
      <ProcessDialog
        open
        mode="edit"
        form={form}
        onFormChange={setForm}
        onClose={() => {}}
        onSave={() => onSave?.(form)}
        onDelete={() => {}}
        siteTimezone="America/New_York"
      />
    </TooltipProvider>
  );
}

const gear = () => screen.getByRole('button', { name: 'configure schedule' });
const section = () => screen.queryByTestId('process-dialog-schedule-section');

describe('ProcessDialog — schedule availability', () => {
  it.each(['off', 'always', 'scheduled'] as const)(
    'offers the schedule gear in %s mode',
    (launchMode) => {
      render(<Harness initial={{ ...BASE_FORM, launch_mode: launchMode }} />);
      expect(gear()).toBeInTheDocument();
    },
  );

  it('auto-shows the schedule section in scheduled mode', () => {
    render(<Harness initial={{ ...BASE_FORM, launch_mode: 'scheduled' }} />);
    expect(section()).toBeInTheDocument();
    expect(gear()).toHaveAttribute('aria-expanded', 'true');
  });

  it('reveals and re-hides the schedule section from off mode', async () => {
    const user = userEvent.setup();
    render(<Harness initial={BASE_FORM} />);

    expect(section()).not.toBeInTheDocument();
    expect(gear()).toHaveAttribute('aria-expanded', 'false');

    await user.click(gear());
    expect(section()).toBeInTheDocument();
    expect(gear()).toHaveAttribute('aria-expanded', 'true');

    await user.click(gear());
    expect(section()).not.toBeInTheDocument();
  });

  it('prefills the editor with the default schedule when none is stored', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...BASE_FORM, launch_mode: 'always' }} />);

    await user.click(gear());

    // DEFAULT_SCHEDULE is mon-fri, and nothing has been written to the form yet.
    expect(screen.getByTitle('monday')).toHaveClass('bg-blue-600');
    expect(screen.getByTitle('saturday')).not.toHaveClass('bg-blue-600');
  });
});

describe('ProcessDialog — schedule edits are decoupled from the launch mode', () => {
  it('saves edited windows from off mode without touching the mode', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn();
    render(<Harness initial={BASE_FORM} onSave={onSave} />);

    await user.click(gear());
    await user.click(screen.getByTitle('saturday'));
    await user.click(screen.getByRole('button', { name: 'save changes' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved: ProcessFormData = onSave.mock.calls[0][0];
    expect(saved.schedules).toEqual([
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        ranges: [{ start: '09:00', stop: '17:00' }],
      },
    ]);
    // The whole point: pre-configuring never flips the process on.
    expect(saved.launch_mode).toBe('off');
    expect(saved.autolaunch).toBe(false);
  });

  it('saves edited windows from always-on mode without downgrading to scheduled', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn();
    render(
      <Harness
        initial={{ ...BASE_FORM, launch_mode: 'always', autolaunch: true }}
        onSave={onSave}
      />,
    );

    await user.click(gear());
    await user.click(screen.getByTitle('sunday'));
    await user.click(screen.getByRole('button', { name: 'save changes' }));

    const saved: ProcessFormData = onSave.mock.calls[0][0];
    expect(saved.schedules?.[0].days).toContain('sun');
    expect(saved.launch_mode).toBe('always');
    expect(saved.autolaunch).toBe(true);
  });

  it('leaves the shared DEFAULT_SCHEDULE constant untouched', async () => {
    const user = userEvent.setup();
    render(<Harness initial={BASE_FORM} />);

    await user.click(gear());
    await user.click(screen.getByTitle('saturday'));

    expect(DEFAULT_SCHEDULE).toEqual([
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ]);
  });

  it('still lets the segments — and only the segments — change the launch mode', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn();
    render(<Harness initial={BASE_FORM} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'scheduled' }));
    await user.click(screen.getByRole('button', { name: 'save changes' }));

    const saved: ProcessFormData = onSave.mock.calls[0][0];
    expect(saved.launch_mode).toBe('scheduled');
    expect(saved.autolaunch).toBe(true);
  });
});
