//! System tray icon — the native replacement for `agent/src/owlette_tray.py`.
//!
//! The service launches this app with `--tray` and expects a notification-area
//! icon that survives with no window on screen, so the semantics here are ported
//! from pystray rather than reinvented:
//!
//! * **Status** comes from `tmp/service_status.json`, read without the JSON
//!   mutex exactly like `owlette_tray.read_service_status` (:234-293), and a
//!   file older than 120 s means the service is not writing, whatever the SCM
//!   says. A read that fails mid-rename falls back to the last good document for
//!   60 s so the icon does not flicker on every service write.
//! * **Icon** encodes that status: amber when connected, dim when the cloud is
//!   unreachable, and a red flash at 800 ms when the service is stopped or a
//!   health probe failed (`owlette_tray._start_flash`, :46-76).
//! * **Toasts** fire only after a degraded state has persisted for 5 s and only
//!   once per episode, with a 10 s grace period after launch — the debounce that
//!   stopped the python tray spamming during a service rewrite
//!   (`_NOTIFY_DELAY`, :41-44 and :681-691).
//!
//! Two deliberate departures from the python tray:
//!
//! * "start on login" manages the `{userstartup}` shortcut (see
//!   [`crate::startup_link`]) instead of the service start type, so it costs no
//!   UAC prompt and cannot leave the machine unsupervised.
//! * "restart service" leaves this app running. pystray had to stop its icon
//!   because the service relaunched the tray as a fresh process; the desktop app
//!   is a single instance, so the service's post-restart launch is folded back
//!   into this one and the menu stays available throughout.
//!
//! Every menu action runs on its own short-lived thread. Menu events arrive on
//! the main thread, and both the tray setters and the window setters marshal
//! back to it, so doing the work inline would block the event loop for as long
//! as an SCM call or a UAC prompt takes.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::paths::{
  self, AGENT_VERSION_REL, GUI_PID_REL, RESTART_FLAG_REL, SERVICE_STATUS_REL, TRAY_PID_REL,
};
use crate::pid_file;
use crate::service_ctl;
use crate::startup_link;

/// Identity of the tray icon, used to fetch it back from an app handle.
const TRAY_ID: &str = "owlette";

const ID_OPEN: &str = "open";
const ID_RESTART: &str = "restart";
const ID_START_ON_LOGIN: &str = "start_on_login";
const ID_EXIT: &str = "exit";

/// Icons, downsampled to 64 px from `agent/icons/*.png` — the same amber owl eye
/// the python tray shows, so the notification area does not change appearance
/// when a machine is upgraded. They are embedded rather than read from
/// `{app}\agent\icons` so the app still has an icon when the agent tree is
/// missing.
const ICON_NORMAL: &[u8] = include_bytes!("../icons/tray/normal.png");
const ICON_DISCONNECTED: &[u8] = include_bytes!("../icons/tray/disconnected.png");
const ICON_ERROR: &[u8] = include_bytes!("../icons/tray/error.png");

/// Monitor granularity. The two cadences below are multiples of it, so one
/// thread drives both the status poll and the error flash.
const TICK: Duration = Duration::from_millis(200);
/// Status re-read cadence (`owlette_tray.monitor_status` sleeps 1 s).
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Half-period of the error flash (`_start_flash` waits 0.8 s per swap).
const FLASH_PERIOD: Duration = Duration::from_millis(800);
/// How long a degraded state must persist before it is worth a toast.
const NOTIFY_DELAY: Duration = Duration::from_secs(5);
/// Silence window after launch, so a service still starting is not an incident.
const NOTIFY_GRACE: Duration = Duration::from_secs(10);
/// How long a cached status document stays usable after a failed read.
const STATUS_CACHE_TTL: Duration = Duration::from_secs(60);
/// Pause between issuing the elevated stop and quitting, so the operator sees a
/// clean transition rather than the icon vanishing first (`exit_action`, :557).
const EXIT_SETTLE: Duration = Duration::from_secs(2);

/// Overall health, in the three buckets the icon can show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusCode {
  /// Service running and reaching the cloud.
  Normal,
  /// Service running, cloud unreachable.
  Warning,
  /// Service stopped, or a health probe failed.
  Error,
}

