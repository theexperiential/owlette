/** @jest-environment node */

import { readFileSync } from 'fs';
import path from 'path';

import { DISPLAY_EVENT_ROUTING } from '@/lib/alerts/displayEventRouting';
import {
  DAY_KEYS,
  TALON_COMMAND_TYPES,
  TALON_EVENT_TYPES,
  TALON_METRICS,
  TALON_OPERATORS,
} from '@/lib/talons/types';
import {
  DEFAULT_TALON_COOLDOWN_MINUTES,
  MAX_TALONS_PER_SITE,
  TALON_DIRECTIVE_MAX_LENGTH,
  TALON_EXPECTATION_MAX_LENGTH,
  TALON_MAX_COOLDOWN_MINUTES,
  TALON_MAX_DELAY_MINUTES,
  TALON_MAX_INTERVAL_MINUTES,
  TALON_MAX_OUTPUTS,
  TALON_MAX_SCHEDULE_ENTRIES,
  TALON_MIN_INTERVAL_MINUTES,
  TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK,
  TALON_NAME_MAX_LENGTH,
  validateTalonInput,
  type TalonFieldError,
  type TalonValidationResult,
  type ValidatedTalonInput,
} from '@/lib/talons/validation';

/**
 * Contract tests for the shared talon validator. The client editor and the
 * server store both run this module, so every rule locked in here is a rule
 * the two surfaces agree on — divergence would let the editor accept a talon
 * the API rejects (or worse, the reverse).
 */

function expectOk(result: TalonValidationResult): ValidatedTalonInput {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function expectErrors(result: TalonValidationResult): TalonFieldError[] {
  if (result.ok) {
    throw new Error(`expected failure, got value: ${JSON.stringify(result.value)}`);
  }
  return result.errors;
}

function errorFor(result: TalonValidationResult, field: string): TalonFieldError | undefined {
  return expectErrors(result).find((e) => e.field === field);
}

const SCHEDULE_ENTRIES_TRIGGER = {
  type: 'schedule',
  entries: [{ id: 'entry-1', days: ['mon', 'wed'], time: '03:00' }],
};

function validTalon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'restart touchdesigner overnight',
    trigger: SCHEDULE_ENTRIES_TRIGGER,
    outputs: [{ type: 'email' }],
    ...overrides,
  };
}

describe('validateTalonInput — valid minimal talons', () => {
  it('accepts a schedule trigger with fixed entries', () => {
    const value = expectOk(validateTalonInput(validTalon()));
    expect(value.trigger).toEqual({
      type: 'schedule',
      entries: [{ id: 'entry-1', days: ['mon', 'wed'], time: '03:00' }],
    });
  });

  it('accepts a schedule trigger with an interval', () => {
    const value = expectOk(
      validateTalonInput(
        validTalon({ trigger: { type: 'schedule', intervalMinutes: TALON_MIN_INTERVAL_MINUTES } }),
      ),
    );
    expect(value.trigger).toEqual({ type: 'schedule', intervalMinutes: 5 });
  });

  it('accepts a threshold trigger', () => {
    const value = expectOk(
      validateTalonInput(
        validTalon({ trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 } }),
      ),
    );
    expect(value.trigger).toEqual({
      type: 'threshold',
      metric: 'cpu_percent',
      operator: '>',
      value: 90,
    });
  });

  it('accepts an event trigger', () => {
    const value = expectOk(
      validateTalonInput(validTalon({ trigger: { type: 'event', eventTypes: ['process_crash'] } })),
    );
    expect(value.trigger).toEqual({ type: 'event', eventTypes: ['process_crash'] });
  });

  it('applies defaults for every omitted optional field', () => {
    const value = expectOk(validateTalonInput(validTalon()));
    expect(value.enabled).toBe(true);
    expect(value.condition).toEqual({ type: 'none' });
    expect(value.scope).toEqual({ machineIds: null });
    expect(value.cooldownMinutes).toBe(DEFAULT_TALON_COOLDOWN_MINUTES);
    expect(value.cooldownMinutes).toBe(60);
    expect(value).not.toHaveProperty('description');
  });

  it('accepts every output type in one talon', () => {
    const value = expectOk(
      validateTalonInput(
        validTalon({
          outputs: [
            { type: 'email' },
            { type: 'webhook', url: 'https://hooks.example.com/talon' },
            { type: 'cortex', directive: 'summarize what happened' },
            { type: 'command', commandType: 'restart_process', processId: 'p1' },
          ],
        }),
      ),
    );
    expect(value.outputs).toHaveLength(4);
  });
});

