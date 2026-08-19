import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setRowDragging } from '@/lib/rowDrag'

type DragDropPayload =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'drop'; paths: string[] }
  | { type: 'leave' }

let emit: ((payload: DragDropPayload) => void) | null = null
const unlisten = vi.fn()
const onDragDropEvent = vi.fn(async (handler: (event: { payload: DragDropPayload }) => void) => {
  emit = (payload) => handler({ payload })
  return unlisten
})

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}))

const { useFileDrop } = await import('./useFileDrop')

/** Deliver one host event and let react settle. */
async function fire(payload: DragDropPayload) {
  await act(async () => {
    emit?.(payload)
  })
}

/** Mount the hook and wait for the subscription promise to resolve. */
async function mount(onDrop = vi.fn()) {
  const view = renderHook(() => useFileDrop(onDrop))
  await act(async () => {})
  return { ...view, onDrop }
}

beforeEach(() => {
  emit = null
  unlisten.mockClear()
  onDragDropEvent.mockClear()
  setRowDragging(false)
})

describe('an os file drag', () => {
  it('lights up on the way in and hands over the paths on the way down', async () => {
    const { result, onDrop } = await mount()

    await fire({ type: 'enter', paths: ['C:\\shows\\a.toe'] })
    expect(result.current).toBe(true)

    await fire({ type: 'drop', paths: ['C:\\shows\\a.toe'] })
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(['C:\\shows\\a.toe'])
    expect(result.current).toBe(false)
  })

  it('stops lighting up when the drag leaves', async () => {
    const { result } = await mount()

    await fire({ type: 'over' })
    expect(result.current).toBe(true)

    await fire({ type: 'leave' })
    expect(result.current).toBe(false)
  })

  it('has nothing to do with an empty drop', async () => {
    const { onDrop } = await mount()

    await fire({ type: 'drop', paths: [] })

    expect(onDrop).not.toHaveBeenCalled()
  })

  it('calls the handler the caller passed most recently', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ onDrop }) => useFileDrop(onDrop), {
      initialProps: { onDrop: first },
    })
    await act(async () => {})

    rerender({ onDrop: second })
    await fire({ type: 'drop', paths: ['C:\\a.exe'] })

    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    // …and the subscription was not torn down to achieve it.
    expect(onDragDropEvent).toHaveBeenCalledOnce()
  })

  it('unsubscribes with the window', async () => {
    const { unmount } = await mount()

    unmount()

    expect(unlisten).toHaveBeenCalledOnce()
  })
})

describe('a process row being dragged', () => {
  it('is not a file drop, and does not raise the overlay', async () => {
    const { result, onDrop } = await mount()
    setRowDragging(true)

    await fire({ type: 'enter', paths: ['C:\\shows\\a.toe'] })
    expect(result.current).toBe(false)

    await fire({ type: 'drop', paths: ['C:\\shows\\a.toe'] })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('still clears an overlay that was already up', async () => {
    const { result } = await mount()

    await fire({ type: 'enter', paths: ['C:\\shows\\a.toe'] })
    setRowDragging(true)
    await fire({ type: 'leave' })

    expect(result.current).toBe(false)
  })
})
