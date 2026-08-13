//! Handing a path or a URL to the Windows shell.
//!
//! The overflow menu's `config`, `logs` and `docs` items are the same three the
//! legacy GUI offered (`owlette_gui.open_config` / `open_logs` / `_open_docs`,
//! :2476-2621), where each one was a bare `os.startfile` / `webbrowser.open`.
//! `ShellExecuteW` is the API underneath both, and it is already how this crate
//! elevates a service command (`service_ctl::elevated`), so it is used directly
//! rather than pulling in a plugin for two call sites.
//!
//! Two rules make this safe to expose over IPC:
//!
//! * A path is resolved against the owlette data root and rejected if it lands
//!   outside it — the same containment [`crate::paths::resolve_in_root`] gives
//!   the JSON commands. The menu can open `config.json`; it cannot open
//!   `C:\Windows\System32\cmd.exe`.
//! * A URL must be `http` or `https`. Without that check the shell would happily
//!   run any registered protocol handler, which is a launcher, not a link.

use std::path::Path;

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::paths;

/// `ShellExecuteW` returns an HINSTANCE; anything above 32 means it launched.
const SHELL_EXECUTE_SUCCESS_FLOOR: isize = 32;

/// `SE_ERR_NOASSOC` — nothing is registered for this file type. Common on a
/// bare Windows Server, where `.json` has no handler at all.
const SE_ERR_NOASSOC: isize = 31;

/// Schemes a frontend link may use.
const ALLOWED_SCHEMES: [&str; 2] = ["https://", "http://"];

/// Open a file or folder inside the owlette tree with its default handler.
///
/// `requested` is relative to the data root (`config/config.json`, `logs`).
/// A file type with no association falls back to Notepad rather than reporting
/// a failure the operator cannot act on.
pub fn open_in_tree(requested: &str) -> Result<(), String> {
  let resolved = paths::resolve_in_root(&paths::data_root(), requested)?;
  if !resolved.exists() {
    return Err(format!("{} does not exist", resolved.display()));
  }
  open_resolved(&resolved)
}

fn open_resolved(path: &Path) -> Result<(), String> {
  match execute(w!("open"), &HSTRING::from(path.as_os_str()), PCWSTR::null()) {
    Ok(()) => Ok(()),
    Err(SE_ERR_NOASSOC) if path.is_file() => open_in_notepad(path),
    Err(code) => Err(format!(
      "windows could not open {} ({code})",
      path.display()
    )),
  }
}

/// Last resort for a file type Windows has no handler for.
fn open_in_notepad(path: &Path) -> Result<(), String> {
  let quoted = HSTRING::from(format!("\"{}\"", path.display()));
  execute(
    w!("open"),
    &HSTRING::from("notepad.exe"),
    PCWSTR(quoted.as_ptr()),
  )
  .map_err(|code| format!("windows could not open {} ({code})", path.display()))
}

/// Open an `http(s)` URL in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
  let trimmed = url.trim();
  let lowered = trimmed.to_ascii_lowercase();
  if !ALLOWED_SCHEMES
    .iter()
    .any(|scheme| lowered.starts_with(scheme))
  {
    return Err(format!("refusing to open a non-web link: {trimmed}"));
  }
  // A control character would let a crafted string break out of the argument the
  // shell parses; there is no legitimate URL containing one.
  if trimmed.chars().any(char::is_control) {
    return Err("refusing to open a link containing control characters".to_string());
  }

  execute(w!("open"), &HSTRING::from(trimmed), PCWSTR::null())
    .map_err(|code| format!("windows could not open {trimmed} ({code})"))
}

/// Run one `ShellExecuteW`, mapping its HINSTANCE onto a result.
fn execute(verb: PCWSTR, file: &HSTRING, parameters: PCWSTR) -> Result<(), isize> {
  // SAFETY: `file` outlives the call, and the other pointers are either null or
  // static wide strings.
  let result = unsafe {
    ShellExecuteW(
      None,
      verb,
      PCWSTR(file.as_ptr()),
      parameters,
      PCWSTR::null(),
      SW_SHOWNORMAL,
    )
  };

  let code = result.0 as isize;
  if code > SHELL_EXECUTE_SUCCESS_FLOOR {
    Ok(())
  } else {
    Err(code)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_web_links_are_opened() {
    for refused in [
      "file:///C:/Windows/System32/cmd.exe",
      "ms-settings:",
      "javascript:alert(1)",
      "C:\\Windows\\System32\\cmd.exe",
      "",
      "   ",
    ] {
      let error = open_url(refused).expect_err("should refuse");
      assert!(error.contains("non-web link"), "{refused}: {error}");
    }
  }

  #[test]
  fn a_control_character_in_a_link_is_refused() {
    let error = open_url("https://owlette.app/docs\r\nnotepad").expect_err("should refuse");
    assert!(error.contains("control characters"), "{error}");
  }

  #[test]
  fn a_path_outside_the_tree_never_reaches_the_shell() {
    let error = open_in_tree("C:\\Windows\\System32\\cmd.exe").expect_err("should refuse");
    assert!(error.contains("escapes"), "{error}");

    let error = open_in_tree("config/../../Windows/notepad.exe").expect_err("should refuse");
    assert!(error.contains(".."), "{error}");
  }

  #[test]
  fn a_missing_target_is_reported_before_the_shell_is_asked() {
    let error = open_in_tree("config/definitely-not-here.json").expect_err("should refuse");
    assert!(error.contains("does not exist"), "{error}");
  }
}
