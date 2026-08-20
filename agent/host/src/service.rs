//! The service itself: SCM plumbing wrapped around the supervision loop.
//!
//! ## The stop protocol — the reason this binary exists
//!
//! NSSM stopped the agent with a console Control-C, then killed the process
//! TREE ~4.5s later whether or not it was delivered. Both halves failed in prod
//! on 2026-08-13: the Control-C never arrived so `online: false` was never
//! flushed, and the tree kill took the desktop app down with the service.
//!
//! Instead, a stop reports `STOP_PENDING` to the SCM and waits.
//! `owlette_service.start_scm_stop_watcher()` polls that state every 250 ms and
//! runs `graceful_shutdown()` — unmissable, because the host is what reports
//! it. After [`CHILD_STOP_GRACE`] the host terminates the ONE process it
//! launched, never the tree, so everything the agent manages (TouchDesigner,
//! players, kiosk shells) and the desktop app survive a service stop.

use std::ffi::OsString;
use std::panic::{self, AssertUnwindSafe};
use std::process::{Child, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use windows_service::service::{
  ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{
  self, ServiceControlHandlerResult, ServiceStatusHandle,
};
use windows_service::{define_windows_service, service_dispatcher};

use crate::hostlog::{self, RotatingLog, MAX_CHILD_LOG_BYTES};
use crate::paths::{self, SERVICE_NAME};
use crate::supervisor::{
  self, classify, crash_backoff, restart_delay, ChildOutcome, RestartWindow, CHILD_KILL_WAIT,
  CHILD_STOP_GRACE, POLL_INTERVAL, RESTART_LOOP_THRESHOLD, RESTART_WINDOW,
};

/// Reported while the first child is being launched.
const START_WAIT_HINT: Duration = Duration::from_secs(30);

/// Covers the whole stop sequence (grace, terminate, slack). The checkpoint is
/// bumped every second so the SCM never concludes the service has hung.
const STOP_WAIT_HINT: Duration = Duration::from_secs(30);

/// Reported to the SCM so the failure actions registered by
/// `owlette-host install` can retry a host that never got off the ground.
const EXIT_NO_INSTALL_ROOT: u32 = 1;
const EXIT_AGENT_WOULD_NOT_START: u32 = 2;
const EXIT_PANIC: u32 = 3;

define_windows_service!(ffi_service_main, service_main);

/// Hand this process to the SCM. Blocks until the service stops.
pub fn dispatch() -> ExitCode {
  match service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
    Ok(()) => ExitCode::SUCCESS,
    Err(error) => {
      eprintln!(
        "owlette-host could not be started by the service control manager: {error}\n\
         This binary hosts the {SERVICE_NAME} service and is normally started by Windows.\n\
         Run `owlette-host help` for the commands you can use from a shell."
      );
      ExitCode::FAILURE
    }
  }
}

fn service_main(_arguments: Vec<OsString>) {
  if let Err(error) = run() {
    hostlog::error(&format!("the service could not be started: {error}"));
  }
}

fn run() -> windows_service::Result<()> {
  let stop_requested = Arc::new(AtomicBool::new(false));
  let handle_slot: Arc<OnceLock<ServiceStatusHandle>> = Arc::new(OnceLock::new());

  let handler_stop = Arc::clone(&stop_requested);
  let handler_slot = Arc::clone(&handle_slot);
  let event_handler = move |control| match control {
    ServiceControl::Stop | ServiceControl::Shutdown => {
      handler_stop.store(true, Ordering::SeqCst);
      // Report STOP_PENDING from the handler so the agent's stop watcher sees
      // it at the earliest instant; the loop reports it again, idempotently. If
      // the control beats `register`, the slot is empty and the loop's report
      // (within one poll interval) is the first.
      if let Some(handle) = handler_slot.get() {
        report(
          handle,
          ServiceState::StopPending,
          ServiceControlAccept::empty(),
          1,
          STOP_WAIT_HINT,
          ServiceExitCode::NO_ERROR,
        );
      }
      ServiceControlHandlerResult::NoError
    }
    ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
    _ => ServiceControlHandlerResult::NotImplemented,
  };

  let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;
  let _ = handle_slot.set(status_handle);

  report(
    &status_handle,
    ServiceState::StartPending,
    ServiceControlAccept::empty(),
    1,
    START_WAIT_HINT,
    ServiceExitCode::NO_ERROR,
  );

  // An escaping panic would unwind out of the SCM's service thread and wedge
  // the service in StartPending until the process died.
  let exit_code = panic::catch_unwind(AssertUnwindSafe(|| {
    supervise(&status_handle, &stop_requested)
  }))
  .unwrap_or_else(|_| {
    hostlog::error("the supervision loop panicked - reporting the service as failed");
    ServiceExitCode::ServiceSpecific(EXIT_PANIC)
  });

  report(
    &status_handle,
    ServiceState::Stopped,
    ServiceControlAccept::empty(),
    0,
    Duration::default(),
    exit_code,
  );
  Ok(())
}

/// Launch the agent, keep it alive, and stop it when told to.
fn supervise(status_handle: &ServiceStatusHandle, stop_requested: &AtomicBool) -> ServiceExitCode {
  let install_root = match paths::install_root() {
    Ok(root) => root,
    Err(error) => {
      hostlog::error(&format!(
        "could not locate the installation directory from this binary: {error}"
      ));
      return ServiceExitCode::ServiceSpecific(EXIT_NO_INSTALL_ROOT);
    }
  };
  let spec = paths::child_spec(&install_root);
  let log_dir = paths::log_dir();
  let stdout_sink = Arc::new(Mutex::new(RotatingLog::open(
    log_dir.join("service_stdout.log"),
    MAX_CHILD_LOG_BYTES,
  )));
  let stderr_sink = Arc::new(Mutex::new(RotatingLog::open(
    log_dir.join("service_stderr.log"),
    MAX_CHILD_LOG_BYTES,
  )));

  hostlog::info(&format!(
    "owlette-host {} starting - install root {}",
    env!("CARGO_PKG_VERSION"),
    install_root.display()
  ));
  for path in [&spec.program, &spec.script] {
    if supervisor::missing(path) {
      hostlog::error(&format!("missing: {}", path.display()));
    }
  }

  let mut crash_window = RestartWindow::new(RESTART_WINDOW);
  let mut self_restart_window = RestartWindow::new(RESTART_WINDOW);
  let mut running_reported = false;

  loop {
    if stop_requested.load(Ordering::SeqCst) {
      hostlog::info("stop requested before the agent was launched - nothing to wind down");
      return ServiceExitCode::NO_ERROR;
    }

    let child = match supervisor::spawn(&spec, &stdout_sink, &stderr_sink) {
      Ok(child) => child,
      Err(error) => {
        hostlog::error(&format!(
          "could not launch {}: {error}",
          spec.command_line()
        ));
        if !running_reported {
          // Never came up: report failure so the SCM retries instead of sitting
          // "stopped" forever.
          return ServiceExitCode::ServiceSpecific(EXIT_AGENT_WOULD_NOT_START);
        }
        let recent = crash_window.record(Instant::now());
        let delay = crash_backoff(recent);
        hostlog::warn(&format!(
          "retrying the launch in {}s ({recent} failures in the last {} minutes)",
          delay.as_secs(),
          RESTART_WINDOW.as_secs() / 60
        ));
        if !sleep_unless_stop(delay, stop_requested) {
          return ServiceExitCode::NO_ERROR;
        }
        continue;
      }
    };

    hostlog::info(&format!(
      "agent started, pid {} - {}",
      child.id(),
      spec.command_line()
    ));

    if !running_reported {
      report(
        status_handle,
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        0,
        Duration::default(),
        ServiceExitCode::NO_ERROR,
      );
      running_reported = true;
    }

    let code = match wait_for_exit_or_stop(child, stop_requested) {
      Waited::StopRequested(child) => return stop_child(status_handle, child),
      Waited::Exited(code) => code,
    };

    let outcome = classify(code);
    match outcome {
      ChildOutcome::CleanExit => {
        // Like NSSM's `AppExit 0 Exit` — a clean exit means done, not faulted.
        hostlog::info("the agent exited cleanly (0) - stopping the service");
        return ServiceExitCode::NO_ERROR;
      }
      ChildOutcome::SelfRestart(code) => {
        let recent = self_restart_window.record(Instant::now());
        let delay = restart_delay(outcome, recent).unwrap_or(Duration::ZERO);
        hostlog::info(&format!(
          "the agent exited {code} to restart itself ({recent} in the last {} minutes) \
           - relaunching in {}s",
          RESTART_WINDOW.as_secs() / 60,
          delay.as_secs()
        ));
        if !sleep_unless_stop(delay, stop_requested) {
          return ServiceExitCode::NO_ERROR;
        }
      }
      ChildOutcome::Crash(code) => {
        let recent = crash_window.record(Instant::now());
        let delay = restart_delay(outcome, recent).unwrap_or(Duration::ZERO);
        let message = format!(
          "the agent exited {code} unexpectedly ({recent} crashes in the last {} minutes) \
           - relaunching in {}s",
          RESTART_WINDOW.as_secs() / 60,
          delay.as_secs()
        );
        if recent >= RESTART_LOOP_THRESHOLD {
          hostlog::error(&format!("crash loop: {message}"));
        } else {
          hostlog::warn(&message);
        }
        if !sleep_unless_stop(delay, stop_requested) {
          return ServiceExitCode::NO_ERROR;
        }
      }
    }
  }
}

enum Waited {
  /// The child exited on its own, with this code.
  Exited(i32),
  /// A stop arrived while the child was running (or had just exited); the child
  /// is handed back for the stop sequence.
  StopRequested(Child),
}

fn wait_for_exit_or_stop(mut child: Child, stop_requested: &AtomicBool) -> Waited {
  loop {
    // Stop is checked first: on a simultaneous exit + stop, the operator wins
    // and nothing is relaunched.
    if stop_requested.load(Ordering::SeqCst) {
      return Waited::StopRequested(child);
    }
    match child.try_wait() {
      Ok(Some(status)) => return Waited::Exited(exit_code_of(status)),
      Ok(None) => {}
      Err(error) => {
        hostlog::error(&format!(
          "could not read the agent's exit status (pid {}): {error} - treating it as a crash",
          child.id()
        ));
        return Waited::Exited(i32::MIN);
      }
    }
    thread::sleep(POLL_INTERVAL);
  }
}

/// Wind the agent down: report STOP_PENDING, let it exit on its own, and only
/// terminate it — never its descendants — if it overruns the grace window.
fn stop_child(status_handle: &ServiceStatusHandle, mut child: Child) -> ServiceExitCode {
  let pid = child.id();
  hostlog::info(&format!(
    "stop requested - reporting STOP_PENDING and giving pid {pid} up to {}s to exit",
    CHILD_STOP_GRACE.as_secs()
  ));

  let started = Instant::now();
  let deadline = started + CHILD_STOP_GRACE;
  let mut checkpoint = 1;
  report(
    status_handle,
    ServiceState::StopPending,
    ServiceControlAccept::empty(),
    checkpoint,
    STOP_WAIT_HINT,
    ServiceExitCode::NO_ERROR,
  );
  let mut last_report = Instant::now();

  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        hostlog::info(&format!(
          "the agent exited {} on its own after {:.1}s - stop complete",
          exit_code_of(status),
          started.elapsed().as_secs_f32()
        ));
        // Let the log pumps drain the child's last output.
        thread::sleep(POLL_INTERVAL);
        return ServiceExitCode::NO_ERROR;
      }
      Ok(None) => {}
      Err(error) => {
        hostlog::error(&format!("could not poll pid {pid} while stopping: {error}"));
        break;
      }
    }
    if Instant::now() >= deadline {
      break;
    }
    thread::sleep(POLL_INTERVAL);
    if last_report.elapsed() >= Duration::from_secs(1) {
      checkpoint += 1;
      report(
        status_handle,
        ServiceState::StopPending,
        ServiceControlAccept::empty(),
        checkpoint,
        STOP_WAIT_HINT,
        ServiceExitCode::NO_ERROR,
      );
      last_report = Instant::now();
    }
  }

  hostlog::warn(&format!(
    "the agent did not exit within {}s - terminating pid {pid} (this process only, never its children)",
    CHILD_STOP_GRACE.as_secs()
  ));
  if let Err(error) = child.kill() {
    hostlog::error(&format!("could not terminate pid {pid}: {error}"));
  }

  let kill_deadline = Instant::now() + CHILD_KILL_WAIT;
  while Instant::now() < kill_deadline {
    match child.try_wait() {
      Ok(Some(_)) => {
        hostlog::info(&format!("pid {pid} terminated - stop complete"));
        return ServiceExitCode::NO_ERROR;
      }
      Ok(None) => thread::sleep(POLL_INTERVAL),
      Err(_) => break,
    }
  }
  hostlog::error(&format!(
    "pid {pid} is still present {}s after being terminated - reporting the service stopped anyway",
    CHILD_KILL_WAIT.as_secs()
  ));
  ServiceExitCode::NO_ERROR
}

