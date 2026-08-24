import { describe, expect, it } from 'vitest'
import {
  addProcess,
  applyForm,
  coerceForm,
  createProcessEntry,
  duplicateProcess,
  expectedImagesFor,
  formFromProcess,
  formsEqual,
  launchModeBlockedReason,
  launchModeOf,
  priorityOf,
  removeProcess,
  reorderProcess,
  scheduleSummary,
  setLaunchMode,
  setSchedules,
  setVisibility,
  uniqueCopyName,
  uniqueDefaultName,
  updateProcess,
  visibilityOf,
  type OwletteConfig,
  type ProcessEntry,
} from './owletteConfig'

/** A config shaped like the one in the field: our keys buried among theirs. */
function liveConfig(): OwletteConfig {
  return {
    environment: 'development',
    logging: { level: 'INFO' },
    processes: [
      {
        schedulePresetId: 'builtin-0',
        processId: 'a',
        name: 'touch',
        id: 'a',
        priority: 'Normal',
        time_to_init: '10',
        visibility: 'Normal',
        relaunch_attempts: '10',
        exe_path: 'C:/Program Files/Derivative/TouchDesigner.2025.32820/bin/TouchDesigner.exe',
        autolaunch: false,
        file_path: 'C:/shows/orientation.toe',
        schedules: [{ days: ['mon', 'tue'], ranges: [{ start: '09:00', stop: '17:00' }] }],
        time_delay: '10',
        launch_mode: 'off',
        cwd: '',
      },
      { id: 'b', name: 'node.js', exe_path: 'C:/Program Files/nodejs/node.exe', launch_mode: 'off' },
    ],
    version: '1.5.0',
    displays: { remoteApplyEnabled: true },
    firebase: {
      _comment: 'Cloud features: remote control, web dashboard, metrics',
      enabled: true,
      site_id: 'default_site',
      project_id: 'owlette-dev-3838a',
      api_base: 'https://dev.owlette.app/api',
    },
  }
}

