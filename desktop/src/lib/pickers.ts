/**
 * Native file and folder pickers.
 *
 * `@tauri-apps/plugin-dialog` talks to the same Win32 common dialogs the legacy
 * GUI opened through tkinter, so an operator gets the shell they know — network
 * paths, recent places, typed UNC — instead of a webview file input.
 *
 * Wrapped here for the same reason `ipc.ts` wraps the commands: one place per
 * dialog, so the filters and default-path rules stay consistent and the call
 * sites stay readable.
 */

import { open } from '@tauri-apps/plugin-dialog'

/**
 * Where to open the picker.
 *
 * The current value is offered as the starting point; a value that no longer
 * exists on disk is dropped rather than passed on, because Windows opens the
 * dialog on the desktop when the default path is bad and that looks like a bug.
 */
function startingPoint(current: string | undefined): string | undefined {
  const value = current?.trim()
  return value ? value : undefined
}

async function pickOne(options: Parameters<typeof open>[0]): Promise<string | null> {
  const picked = await open(options)
  if (Array.isArray(picked)) return picked[0] ?? null
  return typeof picked === 'string' ? picked : null
}

/** The executable or script the service should launch. */
export function pickExecutable(current?: string): Promise<string | null> {
  return pickOne({
    title: 'select an executable or script',
    multiple: false,
    directory: false,
    defaultPath: startingPoint(current),
    filters: [
      { name: 'executables & scripts', extensions: ['exe', 'bat', 'cmd', 'com'] },
      { name: 'all files', extensions: ['*'] },
    ],
  })
}

/** A document to hand the executable — a `.toe` project, a playlist, anything. */
export function pickFile(current?: string): Promise<string | null> {
  return pickOne({
    title: 'select a file to open with this executable',
    multiple: false,
    directory: false,
    defaultPath: startingPoint(current),
  })
}

/** The working directory to launch in. */
export function pickDirectory(current?: string): Promise<string | null> {
  return pickOne({
    title: 'select a working directory',
    multiple: false,
    directory: true,
    defaultPath: startingPoint(current),
  })
}