describe('validateTalonInput — normalization', () => {
  it('trims the name and description, and drops a blank description', () => {
    const value = expectOk(
      validateTalonInput(validTalon({ name: '  nightly restart  ', description: '  keeps the wall alive  ' })),
    );
    expect(value.name).toBe('nightly restart');
    expect(value.description).toBe('keeps the wall alive');

    const blank = expectOk(validateTalonInput(validTalon({ description: '   ' })));
    expect(blank).not.toHaveProperty('description');
  });

  it('de-duplicates days and sorts them into canonical week order', () => {
    const value = expectOk(
      validateTalonInput(
        validTalon({
          trigger: {
            type: 'schedule',
            entries: [{ id: 'e1', days: ['sun', 'mon', 'mon', 'fri'], time: '09:30' }],
          },
        }),
      ),
    );
    expect(value.trigger).toEqual({
      type: 'schedule',
      entries: [{ id: 'e1', days: ['mon', 'fri', 'sun'], time: '09:30' }],
    });
  });

  it('de-duplicates event types', () => {
    const value = expectOk(
      validateTalonInput(
        validTalon({
          trigger: { type: 'event', eventTypes: ['machine_offline', 'process_crash', 'machine_offline'] },
        }),
      ),
    );
    expect(value.trigger).toEqual({
      type: 'event',
      eventTypes: ['process_crash', 'machine_offline'],
    });
  });

  it('de-duplicates and trims scoped machine ids', () => {
    const value = expectOk(
      validateTalonInput(validTalon({ scope: { machineIds: ['m1', ' m1 ', 'm2'] } })),
    );
    expect(value.scope).toEqual({ machineIds: ['m1', 'm2'] });
  });

  it('trims a webhook url', () => {
    const value = expectOk(
      validateTalonInput(validTalon({ outputs: [{ type: 'webhook', url: ' https://ok.example.com/hook ' }] })),
    );
    expect(value.outputs[0]).toEqual({ type: 'webhook', url: 'https://ok.example.com/hook' });
  });
});

describe('validateTalonInput — body and unknown fields', () => {
  it.each([null, undefined, 'talon', 42, [], true])('rejects non-object input %p', (input) => {
    const errors = expectErrors(validateTalonInput(input));
    expect(errors).toEqual([
      { field: 'talon', code: 'invalid_body', message: 'talon input must be an object' },
    ]);
  });

  it.each(['schemaVersion', 'createdBy', 'createdAt', 'consecutiveFailures', 'nextRunAt', 'nope'])(
    'rejects server-owned or unknown field %s',
    (field) => {
      const result = validateTalonInput(validTalon({ [field]: 1 }));
      expect(errorFor(result, field)?.code).toBe('unknown_field');
    },
  );
});

describe('validateTalonInput — name', () => {
  it.each([undefined, '', '   '])('rejects missing or blank name %p', (name) => {
    const result = validateTalonInput(validTalon({ name }));
    expect(errorFor(result, 'name')?.code).toBe('missing_field');
  });

  it('rejects a non-string name', () => {
    expect(errorFor(validateTalonInput(validTalon({ name: 7 })), 'name')?.code).toBe('invalid_field');
  });

  it(`accepts exactly ${TALON_NAME_MAX_LENGTH} characters and rejects one more`, () => {
    expect(expectOk(validateTalonInput(validTalon({ name: 'a'.repeat(80) }))).name).toHaveLength(80);
    expect(errorFor(validateTalonInput(validTalon({ name: 'a'.repeat(81) })), 'name')?.code).toBe(
      'invalid_field',
    );
  });
});

describe('validateTalonInput — trigger', () => {
  it('rejects a missing trigger', () => {
    const talon = validTalon();
    delete talon.trigger;
    expect(errorFor(validateTalonInput(talon), 'trigger')?.code).toBe('missing_field');
  });

  it.each(['nope', 'automation', '', 'threshold_v2'])('rejects unknown trigger type %p', (type) => {
    expect(errorFor(validateTalonInput(validTalon({ trigger: { type } })), 'trigger.type')?.code).toBe(
      'invalid_field',
    );
  });

  it('rejects a non-object trigger', () => {
    expect(errorFor(validateTalonInput(validTalon({ trigger: 'schedule' })), 'trigger')?.code).toBe(
      'invalid_field',
    );
  });

  it('rejects a schedule carrying both entries and intervalMinutes (XOR)', () => {
    const result = validateTalonInput(
      validTalon({
        trigger: { type: 'schedule', entries: SCHEDULE_ENTRIES_TRIGGER.entries, intervalMinutes: 30 },
      }),
    );
    expect(errorFor(result, 'trigger')?.code).toBe('invalid_field');
  });

  it('rejects a schedule carrying neither entries nor intervalMinutes', () => {
    expect(errorFor(validateTalonInput(validTalon({ trigger: { type: 'schedule' } })), 'trigger')?.code).toBe(
      'missing_field',
    );
  });
});