describe('document preservation', () => {
  it('leaves every key it does not own exactly where it was', () => {
    const before = liveConfig()
    const after = updateProcess(before, 'a', (process) => ({ ...process, name: 'renamed' }))

    expect(Object.keys(after)).toEqual(Object.keys(before))
    // Not merely equal — the same object, so nothing inside it can have moved.
    expect(after.firebase).toBe(before.firebase)
    expect(after.displays).toBe(before.displays)
    expect(after.version).toBe('1.5.0')
  })

  it('keeps a process entry\u2019s own key order and unknown fields', () => {
    const before = liveConfig()
    const after = updateProcess(before, 'a', (process) =>
      applyForm(process, { ...formFromProcess(process), name: 'renamed', time_delay: '30' }),
    )
    const entry = after.processes![0]

    expect(Object.keys(entry)).toEqual(Object.keys(before.processes![0]))
    expect(entry.schedulePresetId).toBe('builtin-0')
    expect(entry.name).toBe('renamed')
    expect(entry.time_delay).toBe('30')
  })

  it('never mutates the document it was handed', () => {
    const before = liveConfig()
    const snapshot = JSON.stringify(before)

    removeProcess(before, 'a')
    reorderProcess(before, 'a', 1)
    updateProcess(before, 'a', (process) => ({ ...process, name: 'x' }))

    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('refuses to write an entry that has been deleted underneath it', () => {
    expect(() => updateProcess(liveConfig(), 'gone', (process) => process)).toThrow(/no longer/)
  })

  it('survives a document with no process list at all', () => {
    const document: OwletteConfig = { firebase: { enabled: false } }
    const after = addProcess(document, createProcessEntry('new'))

    expect(after.processes).toHaveLength(1)
    expect(after.firebase).toEqual({ enabled: false })
  })
})

describe('form values', () => {
  const blank = {
    name: '',
    exe_path: '',
    file_path: '',
    cwd: '',
    time_delay: '',
    time_to_init: '',
    relaunch_attempts: '',
  }

  it('reads numbers the service may have written as numbers', () => {
    const form = formFromProcess({ id: 'a', time_delay: 5, relaunch_attempts: 0 })

    expect(form.time_delay).toBe('5')
    expect(form.relaunch_attempts).toBe('0')
    expect(form.name).toBe('')
  })

  it('compares only the fields the form owns', () => {
    const a = formFromProcess({ id: 'a', name: 'x', priority: 'High' })
    const b = formFromProcess({ id: 'a', name: 'x', priority: 'Low' })

    expect(formsEqual(a, b)).toBe(true)
    expect(formsEqual(a, { ...b, name: 'y' })).toBe(false)
  })

  it('falls back to the defaults a soft save is allowed to apply', () => {
    expect(coerceForm({ ...blank, name: 'x' })).toMatchObject({
      time_delay: '0',
      time_to_init: '10',
      relaunch_attempts: '5',
    })
    expect(coerceForm({ ...blank, time_delay: 'soon' }).time_delay).toBe('0')
    expect(coerceForm({ ...blank, time_delay: '-1' }).time_delay).toBe('0')
    // Below the ten-second floor the service enforces.
    expect(coerceForm({ ...blank, time_to_init: '5' }).time_to_init).toBe('10')
    expect(coerceForm({ ...blank, relaunch_attempts: '2.5' }).relaunch_attempts).toBe('5')
    // Zero attempts means unlimited, and is not a mistake.
    expect(coerceForm({ ...blank, relaunch_attempts: '0' }).relaunch_attempts).toBe('0')
  })

  it('keeps values it has no reason to touch, minus stray whitespace', () => {
    const coerced = coerceForm({
      ...blank,
      name: ' player ',
      exe_path: ' C:/apps/player.exe ',
      time_delay: '2.5',
      time_to_init: '30',
      relaunch_attempts: '3',
    })

    expect(coerced).toMatchObject({
      name: 'player',
      exe_path: 'C:/apps/player.exe',
      time_delay: '2.5',
      time_to_init: '30',
      relaunch_attempts: '3',
    })
  })
})

describe('launch mode', () => {
  it('reads the legacy autolaunch flag when no mode was ever written', () => {
    expect(launchModeOf({ id: 'a', autolaunch: true })).toBe('always')
    expect(launchModeOf({ id: 'a', autolaunch: false })).toBe('off')
    expect(launchModeOf({ id: 'a', launch_mode: 'scheduled', autolaunch: false })).toBe('scheduled')
  })

  it('keeps autolaunch in step with the mode', () => {
    expect(setLaunchMode({ id: 'a' }, 'always')).toMatchObject({
      launch_mode: 'always',
      autolaunch: true,
    })
    expect(setLaunchMode({ id: 'a' }, 'off')).toMatchObject({
      launch_mode: 'off',
      autolaunch: false,
    })
  })

  it('requires a name and an exe before it can be enabled', () => {
    expect(launchModeBlockedReason({ id: 'a', name: '', exe_path: 'x.exe' })).toMatch(/name/)
    expect(launchModeBlockedReason({ id: 'a', name: 'x', exe_path: '  ' })).toMatch(/exe path/)
    expect(launchModeBlockedReason({ id: 'a', name: 'x', exe_path: 'x.exe' })).toBeNull()
  })

  it('summarises a schedule, and says what an empty one does', () => {
    const scheduled: ProcessEntry = {
      id: 'a',
      schedules: [{ days: ['mon', 'tue'], ranges: [{ start: '09:00', stop: '17:00' }] }],
    }

    expect(scheduleSummary(scheduled)).toBe('mon, tue: 09:00-17:00')
    expect(scheduleSummary({ id: 'a', schedules: null })).toBe(
      '(no schedule set — runs at all times)',
    )
    expect(scheduleSummary({ id: 'a', schedules: [{ days: [], ranges: [] }] })).toBe(
      '(no schedule set — runs at all times)',
    )
  })

  it('stores schedule blocks the way the web app writes them', () => {
    const authored = [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ]
    // A web-authored entry, `schedulePresetId` and all.
    const entry: ProcessEntry = {
      id: 'a',
      name: 'touch',
      launch_mode: 'scheduled',
      schedulePresetId: 'builtin-0',
      schedules: null,
    }

    const updated = setSchedules(entry, authored)

    expect(updated.schedules).toStrictEqual(authored)
    // Left alone on purpose: the presets live in Firestore, so this app cannot
    // tell whether the edited blocks still match the one that was named.
    expect(updated.schedulePresetId).toBe('builtin-0')
    expect(Object.keys(updated)).toStrictEqual(Object.keys(entry))
  })
})

describe('legacy value mapping', () => {
  it('maps the old visibility spellings', () => {
    expect(visibilityOf({ id: 'a', visibility: 'Show' })).toBe('Normal')
    expect(visibilityOf({ id: 'a', visibility: 'Hide' })).toBe('Hidden')
    expect(visibilityOf({ id: 'a' })).toBe('Normal')
    expect(setVisibility({ id: 'a' }, 'Hidden').visibility).toBe('Hidden')
  })

  it('falls back to a priority the service understands', () => {
    expect(priorityOf({ id: 'a', priority: 'Realtime' })).toBe('Realtime')
    expect(priorityOf({ id: 'a', priority: 'Extreme' })).toBe('Normal')
  })
})

describe('list operations', () => {
  it('adds a new entry with the service\u2019s defaults', () => {
    const entry = createProcessEntry('new-id')

    expect(entry).toMatchObject({
      id: 'new-id',
      launch_mode: 'off',
      autolaunch: false,
      time_to_init: '10',
      relaunch_attempts: '5',
      visibility: 'Normal',
      priority: 'Normal',
    })
  })

  it('names a clone something nothing else is called', () => {
    expect(uniqueCopyName(['td'], 'td')).toBe('td (copy)')
    expect(uniqueCopyName(['td', 'td (copy)'], 'td')).toBe('td (copy 2)')
    expect(uniqueCopyName(['td', 'td (copy)', 'td (copy 2)'], 'td')).toBe('td (copy 3)')
  })

  it('names a fresh entry something nothing else is called', () => {
    const entries = (...names: string[]) =>
      names.map((name, index) => createProcessEntry(`id-${index}`, name))

    expect(uniqueDefaultName([])).toBe('untitled process')
    expect(uniqueDefaultName(entries('td'))).toBe('untitled process')
    expect(uniqueDefaultName(entries('untitled process'))).toBe('untitled process 2')
    expect(uniqueDefaultName(entries('untitled process', 'untitled process 2'))).toBe(
      'untitled process 3',
    )
    // A freed-up middle slot is reused rather than skipped past.
    expect(uniqueDefaultName(entries('untitled process', 'untitled process 3'))).toBe(
      'untitled process 2',
    )
  })

  it('clones deeply, disarmed, and pointing at itself', () => {
    const before = liveConfig()
    const after = duplicateProcess(before, 'a', 'clone-id')
    const clone = after.processes![2]

    expect(clone).toMatchObject({
      id: 'clone-id',
      processId: 'clone-id',
      name: 'touch (copy)',
      launch_mode: 'off',
      autolaunch: false,
    })
    // A deep copy: editing the clone's schedule cannot reach the original.
    expect(clone.schedules).not.toBe(before.processes![0].schedules)
    expect(clone.schedules).toEqual(before.processes![0].schedules)
  })

  it('reorders to an explicit position', () => {
    const before = addProcess(liveConfig(), createProcessEntry('c'))
    const ids = (config: OwletteConfig) => config.processes!.map((process) => process.id)

    // Drag the last row to the top, and the first row to the middle.
    expect(ids(reorderProcess(before, 'c', 0))).toEqual(['c', 'a', 'b'])
    expect(ids(reorderProcess(before, 'a', 1))).toEqual(['b', 'a', 'c'])
    expect(ids(reorderProcess(before, 'a', 2))).toEqual(['b', 'c', 'a'])
  })

  it('treats a move that changes nothing as no move at all', () => {
    const before = liveConfig()

    // Same object back means the caller writes no file.
    expect(reorderProcess(before, 'a', 0)).toBe(before)
    expect(reorderProcess(before, 'a', -1)).toBe(before)
    expect(reorderProcess(before, 'a', 2)).toBe(before)
    expect(reorderProcess(before, 'missing', 1)).toBe(before)
  })

  it('removes only the entry it was asked to', () => {
    expect(removeProcess(liveConfig(), 'a').processes!.map((process) => process.id)).toEqual(['b'])
  })
})

describe('identity for terminate_pid', () => {
  it('offers the full path first, then the bare image name', () => {
    expect(expectedImagesFor({ id: 'a', exe_path: 'C:/apps/player.exe' })).toEqual([
      'C:/apps/player.exe',
      'player.exe',
    ])
  })

  it('knows a script runs as cmd.exe', () => {
    expect(expectedImagesFor({ id: 'a', exe_path: 'C:/apps/start.bat' })).toEqual(['cmd.exe'])
    expect(expectedImagesFor({ id: 'a', exe_path: 'C:/apps/start.CMD' })).toEqual(['cmd.exe'])
  })

  it('has nothing to offer for an entry with no executable', () => {
    expect(expectedImagesFor({ id: 'a' })).toEqual([])
  })
})
