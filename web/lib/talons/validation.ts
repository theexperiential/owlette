/**
 * Shared talon input validator — one rule set behind both the client editor
 * (inline field errors) and the server store (400s), so anything the editor
 * accepts the store accepts.
 *
 * Pure, no I/O, like `@/lib/processPayloadValidation` — but this one
 * accumulates EVERY violation instead of short-circuiting, so the editor can
 * render them all at once.
 *
 * Also normalizes (trims strings, de-dupes days/events, sorts days into week
 * order, fills defaults). Callers persist `value`, never the raw input.
 */
import {
  DAY_KEYS,
  TALON_COMMAND_TYPES,
  TALON_EVENT_TYPES,
  TALON_METRICS,
  TALON_OPERATORS,
  type DayKey,
  type TalonCommandOutput,
  type TalonCommandType,
  type TalonCondition,
  type TalonEventTrigger,
  type TalonEventType,
  type TalonMetric,
  type TalonOperator,
  type TalonOutput,
  type TalonPresetTemplate,
  type TalonScheduleEntry,
  type TalonScope,
  type TalonTrigger,
} from './types';

/** Per-site talon cap. Enforced by the store against a count query, not here. */
export const MAX_TALONS_PER_SITE = 20;

export const TALON_NAME_MAX_LENGTH = 80;
/** Defensive bound — the description is free text on a Firestore doc. */
export const TALON_DESCRIPTION_MAX_LENGTH = 500;
export const TALON_MIN_INTERVAL_MINUTES = 5;
/** Vision checks cost a screenshot + a model call, so they get a wider floor. */
export const TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK = 15;
/** Anything longer than a day belongs in `entries` as a fixed clock time. */
export const TALON_MAX_INTERVAL_MINUTES = 1440;
export const TALON_MAX_SCHEDULE_ENTRIES = 50;
export const TALON_MIN_OUTPUTS = 1;
export const TALON_MAX_OUTPUTS = 5;
export const TALON_DIRECTIVE_MAX_LENGTH = 1000;
export const TALON_EXPECTATION_MAX_LENGTH = 500;
export const TALON_MAX_COOLDOWN_MINUTES = 1440;
export const DEFAULT_TALON_COOLDOWN_MINUTES = 60;
/**
 * Longest an event trigger may defer: a day, matching the cooldown ceiling.
 * Longer is a schedule, not a reaction, and would outlive the fleet state.
 */
export const TALON_MAX_DELAY_MINUTES = 1440;

/** Matches `capture_screenshot`: 0 = all monitors combined, 1 = primary. */
const MIN_MONITOR_INDEX = 0;
const MAX_MONITOR_INDEX = 64;
/** Defensive bound on a command output's process target. */
const PROCESS_TARGET_MAX_LENGTH = 256;
/** Schedule entry ids are minted by the editor, never typed. */
const SCHEDULE_ENTRY_ID_MAX_LENGTH = 128;

/** 24-hour `HH:MM`, the format `ScheduleEditor` reads and writes. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'enabled',
  'trigger',
  'condition',
  'outputs',
  'scope',
  'cooldownMinutes',
]);

export interface TalonFieldError {
  /** Dotted/indexed path to the offending field, e.g. `outputs[1].url`. */
  field: string;
  code: 'invalid_body' | 'missing_field' | 'invalid_field' | 'unknown_field' | 'out_of_range';
  /** Human copy, rendered verbatim by the editor and in problem+json
   * `fieldErrors`. Never names the path — `field` carries that. */
  message: string;
}

/** The caller-supplied half of a talon — the store owns every other field. */
export interface ValidatedTalonInput {
  name: string;
  description?: string;
  enabled: boolean;
  trigger: TalonTrigger;
  condition: TalonCondition;
  outputs: TalonOutput[];
  scope: TalonScope;
  cooldownMinutes: number;
}

export type TalonValidationResult =
  | { ok: true; value: ValidatedTalonInput }
  | { ok: false; errors: TalonFieldError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Syntactic https check only. Real SSRF defense (DNS, private/link-local
 * ranges, redirects) is server-side at send time — this runs on the client too.
 */
function isValidHttpsUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname.length > 0;
}

class ErrorBag {
  readonly errors: TalonFieldError[] = [];

  add(field: string, code: TalonFieldError['code'], message: string): void {
    this.errors.push({ field, code, message });
  }
}