describe('validateTalonInput — schedule entries', () => {
  function withEntries(entries: unknown) {
    return validateTalonInput(validTalon({ trigger: { type: 'schedule', entries } }));
  }

  it.each([[[]], ['nope'], [{}]])('rejects entries that are not a non-empty array: %p', (entries) => {
    expect(errorFor(withEntries(entries), 'trigger.entries')?.code).toBe('invalid_field');
  });

  it(`rejects more than ${TALON_MAX_SCHEDULE_ENTRIES} entries`, () => {
    const entries = Array.from({ length: TALON_MAX_SCHEDULE_ENTRIES + 1 }, (_, i) => ({
      id: `e${i}`,
      days: ['mon'],
      time: '01:00',
    }));
    expect(errorFor(withEntries(entries), 'trigger.entries')?.code).toBe('out_of_range');
  });

  it('rejects an entry missing its id', () => {
    const result = withEntries([{ days: ['mon'], time: '03:00' }]);
    expect(errorFor(result, 'trigger.entries[0].id')?.code).toBe('missing_field');
  });

  it.each([[[]], ['mon'], [['funday']], [['MON']]])('rejects invalid days %p', (days) => {
    const result = withEntries([{ id: 'e1', days, time: '03:00' }]);
    expect(expectErrors(result).some((e) => e.field.startsWith('trigger.entries[0].days'))).toBe(true);
  });

  it.each(['24:00', '9:00', '03:60', '3:00 pm', '0300', '', '23:59:00'])(
    'rejects malformed time %p',
    (time) => {
      const result = withEntries([{ id: 'e1', days: ['mon'], time }]);
      expect(errorFor(result, 'trigger.entries[0].time')?.code).toBe('invalid_field');
    },
  );

  it.each(['00:00', '09:05', '23:59'])('accepts well-formed time %p', (time) => {
    const value = expectOk(withEntries([{ id: 'e1', days: ['mon'], time }]));
    expect(value.trigger).toEqual({ type: 'schedule', entries: [{ id: 'e1', days: ['mon'], time }] });
  });

  it.each(DAY_KEYS)('accepts day key %s', (day) => {
    expect(expectOk(withEntries([{ id: 'e1', days: [day], time: '06:00' }]))).toBeDefined();
  });
});

describe('validateTalonInput — schedule interval floors', () => {
  function withInterval(intervalMinutes: unknown, condition?: unknown) {
    return validateTalonInput(
      validTalon({ trigger: { type: 'schedule', intervalMinutes }, ...(condition ? { condition } : {}) }),
    );
  }

  const VISUAL_CHECK = { type: 'visual_check', expectation: 'the wall shows the show content' };

  it(`rejects an interval below ${TALON_MIN_INTERVAL_MINUTES}`, () => {
    expect(errorFor(withInterval(4), 'trigger.intervalMinutes')?.code).toBe('out_of_range');
    expect(errorFor(withInterval(0), 'trigger.intervalMinutes')?.code).toBe('out_of_range');
  });

  it('rejects a non-integer interval', () => {
    expect(errorFor(withInterval(7.5), 'trigger.intervalMinutes')?.code).toBe('invalid_field');
    expect(errorFor(withInterval('30'), 'trigger.intervalMinutes')?.code).toBe('invalid_field');
  });

  it(`rejects an interval above ${TALON_MAX_INTERVAL_MINUTES}`, () => {
    expect(errorFor(withInterval(TALON_MAX_INTERVAL_MINUTES + 1), 'trigger.intervalMinutes')?.code).toBe(
      'out_of_range',
    );
    expect(expectOk(withInterval(TALON_MAX_INTERVAL_MINUTES)).trigger).toEqual({
      type: 'schedule',
      intervalMinutes: 1440,
    });
  });

  it(`raises the floor to ${TALON_MIN_INTERVAL_MINUTES_VISUAL_CHECK} when the condition is a visual check`, () => {
    expect(errorFor(withInterval(5, VISUAL_CHECK), 'trigger.intervalMinutes')?.code).toBe('out_of_range');
    expect(errorFor(withInterval(14, VISUAL_CHECK), 'trigger.intervalMinutes')?.code).toBe('out_of_range');
    expect(expectOk(withInterval(15, VISUAL_CHECK)).trigger).toEqual({
      type: 'schedule',
      intervalMinutes: 15,
    });
  });

  it('leaves the floor at 5 for a `none` condition', () => {
    expect(expectOk(withInterval(5, { type: 'none' })).trigger).toEqual({
      type: 'schedule',
      intervalMinutes: 5,
    });
  });
});

describe('validateTalonInput — threshold trigger', () => {
  function withThreshold(overrides: Record<string, unknown>) {
    return validateTalonInput(
      validTalon({
        trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90, ...overrides },
      }),
    );
  }

  it.each(TALON_METRICS)('accepts metric %s', (metric) => {
    expect(expectOk(withThreshold({ metric }))).toBeDefined();
  });

  it.each(TALON_OPERATORS)('accepts operator %s', (operator) => {
    expect(expectOk(withThreshold({ operator }))).toBeDefined();
  });

  it.each(['cpu', 'ram_percent', 'CPU_PERCENT', '', 'disk_io'])('rejects unknown metric %p', (metric) => {
    expect(errorFor(withThreshold({ metric }), 'trigger.metric')?.code).toBe('invalid_field');
  });

  it.each(['==', '=>', '!=', 'gt', ''])('rejects unsupported operator %p', (operator) => {
    expect(errorFor(withThreshold({ operator }), 'trigger.operator')?.code).toBe('invalid_field');
  });

  it.each([NaN, Infinity, -Infinity, '90', null, undefined])(
    'rejects non-finite threshold value %p',
    (value) => {
      expect(errorFor(withThreshold({ value }), 'trigger.value')?.code).toBe('invalid_field');
    },
  );
});