impl StatusCode {
  fn icon_bytes(self) -> &'static [u8] {
    match self {
      StatusCode::Normal => ICON_NORMAL,
      StatusCode::Warning => ICON_DISCONNECTED,
      StatusCode::Error => ICON_ERROR,
    }
  }
}

/// Everything the tray displays, as one comparable value: recomputing it each
/// second and diffing is what keeps the menu from being rebuilt 60 times a
/// minute (the python tray rebuilt unconditionally).
#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayView {
  code: StatusCode,
  /// `service: running` / `service: stopped` / `service: error`.
  service: String,
  /// `status: connected` / `status: disconnected` / `status: auth_error` / …
  status: String,
  /// Human-readable health-probe message, when there is one.
  health: Option<String>,
  start_on_login: bool,
}

/// The live menu, kept so the common case is a text update rather than a
/// rebuild. The whole menu is rebuilt only when the health row appears or
/// disappears, because muda has no way to hide an item in place.
struct TrayMenu {
  menu: Menu<Wry>,
  service: MenuItem<Wry>,
  status: MenuItem<Wry>,
  health: Option<MenuItem<Wry>>,
  start_on_login: CheckMenuItem<Wry>,
}

/// Managed state: the menu handles plus the monitor thread's stop flag.
pub struct TrayState {
  menu: Mutex<TrayMenu>,
  stop: Arc<AtomicBool>,
}

/// Build the tray icon and start the status monitor.
///
/// Called from `setup`, so a failure here is reported to the caller: a tray app
/// with no tray icon has no way back to its window.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
  let root = paths::data_root();
  let view = TrayView {
    code: StatusCode::Warning,
    service: "service: checking...".to_string(),
    status: "status: checking...".to_string(),
    health: None,
    start_on_login: startup_link::is_enabled(),
  };

  let menu = build_menu(app, &view)?;
  let tray = TrayIconBuilder::with_id(TRAY_ID)
    .icon(icon_for(view.code))
    .tooltip(tooltip(&root, &view))
    .menu(&menu.menu)
    // Left click opens the window; the menu is the right-click surface. Windows
    // defaults to showing the menu on either button, which would leave the app
    // with no one-click way back to its window.
    .show_menu_on_left_click(false)
    .build(app)?;

  tray.on_menu_event(|app, event| {
    let app = app.clone();
    let id = event.id().0.clone();
    // Menu events arrive on the main thread and the handlers below block on the
    // SCM, on a UAC prompt and on the tray setters (which marshal back here).
    spawn_action("menu", move || handle_menu_event(&app, &id));
  });

  tray.on_tray_icon_event(|tray, event| {
    if let TrayIconEvent::Click {
      button: MouseButton::Left,
      button_state: MouseButtonState::Up,
      ..
    } = event
    {
      let app = tray.app_handle().clone();
      spawn_action("open", move || show_main_window(&app));
    }
  });

  let stop = Arc::new(AtomicBool::new(false));
  app.manage(TrayState {
    menu: Mutex::new(menu),
    stop: Arc::clone(&stop),
  });

  let handle = app.clone();
  thread::Builder::new()
    .name("owlette-tray".into())
    .spawn(move || monitor(handle, stop))?;

  Ok(())
}

/// Ask the monitor thread to stop. Called from `RunEvent::Exit`, before the app
/// handle it holds is torn down.
pub fn shutdown(app: &AppHandle) {
  if let Some(state) = app.try_state::<TrayState>() {
    state.stop.store(true, Ordering::Relaxed);
  }
}

/// Show and focus the main window, and publish `tmp/gui.pid` so the service
/// raises its metrics cadence while the operator is watching.
pub fn show_main_window(app: &AppHandle) {
  let Some(window) = app.get_webview_window("main") else {
    log::warn!("no main window to show");
    return;
  };
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();

  match pid_file::write(&paths::data_root(), GUI_PID_REL) {
    Ok(path) => log::info!("wrote {}", path.display()),
    Err(error) => log::warn!("could not write the gui pid file: {error}"),
  }
}

/// Hide the main window back to the tray and drop `tmp/gui.pid`.
pub fn hide_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.hide();
  }
  pid_file::remove(&paths::data_root(), GUI_PID_REL);
}

// ─── monitor ────────────────────────────────────────────────────────────────