/** Each variant is the WHOLE message — helpers never compose prose around it,
 * so a path can't leak in. */
interface StringCopy {
  /** Absent, blank, or the wrong type. */
  missing: string;
  /** Longer than the bound. */
  tooLong: string;
}

/** The same contract as `StringCopy`, for a bounded integer field. */
interface IntegerCopy {
  /** Missing, non-numeric, or fractional. */
  notInteger: string;
  /** Below the floor. */
  tooLow: string;
  /** Above the ceiling. */
  tooHigh: string;
}

/** Trimmed value, or `null` when it recorded an error. */
function readBoundedString(
  bag: ErrorBag,
  value: unknown,
  field: string,
  maxLength: number,
  copy: StringCopy,
): string | null {
  if (value === undefined || value === null) {
    bag.add(field, 'missing_field', copy.missing);
    return null;
  }
  // A non-string reads as "not given yet" to the user, so it shares the
  // missing copy; only the code distinguishes them.
  if (typeof value !== 'string') {
    bag.add(field, 'invalid_field', copy.missing);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    bag.add(field, 'missing_field', copy.missing);
    return null;
  }
  if (trimmed.length > maxLength) {
    bag.add(field, 'invalid_field', copy.tooLong);
    return null;
  }
  return trimmed;
}

/** Reads an integer within `[min, max]`. Returns `null` when it recorded an error. */
function readBoundedInteger(
  bag: ErrorBag,
  value: unknown,
  field: string,
  min: number,
  max: number,
  copy: IntegerCopy,
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    bag.add(field, 'invalid_field', copy.notInteger);
    return null;
  }
  if (value < min) {
    bag.add(field, 'out_of_range', copy.tooLow);
    return null;
  }
  if (value > max) {
    bag.add(field, 'out_of_range', copy.tooHigh);
    return null;
  }
  return value;
}

function validateDays(bag: ErrorBag, value: unknown, field: string): DayKey[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    bag.add(field, 'invalid_field', 'pick at least one day');
    return null;
  }
  const seen = new Set<DayKey>();
  let valid = true;
  for (const [index, day] of value.entries()) {
    if (typeof day !== 'string' || !DAY_KEYS.includes(day as DayKey)) {
      bag.add(`${field}[${index}]`, 'invalid_field', 'one of these days is not a day of the week');
      valid = false;
      continue;
    }
    seen.add(day as DayKey);
  }
  if (!valid) return null;
  // Canonical week order so equivalent selections persist identically.
  return DAY_KEYS.filter((day) => seen.has(day));
}

/** Ids are generated, so a malformed one isn't user-fixable — say drop the row. */
const BROKEN_SCHEDULE_ENTRY = 'something is off with this time — remove it and add it again';

function validateScheduleEntries(
  bag: ErrorBag,
  value: unknown,
  field: string,
): TalonScheduleEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    bag.add(field, 'invalid_field', 'add at least one time');
    return null;
  }
  if (value.length > TALON_MAX_SCHEDULE_ENTRIES) {
    bag.add(field, 'out_of_range', `add ${TALON_MAX_SCHEDULE_ENTRIES} times or fewer`);
    return null;
  }

  const entries: TalonScheduleEntry[] = [];
  let valid = true;
  for (const [index, entry] of value.entries()) {
    const path = `${field}[${index}]`;
    if (!isPlainObject(entry)) {
      bag.add(path, 'invalid_field', BROKEN_SCHEDULE_ENTRY);
      valid = false;
      continue;
    }

    const id = readBoundedString(bag, entry.id, `${path}.id`, SCHEDULE_ENTRY_ID_MAX_LENGTH, {
      missing: BROKEN_SCHEDULE_ENTRY,
      tooLong: BROKEN_SCHEDULE_ENTRY,
    });
    const days = validateDays(bag, entry.days, `${path}.days`);

    let time: string | null = null;
    if (typeof entry.time !== 'string' || !TIME_PATTERN.test(entry.time)) {
      bag.add(`${path}.time`, 'invalid_field', 'enter a time like 09:30 or 21:00');
    } else {
      time = entry.time;
    }

    if (id === null || days === null || time === null) {
      valid = false;
      continue;
    }
    entries.push({ id, days, time });
  }

  return valid ? entries : null;
}

