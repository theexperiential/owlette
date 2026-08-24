//! owlette-host — the Windows service host for the owlette agent, replacing
//! NSSM 2.24. Launches the agent, keeps it alive, feeds the same two log files,
//! and stops it the way the agent is written to be stopped.
//!
//! Three NSSM behaviours are deliberately gone, each one a production incident:
//! * **No process-tree kill** — NSSM walked the child's tree, so stopping the
//!   service also killed the desktop app. This terminates exactly the process
//!   it started, and only after the grace window.
//! * **No best-effort Control-C** — NSSM's graceful stop needed the child's
//!   console; when that silently failed nothing flushed `online: false` and a
//!   dead machine read as online for eleven minutes. This reports STOP_PENDING
//!   to the SCM, which the agent polls directly, then waits.
//! * **No ignored settings** — `AppKillProcessTree 0` was set and disregarded.
//!   Behaviour lives in this binary, not in registry values.
//!
//! Verbs: `run` (what the SCM starts), `install`, `uninstall`, `start`, `stop`,
//! `status`. `install` also performs the NSSM→host migration.

mod hostlog;
mod paths;
mod registration;
mod service;
mod stopsignal;
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

/// Report a CLI verb's outcome: a line on stderr and the host log, plus an exit
/// code the calling script can branch on.
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
