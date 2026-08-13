import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sidebarWidth = vi.fn<() => Promise<number>>()
const setSidebarWidth = vi.fn<(width: number) => Promise<number>>()

vi.mock('@/lib/ipc', () => ({
  sidebarWidth: () => sidebarWidth(),
  setSidebarWidth: (width: number) => setSidebarWidth(width),
}))

const { SIDEBAR_PERSIST_DELAY_MS, useSidebarWidth } = await import('./useSidebarWidth')
const { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH } = await import('@/lib/sidebarWidth')

/** Render the hook and let the mount read settle. */
async function mounted() {
  const view = renderHook(() => useSidebarWidth())
  await act(async () => {})
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  sidebarWidth.mockReset()
  sidebarWidth.mockResolvedValue(SIDEBAR_DEFAULT_WIDTH)
  setSidebarWidth.mockReset()
  setSidebarWidth.mockImplementation((width) => Promise.resolve(width))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSidebarWidth', () => {
  it('opens at the stored width', async () => {
    sidebarWidth.mockResolvedValue(352)
    const { result } = await mounted()

    expect(result.current.width).toBe(352)
    expect(setSidebarWidth).not.toHaveBeenCalled()
  })

  it('opens at the pre-resizable width when there is no bridge', async () => {
    sidebarWidth.mockRejectedValue(new Error('no bridge'))
    const { result } = await mounted()

    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('clamps a width the host somehow handed back out of range', async () => {
    sidebarWidth.mockResolvedValue(9000)
    const { result } = await mounted()

    expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('applies a new width immediately and writes it once, later', async () => {
    const { result } = await mounted()

    act(() => result.current.set(320))
    expect(result.current.width).toBe(320)
    expect(setSidebarWidth).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS)
    })
    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(320)
  })

  it('batches a drag into a single write of the width it ended on', async () => {
    const { result } = await mounted()

    // What a drag looks like: one call per pointer move.
    act(() => {
      for (let x = 290; x <= 340; x += 5) result.current.set(x)
    })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS * 4)
    })

    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(340)
  })

  it('commit writes the pending width straight away, and only once', async () => {
    const { result } = await mounted()

    act(() => result.current.set(310))
    act(() => result.current.commit())
    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(310)

    // The debounce it short-circuited must not fire a second write.
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS * 4)
    })
    act(() => result.current.commit())
    expect(setSidebarWidth).toHaveBeenCalledTimes(1)
  })

  it('does not let a slow read land on top of a width already dragged to', async () => {
    let settle: (width: number) => void = () => {}
    sidebarWidth.mockReturnValue(
      new Promise<number>((resolve) => {
        settle = resolve
      }),
    )

    const { result } = renderHook(() => useSidebarWidth())
    act(() => result.current.set(240))
    await act(async () => {
      settle(400)
    })

    expect(result.current.width).toBe(240)
  })

  it('flushes a pending width when it goes away', async () => {
    const { result, unmount } = await mounted()

    act(() => result.current.set(300))
    unmount()

    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(300)
  })

  it('survives a write the host refuses', async () => {
    setSidebarWidth.mockRejectedValue('could not save the sidebar width: access denied')
    const { result } = await mounted()

    act(() => result.current.set(300))
    await act(async () => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS)
    })

    expect(result.current.width).toBe(300)
  })
})
