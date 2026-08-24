//! Restart policy and child-process mechanics. The policy half is pure and
//! unit-tested; the mechanics half is the thin `std::process` layer that
//! launches the agent and waits on it.
//!
//! Exit-code contract with `owlette_service.py` — the host honours every code:
//!
//! | code | meaning | host response |
//! |------|---------|---------------|
//! | 42   | restart flag (`tmp\restart.flag`, the desktop app's "restart") | relaunch immediately |
//! | 43   | self-restart watchdog (stuck connection) | relaunch immediately |
//! | 0    | clean exit | stop the service — NSSM's `AppExit 0 Exit` |
//! | else | crash | relaunch, with crash-loop backoff |
//!
//! 42/43 relaunch with no delay on purpose: Owlette is restarting itself, the
//! dashboard already knows it was intentional, and a delay is dead air on a
//! machine that is supposed to be supervising a show.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::hostlog::{pump, RotatingLog};
use crate::paths::ChildSpec;

/// `owlette_service.py` exits with this when it saw `tmp\restart.flag`.
pub const EXIT_RESTART_FLAG: i32 = 42;

/// ...and with this when the self-restart watchdog fired.
pub const EXIT_WATCHDOG_RESTART: i32 = 43;

/// Delay before relaunching after a crash — NSSM's `AppRestartDelay` was the
/// same 5000 ms: too long for a tight failure (missing DLL, syntax error) to
/// spin the CPU, too short for a real crash to show on the dashboard.
pub const BASE_RESTART_DELAY: Duration = Duration::from_secs(5);

/// Delay once the child is in a crash loop.
pub const CRASH_LOOP_DELAY: Duration = Duration::from_secs(60);

/// How many exits of one kind inside [`RESTART_WINDOW`] count as a loop.
pub const RESTART_LOOP_THRESHOLD: usize = 5;

/// Sliding window a loop is measured over. NSSM's `AppThrottle` (10 s) looked
/// only at the most recent run, so it could not tell "crashed once on boot"
/// from "crashing every eight seconds forever".
pub const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);

/// How often the child is polled, both while running and while stopping.
pub const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// How long the child may exit on its own after a stop, before the host kills it.
///
/// The agent's SCM stop watcher polls every 250 ms and runs `graceful_shutdown()`
/// (flush `online: false`, log `agent_stopped`, record a clean external stop) as
/// soon as the host reports STOP_PENDING — well under a second in the field. 20 s
/// is four times NSSM's entire stop budget, which the 2026-08-13 silent-stop
/// incident overran.
pub const CHILD_STOP_GRACE: Duration = Duration::from_secs(20);

/// How long the host waits for a terminated child to actually go away.
pub const CHILD_KILL_WAIT: Duration = Duration::from_secs(5);

/// `CREATE_NO_WINDOW`, NSSM's `AppNoConsole 1`: the agent is a console program
/// with all three handles redirected and must never flash a window on a machine
/// whose whole job is displaying something else.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What a child's exit means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildOutcome {
  /// Owlette restarting itself: 42 (restart flag) or 43 (watchdog).
  SelfRestart(i32),
  /// Exit 0. The service stops; it is not a failure.
  CleanExit,
  /// Any other code, including the negative values Windows reports for an
  /// access violation and friends.
  Crash(i32),
}

/// Classify a child exit code.
pub fn classify(code: i32) -> ChildOutcome {
  match code {
    EXIT_RESTART_FLAG | EXIT_WATCHDOG_RESTART => ChildOutcome::SelfRestart(code),
    0 => ChildOutcome::CleanExit,
    other => ChildOutcome::Crash(other),
  }
}

/// How long to wait before relaunching, or `None` when the service should stop.
/// `recent` counts exits of this kind, including this one, inside
/// [`RESTART_WINDOW`].
pub fn restart_delay(outcome: ChildOutcome, recent: usize) -> Option<Duration> {
  match outcome {
    ChildOutcome::CleanExit => None,
    ChildOutcome::SelfRestart(_) => Some(self_restart_backoff(recent)),
    ChildOutcome::Crash(_) => Some(crash_backoff(recent)),
  }
}

/// Backoff after a crash — or after a launch that failed outright, which is the
/// same kind of failure one step earlier.
pub fn crash_backoff(recent: usize) -> Duration {
  if recent >= RESTART_LOOP_THRESHOLD {
    CRASH_LOOP_DELAY
  } else {
    BASE_RESTART_DELAY
  }
}

/// Backoff after an Owlette-initiated restart: none until it starts to look like
/// a storm, then only the ordinary delay. A self-restart is not a fault and must
/// not be penalised like one — but it does not get to spin.
pub fn self_restart_backoff(recent: usize) -> Duration {
  if recent >= RESTART_LOOP_THRESHOLD {
    BASE_RESTART_DELAY
  } else {
    Duration::ZERO
  }
}

/// A sliding count of recent exits.
#[derive(Debug)]
pub struct RestartWindow {
  window: Duration,
  events: Vec<Instant>,
}

impl RestartWindow {
  pub fn new(window: Duration) -> Self {
    Self {
      window,
      events: Vec::new(),
    }
  }

