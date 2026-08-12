//! `tmp/gui.pid` — the desktop app's liveness marker.
//!
//! The service raises its metrics cadence while an operator has the local UI
//! open. It currently detects that with a python-image scan for
//! `owlette_gui.py` (`firebase_client.py:685`), which cannot match a native
//! executable, so the desktop app publishes its PID the way Cortex already
//! does (`owlette_cortex.write_pid_file`, :71-86) and the service will read it
//! instead.
//!
//! Format matches Cortex exactly — the decimal PID, no trailing newline — so a
//! reader written against one file works on the other.

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::GUI_PID_REL;

/// Write this process's PID to `tmp/gui.pid` under `root`.
pub fn write(root: &Path) -> std::io::Result<PathBuf> {
  let path = root.join(GUI_PID_REL);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }

  // Written through a scratch file and renamed: a reader that catches us
  // mid-write would otherwise parse a truncated PID and conclude the wrong
  // process is alive.
  let temp = path.with_file_name(format!("gui.pid.{}.tmp", std::process::id()));
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

/// Remove `tmp/gui.pid`, if it is ours to remove.
///
/// A stale file left by a crash is claimed by the next launch's [`write`], so
/// removing another instance's marker here would only create a window where a
/// live UI looks closed.
pub fn remove(root: &Path) {
  let path = root.join(GUI_PID_REL);
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
    let path = write(&scratch.0).expect("write pid file");

    assert_eq!(path, scratch.0.join(GUI_PID_REL));
    let contents = fs::read_to_string(&path).expect("read");
    assert_eq!(contents, std::process::id().to_string());
    assert_eq!(contents.trim().parse::<u32>(), Ok(std::process::id()));

    remove(&scratch.0);
    assert!(!path.exists());
  }

  #[test]
  fn leaves_no_scratch_file_behind() {
    let scratch = Scratch::new("temps");
    write(&scratch.0).expect("write pid file");

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
    let path = scratch.0.join(GUI_PID_REL);
    fs::create_dir_all(path.parent().expect("parent")).expect("tmp dir");
    fs::write(&path, "424242").expect("seed");

    remove(&scratch.0);
    assert!(
      path.exists(),
      "removed a pid file belonging to another process"
    );
  }

  #[test]
  fn removing_a_missing_marker_is_not_an_error() {
    let scratch = Scratch::new("absent");
    remove(&scratch.0);
  }
}
