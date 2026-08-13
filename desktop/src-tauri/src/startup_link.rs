//! `{userstartup}\Owlette Tray.lnk` — storage for the tray's "start on login".
//!
//! The legacy tray toggled the *service* start type instead
//! (`owlette_tray.on_select` runs `sc config OwletteService start= …`), which
//! costs a UAC prompt and conflates "supervise this machine" with "show me a
//! tray icon". The desktop app owns the shortcut the installer creates
//! (`owlette_installer.iss:159`) instead: no elevation, and turning it off
//! leaves the service running.
//!
//! Enabling always rewrites the shortcut so an upgraded machine stops
//! auto-starting the python tray — the installer's version points at
//! `pythonw.exe owlette_tray.py`, and ours points at this executable with
//! `--tray`.

use std::path::{Path, PathBuf};

use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
  CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
  FOLDERID_Startup, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
};

/// File name of the shortcut, byte-identical to the installer's `[Icons]` entry
/// (`Name: "{userstartup}\Owlette Tray"`) so the two never coexist.
pub const LINK_NAME: &str = "Owlette Tray.lnk";

/// Argument the shortcut passes, which starts the app hidden in the tray.
pub const TRAY_ARG: &str = "--tray";

/// Application identity stamped onto the shortcut.
///
/// Windows refuses to display a toast from a non-packaged desktop app unless
/// some shortcut under the Start menu carries a matching
/// `System.AppUserModel.ID` — and the notification plugin sends ours under the
/// bundle identifier from `tauri.conf.json`. The Startup folder lives inside the
/// Start menu tree, so writing it here gives the tray's degraded-state toasts a
/// registered identity without waiting for the installer.
///
/// Keep this equal to `tauri.conf.json`'s `identifier`.
const APP_USER_MODEL_ID: &str = "app.owlette.desktop";

/// Absolute path of the shortcut in the current user's Startup folder.
pub fn link_path() -> Result<PathBuf, String> {
  Ok(startup_dir()?.join(LINK_NAME))
}

/// True when owlette is set to start with this user's session.
///
/// Presence is the whole test: a shortcut left by the installer still points at
/// the python tray, and reporting it as "on" is correct — something owlette
/// launches at login. [`enable`] then replaces it with ours.
pub fn is_enabled() -> bool {
  match link_path() {
    Ok(path) => path.is_file(),
    Err(error) => {
      log::warn!("could not locate the startup folder: {error}");
      false
    }
  }
}

/// Create (or replace) the startup shortcut, pointing at this executable.
pub fn enable() -> Result<PathBuf, String> {
  let path = link_path()?;
  write_link(&path)?;
  Ok(path)
}

/// Write the shortcut to an explicit path. Split out from [`enable`] so it can
/// be exercised against a scratch file instead of the live Startup folder.
fn write_link(path: &Path) -> Result<(), String> {
  let exe =
    std::env::current_exe().map_err(|error| format!("could not locate this exe: {error}"))?;
  let working_dir = exe
    .parent()
    .map(|parent| parent.to_path_buf())
    .unwrap_or_else(|| exe.clone());

  let _com = ComGuard::new()?;

  // SAFETY: every call below is a plain COM call on an interface we own for the
  // duration of this function; no pointer outlives it.
  unsafe {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
      .map_err(|error| format!("could not create a shell link: {error}"))?;

    link
      .SetPath(&HSTRING::from(exe.as_os_str()))
      .map_err(|error| format!("could not set the shortcut target: {error}"))?;
    link
      .SetArguments(&HSTRING::from(TRAY_ARG))
      .map_err(|error| format!("could not set the shortcut arguments: {error}"))?;
    link
      .SetWorkingDirectory(&HSTRING::from(working_dir.as_os_str()))
      .map_err(|error| format!("could not set the shortcut working directory: {error}"))?;
    link
      .SetDescription(&HSTRING::from("owlette"))
      .map_err(|error| format!("could not set the shortcut description: {error}"))?;

    let properties: IPropertyStore = link
      .cast()
      .map_err(|error| format!("could not open the shortcut property store: {error}"))?;
    properties
      .SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(APP_USER_MODEL_ID))
      .map_err(|error| format!("could not set the shortcut app id: {error}"))?;
    properties
      .Commit()
      .map_err(|error| format!("could not commit the shortcut properties: {error}"))?;

    let persist: IPersistFile = link
      .cast()
      .map_err(|error| format!("could not persist the shortcut: {error}"))?;
    persist
      .Save(&HSTRING::from(path.as_os_str()), true)
      .map_err(|error| format!("could not write {}: {error}", path.display()))?;
  }

  Ok(())
}

