/**
 * The portable half of a talon: what a reusable template stores, plus the pure
 * helpers the preset surfaces share.
 *
 * A preset doc keeps its own `name`/`description` separate from the talon under
 * `template` — flattening them collides the two names, the ambiguity the
 * deployment-template family lives with today.
 *
 * `TalonPresetTemplate` / `TalonPresetRequirement` are re-exported from
 * `@/lib/talons/types`, never redeclared: duplicate structurally-identical
 * declarations typecheck and then silently drift. This module keeps the preset
 * surfaces free of the built-in catalog (`@/lib/talons/templates`, data-heavy).
 *
 * Dependency-free past types + validator constants — no React, no Firestore —
 * so a hook, a page, and a dialog can all import it.
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
 * Drop the per-machine half of a `command` output. `processId` names a process
 * on ONE machine, so templating it produces talons that silently target nothing
 * (the validator only length-checks it). The name survives, as
 * `DeploymentDialog` does for `close_processes`.
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
 * Project a talon onto the template that reproduces it elsewhere. Two fields
 * are dropped, not copied: `scope` (machine ids belong to one site; the editor
 * seeds `{ machineIds: null }`, and `[]` is invalid so a stripped scope must
 * not survive as one), and `enabled` (a template must not arm what it creates).
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
 * Case-insensitive lookup across the MERGED preset list so built-in collisions
 * are caught too (replacing one mints a `builtin-*` override). Name uniqueness
 * is not enforced server-side in any preset family — this is the same
 * client-side guard `RestartScheduleDialog` uses.
 */
export function findTalonPresetByName<T extends { name: string }>(
  presets: readonly T[],
  name: string,
): T | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return presets.find((preset) => preset.name.trim().toLowerCase() === needle);
}
