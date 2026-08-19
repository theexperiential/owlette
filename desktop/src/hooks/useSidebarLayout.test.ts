import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sidebarWidth = vi.fn<() => Promise<number>>()
const setSidebarWidth = vi.fn<(width: number) => Promise<number>>()
const sidebarCollapsed = vi.fn<() => Promise<boolean>>()
const setSidebarCollapsed = vi.fn<(collapsed: boolean) => Promise<boolean>>()

vi.mock('@/lib/ipc', () => ({
  sidebarWidth: () => sidebarWidth(),
  setSidebarWidth: (width: number) => setSidebarWidth(width),
  sidebarCollapsed: () => sidebarCollapsed(),
  setSidebarCollapsed: (collapsed: boolean) => setSidebarCollapsed(collapsed),
}))

const { SIDEBAR_PERSIST_DELAY_MS, useSidebarLayout } = await import('./useSidebarLayout')
const { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_RAIL_WIDTH } = await import(
  '@/lib/sidebarWidth'
)

/** Render the hook and let the mount reads settle. */
async function mounted() {
  const view = renderHook(() => useSidebarLayout())
  await act(async () => {})
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  sidebarWidth.mockReset()
  sidebarWidth.mockResolvedValue(SIDEBAR_DEFAULT_WIDTH)
  setSidebarWidth.mockReset()
  setSidebarWidth.mockImplementation((width) => Promise.resolve(width))
  sidebarCollapsed.mockReset()
  sidebarCollapsed.mockResolvedValue(false)
  setSidebarCollapsed.mockReset()
  setSidebarCollapsed.mockImplementation((collapsed) => Promise.resolve(collapsed))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSidebarLayout', () => {
  it('opens at the stored layout', async () => {
    sidebarWidth.mockResolvedValue(352)
    sidebarCollapsed.mockResolvedValue(true)
    const { result } = await mounted()

    expect(result.current.width).toBe(352)
    expect(result.current.collapsed).toBe(true)
    // Collapsed, the column is the rail — but the width it expands back to is
    // still the stored one.
    expect(result.current.columnWidth).toBe(SIDEBAR_RAIL_WIDTH)
    expect(setSidebarWidth).not.toHaveBeenCalled()
    expect(setSidebarCollapsed).not.toHaveBeenCalled()
  })

  it('opens at the pre-resizable width when there is no bridge', async () => {
    sidebarWidth.mockRejectedValue(new Error('no bridge'))
    sidebarCollapsed.mockRejectedValue(new Error('no bridge'))
    const { result } = await mounted()

    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(result.current.collapsed).toBe(false)
  })

  it('keeps the setting the host could answer for when the other read fails', async () => {
    sidebarWidth.mockResolvedValue(320)
    sidebarCollapsed.mockRejectedValue(new Error('unknown command'))
    const { result } = await mounted()

    expect(result.current.width).toBe(320)
    expect(result.current.collapsed).toBe(false)
  })

  it('clamps a width the host somehow handed back out of range', async () => {
    sidebarWidth.mockResolvedValue(9000)
    const { result } = await mounted()

    expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('applies a new width immediately and writes it once, later', async () => {
    const { result } = await mounted()

    act(() => result.current.set({ collapsed: false, width: 320 }))
    expect(result.current.width).toBe(320)
    expect(setSidebarWidth).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS)
    })
    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(320)
    // A resize is not a collapse; the flag must not be rewritten.
    expect(setSidebarCollapsed).not.toHaveBeenCalled()
  })

  it('batches a drag into a single write of the width it ended on', async () => {
    const { result } = await mounted()

    // What a drag looks like: one call per pointer move.
    act(() => {
      for (let x = 290; x <= 340; x += 5) result.current.set({ collapsed: false, width: x })
    })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS * 4)
    })

    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(340)
  })

  it('writes the collapse without touching the width it expands back to', async () => {
    sidebarWidth.mockResolvedValue(352)
    const { result } = await mounted()

    act(() => result.current.setCollapsed(true))
    expect(result.current.collapsed).toBe(true)
    expect(result.current.width).toBe(352)
    expect(result.current.columnWidth).toBe(SIDEBAR_RAIL_WIDTH)

    act(() => result.current.commit())
    expect(setSidebarCollapsed).toHaveBeenCalledExactlyOnceWith(true)
    expect(setSidebarWidth).not.toHaveBeenCalled()

    act(() => result.current.setCollapsed(false))
    act(() => result.current.commit())
    expect(setSidebarCollapsed).toHaveBeenLastCalledWith(false)
    expect(result.current.columnWidth).toBe(352)
  })

  it('ignores a collapse that changes nothing', async () => {
    const { result } = await mounted()

    act(() => result.current.setCollapsed(false))
    act(() => result.current.commit())

    expect(setSidebarCollapsed).not.toHaveBeenCalled()
  })

  it('writes both settings when one gesture changed both', async () => {
    const { result } = await mounted()

    // A drag that crosses the threshold after having resized: the width it was
    // dragged to and the collapse both have to survive a relaunch.
    act(() => result.current.set({ collapsed: false, width: 320 }))
    act(() => result.current.set({ collapsed: true, width: 320 }))
    act(() => result.current.commit())

    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(320)
    expect(setSidebarCollapsed).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('commit writes the pending layout straight away, and only once', async () => {
    const { result } = await mounted()

    act(() => result.current.set({ collapsed: false, width: 310 }))
    act(() => result.current.commit())
    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(310)

    // The debounce it short-circuited must not fire a second write.
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS * 4)
    })
    act(() => result.current.commit())
    expect(setSidebarWidth).toHaveBeenCalledTimes(1)
  })

  it('does not let a slow read land on top of a layout already changed', async () => {
    let settle: (width: number) => void = () => {}
    sidebarWidth.mockReturnValue(
      new Promise<number>((resolve) => {
        settle = resolve
      }),
    )

    const { result } = renderHook(() => useSidebarLayout())
    act(() => result.current.set({ collapsed: false, width: 240 }))
    await act(async () => {
      settle(400)
    })

    expect(result.current.width).toBe(240)
  })

  it('flushes a pending layout when it goes away', async () => {
    const { result, unmount } = await mounted()

    act(() => result.current.set({ collapsed: true, width: 300 }))
    unmount()

    expect(setSidebarWidth).toHaveBeenCalledExactlyOnceWith(300)
    expect(setSidebarCollapsed).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('survives a write the host refuses', async () => {
    setSidebarWidth.mockRejectedValue('could not save the sidebar width: access denied')
    const { result } = await mounted()

    act(() => result.current.set({ collapsed: false, width: 300 }))
    await act(async () => {
      vi.advanceTimersByTime(SIDEBAR_PERSIST_DELAY_MS)
    })

    expect(result.current.width).toBe(300)
  })
})