describe('validateTalonInput — event trigger', () => {
  function withEventTypes(eventTypes: unknown) {
    return validateTalonInput(validTalon({ trigger: { type: 'event', eventTypes } }));
  }

  it.each(TALON_EVENT_TYPES)('accepts catalog event %s', (eventType) => {
    expect(expectOk(withEventTypes([eventType])).trigger).toEqual({
      type: 'event',
      eventTypes: [eventType],
    });
  });

  it.each([[[]], ['process_crash'], [null]])('rejects a non-array or empty eventTypes %p', (eventTypes) => {
    expect(errorFor(withEventTypes(eventTypes), 'trigger.eventTypes')?.code).toBe('invalid_field');
  });

  it.each(['process_crashed', 'display.drift', 'machine_online', 'PROCESS_CRASH'])(
    'rejects event outside the closed catalog: %p',
    (eventType) => {
      expect(errorFor(withEventTypes([eventType]), 'trigger.eventTypes[0]')?.code).toBe('invalid_field');
    },
  );
});

describe('validateTalonInput — event trigger delay', () => {
  function withDelay(delayMinutes: unknown, type = 'event') {
    const trigger =
      type === 'event'
        ? { type, eventTypes: ['process_restarted'], delayMinutes }
        : type === 'threshold'
          ? { type, metric: 'cpu_percent', operator: '>', value: 90, delayMinutes }
          : { ...SCHEDULE_ENTRIES_TRIGGER, delayMinutes };
    return validateTalonInput(validTalon({ trigger }));
  }

  it('accepts a delay and keeps it on the trigger', () => {
    expect(expectOk(withDelay(3)).trigger).toEqual({
      type: 'event',
      eventTypes: ['process_restarted'],
      delayMinutes: 3,
    });
  });

  it('accepts the ceiling', () => {
    expect(expectOk(withDelay(TALON_MAX_DELAY_MINUTES)).trigger).toEqual({
      type: 'event',
      eventTypes: ['process_restarted'],
      delayMinutes: TALON_MAX_DELAY_MINUTES,
    });
  });

  it.each([[undefined], [null], [0]])(
    'normalizes %p away — "run right now" has one representation',
    (delayMinutes) => {
      const trigger = expectOk(withDelay(delayMinutes)).trigger;
      expect(trigger).toEqual({ type: 'event', eventTypes: ['process_restarted'] });
      expect(trigger).not.toHaveProperty('delayMinutes');
    },
  );

  it.each([[-1], [TALON_MAX_DELAY_MINUTES + 1]])('rejects %p as out of range', (delayMinutes) => {
    expect(errorFor(withDelay(delayMinutes), 'trigger.delayMinutes')?.code).toBe('out_of_range');
  });

  it.each([[1.5], ['3'], [Number.NaN], [true]])('rejects a non-integer delay %p', (delayMinutes) => {
    expect(errorFor(withDelay(delayMinutes), 'trigger.delayMinutes')?.code).toBe('invalid_field');
  });

  it.each(['schedule', 'threshold'])('rejects a delay on a %s trigger', (type) => {
    expect(errorFor(withDelay(5, type), 'trigger.delayMinutes')).toEqual({
      field: 'trigger.delayMinutes',
      code: 'invalid_field',
      message: 'this only applies to event triggers',
    });
  });

  it('reports a bad delay and a bad event list together', () => {
    const errors = expectErrors(
      validateTalonInput(
        validTalon({ trigger: { type: 'event', eventTypes: ['nope'], delayMinutes: 9000 } }),
      ),
    );
    expect(errors.map((e) => e.field).sort()).toEqual([
      'trigger.delayMinutes',
      'trigger.eventTypes[0]',
    ]);
  });
});

describe('validateTalonInput — condition', () => {
  it('rejects an unknown condition type', () => {
    expect(
      errorFor(validateTalonInput(validTalon({ condition: { type: 'ocr' } })), 'condition.type')?.code,
    ).toBe('invalid_field');
  });

  it('rejects a non-object condition', () => {
    expect(errorFor(validateTalonInput(validTalon({ condition: 'none' })), 'condition')?.code).toBe(
      'invalid_field',
    );
  });

  it.each([undefined, '', '   '])('rejects a visual check with missing expectation %p', (expectation) => {
    const result = validateTalonInput(validTalon({ condition: { type: 'visual_check', expectation } }));
    expect(errorFor(result, 'condition.expectation')?.code).toBe('missing_field');
  });

  it(`rejects an expectation longer than ${TALON_EXPECTATION_MAX_LENGTH} characters`, () => {
    const tooLong = validateTalonInput(
      validTalon({ condition: { type: 'visual_check', expectation: 'x'.repeat(501) } }),
    );
    expect(errorFor(tooLong, 'condition.expectation')?.code).toBe('invalid_field');
    expect(
      expectOk(
        validateTalonInput(validTalon({ condition: { type: 'visual_check', expectation: 'x'.repeat(500) } })),
      ).condition,
    ).toEqual({ type: 'visual_check', expectation: 'x'.repeat(500) });
  });

  it('accepts a monitor index and rejects out-of-range or fractional ones', () => {
    expect(
      expectOk(
        validateTalonInput(
          validTalon({ condition: { type: 'visual_check', expectation: 'content is playing', monitor: 0 } }),
        ),
      ).condition,
    ).toEqual({ type: 'visual_check', expectation: 'content is playing', monitor: 0 });

    const negative = validateTalonInput(
      validTalon({ condition: { type: 'visual_check', expectation: 'content is playing', monitor: -1 } }),
    );
    expect(errorFor(negative, 'condition.monitor')?.code).toBe('out_of_range');

    const fractional = validateTalonInput(
      validTalon({ condition: { type: 'visual_check', expectation: 'content is playing', monitor: 1.5 } }),
    );
    expect(errorFor(fractional, 'condition.monitor')?.code).toBe('invalid_field');
  });
});

