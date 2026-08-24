/**
 * Copy a short string to the clipboard.
 *
 * `http://tauri.localhost` counts as potentially-trustworthy in Chromium, so the
 * async Clipboard API works with no plugin. The `execCommand` fallback covers an
 * unfocused document — a keyboard-shortcut copy while the window is behind
 * another one, where silent failure looks like a dead button.
 *
 * The only thing in the app that writes the clipboard, and only on an explicit
 * click: the legacy python path is off because a background subprocess taking
 * the operator's clipboard unasked is the wrong default.
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
    // Off-screen, not hidden: execCommand('copy') needs a rendered, selectable node.
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