function validateTrigger(
  bag: ErrorBag,
  value: unknown,
  condition: TalonCondition | null,
): TalonTrigger | null {
  if (value === undefined || value === null) {
    bag.add('trigger', 'missing_field', 'choose what makes this talon fire');
    return null;
  }
  if (!isPlainObject(value)) {
    bag.add('trigger', 'invalid_field', 'choose what makes this talon fire');
    return null;
  }

  // Delay only makes sense on an event. Rejected, not dropped — silently
  // ignoring a set field is how a talon stops doing what its author asked.
  // Before the switch so schedule/threshold keep their early returns.
  if (
    (value.type === 'schedule' || value.type === 'threshold') &&
    value.delayMinutes !== undefined &&
    value.delayMinutes !== null
  ) {
    bag.add('trigger.delayMinutes', 'invalid_field', 'this only applies to event triggers');
  }

  switch (value.type) {
    case 'schedule': {
      const hasEntries = value.entries !== undefined && value.entries !== null;
      const hasInterval = value.intervalMinutes !== undefined && value.intervalMinutes !== null;
      if (hasEntries && hasInterval) {
        bag.add(
          'trigger',
          'invalid_field',
          'a schedule runs at set times or on an interval, not both',
        );
        return null;
      }
      if (!hasEntries && !hasInterval) {
        bag.add('trigger', 'missing_field', 'add at least one time, or set an interval');
        return null;
      }

      if (hasEntries) {
        const entries = validateScheduleEntries(bag, value.entries, 'trigger.entries');
        return entries === null ? null : { type: 'schedule', entries };
      }

      // Screenshot + model call per run earns a wider floor than a plain
      // schedule; the condition is validated first so this can be applied.
      const isVisualCheck = condition?.type === 'visual_check';
      const minInterval = isVisualCheck
        ? TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK
        : TALON_MIN_INTERVAL_MINUTES;
      const intervalMinutes = readBoundedInteger(
        bag,
        value.intervalMinutes,
        'trigger.intervalMinutes',
        minInterval,
        TALON_MAX_INTERVAL_MINUTES,
        {
          notInteger: 'enter a whole number of minutes',
          tooLow: isVisualCheck
            ? `visual checks run at most every ${TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK} minutes`
            : `runs at most every ${TALON_MIN_INTERVAL_MINUTES} minutes`,
          tooHigh: 'runs at least once a day — use set times for anything less often',
        },
      );
      return intervalMinutes === null ? null : { type: 'schedule', intervalMinutes };
    }

    case 'threshold': {
      let valid = true;
      if (typeof value.metric !== 'string' || !TALON_METRICS.includes(value.metric as TalonMetric)) {
        bag.add('trigger.metric', 'invalid_field', 'choose a metric to watch');
        valid = false;
      }
      if (
        typeof value.operator !== 'string' ||
        !TALON_OPERATORS.includes(value.operator as TalonOperator)
      ) {
        bag.add('trigger.operator', 'invalid_field', 'choose how to compare the metric');
        valid = false;
      }
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
        bag.add('trigger.value', 'invalid_field', 'enter a number to compare against');
        valid = false;
      }
      if (!valid) return null;
      return {
        type: 'threshold',
        metric: value.metric as TalonMetric,
        operator: value.operator as TalonOperator,
        value: value.value as number,
      };
    }

    case 'event': {
      // Before the event list so both errors surface on one submit.
      let delayMinutes: number | undefined;
      let delayValid = true;
      if (value.delayMinutes !== undefined && value.delayMinutes !== null) {
        const outOfRange = `the delay must be between 0 and ${TALON_MAX_DELAY_MINUTES / 60} hours`;
        const parsed = readBoundedInteger(
          bag,
          value.delayMinutes,
          'trigger.delayMinutes',
          0,
          TALON_MAX_DELAY_MINUTES,
          {
            notInteger: 'enter a whole number of minutes',
            tooLow: outOfRange,
            tooHigh: outOfRange,
          },
        );
        if (parsed === null) delayValid = false;
        // 0 IS no delay — normalize away so "run now" has one representation.
        else if (parsed > 0) delayMinutes = parsed;
      }

      if (!Array.isArray(value.eventTypes) || value.eventTypes.length === 0) {
        bag.add('trigger.eventTypes', 'invalid_field', 'pick at least one event');
        return null;
      }
      const seen = new Set<TalonEventType>();
      let valid = true;
      for (const [index, eventType] of value.eventTypes.entries()) {
        if (
          typeof eventType !== 'string' ||
          !TALON_EVENT_TYPES.includes(eventType as TalonEventType)
        ) {
          bag.add(`trigger.eventTypes[${index}]`, 'invalid_field', 'one of these events is not valid');
          valid = false;
          continue;
        }
        seen.add(eventType as TalonEventType);
      }
      if (!valid || !delayValid) return null;

      const trigger: TalonEventTrigger = {
        type: 'event',
        eventTypes: TALON_EVENT_TYPES.filter((eventType) => seen.has(eventType)),
      };
      if (delayMinutes !== undefined) trigger.delayMinutes = delayMinutes;
      return trigger;
    }

    default:
      bag.add('trigger.type', 'invalid_field', 'choose a trigger type');
      return null;
  }
}