describe('validateTalonInput — outputs', () => {
  function withOutputs(outputs: unknown) {
    return validateTalonInput(validTalon({ outputs }));
  }

  it('rejects zero outputs and more than the maximum', () => {
    expect(errorFor(withOutputs([]), 'outputs')?.code).toBe('out_of_range');
    const tooMany = Array.from({ length: TALON_MAX_OUTPUTS + 1 }, () => ({ type: 'email' }));
    expect(errorFor(withOutputs(tooMany), 'outputs')?.code).toBe('out_of_range');
    const atMax = Array.from({ length: TALON_MAX_OUTPUTS }, () => ({ type: 'email' }));
    expect(expectOk(withOutputs(atMax)).outputs).toHaveLength(5);
  });

  it('rejects a non-array outputs field', () => {
    expect(errorFor(withOutputs({ type: 'email' }), 'outputs')?.code).toBe('invalid_field');
  });

  it.each(['sms', 'slack', '', 'Email'])('rejects unknown output type %p', (type) => {
    expect(errorFor(withOutputs([{ type }]), 'outputs[0].type')?.code).toBe('invalid_field');
  });

  it.each([
    'http://hooks.example.com/talon',
    'ftp://hooks.example.com',
    'hooks.example.com',
    'javascript:alert(1)',
    'https://',
    '',
  ])('rejects non-https or malformed webhook url %p', (url) => {
    expect(errorFor(withOutputs([{ type: 'webhook', url }]), 'outputs[0].url')?.code).toBe('invalid_field');
  });

  it('reports the index of the offending output', () => {
    const result = withOutputs([{ type: 'email' }, { type: 'webhook', url: 'nope' }]);
    expect(errorFor(result, 'outputs[1].url')?.code).toBe('invalid_field');
  });

  it.each([undefined, '', 'x'.repeat(TALON_DIRECTIVE_MAX_LENGTH + 1)])(
    'rejects invalid hoot directive %p',
    (directive) => {
      expect(errorFor(withOutputs([{ type: 'cortex', directive }]), 'outputs[0].directive')).toBeDefined();
    },
  );

  it('accepts a hoot directive at the maximum length', () => {
    const directive = 'x'.repeat(TALON_DIRECTIVE_MAX_LENGTH);
    expect(expectOk(withOutputs([{ type: 'cortex', directive }])).outputs[0]).toEqual({
      type: 'cortex',
      directive,
    });
  });

  it('keeps an opted-in hoot output flagged', () => {
    expect(
      expectOk(withOutputs([{ type: 'cortex', directive: 'fix it', allowActions: true }]))
        .outputs[0],
    ).toEqual({ type: 'cortex', directive: 'fix it', allowActions: true });
  });

  it.each([undefined, false])(
    'normalizes an unset hoot opt-in away (%p)',
    (allowActions) => {
      // `false` IS the default, so it must not persist as a second
      // representation of "hoot only looks".
      expect(
        expectOk(withOutputs([{ type: 'cortex', directive: 'look', allowActions }])).outputs[0],
      ).toEqual({ type: 'cortex', directive: 'look' });
    },
  );

  it('rejects a non-boolean hoot opt-in', () => {
    const result = withOutputs([{ type: 'cortex', directive: 'look', allowActions: 'yes' }]);
    expect(errorFor(result, 'outputs[0].allowActions')?.code).toBe('invalid_field');
  });

  it.each(TALON_COMMAND_TYPES)('accepts command type %s', (commandType) => {
    expect(
      expectOk(withOutputs([{ type: 'command', commandType, processName: 'TouchDesigner' }]))
        .outputs[0],
    ).toEqual({
      type: 'command',
      commandType,
      processName: 'TouchDesigner',
    });
  });

  it.each(TALON_COMMAND_TYPES)(
    'rejects command type %s with no process target',
    (commandType) => {
      // Without a target the agent resolves `<unspecified>` and every run
      // fails, until the tenth consecutive failure auto-disables the talon.
      const error = errorFor(
        withOutputs([{ type: 'command', commandType }]),
        'outputs[0].processId',
      );
      expect(error?.code).toBe('missing_field');
      expect(error?.message).toBe('choose a process');
    },
  );

  it('accepts a command output targeted by id alone', () => {
    expect(
      expectOk(withOutputs([{ type: 'command', commandType: 'stop_process', processId: 'p1' }]))
        .outputs[0],
    ).toEqual({ type: 'command', commandType: 'stop_process', processId: 'p1' });
  });

  it.each(['reboot_machine', 'kill_process', 'update_owlette', 'capture_screenshot', ''])(
    'rejects command type outside the talon subset: %p',
    (commandType) => {
      expect(errorFor(withOutputs([{ type: 'command', commandType }]), 'outputs[0].commandType')?.code).toBe(
        'invalid_field',
      );
    },
  );

  it('rejects a non-string process target on a command output', () => {
    const result = withOutputs([{ type: 'command', commandType: 'stop_process', processName: 42 }]);
    expect(errorFor(result, 'outputs[0].processName')?.code).toBe('invalid_field');
  });
});

