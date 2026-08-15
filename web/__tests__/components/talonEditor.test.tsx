/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * TalonEditorDialog — the trigger | condition | outputs pipeline.
 *
 * A render smoke rather than a full behavioural suite: the rules this editor
 * enforces belong to `@/lib/talons/validation`, which has its own tests. What
 * is asserted here is the wiring the validator can't cover — that the three
 * stages mount, that switching trigger type swaps the stage's contents, that
 * the outputs list stops at `TALON_MAX_OUTPUTS`, and that a validator error
 * lands on the input that earned it instead of a toast.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TalonEditorDialog } from '@/app/talons/components/TalonEditorDialog';
import { TALON_MAX_OUTPUTS } from '@/lib/talons/validation';

// jsdom ships no ResizeObserver; PipelineConnectors constructs one on mount.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no matchMedia. `matches: false` reports a coarse pointer, which
// puts DayPillSelector on its plain click-to-toggle path.
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

// Radix Select drives its trigger with pointer capture and scrolls the active
// item into view — neither exists in jsdom.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '12h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const MACHINES = [
  { id: 'machine-a', name: 'lobby wall', online: true, processes: [{ id: 'p1', name: 'TouchDesigner' }] },
];

/**
 * Every error message on screen, in dom order. Both surfaces use role="alert" —
 * the inline paragraphs each card renders, and the footer summary — so this
 * catches a message printed twice no matter which two places print it.
 */
function errorTexts(): string[] {
  return screen.queryAllByRole('alert').map((el) => el.textContent?.trim() ?? '');
}

/** Switches the first output row to the hoot type, whose directive starts empty. */
async function selectHootOutput(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('output 1 type'));
  await user.click(await screen.findByRole('option', { name: 'hoot' }));
}

function renderEditor(props: Partial<React.ComponentProps<typeof TalonEditorDialog>> = {}) {
  return render(
    <TalonEditorDialog
      open
      onOpenChange={jest.fn()}
      siteId="site-1"
      machines={MACHINES}
      {...props}
    />,
  );
}

