import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SidebarDivider } from '@/components/SidebarDivider'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@/lib/sidebarWidth'

/**
 * jsdom has no `PointerEvent`, so testing-library builds a bare `Event` whose
 * `button` and `clientX` are undefined — useless for a drag. A `MouseEvent`
 * carries both; the pointer id is pinned on by hand. Same helper the process
 * list's reorder tests use.
 */
function pointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  { clientX, button = 0, pointerId = 1 }: { clientX: number; button?: number; pointerId?: number },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  fireEvent(element, event)
}

/** The divider is controlled; this is the state that owns it in the app. */
function Harness({ initial, onCommit }: { initial: number; onCommit: () => void }) {
  const [width, setWidth] = useState(initial)
  return (
    <>
      <SidebarDivider width={width} onWidth={setWidth} onCommit={onCommit} />
      <span data-testid="width">{width}</span>
    </>
  )
}

function setup(initial = 288) {
  const onCommit = vi.fn()
  render(<Harness initial={initial} onCommit={onCommit} />)

  const divider = screen.getByTestId('sidebar-divider')
  // jsdom implements neither half of pointer capture.
  divider.setPointerCapture = () => {}
  divider.releasePointerCapture = () => {}

  return {
    divider,
    onCommit,
    width: () => Number(screen.getByTestId('width').textContent),
  }
}

describe('SidebarDivider', () => {
  it('publishes the range it moves through', () => {
    const { divider } = setup(288)

    expect(divider.getAttribute('role')).toBe('separator')
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(divider.getAttribute('aria-label')).toBe('resize the process list')
    expect(divider.getAttribute('aria-valuenow')).toBe('288')
    expect(divider.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_MIN_WIDTH))
    expect(divider.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_MAX_WIDTH))
    expect(divider.tabIndex).toBe(0)
    expect(divider.className).toContain('cursor-col-resize')
    // Quiet at rest: the line is the border it replaces, one pixel wide.
    expect(divider.className).toContain('bg-border')
    expect(divider.className).toContain('w-px')
  })

  it('follows the pointer, measuring from where the drag started', () => {
    const { divider, width } = setup(288)

    pointer(divider, 'pointerdown', { clientX: 300 })
    pointer(divider, 'pointermove', { clientX: 340 })
    expect(width()).toBe(328)

    // Back past the origin in one move: derived from the start, not accumulated.
    pointer(divider, 'pointermove', { clientX: 260 })
    expect(width()).toBe(248)
  })

  it('parks at the minimum instead of collapsing, and stops at the maximum', () => {
    const { divider, width } = setup(288)

    pointer(divider, 'pointerdown', { clientX: 300 })
    pointer(divider, 'pointermove', { clientX: -2000 })
    expect(width()).toBe(SIDEBAR_MIN_WIDTH)

    pointer(divider, 'pointermove', { clientX: 2000 })
    expect(width()).toBe(SIDEBAR_MAX_WIDTH)

    // …and coming back from the overshoot lands where the pointer actually is.
    pointer(divider, 'pointermove', { clientX: 320 })
    expect(width()).toBe(308)
  })

  it('commits once when the gesture ends, not once per move', () => {
    const { divider, onCommit } = setup(288)

    pointer(divider, 'pointerdown', { clientX: 300 })
    pointer(divider, 'pointermove', { clientX: 310 })
    pointer(divider, 'pointermove', { clientX: 320 })
    pointer(divider, 'pointermove', { clientX: 330 })
    expect(onCommit).not.toHaveBeenCalled()

    pointer(divider, 'pointerup', { clientX: 330 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('marks itself while dragging and lets go on a cancel', () => {
    const { divider, onCommit } = setup(288)

    pointer(divider, 'pointerdown', { clientX: 300 })
    expect(divider.dataset.dragging).toBe('true')

    pointer(divider, 'pointercancel', { clientX: 300 })
    expect(divider.dataset.dragging).toBeUndefined()
    expect(onCommit).toHaveBeenCalledTimes(1)

    // A move after the gesture ended is not a resize.
    pointer(divider, 'pointermove', { clientX: 400 })
    expect(divider.getAttribute('aria-valuenow')).toBe('288')
  })

  it('ignores a non-primary button and a foreign pointer', () => {
    const { divider, width } = setup(288)

    pointer(divider, 'pointerdown', { clientX: 300, button: 2 })
    pointer(divider, 'pointermove', { clientX: 400 })
    expect(width()).toBe(288)

    // A second pointer moving mid-drag (a touch elsewhere) is not this gesture.
    pointer(divider, 'pointerdown', { clientX: 300 })
    pointer(divider, 'pointermove', { clientX: 400, pointerId: 2 })
    expect(width()).toBe(288)
  })

  it('resizes from the keyboard and swallows only the keys it uses', () => {
    const { divider, width, onCommit } = setup(288)

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(width()).toBe(296)
    fireEvent.keyDown(divider, { key: 'ArrowLeft', shiftKey: true })
    expect(width()).toBe(264)
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(width()).toBe(SIDEBAR_MIN_WIDTH)
    fireEvent.keyDown(divider, { key: 'End' })
    expect(width()).toBe(SIDEBAR_MAX_WIDTH)

    const unhandled = fireEvent.keyDown(divider, { key: 'ArrowUp' })
    expect(width()).toBe(SIDEBAR_MAX_WIDTH)
    expect(unhandled).toBe(true) // not preventDefault()ed — someone else may want it

    fireEvent.keyUp(divider, { key: 'End' })
    expect(onCommit).toHaveBeenCalled()
  })
})