describe('validateTalonInput — scope', () => {
  it('treats an omitted scope and an explicit null as "all machines"', () => {
    expect(expectOk(validateTalonInput(validTalon())).scope).toEqual({ machineIds: null });
    expect(expectOk(validateTalonInput(validTalon({ scope: { machineIds: null } }))).scope).toEqual({
      machineIds: null,
    });
  });

  it('rejects an empty machineIds array (null means every machine)', () => {
    expect(errorFor(validateTalonInput(validTalon({ scope: { machineIds: [] } })), 'scope.machineIds')?.code).toBe(
      'invalid_field',
    );
  });

  it('rejects a blank machine id', () => {
    const result = validateTalonInput(validTalon({ scope: { machineIds: ['m1', '  '] } }));
    expect(errorFor(result, 'scope.machineIds[1]')?.code).toBe('invalid_field');
  });

  it('rejects a non-object scope', () => {
    expect(errorFor(validateTalonInput(validTalon({ scope: ['m1'] })), 'scope')?.code).toBe('invalid_field');
  });
});

describe('validateTalonInput — cooldownMinutes', () => {
  it.each([0, 15, TALON_MAX_COOLDOWN_MINUTES])('accepts %p', (cooldownMinutes) => {
    expect(expectOk(validateTalonInput(validTalon({ cooldownMinutes }))).cooldownMinutes).toBe(
      cooldownMinutes,
    );
  });

  it.each([-1, TALON_MAX_COOLDOWN_MINUTES + 1])('rejects out-of-range %p', (cooldownMinutes) => {
    expect(errorFor(validateTalonInput(validTalon({ cooldownMinutes })), 'cooldownMinutes')?.code).toBe(
      'out_of_range',
    );
  });

  it.each([1.5, '60', true])('rejects non-integer %p', (cooldownMinutes) => {
    expect(errorFor(validateTalonInput(validTalon({ cooldownMinutes })), 'cooldownMinutes')?.code).toBe(
      'invalid_field',
    );
  });
});

describe('validateTalonInput — enabled', () => {
  it('accepts an explicit false', () => {
    expect(expectOk(validateTalonInput(validTalon({ enabled: false }))).enabled).toBe(false);
  });

  it('rejects a non-boolean', () => {
    expect(errorFor(validateTalonInput(validTalon({ enabled: 'yes' })), 'enabled')?.code).toBe(
      'invalid_field',
    );
  });
});

