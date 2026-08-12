/**
 * Drag-and-drop classification: dropped paths in, owlette process entries out.
 *
 * The module is deliberately inert — zero imports, no module-level state, and
 * the only contact with the disk is the injected {@link FsProbe}. The whole
 * rule matrix is therefore unit-testable without Tauri, and the rules that run
 * in a test are byte-for-byte the ones that run on a kiosk.
 *
 * The draft it produces mirrors the python service's on-disk schema exactly
 * (`agent/src/owlette_gui.py:1043-1057`). Numeric fields are STRINGS: that is
 * what every entry already in `config.json` looks like, and the service coerces
 * with `int()`/`float()` when it reads them (`owlette_service.py:2097,:2271`).
 * Emitting real numbers here would parse fine but make our entries the odd ones
 * out in a file two other writers (the GUI and the Firestore sync) also touch.
 */

/** CPU priority, spelled the way the service's map expects it. */
export type ProcessPriority = 'Low' | 'Normal' | 'High' | 'Realtime'

/** Window visibility. `Show`/`Hide` are the legacy spellings — do not emit them. */
export type ProcessVisibility = 'Normal' | 'Hidden'

/** Supervision mode. A dropped process starts `off` so nothing launches unasked. */
export type LaunchMode = 'off' | 'always' | 'scheduled'

/** A `processes[]` entry minus the `id`, which the caller mints on confirm. */
export interface ProcessEntryDraft {
  name: string
  exe_path: string
  /** A document opened by `exe_path` — never CLI arguments, see below. */
  file_path: string
  cwd: string
  priority: ProcessPriority
  visibility: ProcessVisibility
  time_delay: string
  time_to_init: string
  relaunch_attempts: string
  launch_mode: LaunchMode
  autolaunch: boolean
  schedules: null
}

/** A full `processes[]` entry, ready to append to `config.json`. */
export interface ProcessEntry extends ProcessEntryDraft {
  id: string
}

/**
 * Fields the classifier could not derive and the confirm card must prompt for.
 *
 * Only `exe_path` today: every rule can derive a name, a cwd and a file
 * argument from the drop itself, but the interpreter or host application may
 * simply not be installed on this machine.
 */
export type NeedsInput = 'exe_path'

/** What a dropped path turned out to be. */
export type DropKind = 'touchdesigner' | 'unity' | 'executable' | 'script'

export interface ClassifiedDrop {
  kind: DropKind
  /** The path as dropped. */
  path: string
  entry: ProcessEntryDraft
  needsInput: NeedsInput[]
  /** Lowercase, user-facing notes for the confirm card. Usually empty. */
  warnings: string[]
}

export interface UnsupportedDrop {
  kind: 'unsupported'
  path: string
  /** Lowercase, user-facing explanation for the toast. */
  reason: string
}

export type DropResult = ClassifiedDrop | UnsupportedDrop

/**
 * Values every dropped entry starts with.
 *
 * `relaunch_attempts` is 3 rather than the python GUI's 5: a drop is a fresh,
 * unproven process, and three failed launches is enough to stop hammering it.
 * `launch_mode: 'off'` (with the matching `autolaunch: false`) means dropping a
 * file configures it without starting it — the operator opts in afterwards.
 */
export const DROP_DEFAULTS = {
  priority: 'Normal',
  visibility: 'Normal',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '3',
  launch_mode: 'off',
  autolaunch: false,
  schedules: null,
} as const satisfies Omit<ProcessEntryDraft, 'name' | 'exe_path' | 'file_path' | 'cwd'>

export interface ClassifyOptions {
  /** Where Derivative installs; one sub-directory per TouchDesigner version. */
  touchDesignerRoot?: string
  /** Interpreters tried in order for a `.py`; the first that exists wins. */
  pythonCandidates?: string[]
  /** Scanned for `Python*` install directories when no candidate above exists. */
  pythonInstallRoot?: string
  /** Interpreters tried in order for a `.ps1`. */
  powershellCandidates?: string[]
}

/**
 * Stock Windows locations. Overridable so tests never touch the real disk and
 * so the caller can prepend per-user installs (`%LOCALAPPDATA%\Programs\…`),
 * which this module cannot expand on its own.
 */
export const DEFAULT_CLASSIFY_OPTIONS: Required<ClassifyOptions> = {
  touchDesignerRoot: 'C:\\Program Files\\Derivative',
  // py.exe is the PEP 397 launcher: it honours a script's shebang and falls
  // back to the newest installed interpreter, so it beats any python.exe we
  // could pick ourselves.
  pythonCandidates: ['C:\\Windows\\py.exe'],
  pythonInstallRoot: 'C:\\Program Files',
  powershellCandidates: [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ],
}

