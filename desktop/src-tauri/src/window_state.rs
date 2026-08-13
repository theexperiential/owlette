//! Layout memory: how big the window was, and how wide the process list was.
//!
//! This is shell geometry, not user state, so it is deliberately device-local:
//! a per-user JSON in `%APPDATA%\app.owlette.desktop\layout.json`, written with
//! plain `std::fs`. It is per-*user* rather than per-machine (the owlette data
//! root in ProgramData) because two operators sharing a kiosk should not inherit
//! each other's window size — and the same reason rules out putting it in
//! `config.json`, which the service owns and uploads.
//!
//! Three deliberate decisions:
//!
//! * **Size and maximised, never position.** A remembered position is how an
//!   app ends up opening on a monitor that has since been unplugged. Restoring
//!   the size and re-centring cannot do that.
//! * **Logical pixels.** The file survives a move to a differently-scaled
//!   display; physical pixels would restore a window a third of the size on a
//!   150 % monitor.
//! * **A namespaced document.** The file is `{"window": {...}, "sidebar": {...}}`
//!   and every write preserves the sections it does not own, so a later key can
//!   join without a migration and without a race between two writers costing a
//!   section.
//!
//! Nothing here is load-bearing: a missing, truncated or hand-mangled file falls
//! back to the `tauri.conf.json` defaults in silence.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalSize, Window};

/// File name inside the per-user app-data directory.
pub const LAYOUT_FILE: &str = "layout.json";

const KEY_WINDOW: &str = "window";
const KEY_SIDEBAR: &str = "sidebar";
const KEY_WIDTH: &str = "width";

/// The window minimums declared in `tauri.conf.json`. Restoring anything below
/// them would be corrected by the window manager on the first paint, so they are
/// applied here instead — and a test asserts these two constants still match the
/// config they mirror.
pub const MIN_WINDOW_WIDTH: f64 = 780.0;
pub const MIN_WINDOW_HEIGHT: f64 = 540.0;

/// Above this a stored dimension is corruption rather than a preference: no
/// logical desktop is this wide, and restoring it would put the titlebar out of
/// reach. Such a file is discarded, not clamped.
const MAX_WINDOW_DIMENSION: f64 = 32_000.0;

/// Sidebar bounds. The divider applies the same numbers while dragging
/// (`src/lib/sidebarWidth.ts`), but this side is the authority — the frontend
/// cannot write a width the host has not clamped.
pub const MIN_SIDEBAR_WIDTH: f64 = 200.0;
pub const MAX_SIDEBAR_WIDTH: f64 = 400.0;
/// `w-72`: the width the sidebar had before it became resizable, and what a
/// machine with no layout file still gets.
pub const DEFAULT_SIDEBAR_WIDTH: f64 = 288.0;

/// The window half of the document, in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowLayout {
  pub width: f64,
  pub height: f64,
  /// Whether the window was maximised when it was last put away. The size above
  /// is still the *un*-maximised one, so restoring down lands where the operator
  /// left it rather than on the config default.
  #[serde(default)]
  pub maximized: bool,
}

impl WindowLayout {
  pub fn new(width: f64, height: f64, maximized: bool) -> Self {
    Self {
      width,
      height,
      maximized,
    }
  }

  /// Clamp to the configured minimums, or reject the record outright when the
  /// numbers cannot describe a window at all.
  fn sanitised(self) -> Option<Self> {
    if !self.width.is_finite() || !self.height.is_finite() {
      return None;
    }
    if self.width <= 0.0 || self.height <= 0.0 {
      return None;
    }
    if self.width > MAX_WINDOW_DIMENSION || self.height > MAX_WINDOW_DIMENSION {
      return None;
    }
    Some(Self {
      width: self.width.max(MIN_WINDOW_WIDTH),
      height: self.height.max(MIN_WINDOW_HEIGHT),
      maximized: self.maximized,
    })
  }
}

/// Clamp a sidebar width into the range the divider offers.
pub fn clamp_sidebar_width(width: f64) -> f64 {
  if !width.is_finite() {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  width.clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH).round()
}

// ─── document ───────────────────────────────────────────────────────────────

