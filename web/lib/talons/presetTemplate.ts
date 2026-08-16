/**
 * The portable half of a talon — what a reusable template stores, and the two
 * pure helpers the preset surfaces share.
 *
 * A talon preset doc keeps its own `name` / `description` (the template's
 * identity) separate from the talon it produces, which lives under `template`.
 * Flattening the two would collide the preset's name with the talon's, which is
 * the ambiguity the deployment-template family lives with today.
 *
 * `TalonPresetTemplate` and `TalonPresetRequirement` are re-exported from
 * `@/lib/talons/types` rather than redeclared. They were briefly declared twice
 * — structurally identical, which typechecks and then silently drifts the first
 * time one side gains a field. This module exists to keep the preset surfaces
 * free of the built-in *catalog* (`@/lib/talons/templates`, which carries data);
 * the shared *types* have always belonged in `types.ts` with the rest.
 *
 * Dependency-free past `@/lib/talons/types` and the validator's constants — no
 * React, no Firestore — so a hook, a page, and a dialog can all import it.
 */

import type {
  TalonCondition,
  TalonOutput,
  TalonPresetRequirement,
  TalonPresetTemplate,
  TalonTrigger,
} from '@/lib/talons/types';
import { DEFAULT_TALON_COOLDOWN_MINUTES } from '@/lib/talons/validation';

export type { TalonPresetRequirement, TalonPresetTemplate };

/** Anything a template can be cut from: a stored talon, or a validated draft. */
export interface TalonPresetSource {
  name: string;
  description?: string | null;
  trigger: TalonTrigger;
  condition: TalonCondition;
  outputs: readonly TalonOutput[];
  cooldownMinutes?: number | null;
}

/**
 * Drop the per-machine half of a `command` output.
 *
 * `processId` identifies a process on ONE machine, so carrying it into a
 * template would produce talons that silently target nothing — the validator
 * only length-checks it, it never asks whether the process exists. The name
 * survives, exactly as `DeploymentDialog` stores `close_processes` as exe names
 * rather than process ids, and the editor reopens it on the free-text path.
 */
function portableOutput(output: TalonOutput): TalonOutput {
  if (output.type !== 'command') return output;
  return {
    type: 'command',
    commandType: output.commandType,
    ...(output.processName ? { processName: output.processName } : {}),
  };
}

/**
 * Project a talon onto the template that reproduces it elsewhere.
 *
 * Two fields are dropped rather than copied:
 *   - `scope` — machine ids belong to one site. The editor seeds every applied
 *     template with "all machines" (`{ machineIds: null }`); an empty array is
 *     invalid, so a stripped scope must not survive as `[]`.
 *   - `enabled` — a template must not decide whether the talon it creates is
 *     armed. Create mode already defaults it to on.
 */
export function talonPresetTemplateFrom(source: TalonPresetSource): TalonPresetTemplate {
  const description = source.description?.trim();
  return {
    name: source.name,
    ...(description ? { description } : {}),
    trigger: source.trigger,
    condition: source.condition,
    outputs: source.outputs.map(portableOutput),
    cooldownMinutes:
      typeof source.cooldownMinutes === 'number'
        ? source.cooldownMinutes
        : DEFAULT_TALON_COOLDOWN_MINUTES,
  };
}

/**
 * Case-insensitive name lookup across the MERGED preset list, so a collision
 * with a built-in is caught too — replacing one mints the `builtin-*` override
 * the api already knows how to write.
 *
 * Name uniqueness is not enforced server-side in any preset family; this is the
 * same client-side guard `RestartScheduleDialog` uses to keep an operator from
 * quietly accumulating three templates called "overnight".
 */
export function findTalonPresetByName<T extends { name: string }>(
  presets: readonly T[],
  name: string,
): T | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return presets.find((preset) => preset.name.trim().toLowerCase() === needle);
}