/** Everything the classifier needs to know about the disk. */
export interface FsProbe {
  /** True when anything — file or directory — exists at `path`. */
  exists(path: string): Promise<boolean>
  /** True when `path` exists and is a directory. */
  isDir(path: string): Promise<boolean>
  /** Entry NAMES (not full paths) directly inside `path`. */
  listDir(path: string): Promise<string[]>
}

/** Suffix Unity gives the data folder beside its player executable. */
const UNITY_DATA_SUFFIX = '_Data'

/** Fallback for the rare name that trims to nothing, so no entry is nameless. */
const FALLBACK_NAME = 'untitled'

/**
 * Shown when a `.ps1` lives under a path with spaces in it.
 *
 * The script has to travel in `file_path` (see {@link classifyPowerShellScript}),
 * and powershell strips the quotes the launcher adds, then reads the spaced path
 * as a command plus arguments — verified against the real powershell.exe.
 */
const POWERSHELL_SPACED_PATH_WARNING =
  'powershell mishandles a script path containing spaces — move the script somewhere without spaces, or check the launch'

/**
 * Classify a set of dropped paths into process entries.
 *
 * Paths are classified concurrently and returned in the order they were
 * dropped. Probes shared between paths — "where is TouchDesigner?" — run once
 * per call: the resolver memoises the promise, not the result, so two `.toe`
 * files dropped together share a single directory scan.
 *
 * A path whose probes throw becomes an `unsupported` result rather than
 * rejecting the batch; one unreadable file must not lose the other nine.
 */
export function classifyDrop(
  paths: string[],
  fs: FsProbe,
  options: ClassifyOptions = {},
): Promise<DropResult[]> {
  const resolved: Required<ClassifyOptions> = { ...DEFAULT_CLASSIFY_OPTIONS, ...options }
  const resolver = createResolver(fs, resolved)

  return Promise.all(
    paths.map(async (path) => {
      try {
        return await classifyOne(path, fs, resolver)
      } catch (error) {
        return unsupported(path, `could not read this path (${messageOf(error)})`)
      }
    }),
  )
}

/** Attach a freshly minted id, keeping the service's field order. */
export function toProcessEntry(draft: ProcessEntryDraft, id: string): ProcessEntry {
  return { id, ...draft }
}

async function classifyOne(path: string, fs: FsProbe, resolver: Resolver): Promise<DropResult> {
  if (!(await fs.exists(path))) return unsupported(path, 'this path no longer exists')
  if (await fs.isDir(path)) return classifyDirectory(path, fs)

  switch (extname(path)) {
    case '.toe':
      return classifyTouchDesignerProject(path, resolver)
    case '.exe':
      return classifyExecutable(path, fs)
    case '.bat':
    case '.cmd':
      return classifyBatchScript(path)
    case '.py':
      return classifyPythonScript(path, resolver)
    case '.ps1':
      return classifyPowerShellScript(path, resolver)
    default:
      return unsupported(path, unsupportedFileReason(path))
  }
}

/**
 * A dropped folder is only useful if it is a Unity player build: an executable
 * sitting beside the `<name>_Data` folder Unity generates for it.
 */
async function classifyDirectory(path: string, fs: FsProbe): Promise<DropResult> {
  const unity = await findUnityPlayer(path, fs)
  if (!unity) {
    return unsupported(
      path,
      'this folder is not a unity build (no <name>.exe beside a <name>_Data folder)',
    )
  }

  return {
    kind: 'unity',
    path,
    entry: draft({
      name: lowerName(unity.stem),
      exe_path: unity.exePath,
      file_path: '',
      // Trailing separator dropped: this string ends up in the config as the
      // working directory, and `C:\builds\Kiosk\` reads as a typo next to the
      // entries the service writes.
      cwd: trimTrailing(path),
    }),
    needsInput: [],
    warnings: [],
  }
}

/**
 * TouchDesigner opens a project as `TouchDesigner.exe <file.toe>`; the cwd is
 * the project's own folder so its relative asset paths resolve the same way
 * they do when an operator double-clicks the file.
 */
async function classifyTouchDesignerProject(path: string, resolver: Resolver): Promise<DropResult> {
  const exePath = await resolver.touchDesigner()

  return {
    kind: 'touchdesigner',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: exePath ?? '',
      file_path: path,
      cwd: dirname(path),
    }),
    needsInput: exePath ? [] : ['exe_path'],
    warnings: [],
  }
}

