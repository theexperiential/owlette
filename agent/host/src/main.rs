//! owlette-host — the Windows service host for the owlette agent.
//!
//! Replaces NSSM 2.24 (released 2014, unmaintained, and the last stable version
//! there will ever be) as the thing that runs `OwletteService`. It launches the
//! agent, keeps it alive, hands its output to the same two log files, and stops
//! it the way the agent is written to be stopped.
//!
//! Three NSSM behaviours are gone on purpose, each of them a production
//! incident:
//!
//! * **No process-tree kill.** NSSM stopped a service by walking the child's
//!   process tree, which is how an operator stopping the service also killed
//!   the desktop app (and would have taken anything else the agent had launched
//!   as a descendant with it). The host terminates exactly the process it
//!   started, and only after the grace window.
//! * **No best-effort Control-C.** NSSM's graceful stop required attaching to
//!   the child's console; when that silently failed, nothing flushed
//!   `online: false` and the machine sat on the dashboard as online with an
//!   eleven-minute-old heartbeat. The host reports STOP_PENDING to the SCM —
//!   which the agent polls directly — and then waits.
//! * **No ignored settings.** `AppKillProcessTree 0` was set in the registry
//!   and disregarded. Everything here is behaviour in this binary, not a
//!   registry value NSSM might or might not honour.
//!
//! Verbs: `run` (what the SCM starts), `install`, `uninstall`, `start`, `stop`,
//! `status`. `install` is also the NSSM→host migration: it stops and removes
//! whatever registration exists before creating its own.

mod hostlog;
mod paths;
mod registration;
mod service;
mod supervisor;

use std::process::ExitCode;

fn main() -> ExitCode {
  hostlog::init(paths::log_dir().join("service_host.log"));

  let mut arguments = std::env::args().skip(1);
  let verb = arguments.next().unwrap_or_else(|| "run".to_string());

  match verb.to_ascii_lowercase().as_str() {
    // No arguments means the SCM started us (the registered image is
    // `"…\owlette-host.exe" run`, but a bare path must work too).
    "run" => service::dispatch(),
    "install" => finish("install", registration::install()),
    "uninstall" => finish("uninstall", registration::uninstall()),
    "start" => finish("start", registration::start()),
    "stop" => finish("stop", registration::stop()),
    "status" => registration::status(),
    "version" | "--version" | "-v" => {
      println!("owlette-host {}", env!("CARGO_PKG_VERSION"));
      ExitCode::SUCCESS
    }
    "help" | "--help" | "-h" | "/?" => {
      print_help();
      ExitCode::SUCCESS
    }
    other => {
      eprintln!("owlette-host: unknown command \"{other}\"");
      print_help();
      ExitCode::from(2)
    }
  }
}

/// Report the outcome of a CLI verb: a line on stderr and the host log, and an
/// exit code the calling script can branch on.
fn finish(verb: &str, outcome: Result<(), String>) -> ExitCode {
  match outcome {
    Ok(()) => ExitCode::SUCCESS,
    Err(error) => {
      hostlog::error(&format!("{verb} failed: {error}"));
      ExitCode::FAILURE
    }
  }
}

fn print_help() {
  println!(
    "owlette-host {version} - the Windows service host for the owlette agent

usage: owlette-host <command>

  run         host the {service} service (this is what Windows starts; the
              default when no command is given)
  install     register {service} to this binary, replacing any existing
              registration - including an NSSM one. Requires elevation.
  uninstall   stop and deregister {service}. Requires elevation.
  start       start {service} and wait for it to be running
  stop        stop {service} and wait for it to be stopped (a service that is
              already stopped is a success)
  status      print the service state and its registered image
              exit 0 running, 3 installed but not running, 4 not installed
  version     print this binary's version
  help        this text

Logs: %ProgramData%\\Owlette\\logs\\service_host.log (host), service_stdout.log
and service_stderr.log (the agent's own output).",
    version = env!("CARGO_PKG_VERSION"),
    service = paths::SERVICE_NAME
  );
}