function validateCondition(bag: ErrorBag, value: unknown): TalonCondition | null {
  if (value === undefined || value === null) return { type: 'none' };
  if (!isPlainObject(value)) {
    bag.add('condition', 'invalid_field', 'choose a condition');
    return null;
  }

  switch (value.type) {
    case 'none':
      return { type: 'none' };

    case 'visual_check': {
      const expectation = readBoundedString(
        bag,
        value.expectation,
        'condition.expectation',
        TALON_EXPECTATION_MAX_LENGTH,
        {
          missing: 'describe what the screen should show',
          tooLong: `keep this to ${TALON_EXPECTATION_MAX_LENGTH} characters or fewer`,
        },
      );

      let monitor: number | undefined;
      if (value.monitor !== undefined && value.monitor !== null) {
        const outOfRange = `monitor must be between ${MIN_MONITOR_INDEX} and ${MAX_MONITOR_INDEX}`;
        const parsed = readBoundedInteger(
          bag,
          value.monitor,
          'condition.monitor',
          MIN_MONITOR_INDEX,
          MAX_MONITOR_INDEX,
          { notInteger: 'enter a whole monitor number', tooLow: outOfRange, tooHigh: outOfRange },
        );
        if (parsed === null) return null;
        monitor = parsed;
      }

      if (expectation === null) return null;
      return monitor === undefined
        ? { type: 'visual_check', expectation }
        : { type: 'visual_check', expectation, monitor };
    }

    default:
      bag.add('condition.type', 'invalid_field', 'choose a condition type');
      return null;
  }
}

/** Per-key copy for a command output's process target. */
const PROCESS_TARGET_COPY: Readonly<Record<'processId' | 'processName', StringCopy>> = {
  processId: {
    missing: 'choose a process',
    tooLong: 'that process is not one owlette can address',
  },
  processName: {
    missing: 'enter a process name',
    tooLong: `keep the process name to ${PROCESS_TARGET_MAX_LENGTH} characters or fewer`,
  },
};

function validateOutput(bag: ErrorBag, value: unknown, path: string): TalonOutput | null {
  if (!isPlainObject(value)) {
    bag.add(path, 'invalid_field', 'this output is not valid — remove it and add it again');
    return null;
  }

  switch (value.type) {
    case 'email':
      return { type: 'email' };

    case 'webhook': {
      if (typeof value.url !== 'string' || !isValidHttpsUrl(value.url.trim())) {
        bag.add(`${path}.url`, 'invalid_field', 'enter a valid https url');
        return null;
      }
      return { type: 'webhook', url: value.url.trim() };
    }

    case 'cortex': {
      const directive = readBoundedString(
        bag,
        value.directive,
        `${path}.directive`,
        TALON_DIRECTIVE_MAX_LENGTH,
        {
          missing: 'tell hoot what to do when this talon fires',
          tooLong: `keep this to ${TALON_DIRECTIVE_MAX_LENGTH} characters or fewer`,
        },
      );

      let allowActions = false;
      if (value.allowActions !== undefined && value.allowActions !== null) {
        if (typeof value.allowActions !== 'boolean') {
          bag.add(`${path}.allowActions`, 'invalid_field', 'this must be on or off');
          return null;
        }
        allowActions = value.allowActions;
      }

      if (directive === null) return null;
      // `false` IS the default — normalize away. Authoring `true` is gated on
      // site admin by the store.
      return allowActions
        ? { type: 'cortex', directive, allowActions: true }
        : { type: 'cortex', directive };
    }

    case 'command': {
      if (
        typeof value.commandType !== 'string' ||
        !TALON_COMMAND_TYPES.includes(value.commandType as TalonCommandType)
      ) {
        bag.add(`${path}.commandType`, 'invalid_field', 'choose a command to run');
        return null;
      }

      const output: TalonCommandOutput = {
        type: 'command',
        commandType: value.commandType as TalonCommandType,
      };
      let valid = true;
      for (const key of ['processId', 'processName'] as const) {
        const raw = value[key];
        if (raw === undefined || raw === null) continue;
        const parsed = readBoundedString(
          bag,
          raw,
          `${path}.${key}`,
          PROCESS_TARGET_MAX_LENGTH,
          PROCESS_TARGET_COPY[key],
        );
        if (parsed === null) {
          valid = false;
          continue;
        }
        output[key] = parsed;
      }
      if (!valid) return null;

      // Nothing downstream accepts a targetless command — the agent reports
      // `<unspecified>` and the executor fails the run until the tenth
      // consecutive failure auto-disables the talon. Reported against
      // `processId` because the editor routes both target keys to one slot.
      if (output.processId === undefined && output.processName === undefined) {
        bag.add(`${path}.processId`, 'missing_field', PROCESS_TARGET_COPY.processId.missing);
        return null;
      }
      return output;
    }

    default:
      bag.add(`${path}.type`, 'invalid_field', 'choose what this output does');
      return null;
  }
}