describe('TalonEditorDialog', () => {
  it('renders the three pipeline stages in create mode', () => {
    renderEditor();

    expect(screen.getByTestId('talon-editor')).toBeInTheDocument();
    expect(screen.getByTestId('trigger-type')).toBeInTheDocument();
    expect(screen.getByTestId('condition-type')).toBeInTheDocument();
    expect(screen.getByTestId('output-add')).toBeInTheDocument();
    expect(screen.getByTestId('talon-editor-save')).toHaveTextContent('create talon');
  });

  it('swaps the trigger stage contents when the trigger type changes', async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.getByTestId('trigger-schedule')).toBeInTheDocument();
    expect(screen.queryByTestId('trigger-threshold')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('trigger-type'));
    await user.click(await screen.findByRole('option', { name: 'when a metric crosses' }));

    expect(screen.getByTestId('trigger-threshold')).toBeInTheDocument();
    expect(screen.queryByTestId('trigger-schedule')).not.toBeInTheDocument();
  });

  it('caps the outputs list at the validator maximum', async () => {
    const user = userEvent.setup();
    renderEditor();

    const add = screen.getByTestId('output-add');
    expect(screen.getAllByTestId('output-row')).toHaveLength(1);

    for (let i = 1; i < TALON_MAX_OUTPUTS; i++) {
      await user.click(add);
    }

    expect(screen.getAllByTestId('output-row')).toHaveLength(TALON_MAX_OUTPUTS);
    expect(add).toBeDisabled();

    await user.click(add);
    expect(screen.getAllByTestId('output-row')).toHaveLength(TALON_MAX_OUTPUTS);
  });

  it('binds a validator error to the field that earned it, and never fetches', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderEditor();

    // The default draft is valid except for the empty name.
    await user.click(screen.getByTestId('talon-editor-save'));

    const name = screen.getByRole('textbox', { name: 'name' });
    expect(name).toHaveAttribute('aria-invalid', 'true');

    expect(errorTexts()).toEqual(['give this talon a name']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes errors in plain english, with no field paths or index notation', async () => {
    const user = userEvent.setup();
    renderEditor();

    // hoot's directive is required and starts empty — two errors, two fields.
    await selectHootOutput(user);
    await user.click(screen.getByTestId('talon-editor-save'));

    const texts = errorTexts();
    expect(texts).toContain('tell hoot what to do when this talon fires');
    for (const text of texts) {
      expect({ text, readable: !/[`[\]]/.test(text) }).toEqual({ text, readable: true });
    }
  });

  it('renders each error exactly once, at the field that owns it', async () => {
    const user = userEvent.setup();
    renderEditor();

    await selectHootOutput(user);
    await user.click(screen.getByTestId('talon-editor-save'));

    // The regression: the directive message printed under the textarea AND
    // again under "add output", because the outputs list matched by prefix.
    const texts = errorTexts();
    expect(texts.filter((text) => text === 'tell hoot what to do when this talon fires')).toHaveLength(1);
    expect(new Set(texts).size).toBe(texts.length);

    // And it is the textarea's own message, not the list's.
    const row = screen.getByTestId('output-row');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      'tell hoot what to do when this talon fires',
    );
  });

  it('clears a field error as soon as that field is corrected', async () => {
    const user = userEvent.setup();
    renderEditor();

    await selectHootOutput(user);
    await user.click(screen.getByTestId('talon-editor-save'));

    expect(errorTexts()).toContain('give this talon a name');
    expect(errorTexts()).toContain('tell hoot what to do when this talon fires');

    await user.type(screen.getByRole('textbox', { name: 'name' }), 'overnight restart');
    expect(errorTexts()).not.toContain('give this talon a name');
    // Untouched fields keep theirs.
    expect(errorTexts()).toContain('tell hoot what to do when this talon fires');

    await user.type(screen.getByRole('textbox', { name: 'output 1 directive' }), 'restart the loop');
    expect(errorTexts()).toEqual([]);
  });

  it('drops output errors when the rows are restructured underneath them', async () => {
    const user = userEvent.setup();
    renderEditor();

    await selectHootOutput(user);
    await user.click(screen.getByTestId('talon-editor-save'));
    expect(errorTexts()).toContain('tell hoot what to do when this talon fires');

    // Adding a row shifts every index the errors were bound to.
    await user.click(screen.getByTestId('output-add'));
    expect(errorTexts()).not.toContain('tell hoot what to do when this talon fires');
  });

  it('offers the delay only on the event trigger, and round-trips it', async () => {
    const user = userEvent.setup();
    renderEditor();

    // The schedule branch the editor opens on has no delay to set.
    expect(screen.queryByLabelText('then wait')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('trigger-type'));
    await user.click(await screen.findByRole('option', { name: 'when an event happens' }));

    const delay = screen.getByLabelText('then wait');
    expect(delay).toHaveValue(0);
    expect(
      screen.getByText('0 runs right away — give a restarted app time to boot before checking it'),
    ).toBeInTheDocument();

    await user.clear(delay);
    await user.type(delay, '3');
    expect(delay).toHaveValue(3);
  });

  it('binds an out-of-range delay to the delay input, not a toast', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderEditor();

    // Paste the name (one input event) — per-keystroke typing here pushed the
    // test past jest's default timeout under full-suite worker contention.
    // Keystroke realism stays where it's under test: the delay field.
    await user.click(screen.getByRole('textbox', { name: 'name' }));
    await user.paste('check the wall after a restart');
    await user.click(screen.getByTestId('trigger-type'));
    await user.click(await screen.findByRole('option', { name: 'when an event happens' }));
    await user.click(screen.getByRole('checkbox', { name: /process_restarted/ }));

    const delay = screen.getByLabelText('then wait');
    await user.clear(delay);
    await user.type(delay, '2000');
    await user.click(screen.getByTestId('talon-editor-save'));

    expect(delay).toHaveAttribute('aria-invalid', 'true');
    expect(errorTexts()).toEqual(['the delay must be between 0 and 24 hours']);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it('prefills the delay from an existing talon', () => {
    renderEditor({
      talon: {
        id: 'talon-1',
        schemaVersion: 1,
        name: 'check the wall after a restart',
        enabled: true,
        trigger: { type: 'event', eventTypes: ['process_restarted'], delayMinutes: 3 },
        condition: { type: 'none' },
        outputs: [{ type: 'email' }],
        scope: { machineIds: null },
        cooldownMinutes: 30,
        createdBy: 'user-1',
        createdVia: 'ui',
        createdAt: 0,
        updatedAt: 0,
        consecutiveFailures: 0,
      },
    });

    expect(screen.getByLabelText('then wait')).toHaveValue(3);
  });

  it('prefills from an existing talon in edit mode', () => {
    renderEditor({
      talon: {
        id: 'talon-1',
        schemaVersion: 1,
        name: 'overnight restart',
        enabled: true,
        trigger: { type: 'event', eventTypes: ['process_crash'] },
        condition: { type: 'none' },
        outputs: [{ type: 'webhook', url: 'https://example.com/hooks/talon' }],
        scope: { machineIds: ['machine-a'] },
        cooldownMinutes: 30,
        createdBy: 'user-1',
        createdVia: 'ui',
        createdAt: 0,
        updatedAt: 0,
        consecutiveFailures: 0,
      },
    });

    expect(screen.getByRole('textbox', { name: 'name' })).toHaveValue('overnight restart');
    expect(screen.getByTestId('trigger-event')).toBeInTheDocument();
    expect(screen.getByTestId('talon-editor-save')).toHaveTextContent('save talon');

    const outputRow = screen.getByTestId('output-row');
    expect(within(outputRow).getByRole('textbox', { name: 'output 1 url' })).toHaveValue(
      'https://example.com/hooks/talon',
    );
  });
});
