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

/**
 * The preset hook is mocked wholesale: its Firestore listener and the shipped
 * built-in catalog belong to their own units, and what this file is testing is
 * what the picker DOES with a template — hydration and the payload it cuts.
 */
const mockCreatePreset = jest.fn(async () => 'talon-saved-1');
const mockUpdatePreset = jest.fn(async () => undefined);
const mockDeletePreset = jest.fn(async () => undefined);
let mockPresets: unknown[] = [];

jest.mock('@/hooks/useTalonPresets', () => ({
  useTalonPresets: () => ({
    presets: mockPresets,
    loading: false,
    error: null,
    createPreset: mockCreatePreset,
    updatePreset: mockUpdatePreset,
    deletePreset: mockDeletePreset,
  }),
}));

const MACHINES = [
  { id: 'machine-a', name: 'lobby wall', online: true, processes: [{ id: 'p1', name: 'TouchDesigner' }] },
];

/**
 * A template carries no `scope` and no `enabled` — that is the whole point of
 * the shape, and the hydration test below proves the editor does not invent
 * either from the preset.
 */
const OVERNIGHT_TEMPLATE = {
  id: 'builtin-overnight-restart',
  name: 'overnight restart',
  description: 'restart the loop when it crashes overnight',
  template: {
    name: 'overnight restart',
    description: 'restart the loop when it crashes overnight',
    trigger: { type: 'event', eventTypes: ['process_crash'], delayMinutes: 2 },
    condition: { type: 'visual_check', expectation: 'the wall shows the brand loop' },
    outputs: [{ type: 'webhook', url: 'https://example.com/hooks/talon' }],
    cooldownMinutes: 30,
  },
  isBuiltIn: true,
  order: 0,
  createdBy: '',
  createdAt: null,
  requires: [],
};

/**
 * Every error message on screen, in dom order. Both surfaces use role="alert" —
 * the inline paragraphs each card renders, and the footer summary — so this
 * catches a message printed twice no matter which two places print it.
 */
function errorTexts(): string[] {
  return screen.queryAllByRole('alert').map((el) => el.textContent?.trim() ?? '');
}

/**
 * The SAVE requests a fetch spy saw, ignoring the editor's read-only probes.
 *
 * Opening the editor in create mode reads whether the current user has an llm
 * key (to annotate the template picker), so "nothing was submitted" can no
 * longer be expressed as "fetch was never called" — only writes count.
 */
