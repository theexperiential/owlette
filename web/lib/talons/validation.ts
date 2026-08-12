/**
 * Shared talon input validator — the single rule set behind both the client
 * editor (inline field errors) and the server store (400 responses), so a
 * talon that the editor accepts is a talon the store accepts.
 *
 * Follows the shared-pure-validator pattern of `@/lib/processPayloadValidation`:
 * pure functions, no I/O, no Firestore imports. Unlike that module this one
 * accumulates *every* violation instead of short-circuiting on the first —
 * the editor renders them all at once.
 *
 * The validator also normalizes: strings are trimmed, day and event lists are
 * de-duplicated (days additionally sorted into canonical week order), and
 * omitted optional fields come back as their defaults. Callers persist
 * `value`, never the raw input.
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
  type TalonEventType,
  type TalonMetric,
  type TalonOperator,
  type TalonOutput,
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
 * Syntactic https check only. Deep SSRF defense — DNS resolution, private and
 * link-local address ranges, redirect chasing — happens server-side at send
 * time; this validator is also client-side and can't be trusted for that.
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

/**
 * Reads a required, non-empty, length-bounded string. Returns the trimmed
 * value, or `null` when it recorded an error.
 */
function readBoundedString(
  bag: ErrorBag,
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    bag.add(field, 'missing_field', `\`${field}\` is required.`);
    return null;
  }
  if (typeof value !== 'string') {
    bag.add(field, 'invalid_field', `\`${field}\` must be a string.`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    bag.add(field, 'missing_field', `\`${field}\` is required.`);
    return null;
  }
  if (trimmed.length > maxLength) {
    bag.add(field, 'invalid_field', `\`${field}\` must be ${maxLength} characters or fewer.`);
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
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    bag.add(field, 'invalid_field', `\`${field}\` must be an integer.`);
    return null;
  }
  if (value < min || value > max) {
    bag.add(field, 'out_of_range', `\`${field}\` must be between ${min} and ${max}.`);
    return null;
  }
  return value;
}

function validateDays(bag: ErrorBag, value: unknown, field: string): DayKey[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    bag.add(field, 'invalid_field', `\`${field}\` must be a non-empty array of day keys.`);
    return null;
  }
  const seen = new Set<DayKey>();
  let valid = true;
  for (const [index, day] of value.entries()) {
    if (typeof day !== 'string' || !DAY_KEYS.includes(day as DayKey)) {
      bag.add(
        `${field}[${index}]`,
        'invalid_field',
        `\`${field}[${index}]\` must be one of: ${DAY_KEYS.join(', ')}.`,
      );
      valid = false;
      continue;
    }
    seen.add(day as DayKey);
  }
  if (!valid) return null;
  // De-duplicated and re-ordered into canonical week order so two equivalent
  // selections always persist identically.
  return DAY_KEYS.filter((day) => seen.has(day));
}

