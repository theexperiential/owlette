'use client';

/**
 * The talon editor — trigger | condition | outputs, left to right.
 *
 * Create when `talon` is null/undefined (POST), edit otherwise (PATCH). Each
 * stage owns its own draft shape and its conversion to the wire form; this
 * dialog assembles the three of them, runs the SHARED validator
 * (`@/lib/talons/validation`), and submits the validator's NORMALIZED `value`
 * — never the raw form state, which still holds numbers as strings and
 * un-trimmed text.
 *
 * The same validator runs server-side inside `@/lib/talons/store.server`, so
 * anything this editor accepts the store accepts. Server rejections come back
 * as RFC 7807 with a structured `fieldErrors` list in the same
 * `{ field, code, message }` shape, and are bound to inputs by the same path
 * mapping — a client-side miss and a server-side miss look identical to the
 * user.
 *
 * Error display has two rules, both enforced here rather than by the cards:
 *   1. ONE PLACE PER MESSAGE. `slotForField` maps each validator path to at
 *      most one inline slot; anything unslotted goes to the footer summary,
 *      which skips messages a slot already shows. Nothing renders twice.
 *   2. CLEARED WHEN CORRECTED. Every draft setter is wrapped so editing a
 *      control drops the errors bound to it, instead of leaving a stale
 *      message under a field the user already fixed.
 *
 * Naming: automations are **talons**; the assistant is **hoot** in every piece
 * of copy here. The wire type for a hoot output stays `'cortex'`.
 */

