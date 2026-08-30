import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetailSections } from '@/lib/ipc'

const detailSections = vi.fn<() => Promise<DetailSections>>()
const setDetailSection = vi.fn<(section: string, open: boolean) => Promise<boolean>>()

vi.mock('@/lib/ipc', () => ({
  detailSections: () => detailSections(),
  setDetailSection: (section: string, open: boolean) => setDetailSection(section, open),
}))

const { DETAIL_SECTION_DEFAULTS, useDetailSections } = await import('./useDetailSections')

/** Render the hook and let the mount read settle. */
async function mounted() {
  const view = renderHook(() => useDetailSections())
  await act(async () => {})
  return view
}

beforeEach(() => {
  detailSections.mockReset()
  detailSections.mockResolvedValue(DETAIL_SECTION_DEFAULTS)
  setDetailSection.mockReset()
  setDetailSection.mockImplementation((_section, open) => Promise.resolve(open))
})

describe('useDetailSections', () => {
  it('opens at the stored preference', async () => {
    detailSections.mockResolvedValue({ whatToRun: false, whenToRun: true, howToRun: true })
    const { result } = await mounted()

    expect(result.current.sections).toEqual({ whatToRun: false, whenToRun: true, howToRun: true })
  })

  it('stands on the defaults when there is no bridge', async () => {
    detailSections.mockRejectedValue(new Error('no tauri'))
    const { result } = await mounted()

    expect(result.current.sections).toEqual(DETAIL_SECTION_DEFAULTS)
  })

  it('applies a toggle at once and persists it', async () => {
    const { result } = await mounted()

    act(() => result.current.toggle('howToRun', true))

    expect(result.current.sections.howToRun).toBe(true)
    expect(setDetailSection).toHaveBeenCalledExactlyOnceWith('howToRun', true)
  })

  it('keeps a toggle even when the write fails', async () => {
    setDetailSection.mockRejectedValue(new Error('file locked'))
    const { result } = await mounted()

    act(() => result.current.toggle('whatToRun', false))
    await act(async () => {})

    expect(result.current.sections.whatToRun).toBe(false)
  })

  it('does not let a slow read land on top of a toggle already made', async () => {
    let resolve!: (sections: DetailSections) => void
    detailSections.mockReturnValue(new Promise((r) => (resolve = r)))
    const { result } = await mounted()

    act(() => result.current.toggle('howToRun', true))
    resolve({ whatToRun: true, whenToRun: true, howToRun: false })
    await act(async () => {})

    expect(result.current.sections.howToRun).toBe(true)
  })
})
