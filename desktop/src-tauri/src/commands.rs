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
use tauri::{AppHandle, State};

use crate::agent_cli::{self, Runs};
use crate::json_io::{self, WriteOutcome};
use crate::paths::{self, SERVICE_STATUS_REL};
use crate::process_ctl::{self, TerminateOutcome, DEFAULT_GRACEFUL_TIMEOUT};
use crate::service_ctl::{self, ServiceCommandOutcome, ServiceStatus};
use crate::shell_open;
use crate::window_state::LayoutState;

/// Absolute path of the owlette data root (`%PROGRAMDATA%\Owlette`).
///
/// The frontend addresses seam files by their relative paths; this exists for
/// the flows that must spawn the bundled interpreter or show the operator where
/// the tree lives.
#[tauri::command(async)]
pub fn owlette_data_root() -> String {
  paths::data_root().to_string_lossy().into_owned()
}

/// argv this process was launched with, including argv[0].
///
/// The service starts the app with `--tray` (supply a tray icon, no window) or
/// `--restart-prompt` (a process has exceeded its relaunch budget and the
/// operator has to be asked about a reboot). Neither is visible to the frontend
/// otherwise. A *second* launch does not reach here — the single-instance plugin
/// forwards its argv on `owlette://second-instance` instead, so a UI that reacts
/// to these flags has to handle both.
#[tauri::command(async)]
pub fn launch_args() -> Vec<String> {
  std::env::args().collect()
}

/// This machine's name, as the fleet knows it (`COMPUTERNAME`).
#[tauri::command(async)]
pub fn hostname() -> String {
  crate::tray::hostname()
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

/// Run one of the agent's headless modes, streaming its output.
///
/// `mode` is a name from `agent_cli::MODES`, never a command line. Returns the
/// run id to match against `owlette://agent-cli` events; the run is finished
/// when its `exit` event arrives.
#[tauri::command(async)]
pub fn agent_cli_start(
  app: AppHandle,
  runs: State<'_, Runs>,
  mode: String,
  payload: Option<Value>,
) -> Result<String, String> {
  agent_cli::start(&app, &runs, &mode, payload)
}

/// Stop a run started by [`agent_cli_start`]. `false` if it had already exited.
#[tauri::command(async)]
pub fn agent_cli_cancel(runs: State<'_, Runs>, run: String) -> Result<bool, String> {
  agent_cli::cancel(&runs, &run)
}

/// Open a file or folder inside the owlette tree with its default handler.
#[tauri::command(async)]
pub fn open_owlette_path(path: String) -> Result<(), String> {
  shell_open::open_in_tree(&path)
}

/// Open an `http(s)` link in the default browser.
#[tauri::command(async)]
pub fn open_external_url(url: String) -> Result<(), String> {
  shell_open::open_url(&url)
}

/// Width the process-list sidebar should open at, in logical pixels.
///
/// Comes from the same per-user layout file the window size lives in, so the
/// two halves of the shell are remembered together.
#[tauri::command(async)]
pub fn sidebar_width(layout: State<'_, LayoutState>) -> f64 {
  layout.sidebar_width()
}

/// Store the sidebar width, returning the value actually kept.
///
/// The host clamps: the divider applies the same bounds while dragging, but a
/// width that reached here out of range would otherwise be remembered forever.
#[tauri::command(async)]
pub fn set_sidebar_width(layout: State<'_, LayoutState>, width: f64) -> Result<f64, String> {
  layout.set_sidebar_width(width)
}
