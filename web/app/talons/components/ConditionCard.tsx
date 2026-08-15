'use client';

/**
 * Stage 2 of the talon pipeline — WHETHER the outputs run, and on WHICH
 * machines.
 *
 * Two jobs sit here because they answer the same question ("does this run, and
 * where?"): the condition gate, and the machine scope. Scope is a top-level
 * talon field rather than part of the condition, but it is rendered in this
 * stage for every condition type — a `command` output needs a target whether or
 * not a vision check gates it, so hiding the selector behind `visual_check`
 * would strand it.
 *
 * The `scope.machineIds: []` trap: an empty array is INVALID. "every machine"
 * is `null`, which is what the `all machines` toggle produces. A cleared
 * checkbox list produces `[]` on purpose, so the validator's own message
 * ("must be a non-empty array … or null") lands inline instead of the editor
 * quietly widening the scope to the whole site.
 */

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TALON_EXPECTATION_MAX_LENGTH } from '@/lib/talons/validation';
import type { TalonCondition, TalonConditionType, TalonScope } from '@/lib/talons/types';

/* -------------------------------------------------------------------------- */
/*  draft shapes                                                              */
/* -------------------------------------------------------------------------- */

export interface ConditionDraft {
  type: TalonConditionType;
  expectation: string;
  /** Raw text; `''` omits the field so the agent's default (all monitors) applies. */
  monitor: string;
}

export interface ScopeDraft {
  allMachines: boolean;
  machineIds: string[];
}

export interface TalonMachineOption {
  id: string;
  name: string;
  online?: boolean;
  processes?: Array<{ id?: string; name: string }>;
}

const CONDITION_TYPE_LABELS: Record<TalonConditionType, string> = {
  none: 'always run outputs',
  visual_check: 'visual check',
};

export function newConditionDraft(): ConditionDraft {
  return { type: 'none', expectation: '', monitor: '' };
}

export function newScopeDraft(): ScopeDraft {
  return { allMachines: true, machineIds: [] };
}

export function conditionDraftFromTalon(condition: TalonCondition): ConditionDraft {
  if (condition.type === 'none') return newConditionDraft();
  return {
    type: 'visual_check',
    expectation: condition.expectation,
    monitor: condition.monitor === undefined ? '' : String(condition.monitor),
  };
}

export function scopeDraftFromTalon(scope: TalonScope): ScopeDraft {
  return scope.machineIds === null
    ? newScopeDraft()
    : { allMachines: false, machineIds: [...scope.machineIds] };
}

export function conditionDraftToInput(draft: ConditionDraft): TalonCondition {
  if (draft.type === 'none') return { type: 'none' };
  const monitor = draft.monitor.trim();
  return {
    type: 'visual_check',
    expectation: draft.expectation,
    ...(monitor === '' ? {} : { monitor: Number(monitor) }),
  };
}

export function scopeDraftToInput(draft: ScopeDraft): TalonScope {
  return { machineIds: draft.allMachines ? null : draft.machineIds };
}

/* -------------------------------------------------------------------------- */
/*  card                                                                      */
/* -------------------------------------------------------------------------- */

interface ConditionCardProps {
  draft: ConditionDraft;
  onChange: (draft: ConditionDraft) => void;
  scope: ScopeDraft;
  onScopeChange: (scope: ScopeDraft) => void;
  machines: TalonMachineOption[];
  disabled: boolean;
  /** Message for one error slot — see `slotForField` in `TalonEditorDialog`. */
  errorFor: (slot: string) => string | undefined;
}

export function ConditionCard({
  draft,
  onChange,
  scope,
  onScopeChange,
  machines,
  disabled,
  errorFor,
}: ConditionCardProps) {
  const expectationError = errorFor('condition.expectation');
  const monitorError = errorFor('condition.monitor');
  const scopeError = errorFor('scope');

  const toggleMachine = (machineId: string) =>
    onScopeChange({
      allMachines: false,
      machineIds: scope.machineIds.includes(machineId)
        ? scope.machineIds.filter((id) => id !== machineId)
        : [...scope.machineIds, machineId],
    });

  return (
    <section className="rounded-lg border border-border bg-background/40 p-5 space-y-4">
      <div className="space-y-4">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">condition</Label>
        <div
          role="radiogroup"
          aria-label="condition"
          data-testid="condition-type"
          className="flex gap-1 rounded-md border border-border p-0.5"
        >
          {(Object.keys(CONDITION_TYPE_LABELS) as TalonConditionType[]).map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={draft.type === type}
              onClick={() => onChange({ ...draft, type })}
              disabled={disabled}
              className={`flex-1 rounded px-2 py-1 text-xs transition-colors cursor-pointer ${
                draft.type === type
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {CONDITION_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      {draft.type === 'visual_check' ? (
        <div className="space-y-4" data-testid="condition-visual-check">
          <div className="space-y-1">
            <Label htmlFor="talon-condition-expectation" className="text-xs text-muted-foreground">
              what should be on screen
            </Label>
            <Textarea
              id="talon-condition-expectation"
              value={draft.expectation}
              onChange={(e) => onChange({ ...draft, expectation: e.target.value })}
              disabled={disabled}
              maxLength={TALON_EXPECTATION_MAX_LENGTH}
              rows={4}
              aria-invalid={!!expectationError}
              placeholder="the wall should show the brand loop — no dialogs, no desktop visible"
              className="bg-background border-border text-sm"
            />
            {expectationError ? (
              <p role="alert" className="text-xs text-destructive">
                {expectationError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                hoot grabs a fresh screenshot and checks it against this on the site llm key. the
                outputs fire when the check FAILS.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="talon-condition-monitor" className="text-xs text-muted-foreground">
              monitor <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="talon-condition-monitor"
              type="number"
              inputMode="numeric"
              min={0}
              value={draft.monitor}
              onChange={(e) => onChange({ ...draft, monitor: e.target.value })}
              disabled={disabled}
              aria-invalid={!!monitorError}
              placeholder="0"
              className="w-24 bg-background border-border"
            />
            {monitorError ? (
              <p role="alert" className="text-xs text-destructive">
                {monitorError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">0 = all monitors, 1 = primary.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          no gate — the outputs run every time the trigger fires.
        </p>
      )}

      <div className="space-y-3" id="talon-scope">
        <Label className="text-xs text-muted-foreground">machines</Label>
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <Checkbox
            checked={scope.allMachines}
            onCheckedChange={(checked) =>
              onScopeChange(
                checked === true ? { allMachines: true, machineIds: [] } : { ...scope, allMachines: false },
              )
            }
            disabled={disabled}
            aria-label="all machines"
          />
          <span>all machines</span>
        </label>

        {!scope.allMachines && (
          <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto border border-border rounded p-2">
            {machines.length === 0 ? (
              <p className="text-xs text-muted-foreground">no machines on this site yet.</p>
            ) : (
              machines.map((machine) => (
                <label
                  key={machine.id}
                  className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
                >
                  <Checkbox
                    checked={scope.machineIds.includes(machine.id)}
                    onCheckedChange={() => toggleMachine(machine.id)}
                    disabled={disabled}
                  />
                  <span className="truncate">{machine.name}</span>
                  {machine.online === false && (
                    <span className="text-[10px] text-muted-foreground">offline</span>
                  )}
                </label>
              ))
            )}
          </div>
        )}

        {scopeError && (
          <p role="alert" className="text-xs text-destructive">
            {scopeError}
          </p>
        )}
      </div>
    </section>
  );
}
