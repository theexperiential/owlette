import { describe, expect, it } from 'vitest'
import {
  isLive,
  launchedAtForProcess,
  livePidForProcess,
  markKilled,
  markRestarting,
  parseAppStates,
  restoreState,
  statusForProcess,
  statusLabel,
  STATUS_DOT,
  STATUS_TEXT,
  PROCESS_STATUSES,
  type AppStates,
} from './processStatus'

describe('parsing the service’s table', () => {
  it('keeps well-formed entries whole, including fields we do not read', () => {
    const states = parseAppStates({
      '18244': { id: 'a', status: 'RUNNING', timestamp: 1_786_562_574, restarts: 2 },
    })

    expect(states['18244']).toEqual({
      id: 'a',
      status: 'RUNNING',
      timestamp: 1_786_562_574,
      restarts: 2,
    })
  })

  it('drops anything that is not a pid mapping to an object', () => {
    const states = parseAppStates({
      '18244': { id: 'a', status: 'RUNNING' },
      None: { id: 'b', status: 'RUNNING' },
      '99': 'RUNNING',
      '100': null,
    })

    expect(Object.keys(states)).toEqual(['18244'])
  })

  it('treats a missing or nonsense document as an empty table', () => {
    expect(parseAppStates({})).toEqual({})
    expect(parseAppStates(null)).toEqual({})
    expect(parseAppStates([1, 2])).toEqual({})
    expect(parseAppStates('RUNNING')).toEqual({})
  })
})

describe('status for a config entry', () => {
  const states: AppStates = {
    '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
    '200': { id: 'a', status: 'LAUNCH_FAILED', timestamp: 20 },
    '300': { id: 'b', status: 'RUNNING', timestamp: 5 },
  }

  it('reports the newest generation, not the happiest one', () => {
    expect(statusForProcess(states, 'a')).toBe('LAUNCH_FAILED')
    expect(statusForProcess(states, 'b')).toBe('RUNNING')
  })

  it('shows the operator’s kill even though an older pid still says running', () => {
    const killed = markKilled(states, 200, 'a')

    expect(statusForProcess(killed, 'a')).toBe('KILLED')
  })

  it('is inactive for an entry the service has never launched', () => {
    expect(statusForProcess(states, 'never-launched')).toBe('INACTIVE')
  })

  it('is inactive for a status word it does not recognise', () => {
    expect(statusForProcess({ '1': { id: 'a', status: 'PONDERING', timestamp: 1 } }, 'a')).toBe(
      'INACTIVE',
    )
  })

  it('has a dot and a lowercase label for every status', () => {
    expect(statusLabel('RUNNING')).toBe('running')
    // The dashboard calls this one "failed"; so do we.
    expect(statusLabel('LAUNCH_FAILED')).toBe('failed')
    expect(statusLabel('RESTARTING')).toBe('restarting')
    for (const status of PROCESS_STATUSES) {
      expect(STATUS_DOT[status]).toBeTruthy()
      expect(STATUS_TEXT[status]).toBeTruthy()
    }
  })

  it('recognises the marker this app writes for a restart', () => {
    // Not knowing our own write would blank the row to inactive for the couple
    // of seconds the service takes to relaunch.
    expect(statusForProcess({ '1': { id: 'a', status: 'RESTARTING', timestamp: 1 } }, 'a')).toBe(
      'RESTARTING',
    )
  })
})

describe('picking a pid to act on', () => {
  it('prefers a running generation over a newer dead one', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
      '200': { id: 'a', status: 'LAUNCH_FAILED', timestamp: 20 },
    }

    expect(livePidForProcess(states, 'a')).toBe(100)
  })

  it('takes the newest running generation when there are several', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
      '400': { id: 'a', status: 'RUNNING', timestamp: 40 },
    }

    expect(livePidForProcess(states, 'a')).toBe(400)
  })

  it('falls back to the newest generation of any status', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'KILLED', timestamp: 10 },
      '200': { id: 'a', status: 'STOPPED', timestamp: 20 },
    }

    expect(livePidForProcess(states, 'a')).toBe(200)
  })

  it('breaks a timestamp tie on the higher pid', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'STOPPED' },
      '200': { id: 'a', status: 'STOPPED' },
    }

    expect(livePidForProcess(states, 'a')).toBe(200)
  })

  it('has nothing to offer when the entry owns no pids', () => {
    expect(livePidForProcess({}, 'a')).toBeNull()
  })
})

describe('whether there is a process to act on', () => {
  it('accepts the three statuses that describe a live generation', () => {
    expect(PROCESS_STATUSES.filter(isLive)).toEqual(['RUNNING', 'LAUNCHING', 'RESTARTING'])
  })

  it('refuses the ones that describe a generation that ended or never began', () => {
    for (const status of ['QUEUED', 'LAUNCH_FAILED', 'KILLED', 'STOPPED', 'INACTIVE'] as const) {
      expect(isLive(status)).toBe(false)
    }
  })
})

describe('when the live generation was launched', () => {
  it('reads the newest generation’s launch time, in milliseconds', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'STOPPED', timestamp: 1_786_562_000 },
      '400': { id: 'a', status: 'RUNNING', timestamp: 1_786_562_574 },
    }

    expect(launchedAtForProcess(states, 'a')).toBe(1_786_562_574_000)
  })

  it('has nothing for an entry the service has never launched', () => {
    expect(launchedAtForProcess({}, 'a')).toBeNull()
    // The service writes a status without a timestamp when it adopts a process
    // it did not start.
    expect(launchedAtForProcess({ '100': { id: 'a', status: 'RUNNING' } }, 'a')).toBeNull()
    expect(
      launchedAtForProcess({ '100': { id: 'a', status: 'RUNNING', timestamp: 0 } }, 'a'),
    ).toBeNull()
  })

  it('ignores a timestamp that is not a number', () => {
    const states = {
      '100': { id: 'a', status: 'RUNNING', timestamp: '1786562574' },
    } as unknown as AppStates

    expect(launchedAtForProcess(states, 'a')).toBeNull()
  })
})

describe('the operator’s markers', () => {
  const states: AppStates = {
    '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
    '300': { id: 'b', status: 'RUNNING', timestamp: 30 },
  }

  it('rewrites one pid and leaves the rest of the file alone', () => {
    const marked = markKilled(states, 100, 'a')

    expect(marked['100']).toEqual({ id: 'a', status: 'KILLED', timestamp: 10 })
    expect(marked['300']).toBe(states['300'])
    expect(states['100'].status).toBe('RUNNING')
  })

  it('says RESTARTING when the operator asked for the process back', () => {
    const marked = markRestarting(states, 100, 'a')

    expect(marked['100']).toEqual({ id: 'a', status: 'RESTARTING', timestamp: 10 })
    expect(marked['300']).toBe(states['300'])
  })

  it('creates the entry when the pid is not in the table yet', () => {
    expect(markKilled({}, 42, 'a')).toEqual({ '42': { status: 'KILLED', id: 'a' } })
  })

  it('restores a row whole, for a marker that turned out to be premature', () => {
    const marked = markRestarting(states, 100, 'a')

    expect(restoreState(marked, 100, states['100'])).toEqual(states)
  })
})
