import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const exeIcon = vi.fn<(path: string) => Promise<string | null>>()

vi.mock('@/lib/ipc', () => ({
  exeIcon: (path: string) => exeIcon(path),
}))

const { knownExeIcon, loadExeIcon, resetExeIconCache, useExeIcon } = await import('./useExeIcon')

const TOUCH = 'data:image/png;base64,TOUCH'

beforeEach(() => {
  resetExeIconCache()
  exeIcon.mockReset()
  exeIcon.mockResolvedValue(TOUCH)
})

describe('loadExeIcon', () => {
  it('asks the host once for a path, however many callers there are', async () => {
    const [first, second] = await Promise.all([
      loadExeIcon('C:/apps/touch.exe'),
      loadExeIcon('C:/apps/touch.exe'),
    ])

    expect(first).toBe(TOUCH)
    expect(second).toBe(TOUCH)
    expect(exeIcon).toHaveBeenCalledTimes(1)
  })

  it('treats a host failure as an entry with no icon', async () => {
    exeIcon.mockRejectedValue(new Error('GetDIBits failed'))

    await expect(loadExeIcon('C:/apps/broken.exe')).resolves.toBeNull()
    // …and remembers that, rather than asking again on every render.
    expect(knownExeIcon('C:/apps/broken.exe')).toBeNull()
  })

  it('keeps two spellings of a path apart, as the host would', async () => {
    await loadExeIcon('C:/apps/touch.exe')
    await loadExeIcon('C:\\apps\\touch.exe')

    expect(exeIcon).toHaveBeenCalledTimes(2)
  })
})

describe('useExeIcon', () => {
  it('resolves to the icon the host gave', async () => {
    const { result } = renderHook(() => useExeIcon('C:/apps/touch.exe'))

    expect(result.current).toBeNull() // nothing known yet — the caller draws its fallback
    await act(async () => {})
    expect(result.current).toBe(TOUCH)
  })

  it('paints a known icon on the first render, with no flash of fallback', async () => {
    await loadExeIcon('C:/apps/touch.exe')

    const { result } = renderHook(() => useExeIcon('C:/apps/touch.exe'))
    expect(result.current).toBe(TOUCH)
  })

  it('asks about nothing when there is no exe path', async () => {
    const { result } = renderHook(() => useExeIcon(undefined))
    await act(async () => {})

    expect(result.current).toBeNull()
    expect(exeIcon).not.toHaveBeenCalled()

    renderHook(() => useExeIcon('   '))
    await act(async () => {})
    expect(exeIcon).not.toHaveBeenCalled()
  })

  it('drops the old application’s icon the moment the path changes', async () => {
    const { result, rerender } = renderHook(({ path }) => useExeIcon(path), {
      initialProps: { path: 'C:/apps/touch.exe' },
    })
    await act(async () => {})
    expect(result.current).toBe(TOUCH)

    // An operator retyping the exe: the previous icon must not sit there
    // claiming to be the new one.
    exeIcon.mockResolvedValue(null)
    rerender({ path: 'C:/apps/other.exe' })
    expect(result.current).toBeNull()

    await act(async () => {})
    expect(result.current).toBeNull()
  })

  it('ignores an answer to a path it is no longer asking about', async () => {
    let settle: (icon: string | null) => void = () => {}
    exeIcon.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          settle = resolve
        }),
    )

    const { result, rerender } = renderHook(({ path }) => useExeIcon(path), {
      initialProps: { path: 'C:/apps/slow.exe' },
    })

    const slow = settle
    exeIcon.mockResolvedValue(TOUCH)
    rerender({ path: 'C:/apps/touch.exe' })
    await act(async () => {
      slow('data:image/png;base64,SLOW')
    })

    expect(result.current).toBe(TOUCH)
  })
})
