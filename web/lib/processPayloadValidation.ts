import type { PublicProcessConfig, ScheduleBlock } from '@/lib/processConfig.server';

export const VALID_PROCESS_LAUNCH_MODES = ['off', 'always', 'scheduled'] as const;
export type ProcessLaunchMode = (typeof VALID_PROCESS_LAUNCH_MODES)[number];

export interface ProcessPayloadValidationError {
  status: 400;
  code: string;
  detail: string;
}

export type ProcessPayloadValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProcessPayloadValidationError };

export type ValidatedCreateProcessFields = Pick<
  PublicProcessConfig,
  | 'name'
  | 'exe_path'
  | 'file_path'
  | 'cwd'
  | 'priority'
  | 'visibility'
  | 'time_delay'
  | 'time_to_init'
  | 'relaunch_attempts'
  | 'launch_mode'
  | 'schedules'
  | 'schedulePresetId'
>;

export type ValidatedUpdateProcessFields = Partial<
  Pick<
    PublicProcessConfig,
    | 'name'
    | 'exe_path'
    | 'file_path'
    | 'cwd'
    | 'priority'
    | 'visibility'
    | 'time_delay'
    | 'time_to_init'
    | 'relaunch_attempts'
    | 'launch_mode'
    | 'schedules'
    | 'schedule'
    | 'schedulePresetId'
    | 'autolaunch'
  >
>;

export interface ValidatedScheduleBody {
  mode: ProcessLaunchMode;
  blocks: ScheduleBlock[] | null;
}

const STRING_FIELDS = [
  'name',
  'exe_path',
  'file_path',
  'cwd',
  'priority',
  'visibility',
  'time_delay',
  'time_to_init',
  'relaunch_attempts',
] as const;

const CREATE_ALLOWED_FIELDS = new Set<string>([
  ...STRING_FIELDS,
  'launch_mode',
  'schedules',
  'schedulePresetId',
]);

const UPDATE_ALLOWED_FIELDS = new Set<string>([
  ...STRING_FIELDS,
  'launch_mode',
  'schedules',
  'schedule',
  'schedulePresetId',
  'autolaunch',
]);

