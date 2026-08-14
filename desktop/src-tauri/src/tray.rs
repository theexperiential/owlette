//! System tray icon — the native replacement for `agent/src/owlette_tray.py`.
//!
//! The service launches this app with `--tray` and expects a notification-area
//! icon that survives with no window on screen, so the semantics here are ported
//! from pystray rather than reinvented:
//!
//! * **Status** comes from the SCM's view of `OwletteService` plus
//!   `tmp/service_status.json`, read without the JSON mutex exactly like
//!   `owlette_tray.read_service_status` (:234-293). A file older than 120 s
//!   means the service is not publishing, and the SCM outranks the file in
//!   both directions.
//!
//!   What the operator *reads* — the tooltip and the four status rows — is
//!   always live, and derives from those two inputs with the same semantics as
//!   the window footer's `serviceHealth.deriveFooterState`. What the operator
//!   *sees* — the icon's error flash and the toasts — keeps the 60 s last-good
//!   fallback and the debounces below, whose purpose is not to flap on a read
//!   that caught the service renaming the file. Mixing the two is how the
//!   tooltip came to say "service: running / status: connected" while the
//!   footer, on the same screen, said "service not running on TEC-A4D".
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
  /// `status: connected to TEC` / `status: disconnected from TEC` /
  /// `status: auth_error` / …
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

      // Asked every poll rather than only when the document is missing: it is
      // the one input that cannot be out of date, and the text below is not
      // allowed to contradict it.
      let scm_running = service_ctl::status(&root.join(SERVICE_STATUS_REL))
        .map(|status| status.running)
        .unwrap_or(false);

      let live = read_status_doc(&root);
      // Two evaluations of the same rules over two documents, because the two
      // halves of the tray answer to different masters. What the operator reads
      // must be live: the tooltip and the status rows are the same claim the
      // window footer makes and have to agree with it. What the operator sees
      // — the icon's error flash, and the toasts — keeps the smoothing, whose
      // whole purpose is to not flap on a read that caught a rename.
      let text = determine_status(&live, scm_running);
      let signal = determine_status(&smoothed(&live, &mut cached_status), scm_running);

      let view = TrayView {
        code: signal.code,
        service: text.service,
        status: text.status,
        health: text.health,
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

      // Degraded-state debounce, ported from `monitor_status` and then
      // narrowed (2026-08-14): only the ERROR tier toasts. A Warning — cloud
      // unreachable while the service runs, which is what every routine
      // restart looks like for a few seconds — shows in the icon and tooltip
      // but never notifies; three queued toasts per restart taught us why.
      // Recovery toasts only close a real Error episode, and only once the
      // state is genuinely Normal again (not merely upgraded to Warning).
      match view.code {
        StatusCode::Normal => {
          if degraded_notified && now.duration_since(started) > NOTIFY_GRACE {
            notify(
              &app,
              "owlette — back online",
              "service running normally.".to_string(),
            );
          }
          degraded_since = None;
          degraded_notified = false;
        }
        StatusCode::Warning => {
          // Icon-only tier: Warning time never accrues toward an Error toast,
          // and an open Error episode stays open until genuinely Normal.
          degraded_since = None;
        }
        StatusCode::Error => {
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

/// What `tmp/service_status.json` had to say, and whether it is worth believing.
///
/// The three failure shapes were collapsed into one `None` before, which is how
/// a service that had stopped publishing came to read as "starting" forever.
#[derive(Clone, Debug, PartialEq)]
enum StatusDoc {
  /// A document written within the freshness window.
  Fresh(Value),
  /// The file exists but has not been rewritten for over 120 s. The service
  /// refreshes it on a 30 s throttle, so nothing is publishing.
  Stale,
  /// No file at all — the service has not written one yet this run.
  Missing,
  /// The file could not be parsed. Almost always a read that caught the
  /// service renaming over it, and gone by the next tick.
  Unreadable,
}

/// Read `tmp/service_status.json` outside the JSON mutex, mirroring
/// `owlette_tray.read_service_status`.
fn read_status_doc(root: &Path) -> StatusDoc {
  let path = root.join(SERVICE_STATUS_REL);
  let info = service_ctl::status_file_info(&path, SystemTime::now());
  if !info.exists {
    return StatusDoc::Missing;
  }
  if info.stale {
    return StatusDoc::Stale;
  }

  match fs::read_to_string(&path).ok().and_then(|text| {
    serde_json::from_str::<Value>(&text)
      .map_err(|error| log::debug!("torn read of {}: {error}", path.display()))
      .ok()
  }) {
    Some(value) => StatusDoc::Fresh(value),
    None => StatusDoc::Unreadable,
  }
}

/// The same document, with a torn read papered over by the last good one.
///
/// This is the only place [`STATUS_CACHE_TTL`] is still allowed to matter, and
/// only the icon and the toasts may use the result: smoothing a sub-second
/// re-read is worth it to keep the icon from flashing, but the same smoothing
/// applied to the tooltip is what let it claim a connected service while the
/// window footer — reading the SCM directly — said the service was not running.
fn smoothed(doc: &StatusDoc, cache: &mut Option<(Value, Instant)>) -> StatusDoc {
  match doc {
    StatusDoc::Fresh(value) => {
      *cache = Some((value.clone(), Instant::now()));
      doc.clone()
    }
    StatusDoc::Unreadable => match cache {
      Some((value, at)) if at.elapsed() < STATUS_CACHE_TTL => StatusDoc::Fresh(value.clone()),
      _ => {
        *cache = None;
        StatusDoc::Unreadable
      }
    },
    // A missing or stale file is a verdict, not a failed read; there is nothing
    // to smooth and holding on to the old document would only delay it.
    _ => {
      *cache = None;
      doc.clone()
    }
  }
}

/// Map the SCM state and a status document onto the icon state and menu lines.
///
/// Ported from `owlette_tray.determine_status` (:296-350) and then corrected on
/// one point of policy: the SCM is consulted *first*, on every evaluation, not
/// only when the document is missing. The old order let the document speak for
/// a service it could not see, so a service that was terminated without writing
/// its shutdown status kept the tray saying "service: running / status:
/// connected" for the whole two-minute freshness window while the window footer
/// said "service not running on <host>". They now answer the same question the
/// same way — `serviceHealth.deriveFooterState` checks `isServiceDown` before
/// anything else, and so does this.
///
/// After that the original precedence stands: a failed health probe outranks
/// everything, a stopped service outranks the cloud state, and firebase being
/// switched off counts as an error because nothing is being monitored.
fn determine_status(doc: &StatusDoc, service_running: bool) -> Status {
  // The SCM's verdict outranks the file's, in both directions.
  if !service_running {
    return Status {
      code: StatusCode::Error,
      service: "service: stopped".to_string(),
      status: "status: unknown".to_string(),
      health: None,
    };
  }

  let data = match doc {
    StatusDoc::Fresh(data) => data,
    // Running by the SCM, but nothing has been published for over two minutes:
    // the same "running but wedged" the footer reports rather than a service
    // that is merely slow to start.
    StatusDoc::Stale => {
      return Status {
        code: StatusCode::Error,
        service: "service: running".to_string(),
        status: "status: not responding".to_string(),
        health: None,
      }
    }
    // No file yet this run — the service really is starting.
    StatusDoc::Missing | StatusDoc::Unreadable => {
      return Status {
        code: StatusCode::Warning,
        service: "service: running".to_string(),
        status: "status: starting".to_string(),
        health: None,
      }
    }
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
  // The site's display name, when the service has been able to resolve it.
  // Same document, same write, so the two can never describe different sites —
  // unlike the window, which has config.json as a second opinion and has to
  // reconcile them (`serviceHealth.siteNameOf`).
  let site_name = firebase
    .and_then(|firebase| firebase.get("site_name"))
    .and_then(Value::as_str)
    .filter(|name| !name.is_empty())
    .unwrap_or(site_id);

  let paired = enabled && !site_id.is_empty();
  // "connected to TEC" rather than a bare "connected": this row and the tooltip
  // are the same claim the window footer makes ("TEC-A4D is connected to TEC"),
  // and an operator comparing the two should read the same sentence. An
  // unpaired machine names no site because there is none to name.
  let firebase_msg = if !paired {
    "disabled".to_string()
  } else if connected {
    format!("connected to {}", truncate(site_name, 40))
  } else {
    format!("disconnected from {}", truncate(site_name, 40))
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

  /// The SCM says the service is up, which is the precondition for the document
  /// being consulted at all.
  const RUNNING: bool = true;
  const STOPPED: bool = false;

  fn fresh(value: Value) -> StatusDoc {
    StatusDoc::Fresh(value)
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
    let stopped = determine_status(&StatusDoc::Missing, STOPPED);
    assert_eq!(stopped.code, StatusCode::Error);
    assert_eq!(stopped.service, "service: stopped");

    let starting = determine_status(&StatusDoc::Missing, RUNNING);
    assert_eq!(starting.code, StatusCode::Warning);
    assert_eq!(starting.status, "status: starting");
  }

  #[test]
  fn a_stopped_service_is_reported_stopped_however_healthy_the_document_looks() {
    // The 2026-08-13 regression: the agent was terminated without writing its
    // shutdown status, so a perfectly healthy document sat there for the whole
    // two-minute freshness window. The footer read the SCM and said "service
    // not running on TEC-A4D"; the tooltip read the file and said the opposite.
    let healthy = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });

    let status = determine_status(&fresh(healthy), STOPPED);

    assert_eq!(status.service, "service: stopped");
    assert_eq!(status.status, "status: unknown");
    assert_eq!(status.code, StatusCode::Error);
    assert!(status.health.is_none());
  }

  #[test]
  fn a_stopped_service_outranks_even_a_failed_health_probe() {
    // deriveFooterState checks isServiceDown before it looks at health, and the
    // two surfaces have to answer the same question the same way.
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "error", "error_code": "auth_error", "error_message": "no token" }
    });

    let status = determine_status(&fresh(data), STOPPED);

    assert_eq!(status.service, "service: stopped");
    assert!(
      status.health.is_none(),
      "no health row for a service that is not running"
    );
  }

  #[test]
  fn the_text_is_live_even_while_the_icon_is_still_smoothed() {
    // The policy split, stated as a test: the cached document may keep the icon
    // steady across a torn read, and must never put words in the tooltip about
    // a service the SCM says is stopped.
    let mut cache = None;
    let healthy = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });

    // A good read while everything is up primes the cache.
    let primed = smoothed(&fresh(healthy), &mut cache);
    assert_eq!(
      determine_status(&primed, RUNNING).status,
      "status: connected to hq"
    );
    assert!(
      cache.is_some(),
      "a good read should be remembered for the icon"
    );

    // The service is stopped and the next read is torn. The icon path still has
    // its cached document — and both halves must now say stopped anyway.
    let live = StatusDoc::Unreadable;
    let icon_doc = smoothed(&live, &mut cache);
    assert!(
      matches!(icon_doc, StatusDoc::Fresh(_)),
      "the icon keeps its smoothing"
    );

    let text = determine_status(&live, STOPPED);
    assert_eq!(text.service, "service: stopped");
    assert_eq!(text.status, "status: unknown");
  }

  #[test]
  fn a_service_that_stopped_publishing_is_not_reported_as_starting() {
    // "starting" is for a service with no file yet. A file that has gone stale
    // means the service is wedged, which is what the footer calls out, and
    // saying "starting" about it for the rest of the machine's uptime is the
    // smoothing this fix removes.
    let stale = determine_status(&StatusDoc::Stale, RUNNING);
    assert_eq!(stale.code, StatusCode::Error);
    assert_eq!(stale.service, "service: running");
    assert_eq!(stale.status, "status: not responding");
  }

  #[test]
  fn a_stale_document_is_never_smoothed_over() {
    // Staleness is a verdict, not a failed read — holding the last good
    // document would only delay it.
    let mut cache = None;
    let healthy = json!({ "service": { "running": true } });
    smoothed(&fresh(healthy), &mut cache);
    assert!(cache.is_some());

    assert_eq!(smoothed(&StatusDoc::Stale, &mut cache), StatusDoc::Stale);
    assert!(cache.is_none(), "the cache must be dropped, not consulted");
  }

  #[test]
  fn a_connected_service_is_normal() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "hq" },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.code, StatusCode::Normal);
    assert_eq!(status.service, "service: running");
    // No name published: the id still says which site, and never nothing.
    assert_eq!(status.status, "status: connected to hq");
    assert!(status.health.is_none());
  }

  #[test]
  fn the_site_is_named_the_way_the_operator_names_it() {
    // The same sentence the window footer builds — "TEC-A4D is connected to
    // TEC" — so an operator comparing the tooltip with the footer reads one
    // claim, not two.
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": true,
        "site_id": "default_site", "site_name": "TEC"
      },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.status, "status: connected to TEC");
  }

  #[test]
  fn an_empty_site_name_falls_back_to_the_id() {
    // What an agent that could not read its site document publishes.
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": true,
        "site_id": "default_site", "site_name": ""
      },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.status, "status: connected to default_site");
  }

  #[test]
  fn an_absurd_site_name_cannot_run_away_with_the_row() {
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": true,
        "site_id": "hq", "site_name": "x".repeat(200)
      },
      "health": { "status": "ok" }
    });
    let status = determine_status(&fresh(data), RUNNING);
    let name = status
      .status
      .strip_prefix("status: connected to ")
      .expect("connected row");
    assert_eq!(name.chars().count(), 40, "37 plus the ellipsis");
    assert!(name.ends_with("..."));
  }

  #[test]
  fn a_disconnected_cloud_is_a_warning_not_an_error() {
    let data = json!({
      "service": { "running": true },
      "firebase": {
        "enabled": true, "connected": false,
        "site_id": "default_site", "site_name": "TEC"
      }
    });
    let status = determine_status(&fresh(data), RUNNING);
    assert_eq!(status.code, StatusCode::Warning);
    // "from", matching the footer's disconnected sentence.
    assert_eq!(status.status, "status: disconnected from TEC");
  }

  #[test]
  fn a_reconnecting_toast_survives_the_site_being_named() {
    // The toast text is chosen from the status row, so anything appended to it
    // has to leave the mapping intact.
    let view = TrayView {
      code: StatusCode::Warning,
      service: "service: running".to_string(),
      status: "status: disconnected from TEC".to_string(),
      health: None,
      start_on_login: false,
    };
    let (title, _) = degraded_notification(&view);
    assert_eq!(title, "owlette — reconnecting");
  }

  #[test]
  fn an_unpaired_machine_is_an_error_because_nothing_is_monitored() {
    let data = json!({
      "service": { "running": true },
      "firebase": { "enabled": true, "connected": true, "site_id": "" }
    });
    let status = determine_status(&fresh(data), RUNNING);
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
    let status = determine_status(&fresh(data), RUNNING);
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
    let status = determine_status(&fresh(data), RUNNING);
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
  fn the_three_ways_a_status_read_can_fail_stay_distinguishable() {
    // Collapsing these into one "absent" is what made a service that had
    // stopped publishing indistinguishable from one that had not started yet.
    let dir = std::env::temp_dir().join(format!("owlette-tray-status-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("tmp")).expect("scratch");

    assert_eq!(read_status_doc(&dir), StatusDoc::Missing);

    fs::write(
      dir.join(SERVICE_STATUS_REL),
      r#"{"service":{"running":true}}"#,
    )
    .expect("seed");
    assert!(matches!(read_status_doc(&dir), StatusDoc::Fresh(_)));

    fs::write(dir.join(SERVICE_STATUS_REL), "{\"service\":").expect("tear");
    assert_eq!(read_status_doc(&dir), StatusDoc::Unreadable);

    // ...and a torn read still rides on the cached document for the icon.
    let mut cache = None;
    smoothed(
      &fresh(json!({ "service": { "running": true } })),
      &mut cache,
    );
    assert!(matches!(
      smoothed(&read_status_doc(&dir), &mut cache),
      StatusDoc::Fresh(_)
    ));

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