/// Remove the startup shortcut. A missing shortcut is already the target state.
pub fn disable() -> Result<(), String> {
  let path = link_path()?;
  match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(format!("could not remove {}: {error}", path.display())),
  }
}

/// The current user's Startup folder, resolved through the shell rather than
/// composed from `%APPDATA%` so a redirected profile still works.
fn startup_dir() -> Result<PathBuf, String> {
  // SAFETY: `SHGetKnownFolderPath` allocates the string with the COM allocator
  // and we free it with `CoTaskMemFree` on both paths below.
  unsafe {
    let raw: PWSTR = SHGetKnownFolderPath(&FOLDERID_Startup, KF_FLAG_DEFAULT, None)
      .map_err(|error| format!("SHGetKnownFolderPath failed: {error}"))?;
    let value = raw.to_string();
    CoTaskMemFree(Some(raw.0 as *const _));
    value
      .map(PathBuf::from)
      .map_err(|error| format!("startup folder path is not valid utf-16: {error}"))
  }
}

/// Initialises COM for the calling thread and uninitialises it on drop.
///
/// The tray runs every menu action on its own short-lived thread, so this owns
/// the apartment outright rather than assuming the caller set one up.
struct ComGuard;

impl ComGuard {
  fn new() -> Result<Self, String> {
    // SAFETY: a plain COM initialisation for this thread; paired with the
    // `CoUninitialize` in `Drop`.
    let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if result.is_err() {
      return Err(format!("could not initialise COM: {result:?}"));
    }
    Ok(Self)
  }
}

impl Drop for ComGuard {
  fn drop(&mut self) {
    // SAFETY: balances the `CoInitializeEx` in `new`, on the same thread.
    unsafe { CoUninitialize() };
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_link_lives_in_the_startup_folder_under_the_installer_name() {
    let path = link_path().expect("startup folder");
    assert_eq!(
      path.file_name().and_then(|name| name.to_str()),
      Some(LINK_NAME)
    );
    assert!(
      path
        .to_string_lossy()
        .to_lowercase()
        .ends_with("\\startup\\owlette tray.lnk"),
      "unexpected startup path: {}",
      path.display()
    );
  }

  #[test]
  fn is_enabled_matches_the_file_on_disk() {
    let path = link_path().expect("startup folder");
    assert_eq!(is_enabled(), path.is_file());
  }

  /// The shortcut is not just a launcher: its `System.AppUserModel.ID` is what
  /// lets Windows display the tray's toasts at all, so a silent regression here
  /// costs the notifications without breaking anything visible.
  #[test]
  fn the_shortcut_carries_the_tray_argument_and_the_app_id() {
    let path = std::env::temp_dir().join(format!("owlette-link-{}.lnk", std::process::id()));
    let _ = std::fs::remove_file(&path);
    write_link(&path).expect("write shortcut");
    assert!(path.is_file(), "shortcut was not written");

    let _com = ComGuard::new().expect("com");
    // SAFETY: the shortcut is loaded, read and dropped inside this block.
    unsafe {
      let link: IShellLinkW =
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).expect("shell link");
      link
        .cast::<IPersistFile>()
        .expect("persist")
        .Load(
          &HSTRING::from(path.as_os_str()),
          windows::Win32::System::Com::STGM_READ,
        )
        .expect("load shortcut");

      let mut arguments = [0u16; 256];
      link.GetArguments(&mut arguments).expect("arguments");
      let arguments = String::from_utf16_lossy(&arguments);
      assert_eq!(arguments.trim_end_matches('\0'), TRAY_ARG);

      let app_id = link
        .cast::<IPropertyStore>()
        .expect("property store")
        .GetValue(&PKEY_AppUserModel_ID)
        .expect("app id");
      assert_eq!(app_id.to_string(), APP_USER_MODEL_ID);
    }

    let _ = std::fs::remove_file(&path);
  }
}