/// Sleep in poll-sized slices. Returns false the moment a stop is requested,
/// so a crash-loop backoff can never delay an operator's stop.
fn sleep_unless_stop(delay: Duration, stop_requested: &AtomicBool) -> bool {
  let deadline = Instant::now() + delay;
  while Instant::now() < deadline {
    if stop_requested.load(Ordering::SeqCst) {
      return false;
    }
    thread::sleep(POLL_INTERVAL.min(delay));
  }
  !stop_requested.load(Ordering::SeqCst)
}

fn exit_code_of(status: std::process::ExitStatus) -> i32 {
  // Always `Some` on Windows; the fallback keeps the impossible case honest.
  status.code().unwrap_or(i32::MIN)
}

fn report(
  status_handle: &ServiceStatusHandle,
  state: ServiceState,
  controls_accepted: ServiceControlAccept,
  checkpoint: u32,
  wait_hint: Duration,
  exit_code: ServiceExitCode,
) {
  let status = ServiceStatus {
    service_type: ServiceType::OWN_PROCESS,
    current_state: state,
    controls_accepted,
    exit_code,
    checkpoint,
    wait_hint,
    process_id: None,
  };
  if let Err(error) = status_handle.set_service_status(status) {
    hostlog::error(&format!(
      "could not report {} to the service control manager: {error}",
      state_name(state)
    ));
  }
}

fn state_name(state: ServiceState) -> &'static str {
  match state {
    ServiceState::Stopped => "STOPPED",
    ServiceState::StartPending => "START_PENDING",
    ServiceState::StopPending => "STOP_PENDING",
    ServiceState::Running => "RUNNING",
    ServiceState::ContinuePending => "CONTINUE_PENDING",
    ServiceState::PausePending => "PAUSE_PENDING",
    ServiceState::Paused => "PAUSED",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_zero_delay_sleep_does_not_block() {
    let stop = AtomicBool::new(false);
    let started = Instant::now();
    assert!(sleep_unless_stop(Duration::ZERO, &stop));
    assert!(started.elapsed() < Duration::from_millis(100));
  }

  #[test]
  fn a_pending_stop_short_circuits_the_backoff() {
    let stop = AtomicBool::new(true);
    let started = Instant::now();
    assert!(!sleep_unless_stop(Duration::from_secs(60), &stop));
    assert!(started.elapsed() < Duration::from_millis(500));
  }

  #[test]
  fn every_service_state_has_a_name() {
    assert_eq!(state_name(ServiceState::StopPending), "STOP_PENDING");
    assert_eq!(state_name(ServiceState::Running), "RUNNING");
  }
}
