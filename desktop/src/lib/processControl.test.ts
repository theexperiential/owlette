import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStates } from './processStatus'

const terminatePid = vi.fn()

vi.mock('@/lib/ipc', () => ({ terminatePid: (...args: unknown[]) => terminatePid(...args) }))

const { NoLiveInstanceError, stopProcess } = await import('./processControl')

const entry = { id: 'a', name: 'player', exe_path: 'C:/apps/player.exe' }

/** A table with one running generation of `entry`. */
function running(): AppStates {
  return { '4242': { id: 'a', status: 'RUNNING', timestamp: 10 } }
}

function deps(states: AppStates) {
  let current = states
  const mutateStates = vi.fn(async (transform: (states: AppStates) => AppStates) => {
    current = transform(current)
    return current
  })
  return {
    readStates: vi.fn(async () => current),
    mutateStates,
    get states() {
      return current
    },
  }
}

beforeEach(() => {
  terminatePid.mockReset()
  terminatePid.mockResolvedValue({
    method: 'wm_close',
    waitedMs: 120,
    windowsClosed: 1,
    imagePath: 'C:\\apps\\player.exe',
  })
})

describe('kill', () => {
  it('terminates the live pid and marks it so the service leaves it alone', async () => {
    const io = deps(running())

    const result = await stopProcess(entry, 'kill', io)

    expect(terminatePid).toHaveBeenCalledWith(4242, 'C:/apps/player.exe')
    expect(result).toMatchObject({ pid: 4242, marked: true })
    expect(io.states['4242']).toEqual({ id: 'a', status: 'KILLED', timestamp: 10 })
  })
})

describe('restart', () => {
  it('terminates and writes nothing, so the service relaunches on its next tick', async () => {
    const io = deps(running())

    const result = await stopProcess(entry, 'restart', io)

    expect(terminatePid).toHaveBeenCalledOnce()
    expect(io.mutateStates).not.toHaveBeenCalled()
    expect(result.marked).toBe(false)
    expect(io.states['4242'].status).toBe('RUNNING')
  })
})

describe('identity check', () => {
  it('falls back to the bare image name when the full path does not match', async () => {
    terminatePid
      .mockRejectedValueOnce(
        new Error(
          'pid 4242 is running C:\\apps\\v2\\player.exe, not C:/apps/player.exe — refusing to terminate it',
        ),
      )
      .mockResolvedValueOnce({
        method: 'terminated',
        waitedMs: 5000,
        windowsClosed: 0,
        imagePath: 'C:\\apps\\v2\\player.exe',
      })

    const result = await stopProcess(entry, 'kill', deps(running()))

    expect(terminatePid.mock.calls.map(([, image]) => image)).toEqual([
      'C:/apps/player.exe',
      'player.exe',
    ])
    expect(result.method).toBe('terminated')
  })

  it('gives up when the pid is running something else entirely', async () => {
    terminatePid.mockRejectedValue(
      new Error('pid 4242 is running C:\\windows\\notepad.exe, not player.exe — refusing to terminate it'),
    )

    await expect(stopProcess(entry, 'kill', deps(running()))).rejects.toThrow(/refusing/)
  })

  it('does not retry a failure that is not an identity mismatch', async () => {
    terminatePid.mockRejectedValue(new Error('could not open process 4242: access is denied'))

    await expect(stopProcess(entry, 'kill', deps(running()))).rejects.toThrow(/access is denied/)
    expect(terminatePid).toHaveBeenCalledOnce()
  })

  it('sends a script entry as the cmd.exe it really runs as', async () => {
    await stopProcess({ ...entry, exe_path: 'C:/apps/start.bat' }, 'kill', deps(running()))

    expect(terminatePid).toHaveBeenCalledWith(4242, 'cmd.exe')
  })
})

describe('nothing to stop', () => {
  it('reports no live instance when the entry owns no pid', async () => {
    await expect(stopProcess(entry, 'kill', deps({}))).rejects.toBeInstanceOf(NoLiveInstanceError)
    expect(terminatePid).not.toHaveBeenCalled()
  })

  it('reports no live instance when the pid has already gone', async () => {
    terminatePid.mockResolvedValue({
      method: 'not_found',
      waitedMs: 0,
      windowsClosed: 0,
      imagePath: null,
    })
    const io = deps(running())

    await expect(stopProcess(entry, 'kill', io)).rejects.toBeInstanceOf(NoLiveInstanceError)
    // Nothing was killed, so nothing may claim it was.
    expect(io.mutateStates).not.toHaveBeenCalled()
  })

  it('refuses to guess when the entry has no executable', async () => {
    await expect(stopProcess({ id: 'a', name: 'x' }, 'kill', deps(running()))).rejects.toThrow(
      /no exe path/,
    )
  })
})
