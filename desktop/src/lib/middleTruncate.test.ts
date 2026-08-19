import { describe, expect, it, vi } from 'vitest'
import { ELLIPSIS, middleTruncate } from './middleTruncate'

/** A measurement that counts characters — every glyph one unit wide. */
const within = (limit: number) => (candidate: string) => candidate.length <= limit

const PATH = 'C:/Program Files/Derivative/TouchDesigner.2025.32820/bin/TouchDesigner.exe'

describe('middleTruncate', () => {
  it('leaves a value that already fits exactly as it is', () => {
    expect(middleTruncate(PATH, within(PATH.length))).toBe(PATH)
    expect(middleTruncate(PATH, () => true)).toBe(PATH)
    expect(middleTruncate('', within(0))).toBe('')
  })

  it('keeps the drive and as many trailing segments as fit', () => {
    // The version directory is the part that says *which* touchdesigner this
    // is; "Program Files" is a given on every machine in the fleet.
    expect(middleTruncate(PATH, within(52))).toBe(
      `C:/${ELLIPSIS}/TouchDesigner.2025.32820/bin/TouchDesigner.exe`,
    )
  })

  it('gives up whole segments, from the front', () => {
    expect(middleTruncate(PATH, within(28))).toBe(`C:/${ELLIPSIS}/bin/TouchDesigner.exe`)
    expect(middleTruncate(PATH, within(23))).toBe(`C:/${ELLIPSIS}/TouchDesigner.exe`)
    // Never mid-segment while a whole-segment cut still fits.
    expect(middleTruncate(PATH, within(40)).split('/').slice(2)).toEqual([
      'bin',
      'TouchDesigner.exe',
    ])
  })

  it('drops the drive before it drops a segment', () => {
    // 20 characters: not enough for `C:/…/TouchDesigner.exe`, enough without.
    expect(middleTruncate(PATH, within(20))).toBe(`${ELLIPSIS}/TouchDesigner.exe`)
  })

  it('keeps the end of a file name that is too long for the box', () => {
    // The extension is the last thing worth losing.
    const shortened = middleTruncate(PATH, within(10))

    expect(shortened).toBe(`${ELLIPSIS}igner.exe`)
    expect(shortened.length).toBe(10)
    expect(PATH.endsWith(shortened.slice(1))).toBe(true)
  })

  it('handles backslashes, the spelling windows itself writes', () => {
    const windows = 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe'

    expect(middleTruncate(windows, within(30))).toBe(`C:\\${ELLIPSIS}\\bin\\TouchDesigner.exe`)
  })

  it('keeps the share of a unc path, which is the machine it names', () => {
    const unc = '\\\\media-01\\shows\\2026\\cathedral\\bin\\player.exe'
    const shortened = middleTruncate(unc, within(32))

    // The host and the share are the two parts that say which machine this is.
    expect(shortened.startsWith('\\\\media-01\\shows\\')).toBe(true)
    expect(shortened).toContain(ELLIPSIS)
    expect(shortened.endsWith('\\player.exe')).toBe(true)
  })

  it('trims from the front when there is no separator at all', () => {
    // `file_path` holds command-line arguments as often as it holds a file.
    const args = '--fullscreen --monitor 2 --project cathedral'
    const shortened = middleTruncate(args, within(20))

    expect(shortened).toBe(`${ELLIPSIS}${args.slice(args.length - 19)}`)
    expect(shortened.endsWith('cathedral')).toBe(true)
  })

  it('degrades to the ellipsis alone rather than overflowing', () => {
    expect(middleTruncate(PATH, within(1))).toBe(ELLIPSIS)
    expect(middleTruncate(PATH, () => false)).toBe(ELLIPSIS)
  })

  it('measures a long path a handful of times, not once per segment', () => {
    const fits = vi.fn(within(40))
    middleTruncate(PATH, fits)

    // The whole value, then a binary search over five cut points.
    expect(fits.mock.calls.length).toBeLessThan(8)
  })
})