fn monitor(app: AppHandle, stop: Arc<AtomicBool>) {
  let root = paths::data_root();
  let started = Instant::now();

  let mut current: Option<TrayView> = None;
  let mut cached_status: Option<(Value, Instant)> = None;
  let mut last_poll: Option<Instant> = None;
  let mut last_flash = Instant::now();
  let mut flash_dim = false;
  let mut degraded_since: Option<Instant> = None;
  let mut degraded_notified = false;

  while !stop.load(Ordering::Relaxed) {
    let now = Instant::now();

    if last_poll.map_or(true, |at| now.duration_since(at) >= POLL_INTERVAL) {
      last_poll = Some(now);

      let status_data = read_status_file(&root, &mut cached_status);
      let status = determine_status(status_data.as_ref(), || {
        service_ctl::status(&root.join(SERVICE_STATUS_REL))
          .map(|status| status.running)
          .unwrap_or(false)
      });
      let view = TrayView {
        code: status.code,
        service: status.service,
        status: status.status,
        health: status.health,
        start_on_login: startup_link::is_enabled(),
      };

      if current.as_ref() != Some(&view) {
        let previous = current.replace(view.clone());
        if previous.map(|view| view.code) != Some(view.code) {
          // Restart the flash cycle from a known phase on every code change, so
          // a transition into error shows the alert frame immediately.
          flash_dim = false;
          last_flash = now;
          set_icon(&app, view.code);
        }
        apply(&app, &root, &view);
      }

      // Degraded-state debounce, ported from `monitor_status`: notify once the
      // state has held for NOTIFY_DELAY, once per episode, and never during the
      // startup grace period.
      if view.code == StatusCode::Normal {
        if degraded_notified && now.duration_since(started) > NOTIFY_GRACE {
          notify(
            &app,
            "owlette — back online",
            "service running normally.".to_string(),
          );
        }
        degraded_since = None;
        degraded_notified = false;
      } else {
        let since = *degraded_since.get_or_insert(now);
        if !degraded_notified
          && now.duration_since(since) >= NOTIFY_DELAY
          && now.duration_since(started) > NOTIFY_GRACE
        {
          degraded_notified = true;
          let (title, body) = degraded_notification(&view);
          notify(&app, title, body);
        }
      }
    }

    // Flash only in the error state; the other two are solid.
    let in_error = current.as_ref().map(|view| view.code) == Some(StatusCode::Error);
    if in_error {
      if now.duration_since(last_flash) >= FLASH_PERIOD {
        last_flash = now;
        flash_dim = !flash_dim;
        set_icon(
          &app,
          if flash_dim {
            StatusCode::Normal
          } else {
            StatusCode::Error
          },
        );
      }
    } else if flash_dim {
      flash_dim = false;
    }

    thread::sleep(TICK);
  }

  log::debug!("tray monitor stopped");
}

/// Push a view onto the tray: menu text (or a rebuild), then the tooltip.
fn apply(app: &AppHandle, root: &Path, view: &TrayView) {
  let Some(tray) = app.tray_by_id(TRAY_ID) else {
    return;
  };
  let Some(state) = app.try_state::<TrayState>() else {
    return;
  };

  match state.menu.lock() {
    Ok(mut menu) => {
      if menu.health.is_some() != view.health.is_some() {
        match build_menu(app, view) {
          Ok(rebuilt) => {
            if let Err(error) = tray.set_menu(Some(rebuilt.menu.clone())) {
              log::warn!("could not swap the tray menu: {error}");
            }
            *menu = rebuilt;
          }
          Err(error) => log::warn!("could not rebuild the tray menu: {error}"),
        }
      } else {
        let _ = menu.service.set_text(&view.service);
        let _ = menu.status.set_text(&view.status);
        if let (Some(item), Some(text)) = (&menu.health, &view.health) {
          let _ = item.set_text(text);
        }
        let _ = menu.start_on_login.set_checked(view.start_on_login);
      }
    }
    Err(error) => log::error!("tray menu lock poisoned: {error}"),
  }

  if let Err(error) = tray.set_tooltip(Some(tooltip(root, view))) {
    log::warn!("could not set the tray tooltip: {error}");
  }
}

fn set_icon(app: &AppHandle, code: StatusCode) {
  let Some(tray) = app.tray_by_id(TRAY_ID) else {
    return;
  };
  if let Err(error) = tray.set_icon(Some(icon_for(code))) {
    log::warn!("could not set the tray icon: {error}");
  }
}

