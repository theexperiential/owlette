//! The stop sentinel: `tmp\stop_signal.json`, pushed at the agent.
//!
//! Reporting STOP_PENDING is a PULL — the agent has to ask the SCM for the
//! host's state every 250 ms, over an RPC that can go blind exactly when it
//! matters most, during OS shutdown. This is the same message as a PUSH: a file
//! in a directory the agent already keeps its other runtime state in. Whichever
//! arrives first wins.
//!
//! The agent treats the file's EXISTENCE as the signal, so the contents are
//! informational and every write here is best-effort — a stop must never fail
//! because a disk would not take a hundred bytes.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hostlog;
use crate::paths;

/// Which control the SCM sent. Recorded so the host log and the sentinel can
/// tell an operator's `net stop` from a machine going down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopControl {
  Stop,
  Shutdown,
  Preshutdown,
}

impl StopControl {
  /// The `control` value in the sentinel, and the word used in the host log.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Stop => "stop",
      Self::Shutdown => "shutdown",
      Self::Preshutdown => "preshutdown",
    }
  }

  /// Encoding for the `AtomicU8` the control handler hands the supervision
  /// loop. Zero is reserved for "nothing has arrived".
  pub fn code(self) -> u8 {
    match self {
      Self::Stop => 1,
      Self::Shutdown => 2,
      Self::Preshutdown => 3,
    }
  }

  pub fn from_code(code: u8) -> Option<Self> {
    match code {
      1 => Some(Self::Stop),
      2 => Some(Self::Shutdown),
      3 => Some(Self::Preshutdown),
      _ => None,
    }
  }
}

/// Write the sentinel. Best-effort, and never fatal.
pub fn write(control: StopControl) {
  let path = paths::stop_signal_path();
  match write_at(&path, control) {
    Ok(()) => hostlog::info(&format!(
      "wrote the {} sentinel {}",
      control.as_str(),
      path.display()
    )),
    Err(error) => hostlog::warn(&format!(
      "could not write {}: {error} - the agent falls back to polling the SCM for STOP_PENDING",
      path.display()
    )),
  }
}

/// Remove a sentinel a previous run left behind, so the agent cannot read a
/// dead signal as a live one. The agent clears it at its own startup too.
pub fn clear() {
  let path = paths::stop_signal_path();
  match clear_at(&path) {
    Ok(true) => hostlog::info(&format!("cleared a stale {}", path.display())),
    Ok(false) => {}
    Err(error) => hostlog::warn(&format!(
      "could not clear a stale {}: {error} - the agent may stop as soon as it starts",
      path.display()
    )),
  }
}

/// Staged and renamed rather than written in place: the agent polls for this
/// file, and a rename is atomic within a volume, so it can never catch a
/// zero-byte one mid-write.
fn write_at(path: &Path, control: StopControl) -> std::io::Result<()> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  let staged = staged_path(path);
  fs::write(&staged, body(control, unix_millis()))?;
  fs::rename(&staged, path)
}

/// `stop_signal.json` → `stop_signal.json.tmp`, the same shape as the log
/// rotation sibling.
fn staged_path(path: &Path) -> PathBuf {
  let mut name = path.as_os_str().to_os_string();
  name.push(".tmp");
  PathBuf::from(name)
}

/// `Ok(false)` when there was nothing there — the ordinary case at startup.
fn clear_at(path: &Path) -> std::io::Result<bool> {
  match fs::remove_file(path) {
    Ok(()) => Ok(true),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(error) => Err(error),
  }
}

/// Hand-rolled rather than taking on serde for one object of two fields.
fn body(control: StopControl, written_at_ms: u128) -> String {
  format!(
    "{{\"control\": \"{}\", \"written_at_ms\": {written_at_ms}}}",
    control.as_str()
  )
}

fn unix_millis() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|since| since.as_millis())
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_sentinel_is_the_json_object_the_agent_parses() {
    assert_eq!(
      body(StopControl::Preshutdown, 1_755_000_000_123),
      r#"{"control": "preshutdown", "written_at_ms": 1755000000123}"#
    );
    assert_eq!(
      body(StopControl::Stop, 0),
      r#"{"control": "stop", "written_at_ms": 0}"#
    );
    assert_eq!(
      body(StopControl::Shutdown, 1),
      r#"{"control": "shutdown", "written_at_ms": 1}"#
    );
  }

  #[test]
  fn every_control_survives_the_trip_through_the_atomic() {
    for control in [
      StopControl::Stop,
      StopControl::Shutdown,
      StopControl::Preshutdown,
    ] {
      assert_eq!(StopControl::from_code(control.code()), Some(control));
    }
  }

  #[test]
  fn zero_means_no_control_has_arrived() {
    assert_eq!(StopControl::from_code(0), None);
    assert_eq!(StopControl::from_code(4), None);
  }

  #[test]
  fn the_sentinel_is_written_into_a_directory_that_may_not_exist_yet() {
    // Never the real path: writing it would tell a live agent to shut down.
    let dir = std::env::temp_dir().join(format!("owlette-host-stop-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let path = dir.join("tmp").join("stop_signal.json");

    // Nothing to clear is success, not an error.
    assert!(!clear_at(&path).expect("clearing nothing"));

    write_at(&path, StopControl::Shutdown).expect("write");
    let written = fs::read_to_string(&path).expect("read back");
    assert!(written.starts_with(r#"{"control": "shutdown", "written_at_ms": "#));
    // The staging file is consumed by the rename, not left behind.
    assert!(!staged_path(&path).exists());

    // Writing over a sentinel that is already there replaces it.
    write_at(&path, StopControl::Preshutdown).expect("overwrite");
    let written = fs::read_to_string(&path).expect("read back");
    assert!(written.starts_with(r#"{"control": "preshutdown", "#));

    assert!(clear_at(&path).expect("clearing the sentinel"));
    assert!(!path.exists());

    let _ = fs::remove_dir_all(&dir);
  }
}