describe('validateTalonInput — error accumulation', () => {
  it('reports every violation in one pass rather than short-circuiting', () => {
    const result = validateTalonInput({
      name: '',
      trigger: { type: 'threshold', metric: 'nope', operator: '==', value: 'high' },
      outputs: [],
      cooldownMinutes: 9999,
      schemaVersion: 1,
    });
    const fields = expectErrors(result).map((e) => e.field).sort();
    expect(fields).toEqual(
      [
        'cooldownMinutes',
        'name',
        'outputs',
        'schemaVersion',
        'trigger.metric',
        'trigger.operator',
        'trigger.value',
      ].sort(),
    );
  });

  it('never returns a value alongside errors', () => {
    const result = validateTalonInput(validTalon({ name: '' }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
  });
});

/**
 * Every rejection path this module has, in one list. The message guards below
 * sweep it — a new rule that ships nerd-speak fails here rather than in front
 * of a user.
 */
const EVERY_REJECTION: unknown[] = [
  'not an object',
  {},
  validTalon({ name: '', description: 'x'.repeat(501), enabled: 'yes', cooldownMinutes: 9999, nope: 1 }),
  validTalon({ name: 7 }),
  validTalon({ name: 'x'.repeat(TALON_NAME_MAX_LENGTH + 1) }),
  validTalon({ description: 42 }),
  validTalon({ trigger: undefined }),
  validTalon({ trigger: 'schedule' }),
  validTalon({ trigger: { type: 'nope' } }),
  validTalon({ trigger: { type: 'schedule' } }),
  validTalon({ trigger: { type: 'schedule', entries: SCHEDULE_ENTRIES_TRIGGER.entries, intervalMinutes: 30 } }),
  validTalon({ trigger: { type: 'schedule', entries: [] } }),
  validTalon({ trigger: { type: 'schedule', entries: ['nope'] } }),
  validTalon({ trigger: { type: 'schedule', entries: [{ days: ['funday'], time: '9:00' }] } }),
  validTalon({ trigger: { type: 'schedule', entries: [{ id: 'x'.repeat(129), days: [], time: '03:00' }] } }),
  validTalon({
    trigger: {
      type: 'schedule',
      entries: Array.from({ length: TALON_MAX_SCHEDULE_ENTRIES + 1 }, (_, i) => ({
        id: `e${i}`,
        days: ['mon'],
        time: '01:00',
      })),
    },
  }),
  validTalon({ trigger: { type: 'schedule', intervalMinutes: '30' } }),
  validTalon({ trigger: { type: 'schedule', intervalMinutes: TALON_MIN_INTERVAL_MINUTES - 1 } }),
  validTalon({ trigger: { type: 'schedule', intervalMinutes: TALON_MAX_INTERVAL_MINUTES + 1 } }),
  validTalon({
    trigger: { type: 'schedule', intervalMinutes: TALON_MIN_INTERVAL_MINUTES },
    condition: { type: 'visual_check', expectation: 'the wall shows the loop' },
  }),
  validTalon({ trigger: { type: 'threshold', metric: 'nope', operator: '==', value: 'high' } }),
  validTalon({ trigger: { type: 'event', eventTypes: [] } }),
  validTalon({ trigger: { type: 'event', eventTypes: ['nope'] } }),
  validTalon({
    trigger: { type: 'event', eventTypes: ['process_crash'], delayMinutes: -1 },
  }),
  validTalon({
    trigger: {
      type: 'event',
      eventTypes: ['process_crash'],
      delayMinutes: TALON_MAX_DELAY_MINUTES + 1,
    },
  }),
  validTalon({ trigger: { type: 'event', eventTypes: ['process_crash'], delayMinutes: 1.5 } }),
  validTalon({ trigger: { ...SCHEDULE_ENTRIES_TRIGGER, delayMinutes: 5 } }),
  validTalon({ condition: 'none' }),
  validTalon({ condition: { type: 'ocr' } }),
  validTalon({ condition: { type: 'visual_check' } }),
  validTalon({ condition: { type: 'visual_check', expectation: 'x'.repeat(TALON_EXPECTATION_MAX_LENGTH + 1) } }),
  validTalon({ condition: { type: 'visual_check', expectation: 'ok', monitor: -1 } }),
  validTalon({ condition: { type: 'visual_check', expectation: 'ok', monitor: 65 } }),
  validTalon({ condition: { type: 'visual_check', expectation: 'ok', monitor: 1.5 } }),
  validTalon({ outputs: 'nope' }),
  validTalon({ outputs: [] }),
  validTalon({ outputs: Array.from({ length: TALON_MAX_OUTPUTS + 1 }, () => ({ type: 'email' })) }),
  validTalon({ outputs: ['nope'] }),
  validTalon({ outputs: [{ type: 'sms' }] }),
  validTalon({ outputs: [{ type: 'webhook', url: 'http://hooks.example.com/talon' }] }),
  validTalon({ outputs: [{ type: 'cortex', directive: '' }] }),
  validTalon({ outputs: [{ type: 'cortex', directive: 'x'.repeat(TALON_DIRECTIVE_MAX_LENGTH + 1) }] }),
  validTalon({ outputs: [{ type: 'command', commandType: 'reboot_machine' }] }),
  validTalon({ outputs: [{ type: 'command', commandType: 'restart_process' }] }),
  validTalon({ outputs: [{ type: 'cortex', directive: 'look', allowActions: 'yes' }] }),
  validTalon({ outputs: [{ type: 'command', commandType: 'stop_process', processName: 42 }] }),
  validTalon({ outputs: [{ type: 'command', commandType: 'stop_process', processId: 'x'.repeat(257) }] }),
  validTalon({ outputs: [{ type: 'command', commandType: 'stop_process', processName: 'x'.repeat(257) }] }),
  validTalon({ scope: ['m1'] }),
  validTalon({ scope: { machineIds: [] } }),
  validTalon({ scope: { machineIds: ['  '] } }),
  validTalon({ cooldownMinutes: -1 }),
  validTalon({ cooldownMinutes: TALON_MAX_COOLDOWN_MINUTES + 1 }),
  validTalon({ cooldownMinutes: 1.5 }),
];

describe('validateTalonInput — human-readable messages', () => {
  it('never leaks a field path, backtick, or index notation into a message', () => {
    for (const input of EVERY_REJECTION) {
      for (const { field, message } of expectErrors(validateTalonInput(input))) {
        // The offending value is reported alongside so a failure names the rule.
        expect({ field, message, readable: !/[`[\]]/.test(message) }).toEqual({
          field,
          message,
          readable: true,
        });
      }
    }
  });

  it('writes every message in the lowercase voice of the rest of the ui', () => {
    for (const input of EVERY_REJECTION) {
      for (const { field, message } of expectErrors(validateTalonInput(input))) {
        expect({ field, message, lowercase: /^[a-z]/.test(message) }).toEqual({
          field,
          message,
          lowercase: true,
        });
      }
    }
  });

  it.each<[unknown, string, string]>([
    [validTalon({ name: '' }), 'name', 'give this talon a name'],
    [
      validTalon({ outputs: [{ type: 'cortex', directive: '' }] }),
      'outputs[0].directive',
      'tell hoot what to do when this talon fires',
    ],
    [
      validTalon({ outputs: [{ type: 'webhook', url: 'http://nope.example.com' }] }),
      'outputs[0].url',
      'enter a valid https url',
    ],
    [validTalon({ outputs: [] }), 'outputs', 'add at least one output'],
    [
      validTalon({ trigger: { type: 'schedule', entries: [] } }),
      'trigger.entries',
      'add at least one time',
    ],
    [
      validTalon({ trigger: { type: 'event', eventTypes: [] } }),
      'trigger.eventTypes',
      'pick at least one event',
    ],
    [
      validTalon({ trigger: { type: 'schedule', intervalMinutes: 4 } }),
      'trigger.intervalMinutes',
      'runs at most every 5 minutes',
    ],
    [
      validTalon({
        trigger: { type: 'schedule', intervalMinutes: 14 },
        condition: { type: 'visual_check', expectation: 'the wall shows the loop' },
      }),
      'trigger.intervalMinutes',
      'visual checks run at most every 15 minutes',
    ],
    [
      validTalon({
        trigger: {
          type: 'event',
          eventTypes: ['process_crash'],
          delayMinutes: TALON_MAX_DELAY_MINUTES + 1,
        },
      }),
      'trigger.delayMinutes',
      'the delay must be between 0 and 24 hours',
    ],
    [
      validTalon({ trigger: { ...SCHEDULE_ENTRIES_TRIGGER, delayMinutes: 5 } }),
      'trigger.delayMinutes',
      'this only applies to event triggers',
    ],
    [
      validTalon({ condition: { type: 'visual_check', expectation: '' } }),
      'condition.expectation',
      'describe what the screen should show',
    ],
    [
      validTalon({ scope: { machineIds: [] } }),
      'scope.machineIds',
      'select at least one machine, or switch to all machines',
    ],
    [
      validTalon({ cooldownMinutes: TALON_MAX_COOLDOWN_MINUTES + 1 }),
      'cooldownMinutes',
      'cooldown must be between 0 and 24 hours',
    ],
  ])('speaks plainly for %#', (input, field, message) => {
    expect(errorFor(validateTalonInput(input), field)?.message).toBe(message);
  });

  it('keeps the structured field path for programmatic binding', () => {
    const result = validateTalonInput(
      validTalon({ outputs: [{ type: 'email' }, { type: 'webhook', url: 'nope' }] }),
    );
    // The path lives here, not in the prose the user reads.
    expect(errorFor(result, 'outputs[1].url')).toEqual({
      field: 'outputs[1].url',
      code: 'invalid_field',
      message: 'enter a valid https url',
    });
  });
});

describe('talon catalogs and limits', () => {
  it('caps a site at 20 talons', () => {
    expect(MAX_TALONS_PER_SITE).toBe(20);
  });

  it('mirrors the 8 metric keys of METRIC_PATHS in functions/src/metricsHistory.ts', () => {
    expect([...TALON_METRICS]).toEqual([
      'cpu_percent',
      'memory_percent',
      'disk_percent',
      'gpu_percent',
      'cpu_temp',
      'gpu_temp',
      'network_latency',
      'network_packet_loss',
    ]);
  });

  it('includes every display event registered in DISPLAY_EVENT_ROUTING', () => {
    // Drift guard: a new `display_*` event that never lands here can never be
    // subscribed to by a talon.
    for (const key of Object.keys(DISPLAY_EVENT_ROUTING)) {
      expect({ key, listed: TALON_EVENT_TYPES.includes(key as (typeof TALON_EVENT_TYPES)[number]) }).toEqual({
        key,
        listed: true,
      });
    }
  });

  it('is the five lifecycle events plus the display events, with no duplicates', () => {
    expect([...TALON_EVENT_TYPES].sort()).toEqual(
      [
        'process_crash',
        'process_start_failed',
        // Both land through the dispatch taps wired in task 2.3 —
        // `exe_missing` at /api/agent/alert, `process_restarted` through the
        // `onTalonLogEventCreated` firestore trigger.
        'process_restarted',
        'exe_missing',
        'machine_offline',
        ...Object.keys(DISPLAY_EVENT_ROUTING),
      ].sort(),
    );
    expect(new Set(TALON_EVENT_TYPES).size).toBe(TALON_EVENT_TYPES.length);
  });

  it('restricts command outputs to the three process-control commands', () => {
    expect([...TALON_COMMAND_TYPES]).toEqual(['restart_process', 'start_process', 'stop_process']);
  });

  it('uses the same day keys as DayPillSelector', () => {
    expect([...DAY_KEYS]).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });
});

describe('talon modules stay pure', () => {
  it.each(['types.ts', 'validation.ts'])('%s imports nothing from firebase/firestore', (file) => {
    const source = readFileSync(path.join(__dirname, '../../../lib/talons', file), 'utf8');
    const imports = source.match(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm) ?? [];
    for (const statement of imports) {
      expect({ file, statement, firestore: /firebase|firestore/i.test(statement) }).toEqual({
        file,
        statement,
        firestore: false,
      });
    }
  });
});
