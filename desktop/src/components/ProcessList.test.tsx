import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProcessList } from '@/components/ProcessList'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProcessEntry } from '@/lib/owletteConfig'
import type { AppStates } from '@/lib/processStatus'
import { isRowDragging } from '@/lib/rowDrag'

const processes: ProcessEntry[] = [
  { id: 'a', name: 'touch' },
  { id: 'b', name: 'node.js' },
  { id: 'c', name: '' },
]

const states: AppStates = {
  '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
  '200': { id: 'b', status: 'LAUNCH_FAILED', timestamp: 20 },
}

function setup(selectedId: string | null = null, entries = processes) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onAction: vi.fn(),
    onReorder: vi.fn(),
  }

  render(
    <TooltipProvider>
      <ProcessList processes={entries} states={states} selectedId={selectedId} {...handlers} />
    </TooltipProvider>,
  )

  return handlers
}

function rows() {
  return screen.getAllByTestId('process-row')
}

/**
 * jsdom lays nothing out and has no pointer capture, so the drag needs both
 * faked: 40 px rows stacked from the top, and a capture call that no-ops.
 */
const ROW_HEIGHT = 40
function stubGeometry() {
  rows().forEach((row, index) => {
    row.setPointerCapture = () => {}
    row.releasePointerCapture = () => {}
    row.getBoundingClientRect = () =>
      ({
        top: index * ROW_HEIGHT,
        bottom: (index + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 240,
        width: 240,
        x: 0,
        y: index * ROW_HEIGHT,
        toJSON: () => ({}),
      }) as DOMRect
  })
}

/**
 * jsdom has no `PointerEvent`, so testing-library builds a bare `Event` whose
 * `button` and `clientY` are undefined — useless for a drag. A `MouseEvent`
 * carries both, and the pointer id is the one property that has to be pinned on
 * by hand.
 */
function pointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  { clientY, button = 0, pointerId = 1 }: { clientY: number; button?: number; pointerId?: number },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientY })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  fireEvent(element, event)
}

/** Press on `from`, travel to `clientY`, release. */
function dragRow(from: number, clientY: number) {
  const row = rows()[from]
  stubGeometry()
  pointer(row, 'pointerdown', { clientY: from * ROW_HEIGHT + 20 })
  pointer(row, 'pointermove', { clientY })
  pointer(row, 'pointerup', { clientY })
}

afterEach(() => {
  // A test that leaves the flag set would lie to the next one.
  expect(isRowDragging()).toBe(false)
})

describe('process list', () => {
  it('joins each entry to the status the service published for it', () => {
    setup()

    expect(rows().map((row) => row.dataset.status)).toEqual([
      'RUNNING',
      'LAUNCH_FAILED',
      // Never launched — no entry in the service's table.
      'INACTIVE',
    ])
  })

  it('gives a nameless entry something to click on', () => {
    setup()

    expect(rows()[2].textContent).toBe('untitled process')
  })

  it('marks the selected entry', () => {
    setup('b')

    expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual([
      'false',
      'true',
      'false',
    ])
  })

  it('selects on click', () => {
    const { onSelect } = setup()

    fireEvent.click(rows()[1])

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('selects the entry that was right-clicked before opening its menu', () => {
    const { onSelect } = setup()

    fireEvent.contextMenu(rows()[1])

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('shows the drop-a-file directions when there is nothing to list', () => {
    setup(null, [])

    expect(screen.queryAllByTestId('process-row')).toHaveLength(0)
    expect(screen.getByTestId('process-list-empty').textContent).toMatch(/no processes yet/)
    expect(screen.getByTestId('process-list-empty').textContent).toMatch(/drag a script/)
  })
})

describe('drag to reorder', () => {
  it('commits one move when a row is dropped further down', () => {
    const { onReorder } = setup()

    // Past the last row's midpoint: the first row becomes the last.
    dragRow(0, 110)

    expect(onReorder).toHaveBeenCalledExactlyOnceWith('a', 2)
  })

  it('commits one move when a row is dropped further up', () => {
    const { onReorder } = setup()

    dragRow(2, 10)

    expect(onReorder).toHaveBeenCalledExactlyOnceWith('c', 0)
  })

  it('writes nothing when the row is dropped where it already was', () => {
    const { onReorder } = setup()

    dragRow(1, 55)

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('writes nothing for a press that never became a drag', () => {
    const { onReorder, onSelect } = setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 22 })
    pointer(row, 'pointerup', { clientY: 22 })
    fireEvent.click(row)

    expect(onReorder).not.toHaveBeenCalled()
    // …and the press still selects, which is what a click on a row means.
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('shows where the row would land, and lifts the one being dragged', () => {
    setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 110 })

    expect(screen.getByTestId('drop-indicator')).toBeTruthy()
    expect(rows()[0].dataset.dragging).toBe('true')
    // The file-drop overlay a later task adds must be able to tell this apart
    // from an OS drag.
    expect(isRowDragging()).toBe(true)
    expect(document.body.dataset.rowDragging).toBe('true')

    pointer(row, 'pointerup', { clientY: 110 })
    expect(screen.queryByTestId('drop-indicator')).toBeNull()
  })

  it('abandons the drag on escape', () => {
    const { onReorder } = setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 110 })
    fireEvent.keyDown(window, { key: 'Escape' })
    pointer(row, 'pointerup', { clientY: 110 })

    expect(onReorder).not.toHaveBeenCalled()
    expect(screen.queryByTestId('drop-indicator')).toBeNull()
  })

  it('ignores a right-button press, which belongs to the context menu', () => {
    const { onReorder } = setup()
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20, button: 2 })
    pointer(row, 'pointermove', { clientY: 110 })
    pointer(row, 'pointerup', { clientY: 110 })

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('has nothing to drag in a one-row list', () => {
    const { onReorder } = setup(null, [processes[0]])
    const row = rows()[0]
    stubGeometry()

    pointer(row, 'pointerdown', { clientY: 20 })
    pointer(row, 'pointermove', { clientY: 110 })
    pointer(row, 'pointerup', { clientY: 110 })

    expect(onReorder).not.toHaveBeenCalled()
  })
})
