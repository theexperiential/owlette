import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessList } from '@/components/ProcessList'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetExeIconCache } from '@/hooks/useExeIcon'
import type { ProcessEntry } from '@/lib/owletteConfig'
import type { AppStates } from '@/lib/processStatus'
import { isRowDragging } from '@/lib/rowDrag'

/** Only TouchDesigner has an icon here; the other two exercise the fallback. */
const exeIcon = vi.fn(async (path: string) =>
  path.toLowerCase().includes('touchdesigner') ? 'data:image/png;base64,TOUCH' : null,
)

vi.mock('@/lib/ipc', () => ({
  exeIcon: (path: string) => exeIcon(path),
}))

const processes: ProcessEntry[] = [
  { id: 'a', name: 'touch', exe_path: 'C:/Program Files/Derivative/bin/TouchDesigner.exe' },
  { id: 'b', name: 'node.js', exe_path: 'C:/tools/node.exe' },
  { id: 'c', name: '' },
]

const states: AppStates = {
  '100': { id: 'a', status: 'RUNNING', timestamp: 10 },
  '200': { id: 'b', status: 'LAUNCH_FAILED', timestamp: 20 },
}

function setup(
  selectedId: string | null = null,
  entries = processes,
  options: { dragOver?: boolean; collapsed?: boolean } = {},
) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onAction: vi.fn(),
    onReorder: vi.fn(),
    onCollapsedChange: vi.fn(),
  }

  render(
    <TooltipProvider>
      <ProcessList
        processes={entries}
        states={states}
        selectedId={selectedId}
        dragOver={options.dragOver}
        collapsed={options.collapsed}
        {...handlers}
      />
    </TooltipProvider>,
  )

  return handlers
}

beforeEach(() => {
  // The icon cache is module-level, so one test's answers would otherwise be
  // the next one's first paint.
  resetExeIconCache()
  exeIcon.mockClear()
})

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
    expect(screen.getByTestId('process-list-empty').textContent).toMatch(/drag an app/)
  })

  it('lights up the empty state while a file is over the window', () => {
    setup(null, [], { dragOver: true })

    expect(screen.getByTestId('process-list-empty').dataset.dragOver).toBe('true')
  })

  it('keeps whispering the drop gesture once there are rows to list', () => {
    setup()

    // The empty state is where an operator learns that a dropped file becomes a
    // process; with rows on screen that lesson has nowhere else to live.
    const hint = screen.getByTestId('process-list-drop-hint')
    expect(hint.textContent).toMatch(/drop an app or script here to add it/)
    // Inert on purpose: a drop target, a reorder drag and a context menu all
    // live in this column already.
    expect(hint.className).toContain('pointer-events-none')
    expect(hint.className).toContain('text-sm')
    // It floats in the room the rows leave: outside the `ul` (so it is not part
    // of the reorder surface) in a region that takes the leftover height.
    expect(hint.closest('ul')).toBeNull()
    const region = hint.parentElement
    expect(region?.className).toContain('flex-1')
    expect(region?.className).toContain('items-center')
    expect(region?.className).toContain('justify-center')
    expect(region?.previousElementSibling?.tagName).toBe('UL')
    expect(region?.parentElement?.className).toContain('min-h-full')
  })

  it('leaves the hint to the empty state when there is nothing to list', () => {
    setup(null, [])

    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
  })
})

describe('exe icons', () => {
  it('asks the host once per entry that has an exe', async () => {
    setup()

    // The nameless third entry has no exe to ask about.
    expect(exeIcon.mock.calls.map(([path]) => path)).toEqual([
      'C:/Program Files/Derivative/bin/TouchDesigner.exe',
      'C:/tools/node.exe',
    ])

    const icons = await screen.findAllByTestId('process-icon')
    expect(icons).toHaveLength(1)
    expect(icons[0].getAttribute('src')).toBe('data:image/png;base64,TOUCH')
  })

  it('draws the fallback glyph for an entry with no icon, in the same box', async () => {
    setup()
    await screen.findAllByTestId('process-icon')

    const fallbacks = screen.getAllByTestId('process-icon-fallback')
    // node.exe answered null, and the nameless entry has no exe at all.
    expect(fallbacks).toHaveLength(2)
    // Same box as the image it stands in for, so an icon arriving late moves
    // nothing beside it.
    expect(fallbacks[0].getAttribute('class')).toContain('size-4')
    expect(screen.getAllByTestId('process-icon')[0].getAttribute('class')).toContain('size-4')
  })

  it('puts the icon between the status dot and the name', async () => {
    setup()
    const icon = (await screen.findAllByTestId('process-icon'))[0]

    const row = icon.closest('[data-testid="process-row"]')
    const children = [...(row?.children ?? [])]
    expect(children.indexOf(icon)).toBe(2) // grip, dot, icon, name
    expect(children[3]?.textContent).toBe('touch')
  })

  it('shares one host call between rows pointing at the same exe', async () => {
    setup(null, [
      { id: 'a', name: 'one', exe_path: 'C:/tools/node.exe' },
      { id: 'b', name: 'two', exe_path: 'C:/tools/node.exe' },
    ])
    await screen.findAllByTestId('process-icon-fallback')

    expect(exeIcon).toHaveBeenCalledTimes(1)
  })
})

