//! Tauri command surface.
//!
//! Thin adapters only: every command resolves its arguments, delegates to a
//! Tauri-free module, and maps errors to strings for the IPC boundary. Keeping
//! the logic out of here is what lets the seam be unit tested without an app
//! handle.
//!
//! All commands are declared `#[tauri::command(async)]`. They are synchronous
//! bodies, so each one runs to completion on a single async-runtime worker
//! thread — which both keeps the main thread free during a mutex wait and
//! preserves the "acquire and release on the same thread" rule Windows mutex
//! ownership requires.

use std::time::Duration;

use serde_json::Value;

use crate::json_io::{self, WriteOutcome};
use crate::paths::{self, SERVICE_STATUS_REL};
use crate::process_ctl::{self, TerminateOutcome, DEFAULT_GRACEFUL_TIMEOUT};
use crate::service_ctl::{self, ServiceCommandOutcome, ServiceStatus};

/// Absolute path of the owlette data root (`%PROGRAMDATA%\Owlette`).
///
/// The frontend addresses seam files by their relative paths; this exists for
/// the flows that must spawn the bundled interpreter or show the operator where
/// the tree lives.
#[tauri::command(async)]
pub fn owlette_data_root() -> String {
  paths::data_root().to_string_lossy().into_owned()
}

/// Read a JSON file from the owlette tree under the cross-process mutex.
///
/// `path` is relative to the data root (or absolute inside it). A missing file
/// reads as `{}`.
#[tauri::command(async)]
pub fn read_owlette_json(path: String) -> Result<Value, String> {
  let resolved = paths::resolve_in_root(&paths::data_root(), &path)?;
  json_io::read_json(&resolved).map_err(|error| error.to_string())
}

/// Write a JSON file into the owlette tree atomically, under the mutex.
#[tauri::command(async)]
pub fn write_owlette_json(path: String, json: Value) -> Result<WriteOutcome, String> {
  let resolved = paths::resolve_in_root(&paths::data_root(), &path)?;
  json_io::write_json(&resolved, &json).map_err(|error| error.to_string())
}

/// SCM state of `OwletteService` plus the freshness of `service_status.json`.
#[tauri::command(async)]
pub fn service_status() -> Result<ServiceStatus, String> {
  service_ctl::status(&paths::data_root().join(SERVICE_STATUS_REL))
}

/// Start `OwletteService`, elevating only when this process lacks the right.
#[tauri::command(async)]
pub fn service_start() -> Result<ServiceCommandOutcome, String> {
  service_ctl::start()
}

/// Stop `OwletteService`, elevating only when this process lacks the right.
#[tauri::command(async)]
pub fn service_stop() -> Result<ServiceCommandOutcome, String> {
  service_ctl::stop()
}

/// Close `pid` gracefully, then terminate it — but only if it is still running
/// `expected_exe`.
#[tauri::command(async)]
pub fn terminate_pid(
  pid: u32,
  expected_exe: String,
  graceful_timeout_ms: Option<u64>,
) -> Result<TerminateOutcome, String> {
  let timeout = graceful_timeout_ms
    .map(Duration::from_millis)
    .unwrap_or(DEFAULT_GRACEFUL_TIMEOUT);
  process_ctl::terminate_pid(pid, &expected_exe, timeout)
}