fn icon_for(code: StatusCode) -> Image<'static> {
  // The bytes are compiled in and were decoded during the build of this file's
  // tests, so a failure here is a packaging bug, not a runtime condition.
  Image::from_bytes(code.icon_bytes()).expect("embedded tray icon should decode")
}

// ─── status ─────────────────────────────────────────────────────────────────

/// Outcome of one status evaluation.
struct Status {
  code: StatusCode,
  service: String,
  status: String,
  health: Option<String>,
}

/// Read `tmp/service_status.json` outside the JSON mutex, mirroring
/// `owlette_tray.read_service_status`.
///
/// A file older than 120 s reads as absent — the service refreshes it on a 30 s
/// throttle, so anything older means nothing is writing it. A transient failure
/// (the service renaming over the file as we read) reuses the last good document
/// for [`STATUS_CACHE_TTL`] rather than reporting a fake "starting".
fn read_status_file(root: &Path, cache: &mut Option<(Value, Instant)>) -> Option<Value> {
  let path = root.join(SERVICE_STATUS_REL);
  let info = service_ctl::status_file_info(&path, SystemTime::now());
  if !info.exists {
    *cache = None;
    return None;
  }
  if info.stale {
    *cache = None;
    return None;
  }

  match fs::read_to_string(&path).ok().and_then(|text| {
    serde_json::from_str::<Value>(&text)
      .map_err(|error| log::debug!("torn read of {}: {error}", path.display()))
      .ok()
  }) {
    Some(value) => {
      *cache = Some((value.clone(), Instant::now()));
      Some(value)
    }
    None => match cache {
      Some((value, at)) if at.elapsed() < STATUS_CACHE_TTL => Some(value.clone()),
      _ => {
        *cache = None;
        None
      }
    },
  }
}

/// Map a status document onto the icon state and the two menu lines.
///
/// A direct port of `owlette_tray.determine_status` (:296-350), kept pure so the
/// precedence rules are testable: a failed health probe outranks everything, a
/// stopped service outranks the cloud state, and firebase being switched off
/// counts as an error because nothing is being monitored.
///
/// `service_running` is only consulted when there is no status document, which
/// is the one case where the SCM is the sole source of truth.
fn determine_status(status_data: Option<&Value>, service_running: impl FnOnce() -> bool) -> Status {
  let Some(data) = status_data else {
    return if service_running() {
      Status {
        code: StatusCode::Warning,
        service: "service: running".to_string(),
        status: "status: starting".to_string(),
        health: None,
      }
    } else {
      Status {
        code: StatusCode::Error,
        service: "service: stopped".to_string(),
        status: "status: unknown".to_string(),
        health: None,
      }
    };
  };

  let health = data.get("health");
  let health_status = health
    .and_then(|health| health.get("status"))
    .and_then(Value::as_str);
  if let Some(health_status) = health_status {
    if !matches!(health_status, "ok" | "unknown") {
      let error_code = health
        .and_then(|health| health.get("error_code"))
        .and_then(Value::as_str)
        .unwrap_or(health_status);
      let message = health
        .and_then(|health| health.get("error_message"))
        .and_then(Value::as_str)
        .unwrap_or(error_code);
      return Status {
        code: StatusCode::Error,
        service: "service: error".to_string(),
        status: format!("status: {}", error_code.to_lowercase()),
        health: Some(format!("  {}", truncate(message, 60))),
      };
    }
  }

  let service_running = data
    .get("service")
    .and_then(|service| service.get("running"))
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let firebase = data.get("firebase");
  let enabled = firebase
    .and_then(|firebase| firebase.get("enabled"))
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let connected = firebase
    .and_then(|firebase| firebase.get("connected"))
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let site_id = firebase
    .and_then(|firebase| firebase.get("site_id"))
    .and_then(Value::as_str)
    .unwrap_or("");

  let paired = enabled && !site_id.is_empty();
  let firebase_msg = if !paired {
    "disabled"
  } else if connected {
    "connected"
  } else {
    "disconnected"
  };

  let code = if !service_running || !paired {
    StatusCode::Error
  } else if connected {
    StatusCode::Normal
  } else {
    StatusCode::Warning
  };

  Status {
    code,
    service: if service_running {
      "service: running".to_string()
    } else {
      "service: stopped".to_string()
    },
    status: format!("status: {firebase_msg}"),
    health: None,
  }
}

