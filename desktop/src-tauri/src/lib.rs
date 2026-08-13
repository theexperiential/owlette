mod agent_cli;
mod commands;
mod json_io;
mod paths;
mod pid_file;
mod process_ctl;
mod service_ctl;
mod shell_open;
mod startup_link;
mod tray;
mod watchers;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use crate::paths::TRAY_PID_REL;

/// Emitted when one of the seam files the service owns is replaced.
pub const EVENT_FILE_CHANGED: &str = "owlette://file-changed";

/// Emitted when a second launch is folded into this instance, carrying its
/// argv (`--tray`, `--restart-prompt`, ...) and working directory.
pub const EVENT_SECOND_INSTANCE: &str = "owlette://second-instance";

/// Argument the service passes when it spawns us to supply the tray icon; the
/// window stays hidden until the operator asks for it.
pub const ARG_TRAY: &str = "--tray";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecondInstance {
  argv: Vec<String>,
  cwd: String,
}

/// Holds the file watchers for the life of the app; dropping this stops them.
struct Watchers(Mutex<Option<watchers::WatchHandle>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Must be registered first: plugins run in registration order and this one
    // has to claim the instance lock before anything else initialises.
    .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
      // A relaunch without `--tray` is the operator asking for the window —
      // either from the Start menu or from the service's restart prompt. A
      // relaunch *with* `--tray` is the service topping up a tray that is
      // already there, and must not pop a window in the operator's face.
      if argv.iter().any(|argument| argument == ARG_TRAY) {
        log::debug!("second instance asked for the tray only; staying hidden");
      } else {
        tray::show_main_window(app);
      }
      if let Err(error) = app.emit(EVENT_SECOND_INSTANCE, SecondInstance { argv, cwd }) {
        log::warn!("could not forward the second instance argv: {error}");
      }
    }))
    // Native file and folder pickers for the process detail form.
    .plugin(tauri_plugin_dialog::init())
    // Degraded-state toasts from the tray monitor.
    .plugin(tauri_plugin_notification::init())
    // Registered for the next task's filesystem browsing (exists / read-dir /
    // stat under the owlette tree); nothing calls it yet.
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      commands::owlette_data_root,
      commands::launch_args,
      commands::hostname,
      commands::read_owlette_json,
      commands::write_owlette_json,
      commands::service_status,
      commands::service_start,
      commands::service_stop,
      commands::terminate_pid,
      commands::agent_cli_start,
      commands::agent_cli_cancel,
      commands::open_owlette_path,
      commands::open_external_url,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let root = paths::data_root();

      // Table of running agent-CLI children, so a pairing poll can be cancelled
      // from the dialog that started it and none of them outlive the app.
      app.manage(agent_cli::Runs::default());

      // Publish our PID so the service stops spawning trays at us. This one is
      // process-lifetime; `tmp/gui.pid` is written only while the window is up.
      match pid_file::write(&root, TRAY_PID_REL) {
        Ok(path) => log::info!("wrote {}", path.display()),
        Err(error) => log::warn!("could not write the tray pid file: {error}"),
      }

      // The window is configured hidden so a `--tray` launch never flashes one.
      // Every other launch is someone asking for the UI.
      if std::env::args().any(|argument| argument == ARG_TRAY) {
        log::info!("started with {ARG_TRAY} — staying in the notification area");
      } else {
        tray::show_main_window(app.handle());
      }

      // A tray app with no tray icon has no way back to its window, so unlike
      // the watchers below this failure is fatal.
      tray::init(app.handle())?;

      // Watch the seam files. A failure here is not fatal — the app still works,
      // it just will not see external changes — so it is logged, not returned.
      let handle = app.handle().clone();
      let watchers = match watchers::spawn(&root, move |change| {
        if let Err(error) = handle.emit(EVENT_FILE_CHANGED, change) {
          log::warn!("could not emit a file-changed event: {error}");
        }
      }) {
        Ok(watchers) => Some(watchers),
        Err(error) => {
          log::error!("could not watch {}: {error}", root.display());
          None
        }
      };
      app.manage(Watchers(Mutex::new(watchers)));

      Ok(())
    })
    .on_window_event(|window, event| {
      // Closing the window hides it instead of quitting: the tray icon is the
      // app's real lifetime, and quitting here would drop it until the service's
      // next launch attempt (up to 30 s later).
      if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
          api.prevent_close();
          tray::hide_main_window(window.app_handle());
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| match event {
      // Tauri exits once the last window closes. We hide rather than close, so
      // this only fires if something else closed it — keep the tray alive. An
      // explicit `app.exit(code)` carries a code and is always honoured.
      RunEvent::ExitRequested { code, api, .. } if code.is_none() => api.prevent_exit(),
      RunEvent::Exit => {
        // Stop the tray monitor and the watcher threads before the process tears
        // down, then drop both pid markers so the service stops treating the UI
        // as open.
        tray::shutdown(app);
        if let Some(runs) = app.try_state::<agent_cli::Runs>() {
          agent_cli::cancel_all(&runs);
        }
        if let Some(watchers) = app.try_state::<Watchers>() {
          if let Ok(mut handle) = watchers.0.lock() {
            drop(handle.take());
          }
        }
        tray::clear_pid_markers();
      }
      _ => {}
    });
}
