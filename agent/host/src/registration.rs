//! Registering, removing and controlling the service.
//!
//! Everything `install.bat` used to drive through `nssm set` lives here, so the
//! registration a machine ends up with is a property of this binary rather than of
//! whichever batch file last ran. `install` is the migration path too: it stops and
//! removes whatever `OwletteService` is already there (an NSSM registration or an older
//! host) and creates the new one. Nothing under `%ProgramData%\Owlette` is touched, so
//! config, tokens, logs and cache survive by construction.

use std::ffi::{OsStr, OsString};
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use windows_service::service::{
  Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceDependency, ServiceErrorControl,
  ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState,
  ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::hostlog;
use crate::paths::{self, DEPENDENCIES, DESCRIPTION, DISPLAY_NAME, SERVICE_NAME};

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;
const ERROR_SERVICE_MARKED_FOR_DELETE: i32 = 1072;
const ERROR_SERVICE_EXISTS: i32 = 1073;

/// Long enough to cover the host's own stop sequence (a 20 s grace window, then
/// a terminate with 5 s to take effect) with room to spare.
const STOP_WAIT: Duration = Duration::from_secs(45);

/// How long a deleted service is given to disappear from the SCM, and a new one to become
/// creatable. Both bounded by other processes' open handles — usually an open Services.msc.
const DELETE_WAIT: Duration = Duration::from_secs(30);

/// How long `start` waits for RUNNING before reporting failure.
const START_WAIT: Duration = Duration::from_secs(60);

const POLL: Duration = Duration::from_millis(250);

/// Exit codes for the `status` verb, so scripts can branch without parsing.
const STATUS_STOPPED: u8 = 3;
const STATUS_NOT_INSTALLED: u8 = 4;

/// Register the service, replacing whatever is there now.
pub fn install() -> Result<(), String> {
  let exe = std::env::current_exe()
    .map_err(|error| format!("could not resolve this binary's path: {error}"))?;

  let manager = ServiceManager::local_computer(
    None::<&str>,
    ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
  )
  .map_err(|error| connect_error(&error))?;

  remove_existing(&manager, "install")?;

  let info = ServiceInfo {
    name: OsString::from(SERVICE_NAME),
    display_name: OsString::from(DISPLAY_NAME),
    service_type: ServiceType::OWN_PROCESS,
    // Automatic, and deliberately NOT delayed — see set_delayed_auto_start below.
    start_type: ServiceStartType::AutoStart,
    error_control: ServiceErrorControl::Normal,
    executable_path: exe.clone(),
    // `run` is explicit so an operator reading the registration in Services.msc
    // or `sc qc` can see what the binary is being asked to do.
    launch_arguments: vec![OsString::from("run")],
    dependencies: DEPENDENCIES
      .iter()
      .map(|name| ServiceDependency::Service(OsString::from(*name)))
      .collect(),
    // None means LocalSystem: the agent needs it to launch installers silently,
    // read the encrypted token store and drive the user session.
    account_name: None,
    account_password: None,
  };

  let access = ServiceAccess::QUERY_CONFIG
    | ServiceAccess::CHANGE_CONFIG
    | ServiceAccess::QUERY_STATUS
    | ServiceAccess::START
    | ServiceAccess::STOP
    | ServiceAccess::DELETE;

  let service = create_with_retry(&manager, &info, access)?;

  service
    .set_description(DESCRIPTION)
    .map_err(|error| format!("could not set the service description: {error}"))?;

  // Explicitly OFF rather than merely unset. The agent gates on real network readiness in
  // process, so the SCM's blind delayed-start timer (up to 120 s) only postpones monitoring
  // — and machines deployed with the old value of 1 keep it unless it is written down as 0.
  service
    .set_delayed_auto_start(false)
    .map_err(|error| format!("could not clear delayed auto-start: {error}"))?;

  // New capability as well as defense in depth: NSSM's registration had no SCM failure
  // actions, so a host that died outright stayed dead. These fire only if THIS process
  // exits without reporting a clean stop.
  service
    .update_failure_actions(failure_actions())
    .map_err(|error| format!("could not set the service failure actions: {error}"))?;
  service
    .set_failure_actions_on_non_crash_failures(true)
    .map_err(|error| format!("could not enable failure actions on non-crash failures: {error}"))?;

  hostlog::info(&format!(
    "registered {SERVICE_NAME} → \"{}\" run (auto-start, not delayed, LocalSystem, after {})",
    exe.display(),
    DEPENDENCIES.join(" ")
  ));
  Ok(())
}

/// Stop and deregister the service. Succeeds when it was not there to begin
/// with — an uninstall must never fail on a machine that is already clean.
pub fn uninstall() -> Result<(), String> {
  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| connect_error(&error))?;
  remove_existing(&manager, "uninstall")?;
  hostlog::info(&format!("{SERVICE_NAME} is deregistered"));
  Ok(())
}

