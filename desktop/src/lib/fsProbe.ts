/**
 * The real disk behind {@link FsProbe}, and the machine-specific search paths
 * the classifier cannot work out on its own.
 *
 * `@tauri-apps/plugin-fs` is scoped in `capabilities/default.json` to `exists`,
 * `readDir` and `stat` — metadata only. **Do not add a content permission for
 * this module.** Classification never needs to look inside a file: what a drop
 * is gets decided by its extension, its neighbours in the folder, and whether a
 * host application is installed. Keeping it that way means a dropped file can
 * be misread but never read.
 */

import { localDataDir } from '@tauri-apps/api/path'
import { exists, readDir, stat } from '@tauri-apps/plugin-fs'
import {
  compareVersionNames,
  DEFAULT_CLASSIFY_OPTIONS,
  type ClassifyOptions,
  type FsProbe,
} from '@/lib/dropClassifier'

/**
 * Metadata probes, with "no" as the answer to anything unreadable.
 *
 * A drop can name a path on a disconnected network share or one the service
 * account may see and this process may not; the classifier only ever asks yes/no
 * questions, so a failed probe is a "no" rather than a thrown batch. `listDir`
 * is the exception — a folder that cannot be listed cannot be told apart from a
 * folder with nothing in it, and calling an unreadable folder "not a unity
 * build" would be a guess. It throws, and `classifyDrop` turns that into an
 * unsupported result carrying the reason.
 */
export const tauriFsProbe: FsProbe = {
  async exists(path: string): Promise<boolean> {
    try {
      return await exists(path)
    } catch {
      return false
    }
  },

  async isDir(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory
    } catch {
      return false
    }
  },

  async listDir(path: string): Promise<string[]> {
    return (await readDir(path)).map((entry) => entry.name)
  },
}

/** Where python.org's per-user installer puts interpreters, under `%LOCALAPPDATA%`. */
const PER_USER_PYTHON_REL = ['Programs', 'Python']

/** Version directories there are `Python313`, `Python39`, … next to `Launcher`. */
const PYTHON_VERSION_DIR = /^python\d/i

/**
 * Classifier options for this machine.
 *
 * Only python needs the help. TouchDesigner and PowerShell install to fixed
 * places under `C:\Program Files` and `C:\Windows`, which the classifier's
 * defaults already cover, but python is routinely installed "for me only" — the
 * default in python.org's installer — which lands it under `%LOCALAPPDATA%`, a
 * path the classifier cannot expand because it has no environment of its own.
 *
 * Order matters: `py.exe` first wherever it is, because the launcher honours a
 * script's shebang, then the newest per-user interpreter. Whatever is passed
 * here *replaces* the default candidate list, so the default is spread back in
 * rather than assumed.
 */
export async function classifyOptionsFor(
  fs: FsProbe,
  localAppData: string,
): Promise<ClassifyOptions> {
  const root = joinPath(localAppData, ...PER_USER_PYTHON_REL)
  const candidates = [
    ...DEFAULT_CLASSIFY_OPTIONS.pythonCandidates,
    joinPath(root, 'Launcher', 'py.exe'),
  ]

  if (await fs.isDir(root)) {
    const versions = (await fs.listDir(root))
      .filter((entry) => PYTHON_VERSION_DIR.test(entry))
      .sort(compareVersionNames)
      .reverse()
    candidates.push(...versions.map((version) => joinPath(root, version, 'python.exe')))
  }

  return { pythonCandidates: candidates }
}

/**
 * {@link classifyOptionsFor} against the running machine.
 *
 * A failure to resolve `%LOCALAPPDATA%` or to list it is not worth failing a
 * drop over — the classifier falls back to its own defaults, and the confirm
 * card asks the operator for an interpreter if none of them exist.
 */
export async function classifyOptions(fs: FsProbe = tauriFsProbe): Promise<ClassifyOptions> {
  try {
    return await classifyOptionsFor(fs, await localDataDir())
  } catch {
    return {}
  }
}

/** Windows path join. Everything this module builds is an absolute local path. */
function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...parts].join('\\')
}