function validateScheduleEntries(
  bag: ErrorBag,
  value: unknown,
  field: string,
): TalonScheduleEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    bag.add(field, 'invalid_field', `\`${field}\` must be a non-empty array.`);
    return null;
  }
  if (value.length > TALON_MAX_SCHEDULE_ENTRIES) {
    bag.add(
      field,
      'out_of_range',
      `\`${field}\` must contain ${TALON_MAX_SCHEDULE_ENTRIES} entries or fewer.`,
    );
    return null;
  }

  const entries: TalonScheduleEntry[] = [];
  let valid = true;
  for (const [index, entry] of value.entries()) {
    const path = `${field}[${index}]`;
    if (!isPlainObject(entry)) {
      bag.add(path, 'invalid_field', `\`${path}\` must be an object.`);
      valid = false;
      continue;
    }

    const id = readBoundedString(bag, entry.id, `${path}.id`, 128);
    const days = validateDays(bag, entry.days, `${path}.days`);

    let time: string | null = null;
    if (typeof entry.time !== 'string' || !TIME_PATTERN.test(entry.time)) {
      bag.add(`${path}.time`, 'invalid_field', `\`${path}.time\` must be a 24-hour HH:MM time.`);
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
    bag.add('trigger', 'missing_field', '`trigger` is required.');
    return null;
  }
  if (!isPlainObject(value)) {
    bag.add('trigger', 'invalid_field', '`trigger` must be an object.');
    return null;
  }

  switch (value.type) {
    case 'schedule': {
      const hasEntries = value.entries !== undefined && value.entries !== null;
      const hasInterval = value.intervalMinutes !== undefined && value.intervalMinutes !== null;
      if (hasEntries && hasInterval) {
        bag.add(
          'trigger',
          'invalid_field',
          'A schedule trigger takes either `entries` or `intervalMinutes`, not both.',
        );
        return null;
      }
      if (!hasEntries && !hasInterval) {
        bag.add(
          'trigger',
          'missing_field',
          'A schedule trigger requires either `entries` or `intervalMinutes`.',
        );
        return null;
      }

      if (hasEntries) {
        const entries = validateScheduleEntries(bag, value.entries, 'trigger.entries');
        return entries === null ? null : { type: 'schedule', entries };
      }

      // A visual check costs a screenshot round-trip plus a model call per
      // run, so it carries a wider interval floor than a plain schedule. The
      // condition is validated first precisely so this floor can be applied.
      const minInterval =
        condition?.type === 'visual_check'
          ? TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK
          : TALON_MIN_INTERVAL_MINUTES;
      const intervalMinutes = readBoundedInteger(
        bag,
        value.intervalMinutes,
        'trigger.intervalMinutes',
        minInterval,
        TALON_MAX_INTERVAL_MINUTES,
      );
      return intervalMinutes === null ? null : { type: 'schedule', intervalMinutes };
    }

    case 'threshold': {
      let valid = true;
      if (typeof value.metric !== 'string' || !TALON_METRICS.includes(value.metric as TalonMetric)) {
        bag.add(
          'trigger.metric',
          'invalid_field',
          `\`trigger.metric\` must be one of: ${TALON_METRICS.join(', ')}.`,
        );
        valid = false;
      }
      if (
        typeof value.operator !== 'string' ||
        !TALON_OPERATORS.includes(value.operator as TalonOperator)
      ) {
        bag.add(
          'trigger.operator',
          'invalid_field',
          `\`trigger.operator\` must be one of: ${TALON_OPERATORS.join(', ')}.`,
        );
        valid = false;
      }
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
        bag.add('trigger.value', 'invalid_field', '`trigger.value` must be a finite number.');
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
      if (!Array.isArray(value.eventTypes) || value.eventTypes.length === 0) {
        bag.add('trigger.eventTypes', 'invalid_field', '`trigger.eventTypes` must be a non-empty array.');
        return null;
      }
      const seen = new Set<TalonEventType>();
      let valid = true;
      for (const [index, eventType] of value.eventTypes.entries()) {
        if (
          typeof eventType !== 'string' ||
          !TALON_EVENT_TYPES.includes(eventType as TalonEventType)
        ) {
          bag.add(
            `trigger.eventTypes[${index}]`,
            'invalid_field',
            `\`trigger.eventTypes[${index}]\` must be one of: ${TALON_EVENT_TYPES.join(', ')}.`,
          );
          valid = false;
          continue;
        }
        seen.add(eventType as TalonEventType);
      }
      if (!valid) return null;
      return {
        type: 'event',
        eventTypes: TALON_EVENT_TYPES.filter((eventType) => seen.has(eventType)),
      };
    }

    default:
      bag.add(
        'trigger.type',
        'invalid_field',
        '`trigger.type` must be one of: schedule, threshold, event.',
      );
      return null;
  }
}

function validateCondition(bag: ErrorBag, value: unknown): TalonCondition | null {
  if (value === undefined || value === null) return { type: 'none' };
  if (!isPlainObject(value)) {
    bag.add('condition', 'invalid_field', '`condition` must be an object.');
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
      );

      let monitor: number | undefined;
      if (value.monitor !== undefined && value.monitor !== null) {
        // Matches `capture_screenshot`: 0 = all monitors combined, 1 = primary.
        const parsed = readBoundedInteger(bag, value.monitor, 'condition.monitor', 0, 64);
        if (parsed === null) return null;
        monitor = parsed;
      }

      if (expectation === null) return null;
      return monitor === undefined
        ? { type: 'visual_check', expectation }
        : { type: 'visual_check', expectation, monitor };
    }

    default:
      bag.add('condition.type', 'invalid_field', '`condition.type` must be one of: none, visual_check.');
      return null;
  }
}