/// Title and body for a degraded-state toast, mirroring
/// `owlette_tray.send_status_notification` and `_HEALTH_ERROR_MESSAGES`.
fn degraded_notification(view: &TrayView) -> (&'static str, String) {
  if view.code == StatusCode::Warning {
    return (
      "owlette — reconnecting",
      "cloud sync temporarily unavailable. local monitoring still active.".to_string(),
    );
  }

  match view.status.trim_start_matches("status: ") {
    "config_error" => (
      "owlette — config error",
      "config file missing or corrupted. please reinstall owlette.".to_string(),
    ),
    "auth_error" => (
      "owlette — not registered",
      "no authentication token found. please run the installer again.".to_string(),
    ),
    "network_error" => (
      "owlette — network unreachable",
      "network was not reachable at startup. check internet connection.".to_string(),
    ),
    "connection_failure" => (
      "owlette — connection failed",
      "persistent connection failures. check service logs.".to_string(),
    ),
    "fatal_error" => (
      "owlette — fatal error",
      "a fatal connection error occurred. check service logs.".to_string(),
    ),
    _ => (
      "owlette — service stopped",
      "the service may have crashed or failed to start.\nclick 'restart service' to fix."
        .to_string(),
    ),
  }
}

fn notify(app: &AppHandle, title: &str, body: String) {
  if let Err(error) = app.notification().builder().title(title).body(body).show() {
    log::warn!("could not show the tray notification: {error}");
  }
}

// ─── menu ───────────────────────────────────────────────────────────────────

fn build_menu(app: &AppHandle, view: &TrayView) -> tauri::Result<TrayMenu> {
  let root = paths::data_root();
  let version = MenuItem::with_id(
    app,
    "version",
    format!("owlette v{}", agent_version(&root)),
    false,
    None::<&str>,
  )?;
  let hostname = MenuItem::with_id(
    app,
    "hostname",
    format!("hostname: {}", hostname()),
    false,
    None::<&str>,
  )?;
  let service = MenuItem::with_id(app, "service", &view.service, false, None::<&str>)?;
  let status = MenuItem::with_id(app, "status", &view.status, false, None::<&str>)?;
  let health = match &view.health {
    Some(text) => Some(MenuItem::with_id(app, "health", text, false, None::<&str>)?),
    None => None,
  };

  let separator = PredefinedMenuItem::separator(app)?;
  let open = MenuItem::with_id(app, ID_OPEN, "open owlette", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, ID_RESTART, "restart service", true, None::<&str>)?;
  let start_on_login = CheckMenuItem::with_id(
    app,
    ID_START_ON_LOGIN,
    "start on login",
    true,
    view.start_on_login,
    None::<&str>,
  )?;
  let exit = MenuItem::with_id(app, ID_EXIT, "exit", true, None::<&str>)?;

  let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
    vec![&version, &hostname, &service, &status];
  if let Some(health) = &health {
    items.push(health);
  }
  items.extend([
    &separator as &dyn tauri::menu::IsMenuItem<Wry>,
    &open,
    &restart,
    &start_on_login,
    &exit,
  ]);

  let menu = Menu::with_items(app, &items)?;

  Ok(TrayMenu {
    menu,
    service,
    status,
    health,
    start_on_login,
  })
}

fn tooltip(root: &Path, view: &TrayView) -> String {
  format!(
    "owlette v{}\nhostname: {}\n{}\n{}",
    agent_version(root),
    hostname(),
    view.service,
    view.status
  )
}

/// Version of the agent this app is installed alongside.
///
/// The tray header is the operator's answer to "what is deployed on this box",
/// which is the agent's version, not this crate's — they are released together
/// but only the agent's is baked into the fleet's records. Falls back to the
/// crate version when the agent tree is missing (a standalone dev run).
fn agent_version(root: &Path) -> String {
  fs::read_to_string(root.join(AGENT_VERSION_REL))
    .map(|text| text.trim().to_string())
    .ok()
    .filter(|version| !version.is_empty())
    .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

pub(crate) fn hostname() -> String {
  std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string())
}

fn truncate(text: &str, limit: usize) -> String {
  if text.chars().count() <= limit {
    return text.to_string();
  }
  let head: String = text.chars().take(limit.saturating_sub(3)).collect();
  format!("{head}...")
}

// ─── actions ────────────────────────────────────────────────────────────────

