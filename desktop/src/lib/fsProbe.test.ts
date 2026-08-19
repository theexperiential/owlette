import { describe, expect, it, vi } from 'vitest'
import type { FsProbe } from './dropClassifier'

// The module reaches for the host at import time only through these two, and
// neither is called by the pure half under test here.
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  stat: vi.fn(),
}))
vi.mock('@tauri-apps/api/path', () => ({ localDataDir: vi.fn() }))

const { classifyOptionsFor } = await import('./fsProbe')

const LOCAL_APP_DATA = 'C:\\Users\\kiosk\\AppData\\Local'
const PYTHON_ROOT = `${LOCAL_APP_DATA}\\Programs\\Python`

/** An fs that knows about one directory and its entries. */
function makeFs(entries: Record<string, string[]>): FsProbe {
  return {
    exists: vi.fn(async () => true),
    isDir: vi.fn(async (path: string) => path in entries),
    listDir: vi.fn(async (path: string) => entries[path] ?? []),
  }
}

describe('per-user python', () => {
  it('offers py.exe first, wherever it lives', async () => {
    const options = await classifyOptionsFor(makeFs({}), LOCAL_APP_DATA)

    // The launcher honours a script's shebang; a specific interpreter cannot.
    expect(options.pythonCandidates?.slice(0, 2)).toEqual([
      'C:\\Windows\\py.exe',
      `${PYTHON_ROOT}\\Launcher\\py.exe`,
    ])
  })

  it('adds the newest per-user interpreter, newest first', async () => {
    const fs = makeFs({ [PYTHON_ROOT]: ['Python39', 'Python313', 'Python311', 'Launcher'] })

    const options = await classifyOptionsFor(fs, LOCAL_APP_DATA)

    // 313 above 39: a plain string sort puts "Python39" on top and picks an
    // interpreter four releases old.
    expect(options.pythonCandidates?.slice(2)).toEqual([
      `${PYTHON_ROOT}\\Python313\\python.exe`,
      `${PYTHON_ROOT}\\Python311\\python.exe`,
      `${PYTHON_ROOT}\\Python39\\python.exe`,
    ])
  })

  it('never proposes the launcher folder as an interpreter', async () => {
    const fs = makeFs({ [PYTHON_ROOT]: ['Launcher', 'Python312'] })

    const options = await classifyOptionsFor(fs, LOCAL_APP_DATA)

    expect(options.pythonCandidates).not.toContain(`${PYTHON_ROOT}\\Launcher\\python.exe`)
  })

  it('does not list a folder that is not there', async () => {
    const fs = makeFs({})

    await classifyOptionsFor(fs, LOCAL_APP_DATA)

    expect(fs.listDir).not.toHaveBeenCalled()
  })

  it('tolerates a data directory handed over with a trailing separator', async () => {
    const fs = makeFs({ [PYTHON_ROOT]: ['Python312'] })

    const options = await classifyOptionsFor(fs, `${LOCAL_APP_DATA}\\`)

    expect(options.pythonCandidates).toContain(`${PYTHON_ROOT}\\Python312\\python.exe`)
  })
})