/// Read the whole document. Anything unreadable — missing file, truncated
/// write, a hand-edited array — is an empty document: layout memory is a
/// convenience and must never be a reason a launch behaves oddly.
fn read_document(path: &Path) -> Map<String, Value> {
  let text = match fs::read_to_string(path) {
    Ok(text) => text,
    Err(error) if error.kind() == io::ErrorKind::NotFound => return Map::new(),
    Err(error) => {
      log::warn!("could not read {}: {error}", path.display());
      return Map::new();
    }
  };

  // A file that has been through Notepad or `Set-Content -Encoding utf8` keeps
  // a UTF-8 BOM, which serde_json refuses outright. Dropping it costs one
  // comparison and turns "your layout was forgotten" into a correct read.
  match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
    Ok(Value::Object(map)) => map,
    Ok(_) => {
      log::warn!("{} is not a json object — ignoring it", path.display());
      Map::new()
    }
    Err(error) => {
      log::warn!("ignoring {}: {error}", path.display());
      Map::new()
    }
  }
}

/// Replace one section, preserving every key this build does not know about.
fn write_section(path: &Path, key: &str, section: Value) -> io::Result<()> {
  let mut document = read_document(path);
  document.insert(key.to_string(), section);

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  let text = serde_json::to_string_pretty(&Value::Object(document)).map_err(io::Error::other)?;

  // Scratch file plus rename, like every other file this app owns: a reader
  // that catches us mid-write gets the previous document rather than half of
  // this one.
  let temp = path.with_extension(format!("{}.tmp", std::process::id()));
  if let Err(error) = fs::write(&temp, text) {
    let _ = fs::remove_file(&temp);
    return Err(error);
  }
  if let Err(error) = fs::rename(&temp, path) {
    let _ = fs::remove_file(&temp);
    return Err(error);
  }
  Ok(())
}

/// The remembered window geometry, clamped; `None` when there is nothing usable
/// on disk and the `tauri.conf.json` defaults should stand.
pub fn load_window(path: &Path) -> Option<WindowLayout> {
  serde_json::from_value::<WindowLayout>(read_document(path).get(KEY_WINDOW)?.clone())
    .ok()?
    .sanitised()
}

/// The remembered sidebar width, clamped; `None` when there is none.
pub fn load_sidebar_width(path: &Path) -> Option<f64> {
  read_document(path)
    .get(KEY_SIDEBAR)?
    .get(KEY_WIDTH)?
    .as_f64()
    .filter(|width| width.is_finite())
    .map(clamp_sidebar_width)
}

pub fn save_window(path: &Path, layout: WindowLayout) -> io::Result<()> {
  let value = serde_json::to_value(layout).map_err(io::Error::other)?;
  write_section(path, KEY_WINDOW, value)
}

pub fn save_sidebar_width(path: &Path, width: f64) -> io::Result<()> {
  let mut section = Map::new();
  section.insert(KEY_WIDTH.to_string(), clamp_sidebar_width(width).into());
  write_section(path, KEY_SIDEBAR, Value::Object(section))
}

// ─── managed state ──────────────────────────────────────────────────────────

/// Managed state: where the file lives, plus the geometry the window events keep
/// current so a save never has to ask a window that may already be gone.
///
/// The path is optional because it comes from Tauri's path resolver, which can
/// in principle fail; when it does, layout memory turns itself off rather than
/// taking the app down with it.
pub struct LayoutState {
  path: Option<PathBuf>,
  window: Mutex<WindowLayout>,
  /// Serialises the read-modify-write of the document. The window is saved from
  /// the main thread and the sidebar from a command worker, and without this the
  /// two could interleave and drop a section.
  file: Mutex<()>,
}

impl LayoutState {
  pub fn new(path: Option<PathBuf>, window: WindowLayout) -> Self {
    Self {
      path,
      window: Mutex::new(window),
      file: Mutex::new(()),
    }
  }

  pub fn path(&self) -> Option<&Path> {
    self.path.as_deref()
  }

  /// Record a resize. `maximized` is always kept; the size is kept only while
  /// the window is *not* maximised, so what is stored stays the size the window
  /// restores down to.
  pub fn record(&self, width: f64, height: f64, maximized: bool) {
    let Ok(mut window) = self.window.lock() else {
      log::error!("layout state lock poisoned");
      return;
    };
    window.maximized = maximized;
    if maximized {
      return;
    }
    if width >= MIN_WINDOW_WIDTH && height >= MIN_WINDOW_HEIGHT {
      window.width = width;
      window.height = height;
    }
  }

