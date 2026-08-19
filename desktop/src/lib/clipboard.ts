/**
 * Copying a short string to the clipboard.
 *
 * The webview is served from `http://tauri.localhost`, which Chromium treats as
 * a potentially-trustworthy origin, so the async Clipboard API is available and
 * no clipboard plugin is needed. The `execCommand` fallback covers the case
 * where the document is not focused — a click on our own button always is, but a
 * copy triggered from a keyboard shortcut while the window is behind another one
 * is not, and silently failing there would look like the button did nothing.
 *
 * The legacy flow copied the pairing phrase from python
 * (`configure_site._copy_to_clipboard`, via win32clipboard). That path is
 * switched off for the desktop app — a background subprocess taking the
 * operator's clipboard without them asking is the wrong default — so this is the
 * only thing that writes to it, and only on an explicit click.
 */

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const scratch = document.createElement('textarea')
    scratch.value = text
    // Off-screen rather than hidden: `execCommand('copy')` needs a selectable,
    // rendered node.
    scratch.setAttribute('readonly', '')
    scratch.style.position = 'fixed'
    scratch.style.top = '-1000px'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)
    scratch.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(scratch)
    return copied
  } catch {
    return false
  }
}