function validateOutput(bag: ErrorBag, value: unknown, path: string): TalonOutput | null {
  if (!isPlainObject(value)) {
    bag.add(path, 'invalid_field', `\`${path}\` must be an object.`);
    return null;
  }

  switch (value.type) {
    case 'email':
      return { type: 'email' };

    case 'webhook': {
      if (typeof value.url !== 'string' || !isValidHttpsUrl(value.url.trim())) {
        bag.add(`${path}.url`, 'invalid_field', `\`${path}.url\` must be a valid https URL.`);
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
      );
      return directive === null ? null : { type: 'cortex', directive };
    }

    case 'command': {
      if (
        typeof value.commandType !== 'string' ||
        !TALON_COMMAND_TYPES.includes(value.commandType as TalonCommandType)
      ) {
        bag.add(
          `${path}.commandType`,
          'invalid_field',
          `\`${path}.commandType\` must be one of: ${TALON_COMMAND_TYPES.join(', ')}.`,
        );
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
        const parsed = readBoundedString(bag, raw, `${path}.${key}`, 256);
        if (parsed === null) {
          valid = false;
          continue;
        }
        output[key] = parsed;
      }
      return valid ? output : null;
    }

    default:
      bag.add(
        `${path}.type`,
        'invalid_field',
        `\`${path}.type\` must be one of: email, webhook, cortex, command.`,
      );
      return null;
  }
}

function validateOutputs(bag: ErrorBag, value: unknown): TalonOutput[] | null {
  if (!Array.isArray(value)) {
    bag.add('outputs', 'invalid_field', '`outputs` must be an array.');
    return null;
  }
  if (value.length < TALON_MIN_OUTPUTS || value.length > TALON_MAX_OUTPUTS) {
    bag.add(
      'outputs',
      'out_of_range',
      `\`outputs\` must contain between ${TALON_MIN_OUTPUTS} and ${TALON_MAX_OUTPUTS} entries.`,
    );
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

function validateScope(bag: ErrorBag, value: unknown): TalonScope | null {
  // Omitted scope means the whole site, the same as an explicit null.
  if (value === undefined || value === null) return { machineIds: null };
  if (!isPlainObject(value)) {
    bag.add('scope', 'invalid_field', '`scope` must be an object.');
    return null;
  }
  const machineIds = value.machineIds;
  if (machineIds === undefined || machineIds === null) return { machineIds: null };

  if (!Array.isArray(machineIds) || machineIds.length === 0) {
    bag.add(
      'scope.machineIds',
      'invalid_field',
      '`scope.machineIds` must be a non-empty array of machine ids, or null for every machine in the site.',
    );
    return null;
  }

  const seen = new Set<string>();
  let valid = true;
  for (const [index, machineId] of machineIds.entries()) {
    if (typeof machineId !== 'string' || machineId.trim().length === 0) {
      bag.add(
        `scope.machineIds[${index}]`,
        'invalid_field',
        `\`scope.machineIds[${index}]\` must be a non-empty string.`,
      );
      valid = false;
      continue;
    }
    seen.add(machineId.trim());
  }
  return valid ? { machineIds: [...seen] } : null;
}

/**
 * Validates and normalizes the caller-supplied half of a talon.
 *
 * Every violation is reported — the result is `ok: false` with the full error
 * list, never a partial value. Server-owned fields (`schemaVersion`,
 * `createdBy`, `createdAt`, run bookkeeping) are rejected as unknown fields so
 * a client can never inject them.
 */
export function validateTalonInput(input: unknown): TalonValidationResult {
  const bag = new ErrorBag();

  if (!isPlainObject(input)) {
    bag.add('talon', 'invalid_body', 'Talon input must be an object.');
    return { ok: false, errors: bag.errors };
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      bag.add(key, 'unknown_field', `Field \`${key}\` is not allowed.`);
    }
  }

  const name = readBoundedString(bag, input.name, 'name', TALON_NAME_MAX_LENGTH);

  let description: string | undefined;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      bag.add('description', 'invalid_field', '`description` must be a string.');
    } else {
      const trimmed = input.description.trim();
      if (trimmed.length > TALON_DESCRIPTION_MAX_LENGTH) {
        bag.add(
          'description',
          'invalid_field',
          `\`description\` must be ${TALON_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
        );
      } else if (trimmed.length > 0) {
        description = trimmed;
      }
    }
  }

  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      bag.add('enabled', 'invalid_field', '`enabled` must be a boolean.');
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
    const parsed = readBoundedInteger(
      bag,
      input.cooldownMinutes,
      'cooldownMinutes',
      0,
      TALON_MAX_COOLDOWN_MINUTES,
    );
    if (parsed !== null) cooldownMinutes = parsed;
  }

  // Every `null` above recorded an error, so the length check alone decides
  // the outcome — the null comparisons are here to narrow the types.
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