function validateOutputs(bag: ErrorBag, value: unknown): TalonOutput[] | null {
  if (!Array.isArray(value)) {
    bag.add('outputs', 'invalid_field', 'add at least one output');
    return null;
  }
  if (value.length < TALON_MIN_OUTPUTS) {
    bag.add('outputs', 'out_of_range', 'add at least one output');
    return null;
  }
  if (value.length > TALON_MAX_OUTPUTS) {
    bag.add('outputs', 'out_of_range', `use ${TALON_MAX_OUTPUTS} outputs or fewer`);
    return null;
  }

  const outputs: TalonOutput[] = [];
  let valid = true;
  for (const [index, output] of value.entries()) {
    const parsed = validateOutput(bag, output, `outputs[${index}]`);
    if (parsed === null) {
      valid = false;
      continue;
    }
    outputs.push(parsed);
  }
  return valid ? outputs : null;
}

/** Both the empty-array trap and a malformed scope resolve the same way. */
const SCOPE_REQUIRED = 'select at least one machine, or switch to all machines';

function validateScope(bag: ErrorBag, value: unknown): TalonScope | null {
  // Omitted scope means the whole site, the same as an explicit null.
  if (value === undefined || value === null) return { machineIds: null };
  if (!isPlainObject(value)) {
    bag.add('scope', 'invalid_field', SCOPE_REQUIRED);
    return null;
  }
  const machineIds = value.machineIds;
  if (machineIds === undefined || machineIds === null) return { machineIds: null };

  if (!Array.isArray(machineIds) || machineIds.length === 0) {
    bag.add('scope.machineIds', 'invalid_field', SCOPE_REQUIRED);
    return null;
  }

  const seen = new Set<string>();
  let valid = true;
  for (const [index, machineId] of machineIds.entries()) {
    if (typeof machineId !== 'string' || machineId.trim().length === 0) {
      bag.add(`scope.machineIds[${index}]`, 'invalid_field', 'one of these machines is not valid');
      valid = false;
      continue;
    }
    seen.add(machineId.trim());
  }
  return valid ? { machineIds: [...seen] } : null;
}

/**
 * Validates + normalizes the caller-supplied half of a talon. Reports every
 * violation; never returns a partial value. Server-owned fields
 * (`schemaVersion`, `createdBy`, `createdAt`, run bookkeeping) are rejected as
 * unknown so a client can never inject them.
 */