describe('the collapsed rail', () => {
  it('keeps the add button and drops the heading', () => {
    setup(null, processes, { collapsed: true })

    expect(screen.getByTestId('process-list').dataset.collapsed).toBe('true')
    expect(screen.getByRole('button', { name: 'add process' })).toBeTruthy()
    expect(screen.queryByText('processes')).toBeNull()
  })

  it('shows one icon per entry, with the status dot in its corner', async () => {
    setup(null, processes, { collapsed: true })
    await screen.findAllByTestId('process-icon')

    const dots = screen.getAllByTestId('rail-status-dot')
    expect(dots).toHaveLength(3)
    // Same statuses as the expanded list draws, in the same colours.
    expect(dots[0].className).toContain('bg-green-500')
    expect(dots[1].className).toContain('bg-red-500')
    expect(dots[0].className).toContain('absolute')
  })

  it('names each row, since the rail has nowhere to print one', () => {
    setup(null, processes, { collapsed: true })

    expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual([
      'touch',
      'node.js',
      'untitled process',
    ])
  })

  it('still selects, reorders and opens the context menu', () => {
    const { onSelect, onReorder } = setup(null, processes, { collapsed: true })

    fireEvent.click(rows()[1])
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b')

    dragRow(0, 110)
    expect(onReorder).toHaveBeenCalledExactlyOnceWith('a', 2)

    fireEvent.contextMenu(rows()[2])
    expect(screen.getByRole('menuitem', { name: 'delete' })).toBeTruthy()
  })

  it('drops the copy that has nowhere to go at 48 px', () => {
    setup(null, processes, { collapsed: true })

    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
  })

  it('says nothing at all when an empty list is collapsed', () => {
    setup(null, [], { collapsed: true })

    expect(screen.queryByTestId('process-list-empty')).toBeNull()
    expect(screen.queryByTestId('process-list-drop-hint')).toBeNull()
    expect(screen.getByRole('button', { name: 'add process' })).toBeTruthy()
  })

  it('offers a way back out, pinned below the icons', () => {
    const { onCollapsedChange } = setup(null, processes, { collapsed: true })

    const expand = screen.getByTestId('expand-sidebar')
    expect(expand.getAttribute('aria-label')).toBe('expand the process list')
    fireEvent.click(expand)

    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(false)
    // The rail has no collapse control — it is already collapsed.
    expect(screen.queryByTestId('collapse-sidebar')).toBeNull()
  })
})

describe('the collapse toggle', () => {
  /** The row the toggle lives in: the last child of the list column. */
  function footer() {
    const list = screen.getByTestId('process-list')
    return list.lastElementChild as HTMLElement
  }

  it('sits at the bottom of the column, right-aligned while expanded', () => {
    const { onCollapsedChange } = setup()

    const collapse = screen.getByTestId('collapse-sidebar')
    expect(collapse.getAttribute('aria-label')).toBe('collapse the process list')
    // Below the list, not in the header beside `+`.
    expect(footer().contains(collapse)).toBe(true)
    expect(footer().className).toContain('justify-end')
    expect(screen.getByRole('button', { name: 'add process' }).closest('header')).toBeTruthy()

    fireEvent.click(collapse)
    expect(onCollapsedChange).toHaveBeenCalledExactlyOnceWith(true)
    expect(screen.queryByTestId('expand-sidebar')).toBeNull()
  })

  it('sits in the same corner of the rail, which at 48 px is the middle', () => {
    setup(null, processes, { collapsed: true })

    expect(footer().contains(screen.getByTestId('expand-sidebar'))).toBe(true)
    expect(footer().className).toContain('justify-center')
  })

  it('is left out entirely when the caller does not offer collapsing', () => {
    render(
      <TooltipProvider>
        <ProcessList
          processes={processes}
          states={states}
          selectedId={null}
          onSelect={vi.fn()}
          onAdd={vi.fn()}
          onAction={vi.fn()}
          onReorder={vi.fn()}
        />
      </TooltipProvider>,
    )

    expect(screen.queryByTestId('collapse-sidebar')).toBeNull()
    expect(screen.queryByTestId('expand-sidebar')).toBeNull()
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