/**
 * A bare executable. If it turns out to be a Unity player — dropped directly
 * rather than by its folder — say so, so the confirm card can label it
 * correctly; the entry itself is identical either way.
 */
async function classifyExecutable(path: string, fs: FsProbe): Promise<DropResult> {
  const directory = dirname(path)
  const isUnityPlayer = await fs.isDir(join(directory, `${stem(path)}${UNITY_DATA_SUFFIX}`))

  return {
    kind: isUnityPlayer ? 'unity' : 'executable',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: path,
      file_path: '',
      cwd: directory,
    }),
    needsInput: [],
    warnings: [],
  }
}

/**
 * `.bat`/`.cmd` go in as the executable, not as an argument to cmd.exe: the
 * launcher already knows a batch file cannot go through CreateProcess and
 * wraps it itself (`agent/src/process_launcher.py:170-174`). Routing it
 * through cmd.exe here would put `/c "<script>"` in `file_path`, which the
 * service runs through `os.path.abspath()` and mangles into a bogus path
 * (`owlette_service.py:1902-1910` → `_validate_path`).
 */
function classifyBatchScript(path: string): DropResult {
  return {
    kind: 'script',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: path,
      file_path: '',
      cwd: dirname(path),
    }),
    needsInput: [],
    warnings: [],
  }
}

/** `py.exe "<script>"` — the launcher quotes an existing file for us. */
async function classifyPythonScript(path: string, resolver: Resolver): Promise<DropResult> {
  const exePath = await resolver.python()

  return {
    kind: 'script',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: exePath ?? '',
      file_path: path,
      cwd: dirname(path),
    }),
    needsInput: exePath ? [] : ['exe_path'],
    warnings: [],
  }
}

/**
 * `powershell.exe "<script>"`, for the same reason as python: the script goes
 * in `file_path` because anything that is not an existing file there gets
 * rewritten by the service's path validator, which rules out the `-File` form.
 * That costs one edge case, which is warned about rather than left to fail
 * silently at 2 am — see {@link POWERSHELL_SPACED_PATH_WARNING}.
 */
async function classifyPowerShellScript(path: string, resolver: Resolver): Promise<DropResult> {
  const exePath = await resolver.powershell()

  return {
    kind: 'script',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: exePath ?? '',
      file_path: path,
      cwd: dirname(path),
    }),
    needsInput: exePath ? [] : ['exe_path'],
    warnings: /\s/.test(path) ? [POWERSHELL_SPACED_PATH_WARNING] : [],
  }
}

interface UnityPlayer {
  exePath: string
  stem: string
}

/**
 * Find the player executable in a Unity build folder.
 *
 * The `_Data` folder is the anchor, not the exe: a build ships several
 * executables (`UnityCrashHandler64.exe`, launchers, installers) but exactly
 * one of them is named after a `_Data` folder. When a folder somehow holds
 * more than one such pair, the one named after the folder itself wins.
 */
async function findUnityPlayer(directory: string, fs: FsProbe): Promise<UnityPlayer | null> {
  const entries = await fs.listDir(directory)
  const executables = new Set(
    entries.filter((entry) => extname(entry) === '.exe').map((entry) => entry.toLowerCase()),
  )

  const candidates: UnityPlayer[] = []
  for (const entry of [...entries].sort(compareVersionNames)) {
    if (!entry.toLowerCase().endsWith(UNITY_DATA_SUFFIX.toLowerCase())) continue

    const base = entry.slice(0, -UNITY_DATA_SUFFIX.length)
    if (!base || !executables.has(`${base.toLowerCase()}.exe`)) continue

    const exePath = join(directory, `${base}.exe`)
    if (!(await fs.isDir(join(directory, entry)))) continue
    if (!(await isFile(fs, exePath))) continue

    candidates.push({ exePath, stem: base })
  }

  const folder = basename(directory).toLowerCase()
  const named = candidates.find((candidate) => candidate.stem.toLowerCase() === folder)
  return named ?? candidates[0] ?? null
}

interface Resolver {
  touchDesigner(): Promise<string | null>
  python(): Promise<string | null>
  powershell(): Promise<string | null>
}