function saveCalls(fetchSpy: jest.Mock): unknown[][] {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/talons'));
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
  beforeEach(() => {
    mockPresets = [];
  });

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

  it('binds a validator error to the field that earned it, and never saves', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const user = userEvent.setup();
    renderEditor();

    // The default draft is valid except for the empty name.
    await user.click(screen.getByTestId('talon-editor-save'));

    const name = screen.getByRole('textbox', { name: 'name' });
    expect(name).toHaveAttribute('aria-invalid', 'true');

    expect(errorTexts()).toEqual(['give this talon a name']);
    expect(saveCalls(fetchSpy)).toHaveLength(0);
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

    // Paste rather than type: what's under test is that correcting a field
    // clears its error, not per-keystroke behaviour, and 33 keystrokes across a
    // now-heavier editor (preset picker + cooldown control) pushed this past
    // jest's default timeout under full-suite worker contention. Same reason
    // the delay test pastes its name.
    await user.click(screen.getByRole('textbox', { name: 'name' }));
    await user.paste('overnight restart');
    expect(errorTexts()).not.toContain('give this talon a name');
    // Untouched fields keep theirs.
    expect(errorTexts()).toContain('tell hoot what to do when this talon fires');

    await user.click(screen.getByRole('textbox', { name: 'output 1 directive' }));
    await user.paste('restart the loop');
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
    expect(saveCalls(fetchSpy)).toHaveLength(0);
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

  it('hides the template picker in edit mode', () => {
    mockPresets = [OVERNIGHT_TEMPLATE];
    renderEditor({
      talon: {
        id: 'talon-1',
        schemaVersion: 1,
        name: 'overnight restart',
        enabled: true,
        trigger: { type: 'event', eventTypes: ['process_crash'] },
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

    expect(screen.queryByTestId('talon-template-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('talon-template-save')).not.toBeInTheDocument();
  });

  /* --- a met requirement is not a requirement -----------------------------
   *
   * The picker used to print "needs an ai key" on every ai template whatever
   * the operator had configured — the copy only varied when the key was known
   * to be MISSING, so having one and having none read identically, and every ai
   * template sat under "needs a detail" for the people best equipped to run it.
   */

  const AI_TEMPLATE = { ...OVERNIGHT_TEMPLATE, requires: ['llm_key'] as const };

  function mockLlmKey(configured: boolean) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ configured }),
    }) as unknown as typeof fetch;
  }

  it('says nothing about an ai key once the operator has one', async () => {
    mockPresets = [AI_TEMPLATE];
    mockLlmKey(true);
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByTestId('talon-template-picker'));
    const option = await screen.findByRole('option', { name: /overnight restart/ });

    expect(option).not.toHaveTextContent(/needs an ai/i);
    // ...and it belongs with the templates that run as-is.
    expect(await screen.findByText('ready to use')).toBeInTheDocument();
    expect(screen.queryByText('needs a detail')).not.toBeInTheDocument();
  });

  it('asks for an ai api key only when the operator has none', async () => {
    mockPresets = [AI_TEMPLATE];
    mockLlmKey(false);
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByTestId('talon-template-picker'));
    const option = await screen.findByRole('option', { name: /overnight restart/ });

    expect(option).toHaveTextContent(/needs an ai api key/i);
    expect(await screen.findByText('needs a detail')).toBeInTheDocument();
  });

  it('hydrates the whole form from a template and resets scope to all machines', async () => {
    mockPresets = [OVERNIGHT_TEMPLATE];
    const user = userEvent.setup();
    renderEditor();

    // Narrow the scope first, so "all machines" afterwards is the template
    // resetting it rather than the create-mode default never having moved.
    await user.click(screen.getByRole('checkbox', { name: 'all machines' }));
    await user.click(screen.getByRole('checkbox', { name: /lobby wall/ }));
    expect(screen.getByRole('checkbox', { name: 'all machines' })).not.toBeChecked();

    await user.click(screen.getByTestId('talon-template-picker'));
    await user.click(await screen.findByRole('option', { name: /overnight restart/ }));

    // trigger
    expect(screen.getByTestId('trigger-event')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /process_crash/ })).toBeChecked();
    expect(screen.getByLabelText('then wait')).toHaveValue(2);

    // condition
    expect(screen.getByTestId('condition-visual-check')).toBeInTheDocument();
    expect(screen.getByLabelText(/what should be on screen/)).toHaveValue(
      'the wall shows the brand loop',
    );

    // outputs
    expect(screen.getByRole('textbox', { name: 'output 1 url' })).toHaveValue(
      'https://example.com/hooks/talon',
    );

    // name, description and cooldown all come along
    expect(screen.getByRole('textbox', { name: 'name' })).toHaveValue('overnight restart');
    expect(screen.getByRole('spinbutton', { name: 'run at most once every' })).toHaveValue(30);

    // scope is the one field a template never carries
    expect(screen.getByRole('checkbox', { name: 'all machines' })).toBeChecked();
  });

  it('cuts a template with no scope, no enabled and no process id', async () => {
    const user = userEvent.setup();
    renderEditor({ isSiteAdmin: true });

    await user.click(screen.getByRole('textbox', { name: 'name' }));
    await user.paste('restart the lobby loop');

    // A command output bound to a real process id — the per-machine identifier
    // a template must not carry.
    await user.click(screen.getByLabelText('output 1 type'));
    await user.click(await screen.findByRole('option', { name: 'command' }));
    await user.click(screen.getByLabelText('output 1 process'));
    await user.click(await screen.findByRole('option', { name: 'TouchDesigner' }));

    await user.click(screen.getByTestId('talon-template-save'));

    // The inline form pre-fills from the talon's own name.
    expect(screen.getByTestId('talon-template-name')).toHaveValue('restart the lobby loop');
    await user.click(screen.getByTestId('talon-template-submit'));

    expect(mockCreatePreset).toHaveBeenCalledTimes(1);
    const body = mockCreatePreset.mock.calls[0][0] as unknown as Record<string, unknown>;
    const template = body.template as Record<string, unknown>;

    expect(body).toMatchObject({ name: 'restart the lobby loop', isBuiltIn: false, order: 100 });
    expect(template.outputs).toEqual([{ type: 'command', commandType: 'restart_process' }]);
    expect(template.cooldownMinutes).toBe(60);

    // Nothing site-specific and nothing armed survives the round trip, at any
    // depth — a nested `scope` would be just as wrong as a top-level one.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('scope');
    expect(serialized).not.toContain('enabled');
    expect(serialized).not.toContain('processId');
  });

  it('refuses to cut a template from a draft the validator rejects', async () => {
    const user = userEvent.setup();
    renderEditor();

    // Name is empty — the same error the save button raises.
    await user.click(screen.getByTestId('talon-template-save'));

    expect(errorTexts()).toEqual(['give this talon a name']);
    expect(screen.queryByTestId('talon-template-name')).not.toBeInTheDocument();
    expect(mockCreatePreset).not.toHaveBeenCalled();
  });

  it('asks before replacing a template whose name is already taken', async () => {
    mockPresets = [OVERNIGHT_TEMPLATE];
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('textbox', { name: 'name' }));
    await user.paste('Overnight Restart');
    await user.click(screen.getByTestId('talon-template-save'));
    await user.click(screen.getByTestId('talon-template-submit'));

    // Case-insensitive, and checked against the merged list so a built-in
    // counts — nothing is created until the operator says so.
    expect(mockCreatePreset).not.toHaveBeenCalled();
    expect(
      screen.getByText(/template “overnight restart” already exists\. replace it\?/),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('talon-template-replace'));

    expect(mockCreatePreset).not.toHaveBeenCalled();
    expect(mockUpdatePreset).toHaveBeenCalledTimes(1);
    expect(mockUpdatePreset.mock.calls[0][0]).toBe('builtin-overnight-restart');
  });
});
