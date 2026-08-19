import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PathInput } from '@/components/PathInput'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ELLIPSIS } from '@/lib/middleTruncate'

/**
 * jsdom lays nothing out and has no canvas, so both halves of the measurement
 * are faked: a fixed content box, and a font where every character is 8 px.
 * That is all the component asks the platform for.
 */
const CHARACTER_PX = 8

function stubMeasurement(contentWidth: number) {
  Object.defineProperty(HTMLInputElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => contentWidth,
  })
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () =>
      ({
        font: '',
        measureText: (text: string) => ({ width: text.length * CHARACTER_PX }),
      }) as unknown as CanvasRenderingContext2D,
  ) as unknown as HTMLCanvasElement['getContext']
}

/** No layout at all — what a plain `render()` gives, and what a first paint is. */
function stubNoLayout() {
  Object.defineProperty(HTMLInputElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 0,
  })
}

const PATH = 'C:/Program Files/Derivative/TouchDesigner.2023/bin/TouchDesigner.exe'

function setup(value = PATH) {
  const view = render(
    <TooltipProvider>
      <PathInput aria-label="exe" className="font-mono text-xs" value={value} onChange={() => {}} />
    </TooltipProvider>,
  )
  return {
    input: screen.getByLabelText('exe') as HTMLInputElement,
    rerender: (next: string) =>
      view.rerender(
        <TooltipProvider>
          <PathInput
            aria-label="exe"
            className="font-mono text-xs"
            value={next}
            onChange={() => {}}
          />
        </TooltipProvider>,
      ),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('PathInput', () => {
  it('holds the whole path whatever it shows', () => {
    // 30 characters of room for a 71-character path.
    stubMeasurement(30 * CHARACTER_PX)
    const { input } = setup()

    expect(screen.getByTestId('path-overlay').textContent).toContain(ELLIPSIS)
    // The one thing that must never change: an input cannot show one string and
    // hold another, or the next keystroke saves the lie.
    expect(input.value).toBe(PATH)
  })

  it('keeps the drive and the end of the path in what it draws', () => {
    stubMeasurement(30 * CHARACTER_PX)
    setup()

    const shown = screen.getByTestId('path-overlay').textContent ?? ''
    expect(shown.startsWith('C:/')).toBe(true)
    expect(shown.endsWith('/bin/TouchDesigner.exe')).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(30)
  })

  it('paints nothing over a path that fits', () => {
    stubMeasurement(200 * CHARACTER_PX)
    const { input } = setup()

    expect(screen.queryByTestId('path-overlay')).toBeNull()
    expect(input.className).not.toContain('text-transparent')
  })

  it('gets out of the way while the field is being edited', () => {
    stubMeasurement(30 * CHARACTER_PX)
    const { input } = setup()

    fireEvent.focus(input)
    expect(screen.queryByTestId('path-overlay')).toBeNull()
    // Real text, real colour: the field edits exactly as it always did.
    expect(input.className).not.toContain('text-transparent')
    expect(input.value).toBe(PATH)

    fireEvent.blur(input)
    expect(screen.getByTestId('path-overlay')).toBeTruthy()
    expect(input.className).toContain('text-transparent')
  })

  it('re-measures when the value changes', () => {
    stubMeasurement(30 * CHARACTER_PX)
    const { rerender } = setup()

    rerender('C:/short.exe')
    expect(screen.queryByTestId('path-overlay')).toBeNull()

    rerender(PATH)
    expect(screen.getByTestId('path-overlay')).toBeTruthy()
  })

  it('shows the value untouched when nothing can be measured', () => {
    // No layout: a first paint, or a test renderer. Truncating on a guess would
    // hide characters that fit perfectly well.
    stubNoLayout()
    const { input } = setup()

    expect(screen.queryByTestId('path-overlay')).toBeNull()
    expect(input.value).toBe(PATH)
  })

  /**
   * The tooltip is deliberately uncontrolled — Radix decides when it is up, and
   * the only thing this component decides is whether there is anything to show.
   * That is what these assert: the *gate*, which is the part that is ours.
   * Radix's hover timing has no meaning in jsdom (no layout, no real pointer),
   * so how long it stays up is verified live instead.
   */
  it('arms the tooltip when the value does not fit its box', () => {
    stubNoLayout()
    const { input } = setup()
    // Overflow is the input's own measurement, independent of the truncation.
    Object.defineProperty(input, 'scrollWidth', { configurable: true, get: () => 900 })
    const wrapper = input.parentElement as HTMLElement

    expect(wrapper.dataset.overflowing).toBeUndefined()
    fireEvent.pointerEnter(wrapper)
    expect(wrapper.dataset.overflowing).toBe('true')
  })

  it('does not arm it for a path that fits', () => {
    stubNoLayout()
    const { input } = setup('C:/short.exe')
    Object.defineProperty(input, 'scrollWidth', { configurable: true, get: () => 0 })
    const wrapper = input.parentElement as HTMLElement

    fireEvent.pointerEnter(wrapper)

    expect(wrapper.dataset.overflowing).toBeUndefined()
    // Nothing to show means nothing can be shown, whatever radix decides.
    expect(screen.queryAllByText('C:/short.exe')).toHaveLength(0)
  })

  it('disarms it while the field is being typed in', () => {
    stubNoLayout()
    const { input } = setup()
    Object.defineProperty(input, 'scrollWidth', { configurable: true, get: () => 900 })
    const wrapper = input.parentElement as HTMLElement

    fireEvent.pointerEnter(wrapper)
    expect(wrapper.dataset.overflowing).toBe('true')

    // Radix opens tooltips on focus as well as on hover; with no content there
    // is nothing to pop over the cursor.
    fireEvent.focus(input)
    expect(wrapper.dataset.overflowing).toBeUndefined()

    // …and the next hover measures again.
    fireEvent.blur(input)
    fireEvent.pointerEnter(wrapper)
    expect(wrapper.dataset.overflowing).toBe('true')
  })
})