/** Per-call lookups for the host applications, each probed at most once. */
function createResolver(fs: FsProbe, options: Required<ClassifyOptions>): Resolver {
  let touchDesigner: Promise<string | null> | undefined
  let python: Promise<string | null> | undefined
  let powershell: Promise<string | null> | undefined

  return {
    touchDesigner: () =>
      (touchDesigner ??= newestInstall(fs, options.touchDesignerRoot, 'TouchDesigner', [
        'bin',
        'TouchDesigner.exe',
      ])),
    python: () =>
      (python ??= firstExistingFile(fs, options.pythonCandidates).then(
        (found) => found ?? newestInstall(fs, options.pythonInstallRoot, 'Python', ['python.exe']),
      )),
    powershell: () => (powershell ??= firstExistingFile(fs, options.powershellCandidates)),
  }
}

/**
 * Newest `<prefix>*` install directory under `root` that actually contains
 * `<tail>` — a version directory left behind by an uninstall has the name but
 * not the executable, so the name alone proves nothing.
 */
async function newestInstall(
  fs: FsProbe,
  root: string,
  prefix: string,
  tail: string[],
): Promise<string | null> {
  if (!(await fs.isDir(root))) return null

  const entries = await fs.listDir(root)
  const versions = entries
    .filter((entry) => entry.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort(compareVersionNames)
    .reverse()

  for (const version of versions) {
    const candidate = join(root, version, ...tail)
    if (await isFile(fs, candidate)) return candidate
  }
  return null
}

async function firstExistingFile(fs: FsProbe, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(fs, candidate)) return candidate
  }
  return null
}

async function isFile(fs: FsProbe, path: string): Promise<boolean> {
  return (await fs.exists(path)) && !(await fs.isDir(path))
}

/**
 * Natural comparison of install directory names.
 *
 * Digit runs compare as numbers so `TouchDesigner.2025.9999` sorts BELOW
 * `TouchDesigner.2025.30060`, which a plain string sort gets backwards — and
 * picking the wrong build is exactly the failure this exists to prevent. A
 * name with no version at all (`TouchDesigner`) sorts oldest.
 */
export function compareVersionNames(a: string, b: string): number {
  const left = chunk(a)
  const right = chunk(b)

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1

    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }

    const xs = String(x).toLowerCase()
    const ys = String(y).toLowerCase()
    if (xs !== ys) return xs < ys ? -1 : 1
  }
  return 0
}

/** Split a name into alternating text and numeric runs. */
function chunk(value: string): Array<string | number> {
  return value
    .split(/(\d+)/)
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

type DerivedFields = Pick<ProcessEntryDraft, 'name' | 'exe_path' | 'file_path' | 'cwd'>

/** Everything a rule derives, wrapped in the defaults every entry shares. */
function draft(fields: DerivedFields): ProcessEntryDraft {
  return {
    name: fields.name,
    exe_path: fields.exe_path,
    file_path: fields.file_path,
    cwd: fields.cwd,
    ...DROP_DEFAULTS,
  }
}

function unsupported(path: string, reason: string): UnsupportedDrop {
  return { kind: 'unsupported', path, reason }
}

function unsupportedFileReason(path: string): string {
  const extension = extname(path)
  return extension
    ? `owlette does not know how to launch a ${extension} file`
    : 'owlette does not know how to launch a file with no extension'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Process names are lowercase like the rest of the UI. */
function lowerName(value: string): string {
  return value.trim().toLowerCase() || FALLBACK_NAME
}

/*
 * Path helpers. Windows accepts either separator and both turn up in the wild —
 * Tauri hands us backslashes, while entries written by the python GUI's file
 * dialog are full of forward slashes — so these read both and write back the
 * separator the input already used.
 */

function separatorOf(path: string): string {
  return !path.includes('\\') && path.includes('/') ? '/' : '\\'
}

function trimTrailing(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  // A drive root trims to `C:`, which no longer names a directory.
  return trimmed === '' ? path : trimmed
}

function basename(path: string): string {
  const trimmed = trimTrailing(path)
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

function dirname(path: string): string {
  const trimmed = trimTrailing(path)
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index === -1) return ''
  const parent = trimmed.slice(0, index)
  // `C:\app.exe` — keep the root's separator rather than returning a bare `C:`.
  return /^[a-z]:$/i.test(parent) ? parent + separatorOf(path) : parent
}

function extname(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

function stem(path: string): string {
  const name = basename(path)
  const extension = extname(path)
  return extension ? name.slice(0, -extension.length) : name
}

function join(base: string, ...parts: string[]): string {
  const separator = separatorOf(base)
  return [trimTrailing(base), ...parts].filter((segment) => segment !== '').join(separator)
}