/// Start the service and wait for it to reach RUNNING.
pub fn start() -> Result<(), String> {
  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| connect_error(&error))?;
  let service = manager
    .open_service(
      SERVICE_NAME,
      ServiceAccess::START | ServiceAccess::QUERY_STATUS,
    )
    .map_err(|error| open_error(&error))?;

  let state = query_state(&service)?;
  if state == ServiceState::Running {
    hostlog::info(&format!("{SERVICE_NAME} is already running"));
    return Ok(());
  }

  match service.start(&[] as &[&OsStr]) {
    Ok(()) => {}
    Err(error) if error_code(&error) == Some(ERROR_SERVICE_ALREADY_RUNNING) => {}
    Err(error) => return Err(format!("could not start {SERVICE_NAME}: {error}")),
  }

  wait_for_state(&service, ServiceState::Running, START_WAIT)?;
  hostlog::info(&format!("{SERVICE_NAME} is running"));
  Ok(())
}

/// Stop the service and wait for it to reach STOPPED.
///
/// Already-stopped is success: callers (`configure_site.py --leave`, `install.bat`) ask
/// for a stop to guarantee a state, not to perform an action.
pub fn stop() -> Result<(), String> {
  let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    .map_err(|error| connect_error(&error))?;
  let service = manager
    .open_service(
      SERVICE_NAME,
      ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
    )
    .map_err(|error| open_error(&error))?;
  stop_and_wait(&service)?;
  hostlog::info(&format!("{SERVICE_NAME} is stopped"));
  Ok(())
}

/// Print what the SCM knows about the service.
///
/// Exit code: 0 running, 3 installed but not running, 4 not installed. The registered
/// image is printed too, which is how an upgrade is checked to have migrated off NSSM.
pub fn status() -> ExitCode {
  let manager = match ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT) {
    Ok(manager) => manager,
    Err(error) => {
      eprintln!("{}", connect_error(&error));
      return ExitCode::FAILURE;
    }
  };
  let service = match manager.open_service(
    SERVICE_NAME,
    ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
  ) {
    Ok(service) => service,
    Err(error) if error_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
      println!("{SERVICE_NAME}: not installed");
      return ExitCode::from(STATUS_NOT_INSTALLED);
    }
    Err(error) => {
      eprintln!("{}", open_error(&error));
      return ExitCode::FAILURE;
    }
  };

  let state = match service.query_status() {
    Ok(status) => status.current_state,
    Err(error) => {
      eprintln!("could not query {SERVICE_NAME}: {error}");
      return ExitCode::FAILURE;
    }
  };
  let image = service
    .query_config()
    .map(|config| config.executable_path.display().to_string())
    .unwrap_or_else(|_| "unknown".to_string());

  println!("{SERVICE_NAME}: {} - {image}", state_word(state));
  if state == ServiceState::Running {
    ExitCode::SUCCESS
  } else {
    ExitCode::from(STATUS_STOPPED)
  }
}

/// Stop and delete whatever `OwletteService` currently is.
fn remove_existing(manager: &ServiceManager, context: &str) -> Result<(), String> {
  let access = ServiceAccess::QUERY_STATUS
    | ServiceAccess::QUERY_CONFIG
    | ServiceAccess::STOP
    | ServiceAccess::DELETE;
  let service = match manager.open_service(SERVICE_NAME, access) {
    Ok(service) => service,
    Err(error) if error_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
      hostlog::info(&format!(
        "no existing {SERVICE_NAME} registration ({context})"
      ));
      return Ok(());
    }
    Err(error) => return Err(open_error(&error)),
  };

  match service.query_config() {
    Ok(config) => {
      let image = config.executable_path.display().to_string();
      if paths::image_is_nssm(&image) {
        hostlog::info(&format!(
          "existing registration is NSSM ({image}) - migrating to owlette-host; \
           configuration, tokens and logs are untouched"
        ));
      } else {
        hostlog::info(&format!("replacing the existing registration ({image})"));
      }
    }
    Err(error) => hostlog::warn(&format!(
      "could not read the existing registration's configuration: {error}"
    )),
  }

  stop_and_wait(&service)?;

  service
    .delete()
    .map_err(|error| format!("could not deregister {SERVICE_NAME}: {error}"))?;
  // Windows only removes the service once every handle to it is closed.
  drop(service);
  wait_until_gone(manager)
}

/// Ask the service to stop, then wait for STOPPED. Already-stopped is success.
fn stop_and_wait(service: &Service) -> Result<(), String> {
  let state = query_state(service)?;
  if state == ServiceState::Stopped {
    return Ok(());
  }
  if state != ServiceState::StopPending {
    match service.stop() {
      Ok(_) => {}
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_NOT_ACTIVE) => return Ok(()),
      Err(error) => return Err(format!("could not stop {SERVICE_NAME}: {error}")),
    }
  }
  // The agent flushes `online: false` to Firestore inside this window, which is
  // why the wait is generous and why nothing here forces the issue.
  wait_for_state(service, ServiceState::Stopped, STOP_WAIT)
}

