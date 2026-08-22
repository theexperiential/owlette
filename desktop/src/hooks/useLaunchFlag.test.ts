import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface SecondInstancePayload {
  argv: string[]
  cwd: string
}

const launchArgs = vi.fn<() => Promise<string[]>>()
const unlisten = vi.fn()
let forward: ((payload: SecondInstancePayload) => void) | null = null
const onSecondInstance = vi.fn(async (handler: (payload: SecondInstancePayload) => void) => {
  forward = handler
  return unlisten
})

vi.mock('@/lib/ipc', () => ({
  launchArgs: () => launchArgs(),
  onSecondInstance: (handler: (payload: SecondInstancePayload) => void) => onSecondInstance(handler),
}))

const { useLaunchFlag } = await import('./useLaunchFlag')

const FLAG = '--restart-prompt'
const EXE = 'C:\\ProgramData\\Owlette\\app\\owlette-desktop.exe'

/** Mount the hook and let both subscription promises settle. */
async function mount(flag = FLAG) {
  const view = renderHook(() => useLaunchFlag(flag))
  await act(async () => {})
  return view
}

/** Deliver one forwarded launch and let react settle. */
async function relaunch(...argv: string[]) {
  await act(async () => {
    forward?.({ argv, cwd: 'C:\\ProgramData\\Owlette' })
  })
}

beforeEach(() => {
  forward = null
  unlisten.mockClear()
  onSecondInstance.mockClear()
  launchArgs.mockReset()
  launchArgs.mockResolvedValue([EXE, '--tray'])
})

describe('useLaunchFlag', () => {
  it('arms on the flag being on our own argv', async () => {
    launchArgs.mockResolvedValue([EXE, FLAG])

    const { result } = await mount()

    expect(result.current.armed).toBe(true)
  })

  it('arms on the flag arriving from a forwarded second instance', async () => {
    const { result } = await mount()
    expect(result.current.armed).toBe(false)

    await relaunch(EXE, FLAG)

    expect(result.current.armed).toBe(true)
  })

  it('stays disarmed when neither route carries the flag', async () => {
    const { result } = await mount()

    await relaunch(EXE, '--tray')

    expect(result.current.armed).toBe(false)
    expect(result.current.argv).toEqual([])
  })

  it('hands back the whole argv of the launch that armed it', async () => {
    const { result } = await mount()

    await relaunch(EXE, FLAG, 'touchdesigner')

    expect(result.current.argv).toEqual([EXE, FLAG, 'touchdesigner'])
  })

  it('clears both the flag and its argv on dismiss', async () => {
    launchArgs.mockResolvedValue([EXE, FLAG])
    const { result } = await mount()

    act(() => {
      result.current.dismiss()
    })

    // A stale argv would let a later re-open read the flag a second time.
    expect(result.current.armed).toBe(false)
    expect(result.current.argv).toEqual([])
  })

  it('unsubscribes from second instances with the window', async () => {
    const { unmount } = await mount()

    unmount()

    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('shrugs off having no bridge to ask', async () => {
    launchArgs.mockRejectedValue(new Error('window.__TAURI_INTERNALS__ is undefined'))

    const { result } = await mount()

    expect(result.current.armed).toBe(false)
    expect(result.current.argv).toEqual([])
  })
})