  /// Record an exit at `now` and return how many are inside the window.
  pub fn record(&mut self, now: Instant) -> usize {
    self
      .events
      .retain(|at| now.duration_since(*at) < self.window);
    self.events.push(now);
    self.events.len()
  }
}

/// Launch the agent and start pumping its output into the two log files.
pub fn spawn(
  spec: &ChildSpec,
  stdout_sink: &Arc<Mutex<RotatingLog>>,
  stderr_sink: &Arc<Mutex<RotatingLog>>,
) -> std::io::Result<Child> {
  use std::os::windows::process::CommandExt;

  let mut child = Command::new(&spec.program)
    .arg(&spec.script)
    .current_dir(&spec.working_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    // The service's own environment is inherited, exactly as NSSM passed it —
    // LocalSystem's block, with no AppEnvironmentExtra to reproduce.
    .creation_flags(CREATE_NO_WINDOW)
    .spawn()?;

  if let Some(stream) = child.stdout.take() {
    pump(stream, Arc::clone(stdout_sink));
  }
  if let Some(stream) = child.stderr.take() {
    pump(stream, Arc::clone(stderr_sink));
  }
  Ok(child)
}

/// True when `path` is missing — used to explain a spawn failure in one line
/// instead of a bare OS error number.
pub fn missing(path: &Path) -> bool {
  !path.exists()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_self_restart_codes_are_recognised() {
    assert_eq!(classify(42), ChildOutcome::SelfRestart(42));
    assert_eq!(classify(43), ChildOutcome::SelfRestart(43));
  }

  #[test]
  fn zero_is_a_clean_exit_and_everything_else_is_a_crash() {
    assert_eq!(classify(0), ChildOutcome::CleanExit);
    assert_eq!(classify(1), ChildOutcome::Crash(1));
    assert_eq!(classify(41), ChildOutcome::Crash(41));
    assert_eq!(classify(44), ChildOutcome::Crash(44));
    // Windows reports an access violation as 0xC0000005, which lands here as a
    // negative i32.
    assert_eq!(
      classify(-1_073_741_819),
      ChildOutcome::Crash(-1_073_741_819)
    );
  }

  #[test]
  fn a_clean_exit_stops_the_service() {
    assert_eq!(restart_delay(ChildOutcome::CleanExit, 1), None);
    assert_eq!(restart_delay(ChildOutcome::CleanExit, 99), None);
  }

  #[test]
  fn a_self_restart_relaunches_immediately() {
    assert_eq!(
      restart_delay(ChildOutcome::SelfRestart(42), 1),
      Some(Duration::ZERO)
    );
    assert_eq!(
      restart_delay(ChildOutcome::SelfRestart(43), 4),
      Some(Duration::ZERO)
    );
  }

  #[test]
  fn a_self_restart_storm_is_slowed_but_not_penalised() {
    assert_eq!(
      restart_delay(ChildOutcome::SelfRestart(42), RESTART_LOOP_THRESHOLD),
      Some(BASE_RESTART_DELAY)
    );
  }

  #[test]
  fn a_crash_waits_five_seconds_until_it_becomes_a_loop() {
    assert_eq!(
      restart_delay(ChildOutcome::Crash(1), 1),
      Some(BASE_RESTART_DELAY)
    );
    assert_eq!(
      restart_delay(ChildOutcome::Crash(1), RESTART_LOOP_THRESHOLD - 1),
      Some(BASE_RESTART_DELAY)
    );
    assert_eq!(
      restart_delay(ChildOutcome::Crash(1), RESTART_LOOP_THRESHOLD),
      Some(CRASH_LOOP_DELAY)
    );
    assert_eq!(
      restart_delay(ChildOutcome::Crash(1), 50),
      Some(CRASH_LOOP_DELAY)
    );
  }

  #[test]
  fn the_window_counts_only_recent_exits() {
    let mut window = RestartWindow::new(Duration::from_secs(300));
    let start = Instant::now();

    // Five crashes inside five minutes: the fifth trips the threshold, and its
    // returned count is what the backoff is decided from.
    let mut count = 0;
    for (index, offset) in [0u64, 10, 20, 30, 40].iter().enumerate() {
      count = window.record(start + Duration::from_secs(*offset));
      assert_eq!(count, index + 1);
    }
    assert_eq!(crash_backoff(count), CRASH_LOOP_DELAY);

    // An hour later the window is empty again and the count restarts at one.
    let count = window.record(start + Duration::from_secs(3_600));
    assert_eq!(count, 1);
  }

  #[test]
  fn the_window_boundary_is_exclusive() {
    let mut window = RestartWindow::new(Duration::from_secs(300));
    let start = Instant::now();
    window.record(start);
    // Exactly one window later, the first event has aged out.
    assert_eq!(window.record(start + Duration::from_secs(300)), 1);
    // Just inside, it has not.
    let mut window = RestartWindow::new(Duration::from_secs(300));
    window.record(start);
    assert_eq!(window.record(start + Duration::from_secs(299)), 2);
  }
}