import { Loader2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast';
import type { TalonDoc } from '@/lib/talons/types';
import {
  DEFAULT_TALON_COOLDOWN_MINUTES,
  TALON_DESCRIPTION_MAX_LENGTH,
  TALON_MIN_INTERVAL_MINUTES,
  TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK,
  TALON_NAME_MAX_LENGTH,
  validateTalonInput,
  type TalonFieldError,
} from '@/lib/talons/validation';

import {
  ConditionCard,
  conditionDraftFromTalon,
  conditionDraftToInput,
  newConditionDraft,
  newScopeDraft,
  scopeDraftFromTalon,
  scopeDraftToInput,
  type ConditionDraft,
  type ScopeDraft,
  type TalonMachineOption,
} from './ConditionCard';
import { OutputsCard, newOutputDraft, outputDraftFromTalon, outputDraftToInput, type OutputDraft } from './OutputsCard';
import { PipelineConnectors, PipelineStackConnector } from './PipelineConnectors';
import { TriggerCard, newTriggerDraft, triggerDraftFromTalon, triggerDraftToInput, type TriggerDraft } from './TriggerCard';

/* -------------------------------------------------------------------------- */
/*  field path → DOM id                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Maps a validator field path onto the id of the input that owns it, so
 * `useFieldError` can move the caret to the problem. Output paths carry a row
 * index and are handled separately; everything else falls back up the path
 * (`trigger.entries[0].time` → `trigger.entries` → `trigger`) until it hits a
 * mapped ancestor, which keeps unmapped leaf paths pointing somewhere useful.
 */
const FIELD_ELEMENT_IDS: Readonly<Record<string, string>> = {
  name: 'talon-name',
  description: 'talon-description',
  trigger: 'talon-trigger-type',
  'trigger.type': 'talon-trigger-type',
  'trigger.entries': 'talon-trigger-entries',
  'trigger.intervalMinutes': 'talon-trigger-interval',
  'trigger.metric': 'talon-trigger-metric',
  'trigger.operator': 'talon-trigger-operator',
  'trigger.value': 'talon-trigger-value',
  'trigger.eventTypes': 'talon-trigger-events',
  'trigger.delayMinutes': 'talon-trigger-delay',
  condition: 'talon-condition-expectation',
  'condition.type': 'talon-condition-expectation',
  'condition.expectation': 'talon-condition-expectation',
  'condition.monitor': 'talon-condition-monitor',
  outputs: 'talon-outputs',
  scope: 'talon-scope',
  'scope.machineIds': 'talon-scope',
  cooldownMinutes: 'talon-name',
};

const OUTPUT_FIELD_SUFFIXES: Readonly<Record<string, string>> = {
  url: 'url',
  directive: 'directive',
  commandType: 'command-type',
  processId: 'process',
  processName: 'process',
  type: 'type',
};

/** `outputs[2].url` → index 2, key `url`. */
const OUTPUT_FIELD_PATTERN = /^outputs\[(\d+)\]\.(\w+)$/;
/** `outputs[2]` — the row itself, from a non-object output. */
const OUTPUT_ROW_PATTERN = /^outputs\[(\d+)\]$/;
/** The three command keys share one message slot; the row shows one at a time. */
const OUTPUT_COMMAND_FIELDS: ReadonlySet<string> = new Set([
  'commandType',
  'processId',
  'processName',
]);

function elementIdForField(field: string): string {
  const outputMatch = OUTPUT_FIELD_PATTERN.exec(field);
  if (outputMatch) {
    const suffix = OUTPUT_FIELD_SUFFIXES[outputMatch[2]];
    if (suffix) return `talon-output-${outputMatch[1]}-${suffix}`;
    return 'talon-outputs';
  }

  let path = field.replace(/\[\d+\]/g, '');
  for (;;) {
    const mapped = FIELD_ELEMENT_IDS[path];
    if (mapped) return mapped;
    const cut = path.lastIndexOf('.');
    if (cut < 0) return '';
    path = path.slice(0, cut);
  }
}

/* -------------------------------------------------------------------------- */
/*  field path → error slot                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The inline slot that renders a given validator path, or null when no control
 * owns one.
 *
 * Every path maps to AT MOST ONE slot, and that is what keeps a message from
 * rendering twice. The previous routing matched by prefix, so the outputs card
 * asked for `outputs` and was handed `outputs[0].directive` — printing the same
 * sentence under the textarea AND under "add output". Slots are exact.
 *
 * Paths with no slot (an output's `type`, `cooldownMinutes`, `trigger.metric`,
 * an unknown field from the API) fall through to the footer summary, which
 * renders ONLY those. Between them the two surfaces cover every error exactly
 * once.
 */
function slotForField(field: string): string | null {
  const output = OUTPUT_FIELD_PATTERN.exec(field);
  if (output) {
    const [, index, key] = output;
    if (key === 'url' || key === 'directive') return `outputs[${index}].${key}`;
    if (OUTPUT_COMMAND_FIELDS.has(key)) return `outputs[${index}].command`;
    // `type` has a select but no message slot of its own.
    return null;
  }
  if (field === 'outputs' || OUTPUT_ROW_PATTERN.test(field)) return 'outputs';
  if (field === 'name' || field === 'description') return field;
  if (field === 'trigger.entries' || field.startsWith('trigger.entries[')) return 'trigger.entries';
  if (field === 'trigger.eventTypes' || field.startsWith('trigger.eventTypes[')) {
    return 'trigger.eventTypes';
  }
  if (field === 'trigger.intervalMinutes') return 'trigger.intervalMinutes';
  // Owned by the event branch's delay input, which is mounted whenever this
  // error is reachable: `triggerDraftToInput` sends `delayMinutes` on the event
  // form only, so the validator's "this only applies to event triggers" cannot
  // be raised against anything this editor submits.
  if (field === 'trigger.delayMinutes') return 'trigger.delayMinutes';
  if (field === 'trigger.value') return 'trigger.value';
  if (field === 'condition.expectation') return 'condition.expectation';
  if (field === 'condition.monitor') return 'condition.monitor';
  if (field === 'scope' || field.startsWith('scope.')) return 'scope';
  return null;
}

/** Row index for any output-scoped path, or null for the list itself. */
function outputRowIndex(field: string): number | null {
  const match = /^outputs\[(\d+)\]/.exec(field);
  return match === null ? null : Number(match[1]);
}

/**
 * Move the caret to the first offender. Deferred a tick so it runs after the
 * re-render that applies `aria-invalid`, otherwise focus can land before the
 * field is marked and some browsers skip the announcement. (Same contract as
 * `useFieldError.fail`, which this form cannot use: that hook models ONE error
 * with one message, and rendering its message alongside the inline bindings is
 * exactly the duplication this editor had to remove.)
 */
function focusField(elementId: string): void {
  if (!elementId || typeof window === 'undefined') return;
  window.setTimeout(() => {
    const el = document.getElementById(elementId);
    if (el instanceof HTMLElement) el.focus();
  }, 0);
}

/** RFC 7807 body, narrowed to the members this dialog reads. */
interface TalonProblem {
  title?: string;
  detail?: string;
  fieldErrors?: TalonFieldError[];
}

function isFieldErrorList(value: unknown): value is TalonFieldError[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as TalonFieldError).field === 'string' &&
        typeof (entry as TalonFieldError).message === 'string',
    )
  );
}

