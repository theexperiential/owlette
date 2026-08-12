mod commands;
mod json_io;
mod paths;
mod pid_file;
mod process_ctl;
mod service_ctl;
mod watchers;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};

/// Emitted when one of the seam files the service owns is replaced.
pub const EVENT_FILE_CHANGED: &str = "owlette://file-changed";

/// Emitted when a second launch is folded into this instance, carrying its
/// argv (`--tray`, `--restart-prompt`, ...) and working directory.
pub const EVENT_SECOND_INSTANCE: &str = "owlette://second-instance";

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
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
      if let Err(error) = app.emit(EVENT_SECOND_INSTANCE, SecondInstance { argv, cwd }) {
        log::warn!("could not forward the second instance argv: {error}");
      }
    }))
    // Native file and folder pickers for the process detail form.
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::owlette_data_root,
      commands::read_owlette_json,
      commands::write_owlette_json,
      commands::service_status,
      commands::service_start,
      commands::service_stop,
      commands::terminate_pid,
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

      // Publish our PID so the service can tell the local UI is open.
      match pid_file::write(&root) {
        Ok(path) => log::info!("wrote {}", path.display()),
        Err(error) => log::warn!("could not write the gui pid file: {error}"),
      }

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
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        // Stop the watcher threads before the process tears down, then drop the
        // pid file so the service stops treating the UI as open.
        if let Some(watchers) = app.try_state::<Watchers>() {
          if let Ok(mut handle) = watchers.0.lock() {
            drop(handle.take());
          }
        }
        pid_file::remove(&paths::data_root());
      }
    });
}
