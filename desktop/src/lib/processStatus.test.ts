import { describe, expect, it } from 'vitest'
import {
  livePidForProcess,
  markKilled,
  parseAppStates,
  statusForProcess,
  statusLabel,
  STATUS_DOT,
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
    expect(Object.values(STATUS_DOT).every((value) => value.length > 0)).toBe(true)
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

describe('the killed marker', () => {
  it('rewrites one pid and leaves the rest of the file alone', () => {
    const states: AppStates = {
      '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
      '300': { id: 'b', status: 'RUNNING', timestamp: 30 },
    }

    const marked = markKilled(states, 100, 'a')

    expect(marked['100']).toEqual({ id: 'a', status: 'KILLED', timestamp: 10 })
    expect(marked['300']).toBe(states['300'])
    expect(states['100'].status).toBe('RUNNING')
  })

  it('creates the entry when the pid is not in the table yet', () => {
    expect(markKilled({}, 42, 'a')).toEqual({ '42': { status: 'KILLED', id: 'a' } })
  })
})