function validationError(code: string, detail: string): ProcessPayloadValidationResult<never> {
  return { ok: false, error: { status: 400, code, detail } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLaunchMode(value: unknown): value is ProcessLaunchMode {
  return typeof value === 'string' && VALID_PROCESS_LAUNCH_MODES.includes(value as ProcessLaunchMode);
}

function assertNoForbiddenIds(body: Record<string, unknown>): ProcessPayloadValidationResult<undefined> {
  if ('processId' in body || 'id' in body) {
    return validationError('forbidden_field', 'Cannot set `processId` or `id`.');
  }
  return { ok: true, value: undefined };
}

function assertAllowedFields(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): ProcessPayloadValidationResult<undefined> {
  const unknown = Object.keys(body).find((key) => key !== 'processId' && key !== 'id' && !allowed.has(key));
  if (unknown) {
    return validationError('unknown_field', `Field \`${unknown}\` is not allowed.`);
  }
  return { ok: true, value: undefined };
}

function readString(
  body: Record<string, unknown>,
  key: (typeof STRING_FIELDS)[number],
  options: { required?: boolean; nonEmpty?: boolean } = {},
): ProcessPayloadValidationResult<string | undefined> {
  const value = body[key];
  if (value === undefined) {
    if (options.required) return validationError('missing_field', `Field \`${key}\` is required.`);
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return validationError('invalid_field', `Field \`${key}\` must be a string.`);
  }
  if (options.nonEmpty && value.trim().length === 0) {
    return validationError('missing_field', `Field \`${key}\` is required.`);
  }
  return { ok: true, value };
}

export function validateScheduleBlocks(
  value: unknown,
  fieldName = 'schedules',
  options: { required?: boolean; nonEmpty?: boolean } = {},
): ProcessPayloadValidationResult<ScheduleBlock[] | null> {
  if (value === undefined || value === null) {
    if (options.required) {
      return validationError('missing_schedules', `Field \`${fieldName}\` is required.`);
    }
    return { ok: true, value: null };
  }
  if (!Array.isArray(value)) {
    return validationError('invalid_field', `Field \`${fieldName}\` must be an array.`);
  }
  if (options.nonEmpty && value.length === 0) {
    return validationError('missing_schedules', `Field \`${fieldName}\` must be non-empty.`);
  }

  const cleaned: ScheduleBlock[] = [];
  for (const [blockIndex, block] of value.entries()) {
    if (!isPlainObject(block)) {
      return validationError('invalid_field', `Field \`${fieldName}[${blockIndex}]\` must be an object.`);
    }

    if (!Array.isArray(block.days) || !block.days.every((day) => typeof day === 'string' && day.length > 0)) {
      return validationError(
        'invalid_field',
        `Field \`${fieldName}[${blockIndex}].days\` must be an array of strings.`,
      );
    }
    if (!Array.isArray(block.ranges) || block.ranges.length === 0) {
      return validationError(
        'invalid_field',
        `Field \`${fieldName}[${blockIndex}].ranges\` must be a non-empty array.`,
      );
    }

    const ranges: ScheduleBlock['ranges'] = [];
    for (const [rangeIndex, range] of block.ranges.entries()) {
      if (
        !isPlainObject(range) ||
        typeof range.start !== 'string' ||
        range.start.length === 0 ||
        typeof range.stop !== 'string' ||
        range.stop.length === 0
      ) {
        return validationError(
          'invalid_field',
          `Field \`${fieldName}[${blockIndex}].ranges[${rangeIndex}]\` must include string start and stop.`,
        );
      }
      ranges.push({ start: range.start, stop: range.stop });
    }

    const cleanBlock: ScheduleBlock = { days: [...block.days], ranges };
    if (block.name !== undefined) {
      if (typeof block.name !== 'string') {
        return validationError('invalid_field', `Field \`${fieldName}[${blockIndex}].name\` must be a string.`);
      }
      cleanBlock.name = block.name;
    }
    if (block.colorIndex !== undefined) {
      if (typeof block.colorIndex !== 'number' || !Number.isFinite(block.colorIndex)) {
        return validationError(
          'invalid_field',
          `Field \`${fieldName}[${blockIndex}].colorIndex\` must be a number.`,
        );
      }
      cleanBlock.colorIndex = block.colorIndex;
    }
    cleaned.push(cleanBlock);
  }

  return { ok: true, value: cleaned };
}

function validateScheduleObject(value: unknown): ProcessPayloadValidationResult<PublicProcessConfig['schedule']> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) {
    return validationError('invalid_field', 'Field `schedule` must be an object or null.');
  }
  if (!isLaunchMode(value.mode)) {
    return validationError(
      'invalid_field',
      `Field \`schedule.mode\` must be one of: ${VALID_PROCESS_LAUNCH_MODES.join(', ')}.`,
    );
  }
  const blocks = validateScheduleBlocks(value.blocks, 'schedule.blocks', {
    required: value.mode === 'scheduled',
    nonEmpty: value.mode === 'scheduled',
  });
  if (!blocks.ok) return blocks;
  return {
    ok: true,
    value: blocks.value ? { mode: value.mode, blocks: blocks.value } : { mode: value.mode },
  };
}