fn spawn_action<F>(label: &'static str, action: F)
where
  F: FnOnce() + Send + 'static,
{
  if let Err(error) = thread::Builder::new()
    .name(format!("owlette-tray-{label}"))
    .spawn(action)
  {
    log::error!("could not run the {label} tray action: {error}");
  }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
  match id {
    ID_OPEN => show_main_window(app),
    ID_RESTART => restart_service(app),
    ID_START_ON_LOGIN => toggle_start_on_login(app),
    ID_EXIT => exit_owlette(app),
    // The four header rows are disabled, so they never raise an event; anything
    // else is a menu item someone added without a handler.
    other => log::debug!("unhandled tray menu id: {other}"),
  }
}

/// Restart the service without a UAC prompt.
///
/// A running service is asked to exit 42 through `tmp/restart.flag`, which NSSM
/// turns into an automatic restart. A *stopped* service cannot read the flag —
/// there is no loop to read it — so it is started directly instead, which is the
/// one path that can raise an elevation prompt (`owlette_tray.restart_service`,
/// :443-511).
fn restart_service(app: &AppHandle) {
  let root = paths::data_root();
  let running = service_ctl::status(&root.join(SERVICE_STATUS_REL))
    .map(|status| status.running)
    .unwrap_or(false);

  if !running {
    log::info!("service is stopped — starting it instead of writing the restart flag");
    match service_ctl::start() {
      Ok(outcome) => {
        log::info!("service start issued ({})", outcome.method);
        notify(
          app,
          "owlette — starting",
          "starting service — will return momentarily".to_string(),
        );
      }
      Err(error) => {
        log::error!("could not start the service: {error}");
        notify(app, "restart failed", error);
      }
    }
    return;
  }

  let flag = root.join(RESTART_FLAG_REL);
  let written = flag
    .parent()
    .map(fs::create_dir_all)
    .unwrap_or(Ok(()))
    .and_then(|()| fs::write(&flag, "restart_requested"));

  match written {
    Ok(()) => {
      log::info!("restart flag written — the service will restart via NSSM");
      notify(
        app,
        "owlette — restarting",
        "restarting service — will return momentarily".to_string(),
      );
    }
    Err(error) => {
      log::error!("could not write {}: {error}", flag.display());
      notify(app, "restart failed", error.to_string());
    }
  }
}

fn toggle_start_on_login(app: &AppHandle) {
  let enabled = startup_link::is_enabled();
  let result = if enabled {
    startup_link::disable()
  } else {
    startup_link::enable().map(|path| log::info!("wrote {}", path.display()))
  };

  if let Err(error) = result {
    log::error!("could not change the start-on-login shortcut: {error}");
    notify(app, "owlette — start on login", error);
  }

  // muda toggles the tick itself on click, so resync it against what is actually
  // on disk — otherwise a failed write leaves the menu lying.
  if let Some(state) = app.try_state::<TrayState>() {
    if let Ok(menu) = state.menu.lock() {
      let _ = menu.start_on_login.set_checked(startup_link::is_enabled());
    }
  }
}

/// Quit owlette: stop supervising the machine, then quit the app.
///
/// Stopping the service is the point of this item — NSSM restarts the service on
/// any process exit, so the only way to actually stop owlette is a controlled
/// SCM stop, which needs rights this process usually lacks. We quit either way,
/// matching `owlette_tray.exit_action`: if the operator declines the prompt the
/// service stays up and relaunches the tray within its cooldown.
fn exit_owlette(app: &AppHandle) {
  hide_main_window(app);

  match service_ctl::stop() {
    Ok(outcome) => log::info!("service stop issued ({})", outcome.method),
    Err(error) => log::error!("could not stop the service on exit: {error}"),
  }

  thread::sleep(EXIT_SETTLE);
  app.exit(0);
}

// ─── shutdown helper ────────────────────────────────────────────────────────

/// Drop both pid markers. Called on `RunEvent::Exit`.
pub fn clear_pid_markers() {
  let root = paths::data_root();
  pid_file::remove(&root, GUI_PID_REL);
  pid_file::remove(&root, TRAY_PID_REL);
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn never_asked() -> bool {
    panic!("the SCM must not be queried when a status document is available");
  }

  #[test]
  fn every_embedded_icon_decodes() {
    for code in [StatusCode::Normal, StatusCode::Warning, StatusCode::Error] {
      let image = Image::from_bytes(code.icon_bytes()).expect("icon should decode");
      assert_eq!((image.width(), image.height()), (64, 64));
    }
  }

  #[test]
  fn a_missing_status_document_falls_back_to_the_scm() {
    let stopped = determine_status(None, || false);
    assert_eq!(stopped.code, StatusCode::Error);
    assert_eq!(stopped.service, "service: stopped");

    let starting = determine_status(None, || true);
    assert_eq!(starting.code, StatusCode::Warning);
    assert_eq!(starting.status, "status: starting");
  }

  #[test]
  fn a_connected_service_is_normal() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });
    let status = determine_status(Some(&data), never_asked);
    assert_eq!(status.code, StatusCode::Normal);
    assert_eq!(status.service, "service: running");
    assert_eq!(status.status, "status: connected");
    assert!(status.health.is_none());
  }

  #[test]
  fn a_disconnected_cloud_is_a_warning_not_an_error() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": false, "site_id": "hq" }
    });
    let status = determine_status(Some(&data), never_asked);
    assert_eq!(status.code, StatusCode::Warning);
    assert_eq!(status.status, "status: disconnected");
  }

  #[test]
  fn an_unpaired_machine_is_an_error_because_nothing_is_monitored() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "" }
    });
    let status = determine_status(Some(&data), never_asked);
    assert_eq!(status.code, StatusCode::Error);
    assert_eq!(status.status, "status: disabled");
  }

  #[test]
  fn a_failed_health_probe_outranks_a_healthy_connection() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "error", "error_code": "auth_error", "error_message": "no token" }
    });
    let status = determine_status(Some(&data), never_asked);
    assert_eq!(status.code, StatusCode::Error);
    assert_eq!(status.service, "service: error");
    assert_eq!(status.status, "status: auth_error");
    assert_eq!(status.health.as_deref(), Some("  no token"));
  }

  #[test]
  fn a_long_health_message_is_truncated_for_the_menu() {
    let message = "x".repeat(200);
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "error", "error_code": "config_error", "error_message": message }
    });
    let status = determine_status(Some(&data), never_asked);
    let row = status.health.expect("health row");
    assert_eq!(row.chars().count(), 62, "two leading spaces plus 60");
    assert!(row.ends_with("..."));
  }

  #[test]
  fn health_error_codes_map_to_their_own_toast() {
    let view = |status: &str, code: StatusCode| TrayView {
      code,
      service: "service: error".to_string(),
      status: status.to_string(),
      health: None,
      start_on_login: false,
    };

    let (title, _) = degraded_notification(&view("status: auth_error", StatusCode::Error));
    assert_eq!(title, "owlette — not registered");

    let (title, _) = degraded_notification(&view("status: unknown", StatusCode::Error));
    assert_eq!(title, "owlette — service stopped");

    let (title, _) = degraded_notification(&view("status: disconnected", StatusCode::Warning));
    assert_eq!(title, "owlette — reconnecting");
  }

  #[test]
  fn a_stale_status_file_reads_as_absent() {
    let dir = std::env::temp_dir().join(format!("owlette-tray-status-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("tmp")).expect("scratch");

    let mut cache = None;
    assert!(
      read_status_file(&dir, &mut cache).is_none(),
      "a missing file must not read as a status"
    );

    fs::write(
      dir.join(SERVICE_STATUS_REL),
      r#"{"service":{"running":true}}"#,
    )
    .expect("seed");
    assert!(read_status_file(&dir, &mut cache).is_some());

    // A torn read rides on the cached document rather than reporting nothing.
    fs::write(dir.join(SERVICE_STATUS_REL), "{\"service\":").expect("tear");
    assert!(
      read_status_file(&dir, &mut cache).is_some(),
      "a torn read should fall back to the cached document"
    );

    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn the_agent_version_falls_back_to_the_crate_version() {
    let dir = std::env::temp_dir().join(format!("owlette-tray-version-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch");
    assert_eq!(agent_version(&dir), env!("CARGO_PKG_VERSION"));

    fs::create_dir_all(dir.join("agent")).expect("agent dir");
    fs::write(dir.join(AGENT_VERSION_REL), "2.12.21\n").expect("seed");
    assert_eq!(agent_version(&dir), "2.12.21");

    let _ = fs::remove_dir_all(&dir);
  }
}