export function validateTalonInput(input: unknown): TalonValidationResult {
  const bag = new ErrorBag();

  if (!isPlainObject(input)) {
    bag.add('talon', 'invalid_body', 'talon input must be an object');
    return { ok: false, errors: bag.errors };
  }

  // Server-owned fields land here too. Plain copy: API-only path.
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      bag.add(key, 'unknown_field', 'this field cannot be set here');
    }
  }

  const name = readBoundedString(bag, input.name, 'name', TALON_NAME_MAX_LENGTH, {
    missing: 'give this talon a name',
    tooLong: `keep the name to ${TALON_NAME_MAX_LENGTH} characters or fewer`,
  });

  let description: string | undefined;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      bag.add('description', 'invalid_field', 'the description must be text');
    } else {
      const trimmed = input.description.trim();
      if (trimmed.length > TALON_DESCRIPTION_MAX_LENGTH) {
        bag.add(
          'description',
          'invalid_field',
          `keep the description to ${TALON_DESCRIPTION_MAX_LENGTH} characters or fewer`,
        );
      } else if (trimmed.length > 0) {
        description = trimmed;
      }
    }
  }

  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      bag.add('enabled', 'invalid_field', 'enabled must be true or false');
    } else {
      enabled = input.enabled;
    }
  }

  // Condition before trigger: the interval floor depends on whether this is a
  // visual check.
  const condition = validateCondition(bag, input.condition);
  const trigger = validateTrigger(bag, input.trigger, condition);
  const outputs = validateOutputs(bag, input.outputs);
  const scope = validateScope(bag, input.scope);

  let cooldownMinutes = DEFAULT_TALON_COOLDOWN_MINUTES;
  if (input.cooldownMinutes !== undefined && input.cooldownMinutes !== null) {
    const outOfRange = `cooldown must be between 0 and ${TALON_MAX_COOLDOWN_MINUTES / 60} hours`;
    const parsed = readBoundedInteger(
      bag,
      input.cooldownMinutes,
      'cooldownMinutes',
      0,
      TALON_MAX_COOLDOWN_MINUTES,
      {
        notInteger: 'enter a whole number of minutes',
        tooLow: outOfRange,
        tooHigh: outOfRange,
      },
    );
    if (parsed !== null) cooldownMinutes = parsed;
  }

  // Every `null` above already recorded an error, so the length check decides
  // the outcome; the null comparisons only narrow types.
  if (
    bag.errors.length > 0 ||
    name === null ||
    trigger === null ||
    condition === null ||
    outputs === null ||
    scope === null
  ) {
    return { ok: false, errors: bag.errors };
  }

  const value: ValidatedTalonInput = {
    name,
    enabled,
    trigger,
    condition,
    outputs,
    scope,
    cooldownMinutes,
  };
  if (description !== undefined) value.description = description;

  return { ok: true, value };
}


export type TalonPresetTemplateResult =
  | { ok: true; value: TalonPresetTemplate }
  | { ok: false; errors: TalonFieldError[] };

/**
 * Talon fields a TEMPLATE must not carry ({@link TalonPresetTemplate}).
 * Rejected, not dropped — silently discarding a set field is how a preset
 * stops doing what its author asked.
 */
const PRESET_FORBIDDEN_FIELDS: Readonly<Record<string, string>> = {
  scope: 'a template applies to every machine — pick machines when you use it',
  enabled: 'a template does not decide whether the talon it creates is on',
};

/**
 * Validates the talon-shaped payload a preset carries.
 *
 * DELEGATES to `validateTalonInput` rather than re-deriving the rules — a
 * preset storing a talon the store would refuse only breaks at apply time.
 * `enabled` and `scope` are injected at template defaults so the delegate sees
 * a complete talon, then dropped (a template owns neither). Error paths are
 * prefixed `template.` to address the body the caller actually sent.
 */
export function validateTalonPresetInput(input: unknown): TalonPresetTemplateResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        { field: 'template', code: 'invalid_body', message: 'the template must be an object' },
      ],
    };
  }

  const forbidden = Object.entries(PRESET_FORBIDDEN_FIELDS)
    .filter(([key]) => input[key] !== undefined)
    .map(([key, message]): TalonFieldError => ({
      field: `template.${key}`,
      code: 'unknown_field',
      message,
    }));
  if (forbidden.length > 0) return { ok: false, errors: forbidden };

  const result = validateTalonInput({ ...input, enabled: true, scope: { machineIds: null } });
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors.map((error) => ({ ...error, field: `template.${error.field}` })),
    };
  }

  const { name, description, trigger, condition, outputs, cooldownMinutes } = result.value;
  const value: TalonPresetTemplate = { name, trigger, condition, outputs, cooldownMinutes };
  if (description !== undefined) value.description = description;
  return { ok: true, value };
}