/** `crypto.randomUUID` needs a secure context; the fallback keeps http dev origins working. */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `talon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* -------------------------------------------------------------------------- */
/*  dialog                                                                    */
/* -------------------------------------------------------------------------- */

interface TalonEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  machines: TalonMachineOption[];
  /** Null / undefined = create mode. */
  talon?: (TalonDoc & { id: string }) | null;
  isSiteAdmin?: boolean;
}

/**
 * Shell only. Radix unmounts `DialogContent` while the dialog is closed, so the
 * form below is a separate component whose `useState` initializers run fresh on
 * every open — no reset effect, and no `setState` inside one. The `key` covers
 * the remaining case: swapping which talon is being edited without the dialog
 * closing in between.
 */
export function TalonEditorDialog({
  open,
  onOpenChange,
  siteId,
  machines,
  talon,
  isSiteAdmin = false,
}: TalonEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The base DialogContent carries `sm:max-w-lg`, which outranks a plain
          `max-w-*` at sm+ — width overrides must be breakpoint-qualified
          (see ManageSitesDialog for the same pattern). */}
      <DialogContent
        data-testid="talon-editor"
        className="bg-card border-border sm:max-w-5xl lg:max-w-6xl max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{talon ? 'edit talon' : 'new talon'}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            a talon watches for something, checks a condition, then acts.
          </DialogDescription>
        </DialogHeader>

        <TalonEditorForm
          key={talon?.id ?? 'new'}
          siteId={siteId}
          machines={machines}
          talon={talon ?? null}
          isSiteAdmin={isSiteAdmin}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

interface TalonEditorFormProps {
  siteId: string;
  machines: TalonMachineOption[];
  talon: (TalonDoc & { id: string }) | null;
  isSiteAdmin: boolean;
  onClose: () => void;
}

function TalonEditorForm({ siteId, machines, talon, isSiteAdmin, onClose }: TalonEditorFormProps) {
  const [name, setName] = useState(talon?.name ?? '');
  const [description, setDescription] = useState(talon?.description ?? '');
  const [trigger, setTrigger] = useState<TriggerDraft>(() =>
    talon ? triggerDraftFromTalon(talon.trigger) : newTriggerDraft(),
  );
  const [condition, setCondition] = useState<ConditionDraft>(() =>
    talon ? conditionDraftFromTalon(talon.condition) : newConditionDraft(),
  );
  const [scope, setScope] = useState<ScopeDraft>(() =>
    talon ? scopeDraftFromTalon(talon.scope) : newScopeDraft(),
  );
  const [outputs, setOutputs] = useState<OutputDraft[]>(() =>
    talon && talon.outputs.length > 0
      ? talon.outputs.map(outputDraftFromTalon)
      : [newOutputDraft('email')],
  );
  // No control renders these two: the list owns the enable toggle, and the
  // cooldown has no editor yet. They are still carried through every save —
  // PATCH replaces the caller-owned half of the talon wholesale, and the
  // validator defaults an omitted `enabled` to true and an omitted cooldown to
  // 60, which would silently re-enable a paused talon or reset a tuned gap.
  const enabled = talon?.enabled ?? true;
  const cooldownMinutes = talon?.cooldownMinutes ?? DEFAULT_TALON_COOLDOWN_MINUTES;

  const [fieldErrors, setFieldErrors] = useState<TalonFieldError[]>([]);
  const [busy, setBusy] = useState(false);

  /**
   * Split the error list into the inline slots and the footer summary.
   *
   * Slots are first-wins: two errors on one slot show the first, and the second
   * surfaces on the next submit once the first is fixed. The summary drops any
   * message a slot is already showing, so no sentence can appear twice on
   * screen even when two different paths produce the same copy.
   */
  const { slotMessages, summaryMessages } = useMemo(() => {
    const slots = new Map<string, string>();
    for (const entry of fieldErrors) {
      const slot = slotForField(entry.field);
      if (slot !== null && !slots.has(slot)) slots.set(slot, entry.message);
    }
    const shown = new Set(slots.values());
    const summary: string[] = [];
    for (const entry of fieldErrors) {
      if (slotForField(entry.field) !== null || shown.has(entry.message)) continue;
      shown.add(entry.message);
      summary.push(entry.message);
    }
    return { slotMessages: slots, summaryMessages: summary };
  }, [fieldErrors]);

  const errorFor = (slot: string): string | undefined => slotMessages.get(slot);

  /**
   * Drop every error whose field matches, so a corrected control stops showing
   * a stale message the moment it changes rather than at the next submit.
   */
  function clearErrorsWhere(matches: (field: string) => boolean): void {
    setFieldErrors((prev) => {
      const next = prev.filter((entry) => !matches(entry.field));
      return next.length === prev.length ? prev : next;
    });
  }

  function handleNameChange(value: string): void {
    setName(value);
    clearErrorsWhere((field) => field === 'name');
  }

  function handleDescriptionChange(value: string): void {
    setDescription(value);
    clearErrorsWhere((field) => field === 'description');
  }

  function handleTriggerChange(next: TriggerDraft): void {
    setTrigger(next);
    clearErrorsWhere((field) => field === 'trigger' || field.startsWith('trigger.'));
  }

  function handleConditionChange(next: ConditionDraft): void {
    setCondition(next);
    // The interval floor is a function of the condition type, so a stale
    // "visual checks run at most every 15 minutes" goes with it.
    clearErrorsWhere(
      (field) =>
        field === 'condition' ||
        field.startsWith('condition.') ||
        field === 'trigger.intervalMinutes',
    );
  }

  function handleScopeChange(next: ScopeDraft): void {
    setScope(next);
    clearErrorsWhere((field) => field === 'scope' || field.startsWith('scope.'));
  }

  function handleOutputsChange(next: OutputDraft[]): void {
    // Adding, removing or reordering shifts the indexes every output error is
    // bound to, so the whole set is unbound — there is no honest way to keep
    // `outputs[1].url` pointing at the row the user meant.
    const restructured =
      next.length !== outputs.length || next.some((draft, i) => draft.key !== outputs[i].key);
    setOutputs(next);
    clearErrorsWhere((field) => {
      if (!field.startsWith('outputs')) return false;
      if (restructured) return true;
      const index = outputRowIndex(field);
      // An in-place edit clears only the row whose draft object changed.
      return index !== null && next[index] !== outputs[index];
    });
  }

  /** Bind a validator/server error list to the inputs, and focus the first offender. */
  function applyFieldErrors(errors: TalonFieldError[]): void {
    setFieldErrors(errors);
    focusField(elementIdForField(errors[0].field));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setFieldErrors([]);

    const result = validateTalonInput({
      name,
      ...(description.trim() ? { description } : {}),
      enabled,
      trigger: triggerDraftToInput(trigger),
      condition: conditionDraftToInput(condition),
      outputs: outputs.map(outputDraftToInput),
      scope: scopeDraftToInput(scope),
      cooldownMinutes,
    });
    if (!result.ok) {
      applyFieldErrors(result.errors);
      return;
    }

    setBusy(true);
    try {
      const base = `/api/sites/${encodeURIComponent(siteId)}/talons`;
      const response = await fetch(talon ? `${base}/${encodeURIComponent(talon.id)}` : base, {
        method: talon ? 'PATCH' : 'POST',
        headers: {
          'content-type': 'application/json',
          // Create only — PATCH is already idempotent by replacement.
          ...(talon ? {} : { 'Idempotency-Key': newIdempotencyKey() }),
        },
        // The validator's normalized value, never the raw draft.
        body: JSON.stringify(result.value),
      });

      if (!response.ok) {
        let problem: TalonProblem = {};
        try {
          problem = (await response.json()) as TalonProblem;
        } catch {
          // Non-json error body (proxy, network layer) — fall through to the toast.
        }
        if (isFieldErrorList(problem.fieldErrors)) {
          applyFieldErrors(problem.fieldErrors);
        } else {
          toast.error(problem.detail ?? problem.title ?? `failed to save talon (${response.status})`);
        }
        setBusy(false);
        return;
      }

      toast.success(talon ? 'talon updated' : 'talon created');
      onClose();
    } catch {
      toast.error('failed to save talon');
      setBusy(false);
    }
  }

  const minIntervalMinutes =
    condition.type === 'visual_check'
      ? TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK
      : TALON_MIN_INTERVAL_MINUTES;

  // The process picker only offers processes from machines this talon can act on.
  const scopedMachines = scope.allMachines
    ? machines
    : machines.filter((machine) => scope.machineIds.includes(machine.id));

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="max-h-[65vh] overflow-y-auto space-y-5 pr-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="talon-name">name</Label>
            <Input
              id="talon-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              disabled={busy}
              maxLength={TALON_NAME_MAX_LENGTH}
              required
              placeholder="restart the lobby loop overnight"
              aria-invalid={!!errorFor('name')}
              className="bg-background border-border"
            />
            {errorFor('name') && (
              <p role="alert" className="text-xs text-destructive">
                {errorFor('name')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="talon-description">
              description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="talon-description"
              value={description}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              disabled={busy}
              maxLength={TALON_DESCRIPTION_MAX_LENGTH}
              placeholder="what this talon is for"
              aria-invalid={!!errorFor('description')}
              className="bg-background border-border"
            />
            {errorFor('description') && (
              <p role="alert" className="text-xs text-destructive">
                {errorFor('description')}
              </p>
            )}
          </div>
        </div>

        {/* Each card sits in a `grid` wrapper rather than being the grid item
            itself: the wrapper is what `PipelineConnectors` measures, and a
            single-item grid still stretches the card to the row height the way
            the bare section did. */}
        <div className="relative">
          {/* Wide horizontal gutters at md+ — the connector fan lives in them,
              and at gap-5 the wires sat on top of the card borders. */}
          <div className="grid md:grid-cols-3 gap-5 md:gap-x-10">
            <div data-talon-node="trigger-card" className="grid">
              <TriggerCard
                draft={trigger}
                onChange={handleTriggerChange}
                minIntervalMinutes={minIntervalMinutes}
                disabled={busy}
                errorFor={errorFor}
              />
            </div>
            <PipelineStackConnector />
            <div data-talon-node="condition-card" className="grid">
              <ConditionCard
                draft={condition}
                onChange={handleConditionChange}
                scope={scope}
                onScopeChange={handleScopeChange}
                machines={machines}
                disabled={busy}
                errorFor={errorFor}
              />
            </div>
            <PipelineStackConnector />
            <div data-talon-node="outputs-card" className="grid">
              <OutputsCard
                drafts={outputs}
                onChange={handleOutputsChange}
                machines={scopedMachines}
                isSiteAdmin={isSiteAdmin}
                disabled={busy}
                errorFor={errorFor}
              />
            </div>
          </div>
          <PipelineConnectors outputCount={outputs.length} />
        </div>
      </div>

      {/* Only what no control renders inline — see `slotForField`. */}
      {summaryMessages.length > 0 && (
        <div className="space-y-2">
          {summaryMessages.map((message) => (
            <FormError key={message} message={message} />
          ))}
        </div>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={busy}
          className="border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="submit"
          data-testid="talon-editor-save"
          disabled={busy}
          className="text-gray-900 cursor-pointer"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : talon ? (
            'save talon'
          ) : (
            'create talon'
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
