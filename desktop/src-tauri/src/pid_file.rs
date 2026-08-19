//! The two pid markers the service reads to see what the operator has open.
//!
//! * `tmp/tray.pid` — written for the life of the process. The service polls it
//!   from `_is_tray_alive()` and only spawns `owlette-desktop.exe --tray` when
//!   nothing is there, so a stale or missing marker costs a duplicate launch
//!   (which the single-instance plugin folds straight back in).
//! * `tmp/gui.pid` — written only while the main window is on screen. The
//!   service raises its metrics cadence to 5 s while an operator is watching
//!   (`firebase_client._metrics_loop`), which used to be a python-image scan for
//!   `owlette_gui.py` and could never match a native executable. Tying it to the
//!   window rather than the process matters now that the app lives in the tray:
//!   a process-lifetime marker would pin the fleet at the 5 s cadence forever.
//!
//! Format matches Cortex exactly (`owlette_cortex.write_pid_file`, :71-86) — the
//! decimal pid, no trailing newline — so one reader works on any of them.

use std::fs;
use std::path::{Path, PathBuf};

/// Write this process's pid to `relative` under `root`.
pub fn write(root: &Path, relative: &str) -> std::io::Result<PathBuf> {
  let path = root.join(relative);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }

  // Written through a scratch file and renamed: a reader that catches us
  // mid-write would otherwise parse a truncated PID and conclude the wrong
  // process is alive.
  let file_name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "owlette.pid".to_string());
  let temp = path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()));
  if let Err(error) = fs::write(&temp, std::process::id().to_string()) {
    let _ = fs::remove_file(&temp);
    return Err(error);
  }
  if let Err(error) = fs::rename(&temp, &path) {
    let _ = fs::remove_file(&temp);
    return Err(error);
  }

  Ok(path)
}

/// Remove `relative` under `root`, if it is ours to remove.
///
/// A stale file left by a crash is claimed by the next launch's [`write`], so
/// removing another instance's marker here would only create a window where a
/// live UI looks closed.
pub fn remove(root: &Path, relative: &str) {
  let path = root.join(relative);
  match fs::read_to_string(&path) {
    Ok(contents) => {
      if contents.trim().parse::<u32>() == Ok(std::process::id()) {
        if let Err(error) = fs::remove_file(&path) {
          log::warn!("could not remove {}: {error}", path.display());
        }
      } else {
        log::debug!(
          "leaving {} alone — it belongs to another instance",
          path.display()
        );
      }
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => log::warn!("could not read {}: {error}", path.display()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::paths::{GUI_PID_REL, TRAY_PID_REL};

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let dir = std::env::temp_dir().join(format!(
        "owlette-desktop-pid-{}-{label}",
        std::process::id()
      ));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).expect("scratch dir");
      Self(dir)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn writes_the_decimal_pid_and_removes_it_again() {
    let scratch = Scratch::new("roundtrip");
    let path = write(&scratch.0, GUI_PID_REL).expect("write pid file");

    assert_eq!(path, scratch.0.join(GUI_PID_REL));
    let contents = fs::read_to_string(&path).expect("read");
    assert_eq!(contents, std::process::id().to_string());
    assert_eq!(contents.trim().parse::<u32>(), Ok(std::process::id()));

    remove(&scratch.0, GUI_PID_REL);
    assert!(!path.exists());
  }

  #[test]
  fn the_two_markers_are_independent() {
    let scratch = Scratch::new("independent");
    let gui = write(&scratch.0, GUI_PID_REL).expect("gui marker");
    let tray = write(&scratch.0, TRAY_PID_REL).expect("tray marker");

    // Closing the window must not tell the service the tray is gone.
    remove(&scratch.0, GUI_PID_REL);
    assert!(!gui.exists());
    assert!(tray.exists());

    remove(&scratch.0, TRAY_PID_REL);
    assert!(!tray.exists());
  }

  #[test]
  fn leaves_no_scratch_file_behind() {
    let scratch = Scratch::new("temps");
    write(&scratch.0, GUI_PID_REL).expect("write pid file");

    let entries: Vec<_> = fs::read_dir(scratch.0.join("tmp"))
      .expect("read dir")
      .filter_map(Result::ok)
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(entries, vec!["gui.pid".to_string()]);
  }

  #[test]
  fn does_not_remove_another_instances_marker() {
    let scratch = Scratch::new("foreign");
    let path = scratch.0.join(TRAY_PID_REL);
    fs::create_dir_all(path.parent().expect("parent")).expect("tmp dir");
    fs::write(&path, "424242").expect("seed");

    remove(&scratch.0, TRAY_PID_REL);
    assert!(
      path.exists(),
      "removed a pid file belonging to another process"
    );
  }

  #[test]
  fn removing_a_missing_marker_is_not_an_error() {
    let scratch = Scratch::new("absent");
    remove(&scratch.0, GUI_PID_REL);
  }
}