  pub fn snapshot(&self) -> WindowLayout {
    match self.window.lock() {
      Ok(window) => *window,
      Err(error) => {
        log::error!("layout state lock poisoned: {error}");
        WindowLayout::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, false)
      }
    }
  }

  /// Write the current window geometry out. Called when the window is put away
  /// and again on exit; failures are logged and dropped.
  pub fn persist(&self) {
    let Some(path) = self.path() else {
      return;
    };
    let layout = self.snapshot();
    let _guard = self.file.lock();
    if let Err(error) = save_window(path, layout) {
      log::warn!("could not save the window layout: {error}");
    } else {
      log::debug!(
        "saved window layout {}x{} maximized={}",
        layout.width,
        layout.height,
        layout.maximized
      );
    }
  }

  /// The sidebar width to open with.
  pub fn sidebar_width(&self) -> f64 {
    self
      .path()
      .and_then(load_sidebar_width)
      .unwrap_or(DEFAULT_SIDEBAR_WIDTH)
  }

  /// Store a sidebar width, returning the value actually kept.
  pub fn set_sidebar_width(&self, width: f64) -> Result<f64, String> {
    let clamped = clamp_sidebar_width(width);
    let Some(path) = self.path() else {
      return Ok(clamped);
    };
    let _guard = self.file.lock();
    save_sidebar_width(path, clamped)
      .map(|()| clamped)
      .map_err(|error| format!("could not save the sidebar width: {error}"))
  }
}

// ─── window glue ────────────────────────────────────────────────────────────

/// Restore the remembered geometry onto the main window and build the state to
/// manage.
///
/// Called from `setup`, which is the only place where every launch converges
/// *before* the window is first shown — `--tray` leaves it hidden for the tray
/// to open later, a plain launch shows it at the end of setup, and a second
/// instance is forwarded into a window this has already sized.
pub fn restore(app: &AppHandle) -> LayoutState {
  let path = match app.path().app_data_dir() {
    Ok(dir) => Some(dir.join(LAYOUT_FILE)),
    Err(error) => {
      log::warn!("no per-user app data directory ({error}) — layout memory is off");
      None
    }
  };

  let Some(window) = app.get_webview_window("main") else {
    log::warn!("no main window to restore a layout onto");
    return LayoutState::new(
      path,
      WindowLayout::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, false),
    );
  };

  // The baseline is read off the window rather than duplicated here, so the
  // `tauri.conf.json` size stays the single source of the first-run default.
  let configured = configured_size(&window);

  let Some(saved) = path.as_deref().and_then(load_window) else {
    return LayoutState::new(path, configured);
  };

  if let Err(error) = window.set_size(LogicalSize::new(saved.width, saved.height)) {
    log::warn!("could not restore the window size: {error}");
    return LayoutState::new(path, configured);
  }
  // Position is deliberately not remembered, and growing from the config's
  // centred origin would leave a restored window off-centre — or off-screen on
  // a display that has since shrunk. Re-centring is the whole restore.
  if let Err(error) = window.center() {
    log::warn!("could not centre the window: {error}");
  }
  if saved.maximized {
    if let Err(error) = window.maximize() {
      log::warn!("could not restore the maximised window: {error}");
    }
  }

  log::info!(
    "restored window layout {}x{} maximized={}",
    saved.width,
    saved.height,
    saved.maximized
  );
  LayoutState::new(path, saved)
}

/// The window's current logical size, i.e. what `tauri.conf.json` asked for.
fn configured_size(window: &tauri::WebviewWindow) -> WindowLayout {
  let scale = window.scale_factor().unwrap_or(1.0);
  match window.inner_size() {
    Ok(size) => {
      let logical: LogicalSize<f64> = size.to_logical(scale);
      WindowLayout::new(logical.width, logical.height, false)
    }
    Err(error) => {
      log::warn!("could not read the window size: {error}");
      WindowLayout::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, false)
    }
  }
}