export function validateCreateProcessFields(
  body: Record<string, unknown>,
): ProcessPayloadValidationResult<ValidatedCreateProcessFields> {
  const ids = assertNoForbiddenIds(body);
  if (!ids.ok) return ids;
  const allowed = assertAllowedFields(body, CREATE_ALLOWED_FIELDS);
  if (!allowed.ok) return allowed;

  const name = readString(body, 'name', { required: true, nonEmpty: true });
  if (!name.ok) return name;
  const exePath = readString(body, 'exe_path', { required: true, nonEmpty: true });
  if (!exePath.ok) return exePath;

  const value: ValidatedCreateProcessFields = {
    name: name.value as string,
    exe_path: exePath.value as string,
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Show',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    launch_mode: 'off',
    schedules: null,
  };

  for (const field of STRING_FIELDS) {
    if (field === 'name' || field === 'exe_path') continue;
    const result = readString(body, field);
    if (!result.ok) return result;
    if (result.value !== undefined) value[field] = result.value;
  }

  if (body.launch_mode !== undefined) {
    if (!isLaunchMode(body.launch_mode)) {
      return validationError(
        'invalid_field',
        `Field \`launch_mode\` must be one of: ${VALID_PROCESS_LAUNCH_MODES.join(', ')}.`,
      );
    }
    value.launch_mode = body.launch_mode;
  }

  const schedules = validateScheduleBlocks(body.schedules, 'schedules', {
    required: value.launch_mode === 'scheduled',
    nonEmpty: value.launch_mode === 'scheduled',
  });
  if (!schedules.ok) return schedules;
  value.schedules = schedules.value;

  if (body.schedulePresetId !== undefined) {
    if (body.schedulePresetId !== null && typeof body.schedulePresetId !== 'string') {
      return validationError('invalid_field', 'Field `schedulePresetId` must be a string or null.');
    }
    value.schedulePresetId = body.schedulePresetId;
  }

  return { ok: true, value };
}

export function validateUpdateProcessFields(
  body: Record<string, unknown>,
): ProcessPayloadValidationResult<ValidatedUpdateProcessFields> {
  const ids = assertNoForbiddenIds(body);
  if (!ids.ok) return ids;
  const allowed = assertAllowedFields(body, UPDATE_ALLOWED_FIELDS);
  if (!allowed.ok) return allowed;
  if (Object.keys(body).length === 0) {
    return validationError('no_fields', 'Request body must contain at least one field to update.');
  }

  const value: ValidatedUpdateProcessFields = {};
  for (const field of STRING_FIELDS) {
    if (!(field in body)) continue;
    const result = readString(body, field, {
      nonEmpty: field === 'name' || field === 'exe_path',
    });
    if (!result.ok) return result;
    value[field] = result.value;
  }

  if (body.launch_mode !== undefined) {
    if (!isLaunchMode(body.launch_mode)) {
      return validationError(
        'invalid_field',
        `Field \`launch_mode\` must be one of: ${VALID_PROCESS_LAUNCH_MODES.join(', ')}.`,
      );
    }
    value.launch_mode = body.launch_mode;
  }

  if (body.schedules !== undefined) {
    const schedules = validateScheduleBlocks(body.schedules, 'schedules', {
      required: body.launch_mode === 'scheduled',
      nonEmpty: body.launch_mode === 'scheduled',
    });
    if (!schedules.ok) return schedules;
    value.schedules = schedules.value;
  }

  if (body.schedule !== undefined) {
    const schedule = validateScheduleObject(body.schedule);
    if (!schedule.ok) return schedule;
    value.schedule = schedule.value;
  }

  if (body.schedulePresetId !== undefined) {
    if (body.schedulePresetId !== null && typeof body.schedulePresetId !== 'string') {
      return validationError('invalid_field', 'Field `schedulePresetId` must be a string or null.');
    }
    value.schedulePresetId = body.schedulePresetId;
  }

  if (body.autolaunch !== undefined) {
    if (typeof body.autolaunch !== 'boolean') {
      return validationError('invalid_field', 'Field `autolaunch` must be a boolean.');
    }
    value.autolaunch = body.autolaunch;
  }

  return { ok: true, value };
}

export function validateProcessScheduleBody(
  body: Record<string, unknown>,
): ProcessPayloadValidationResult<ValidatedScheduleBody> {
  const unknown = Object.keys(body).find((key) => key !== 'mode' && key !== 'blocks');
  if (unknown) {
    return validationError('unknown_field', `Field \`${unknown}\` is not allowed.`);
  }
  if (!isLaunchMode(body.mode)) {
    return validationError(
      'invalid_field',
      `Field \`mode\` must be one of: ${VALID_PROCESS_LAUNCH_MODES.join(', ')}.`,
    );
  }

  const blocks = validateScheduleBlocks(body.blocks, 'blocks', {
    required: body.mode === 'scheduled',
    nonEmpty: body.mode === 'scheduled',
  });
  if (!blocks.ok) return blocks;

  return { ok: true, value: { mode: body.mode, blocks: blocks.value } };
}