fn wait_for_state(
  service: &Service,
  wanted: ServiceState,
  timeout: Duration,
) -> Result<(), String> {
  let deadline = Instant::now() + timeout;
  loop {
    let state = query_state(service)?;
    if state == wanted {
      return Ok(());
    }
    if Instant::now() >= deadline {
      return Err(format!(
        "{SERVICE_NAME} was still {} after {}s (wanted {})",
        state_word(state),
        timeout.as_secs(),
        state_word(wanted)
      ));
    }
    thread::sleep(POLL);
  }
}

fn wait_until_gone(manager: &ServiceManager) -> Result<(), String> {
  let deadline = Instant::now() + DELETE_WAIT;
  loop {
    match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
      Err(error) if error_code(&error) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => return Ok(()),
      _ => {
        if Instant::now() >= deadline {
          return Err(format!(
            "{SERVICE_NAME} was still registered {}s after being deleted - something else holds \
             a handle to it (an open Services.msc is the usual cause)",
            DELETE_WAIT.as_secs()
          ));
        }
        thread::sleep(POLL);
      }
    }
  }
}

/// Create the service, retrying while the SCM is still finishing the delete.
fn create_with_retry(
  manager: &ServiceManager,
  info: &ServiceInfo,
  access: ServiceAccess,
) -> Result<Service, String> {
  let deadline = Instant::now() + DELETE_WAIT;
  loop {
    match manager.create_service(info, access) {
      Ok(service) => return Ok(service),
      Err(error)
        if matches!(
          error_code(&error),
          Some(ERROR_SERVICE_MARKED_FOR_DELETE) | Some(ERROR_SERVICE_EXISTS)
        ) && Instant::now() < deadline =>
      {
        thread::sleep(POLL);
      }
      Err(error) if error_code(&error) == Some(ERROR_ACCESS_DENIED) => {
        return Err(format!(
          "could not register {SERVICE_NAME}: access denied - run this from an elevated prompt"
        ))
      }
      Err(error) => return Err(format!("could not register {SERVICE_NAME}: {error}")),
    }
  }
}

/// Restart twice quickly, then back off to a minute, forgetting failures after a day —
/// the same shape as the agent's crash-loop backoff, one level up.
fn failure_actions() -> ServiceFailureActions {
  ServiceFailureActions {
    reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
    reboot_msg: None,
    command: None,
    actions: Some(vec![
      ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(5),
      },
      ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(5),
      },
      ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(60),
      },
    ]),
  }
}

fn query_state(service: &Service) -> Result<ServiceState, String> {
  service
    .query_status()
    .map(|status| status.current_state)
    .map_err(|error| format!("could not query {SERVICE_NAME}: {error}"))
}

fn connect_error(error: &windows_service::Error) -> String {
  if error_code(error) == Some(ERROR_ACCESS_DENIED) {
    "could not connect to the service control manager: access denied - run this from an elevated \
     prompt"
      .to_string()
  } else {
    format!("could not connect to the service control manager: {error}")
  }
}

fn open_error(error: &windows_service::Error) -> String {
  match error_code(error) {
    Some(ERROR_SERVICE_DOES_NOT_EXIST) => format!("{SERVICE_NAME} is not installed"),
    Some(ERROR_ACCESS_DENIED) => {
      format!("could not open {SERVICE_NAME}: access denied - run this from an elevated prompt")
    }
    _ => format!("could not open {SERVICE_NAME}: {error}"),
  }
}

fn error_code(error: &windows_service::Error) -> Option<i32> {
  match error {
    windows_service::Error::Winapi(io) => io.raw_os_error(),
    _ => None,
  }
}

fn state_word(state: ServiceState) -> &'static str {
  match state {
    ServiceState::Stopped => "stopped",
    ServiceState::StartPending => "start pending",
    ServiceState::StopPending => "stop pending",
    ServiceState::Running => "running",
    ServiceState::ContinuePending => "continue pending",
    ServiceState::PausePending => "pause pending",
    ServiceState::Paused => "paused",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_failure_actions_restart_twice_then_back_off() {
    let actions = failure_actions();
    assert_eq!(
      actions.reset_period,
      ServiceFailureResetPeriod::After(Duration::from_secs(86_400))
    );
    let actions = actions.actions.expect("actions");
    assert_eq!(actions.len(), 3);
    assert!(actions
      .iter()
      .all(|action| action.action_type == ServiceActionType::Restart));
    assert_eq!(actions[0].delay, Duration::from_secs(5));
    assert_eq!(actions[1].delay, Duration::from_secs(5));
    assert_eq!(actions[2].delay, Duration::from_secs(60));
  }

  #[test]
  fn every_state_has_a_word() {
    assert_eq!(state_word(ServiceState::Running), "running");
    assert_eq!(state_word(ServiceState::StopPending), "stop pending");
  }
}