/// Fold a resize into the state, in logical pixels.
///
/// A minimised window reports 0x0 and is not maximised even when it will restore
/// to maximised, so those events are dropped before they can rewrite either
/// half of the record.
pub fn record_resize(window: &Window, state: &LayoutState, size: PhysicalSize<u32>) {
  if window.is_minimized().unwrap_or(false) {
    return;
  }
  let scale = window.scale_factor().unwrap_or(1.0);
  let logical: LogicalSize<f64> = size.to_logical(scale);
  state.record(
    logical.width,
    logical.height,
    window.is_maximized().unwrap_or(false),
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let dir = std::env::temp_dir().join(format!(
        "owlette-desktop-layout-{}-{label}",
        std::process::id()
      ));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).expect("scratch dir");
      Self(dir)
    }

    /// A path one directory *below* the scratch root, so the writes have to
    /// create their parent the way the real app-data directory needs.
    fn file(&self) -> PathBuf {
      self.0.join("app.owlette.desktop").join(LAYOUT_FILE)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn the_minimums_still_match_tauri_conf() {
    // The clamp exists to agree with the window the config declares; a bump
    // there without one here would restore windows the shell then resizes.
    let config: Value =
      serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
    let window = &config["app"]["windows"][0];
    assert_eq!(window["minWidth"].as_f64(), Some(MIN_WINDOW_WIDTH));
    assert_eq!(window["minHeight"].as_f64(), Some(MIN_WINDOW_HEIGHT));
    assert_eq!(window["visible"].as_bool(), Some(false));
  }

  #[test]
  fn a_missing_file_remembers_nothing() {
    let scratch = Scratch::new("missing");
    assert_eq!(load_window(&scratch.file()), None);
    assert_eq!(load_sidebar_width(&scratch.file()), None);
  }

  #[test]
  fn the_window_round_trips_through_the_file() {
    let scratch = Scratch::new("window");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(1400.0, 900.0, true)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1400.0, 900.0, true))
    );

    // Restoring down and closing again overwrites the flag, not the size.
    save_window(&path, WindowLayout::new(1400.0, 900.0, false)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1400.0, 900.0, false))
    );
  }

  #[test]
  fn the_document_is_namespaced_and_keeps_sections_it_does_not_own() {
    let scratch = Scratch::new("namespaced");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(1200.0, 800.0, false)).expect("window");
    save_sidebar_width(&path, 320.0).expect("sidebar");

    // A key from a future build must survive a write from this one.
    let mut document = read_document(&path);
    document.insert("timeFormat".to_string(), Value::from("24h"));
    fs::write(
      &path,
      serde_json::to_string_pretty(&Value::Object(document)).expect("serialise"),
    )
    .expect("seed");

    save_window(&path, WindowLayout::new(1000.0, 700.0, false)).expect("rewrite");

    let document = read_document(&path);
    assert_eq!(document["timeFormat"], Value::from("24h"));
    assert_eq!(document[KEY_SIDEBAR][KEY_WIDTH].as_f64(), Some(320.0));
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1000.0, 700.0, false))
    );
    assert_eq!(load_sidebar_width(&path), Some(320.0));
  }

  #[test]
  fn a_corrupt_file_falls_back_silently() {
    let scratch = Scratch::new("corrupt");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    for junk in [
      "",
      "{",
      "[]",
      r#"{"window":"1400x900"}"#,
      r#"{"window":{"width":"wide","height":900}}"#,
      r#"{"window":{"width":null,"height":null}}"#,
      r#"{"sidebar":{"width":"wide"}}"#,
    ] {
      fs::write(&path, junk).expect("seed");
      assert_eq!(load_window(&path), None, "window from {junk}");
      assert_eq!(load_sidebar_width(&path), None, "sidebar from {junk}");
    }

    // And a corrupt file is replaced, not appended to.
    fs::write(&path, "{").expect("seed");
    save_window(&path, WindowLayout::new(1060.0, 640.0, false)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1060.0, 640.0, false))
    );
  }

  #[test]
  fn a_hand_edited_file_with_a_byte_order_mark_is_still_read() {
    let scratch = Scratch::new("bom");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    // What `Set-Content -Encoding utf8` leaves behind on Windows PowerShell.
    fs::write(
      &path,
      "\u{feff}{\"window\":{\"width\":1200,\"height\":800},\"sidebar\":{\"width\":320}}",
    )
    .expect("seed");

    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1200.0, 800.0, false))
    );
    assert_eq!(load_sidebar_width(&path), Some(320.0));
  }

  #[test]
  fn a_window_smaller_than_the_minimum_is_clamped_up() {
    let scratch = Scratch::new("clamp-window");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(320.0, 200.0, false)).expect("save");
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(
        MIN_WINDOW_WIDTH,
        MIN_WINDOW_HEIGHT,
        false
      ))
    );
  }

  #[test]
  fn an_impossible_window_is_discarded_rather_than_clamped() {
    let scratch = Scratch::new("absurd");
    let path = scratch.file();
    fs::create_dir_all(path.parent().expect("parent")).expect("dir");

    for junk in [
      r#"{"window":{"width":0,"height":0}}"#,
      r#"{"window":{"width":-1400,"height":900}}"#,
      r#"{"window":{"width":1.0e9,"height":900}}"#,
    ] {
      fs::write(&path, junk).expect("seed");
      assert_eq!(load_window(&path), None, "{junk}");
    }
  }

  #[test]
  fn the_sidebar_width_is_clamped_on_the_way_in_and_out() {
    let scratch = Scratch::new("clamp-sidebar");
    let path = scratch.file();

    save_window(&path, WindowLayout::new(1060.0, 640.0, false)).expect("window");

    save_sidebar_width(&path, 40.0).expect("save");
    assert_eq!(load_sidebar_width(&path), Some(MIN_SIDEBAR_WIDTH));

    save_sidebar_width(&path, 4000.0).expect("save");
    assert_eq!(load_sidebar_width(&path), Some(MAX_SIDEBAR_WIDTH));

    save_sidebar_width(&path, 301.4).expect("save");
    assert_eq!(load_sidebar_width(&path), Some(301.0));

    // A value written by hand outside the range is clamped as it is read, too.
    let mut document = read_document(&path);
    document.insert(
      KEY_SIDEBAR.to_string(),
      serde_json::json!({ KEY_WIDTH: 10_000 }),
    );
    fs::write(
      &path,
      serde_json::to_string_pretty(&Value::Object(document)).expect("serialise"),
    )
    .expect("seed");
    assert_eq!(load_sidebar_width(&path), Some(MAX_SIDEBAR_WIDTH));

    // …and none of that disturbed the window section.
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1060.0, 640.0, false))
    );
  }

  #[test]
  fn a_write_leaves_no_scratch_file_behind() {
    let scratch = Scratch::new("temps");
    let path = scratch.file();
    save_window(&path, WindowLayout::new(1060.0, 640.0, false)).expect("save");

    let entries: Vec<String> = fs::read_dir(path.parent().expect("parent"))
      .expect("read dir")
      .filter_map(Result::ok)
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(entries, vec![LAYOUT_FILE.to_string()]);
  }

  #[test]
  fn a_maximised_resize_keeps_the_size_to_restore_down_to() {
    let state = LayoutState::new(None, WindowLayout::new(1060.0, 640.0, false));

    state.record(1200.0, 800.0, false);
    assert_eq!(state.snapshot(), WindowLayout::new(1200.0, 800.0, false));

    // Maximising resizes the window to the work area; that size must not become
    // the one the operator gets back when they restore down.
    state.record(2560.0, 1392.0, true);
    assert_eq!(state.snapshot(), WindowLayout::new(1200.0, 800.0, true));

    state.record(1200.0, 800.0, false);
    assert_eq!(state.snapshot(), WindowLayout::new(1200.0, 800.0, false));
  }

  #[test]
  fn a_minimise_sized_event_is_ignored() {
    let state = LayoutState::new(None, WindowLayout::new(1060.0, 640.0, false));
    // Windows reports 0x0 when a window is minimised.
    state.record(0.0, 0.0, false);
    assert_eq!(state.snapshot(), WindowLayout::new(1060.0, 640.0, false));
  }

  #[test]
  fn a_state_with_no_path_still_answers_the_frontend() {
    let state = LayoutState::new(None, WindowLayout::new(1060.0, 640.0, false));
    assert_eq!(state.sidebar_width(), DEFAULT_SIDEBAR_WIDTH);
    assert_eq!(state.set_sidebar_width(5000.0), Ok(MAX_SIDEBAR_WIDTH));
    state.persist();
  }

  #[test]
  fn the_managed_state_round_trips_both_sections() {
    let scratch = Scratch::new("managed");
    let path = scratch.file();

    let state = LayoutState::new(Some(path.clone()), WindowLayout::new(1060.0, 640.0, false));
    state.record(1440.0, 900.0, false);
    state.persist();
    assert_eq!(state.set_sidebar_width(360.0), Ok(360.0));

    let reopened = LayoutState::new(Some(path.clone()), WindowLayout::new(1060.0, 640.0, false));
    assert_eq!(reopened.sidebar_width(), 360.0);
    assert_eq!(
      load_window(&path),
      Some(WindowLayout::new(1440.0, 900.0, false))
    );
  }
}
