//! Two kinds of log, both size-capped, neither of which may ever be the reason
//! the service falls over.
//!
//! * The child's stdout and stderr go verbatim into
//!   `logs\service_stdout.log` / `logs\service_stderr.log` — the same two files
//!   NSSM wrote, because they are the crash forensics of last resort and the
//!   docs, the runbooks and the support flow all name them.
//! * The host's own narration goes into `logs\service_host.log`: registration,
//!   spawns, exits with their codes, backoff decisions, stop escalations.
//!
//! Every write is best-effort. A full disk, a locked file or a revoked
//! permission gets swallowed: losing a log line is survivable, taking the
//! machine's supervisor down with it is not.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/// Cap for each of the child's two streams, matching NSSM's `AppRotateBytes`
/// (10 MB). One rotation sibling is kept, so the worst case on disk is 40 MB
/// across both streams.
pub const MAX_CHILD_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Cap for the host's own log. It writes a handful of lines per service
/// lifetime, so this is a bound on a pathological crash loop rather than a
/// number anyone should reach.
pub const MAX_HOST_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// An append-only file that rotates to a single sibling when it would exceed
/// its cap.
pub struct RotatingLog {
  path: PathBuf,
  max_bytes: u64,
  /// `None` after a failed open or write; the next write tries again.
  file: Option<File>,
  len: u64,
}

impl RotatingLog {
  /// Open (or create) the log.
  ///
  /// Infallible by design: if the directory cannot be created or the file
  /// cannot be opened, the log starts closed and every write retries the open.
  /// A machine that cannot write a log file still has to be supervised.
  pub fn open(path: PathBuf, max_bytes: u64) -> Self {
    let mut log = Self {
      path,
      max_bytes,
      file: None,
      len: 0,
    };
    log.reopen();
    log
  }

  /// Append bytes verbatim, rotating first if they would push the file past
  /// its cap.
  pub fn write(&mut self, bytes: &[u8]) {
    if bytes.is_empty() {
      return;
    }
    if should_rotate(self.len, bytes.len() as u64, self.max_bytes) {
      self.rotate();
    }
    if self.file.is_none() {
      self.reopen();
    }
    let Some(file) = self.file.as_mut() else {
      return;
    };
    if file.write_all(bytes).is_err() {
      // Drop the handle so the next write starts from a clean open rather than
      // hammering a broken one.
      self.file = None;
      return;
    }
    let _ = file.flush();
    self.len += bytes.len() as u64;
  }

  /// Release the handle, move the file aside, and let the next write reopen.
  ///
  /// If the rename fails the file simply keeps growing and rotation is retried
  /// on the next write — a log over its cap is a far smaller problem than a
  /// truncated one, so nothing here ever deletes live content.
  fn rotate(&mut self) {
    self.file = None;
    let sibling = rotated_path(&self.path);
    let _ = fs::remove_file(&sibling);
    if fs::rename(&self.path, &sibling).is_ok() {
      self.len = 0;
    }
  }

  fn reopen(&mut self) {
    if let Some(parent) = self.path.parent() {
      let _ = fs::create_dir_all(parent);
    }
    if let Ok(file) = OpenOptions::new()
      .create(true)
      .append(true)
      .open(&self.path)
    {
      self.len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
      self.file = Some(file);
    }
  }
}

/// Rotate only when the file already has content and the incoming write would
/// take it past the cap — so a single oversized line still lands somewhere
/// rather than triggering an endless rotate-and-retry.
pub fn should_rotate(current_len: u64, incoming_len: u64, max_bytes: u64) -> bool {
  current_len > 0 && current_len.saturating_add(incoming_len) > max_bytes
}

/// The single rotation sibling: `service_stdout.log` → `service_stdout.log.1`.
pub fn rotated_path(path: &Path) -> PathBuf {
  let mut name = path.as_os_str().to_os_string();
  name.push(".1");
  PathBuf::from(name)
}

/// Copy a child's stream into a log until it closes.
///
/// Reads whole lines so a rotation can never land mid-line, and writes the
/// bytes verbatim: these files are meant to be byte-identical to what the agent
/// printed, with no host framing added.
///
/// The thread is deliberately detached rather than joined. A grandchild that
/// inherited the pipe can hold it open after the agent itself has exited, and
/// the supervisor must be free to relaunch immediately; the sink is shared
/// across child generations (an `Arc<Mutex<_>>`) precisely so a straggler and
/// the new child can write to the same file safely.
pub fn pump<R>(reader: R, sink: Arc<Mutex<RotatingLog>>)
where
  R: Read + Send + 'static,
{
  thread::spawn(move || {
    let mut reader = BufReader::new(reader);
    let mut line: Vec<u8> = Vec::with_capacity(256);
    loop {
      line.clear();
      match reader.read_until(b'\n', &mut line) {
        Ok(0) => return,
        Ok(_) => {
          if let Ok(mut sink) = sink.lock() {
            sink.write(&line);
          }
        }
        Err(_) => return,
      }
    }
  });
}

static HOST_LOG: OnceLock<Mutex<Option<RotatingLog>>> = OnceLock::new();

fn host_log() -> &'static Mutex<Option<RotatingLog>> {
  HOST_LOG.get_or_init(|| Mutex::new(None))
}

/// Point the host log at `path`. Safe to call more than once; the first call
/// wins, which keeps a CLI verb from reopening the file under a running
/// service.
pub fn init(path: PathBuf) {
  let mut slot = match host_log().lock() {
    Ok(slot) => slot,
    Err(_) => return,
  };
  if slot.is_none() {
    *slot = Some(RotatingLog::open(path, MAX_HOST_LOG_BYTES));
  }
}

fn log(level: &str, message: &str) {
  let line = format!(
    "{} [{}] {}\r\n",
    format_timestamp(unix_now()),
    level,
    message
  );
  if let Ok(mut slot) = host_log().lock() {
    if let Some(sink) = slot.as_mut() {
      sink.write(line.as_bytes());
    }
  }
  // Also to stderr, which is where `install.bat` and an operator running the
  // verbs by hand read it. Under the SCM there is no console and this is a
  // no-op.
  let _ = std::io::stderr().write_all(line.as_bytes());
}

pub fn info(message: &str) {
  log("info", message);
}

pub fn warn(message: &str) {
  log("warn", message);
}

pub fn error(message: &str) {
  log("error", message);
}

fn unix_now() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|since| since.as_secs())
    .unwrap_or(0)
}

/// ISO-8601 UTC, e.g. `2026-08-14T18:22:03Z`.
///
/// UTC rather than local time, and spelled out with the `Z`, so a host line can
/// never be mistaken for one of the agent's local-time python log lines when
/// the two are read side by side. Hand-rolled (the civil-from-days algorithm)
/// because a timestamp is not worth a dependency.
pub fn format_timestamp(unix_secs: u64) -> String {
  let days = (unix_secs / 86_400) as i64;
  let seconds_of_day = unix_secs % 86_400;
  let (year, month, day) = civil_from_days(days);
  format!(
    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
    year,
    month,
    day,
    seconds_of_day / 3600,
    (seconds_of_day % 3600) / 60,
    seconds_of_day % 60
  )
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch to a
/// proleptic-Gregorian (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let day_of_era = (z - era * 146_097) as u64; // [0, 146096]
  let year_of_era =
    (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365; // [0, 399]
  let year = year_of_era as i64 + era * 400;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100); // [0, 365]
  let mp = (5 * day_of_year + 2) / 153; // [0, 11], March-based
  let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
  let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
  (year + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_empty_log_never_rotates() {
    assert!(!should_rotate(0, 5_000_000_000, MAX_CHILD_LOG_BYTES));
  }

  #[test]
  fn rotation_happens_only_when_the_write_would_cross_the_cap() {
    assert!(!should_rotate(
      MAX_CHILD_LOG_BYTES - 10,
      10,
      MAX_CHILD_LOG_BYTES
    ));
    assert!(should_rotate(
      MAX_CHILD_LOG_BYTES - 10,
      11,
      MAX_CHILD_LOG_BYTES
    ));
    assert!(should_rotate(MAX_CHILD_LOG_BYTES, 1, MAX_CHILD_LOG_BYTES));
  }

  #[test]
  fn the_sibling_keeps_the_full_name_and_adds_a_suffix() {
    assert_eq!(
      rotated_path(Path::new(r"C:\ProgramData\Owlette\logs\service_stdout.log")),
      PathBuf::from(r"C:\ProgramData\Owlette\logs\service_stdout.log.1")
    );
  }

  #[test]
  fn a_log_rotates_once_it_passes_its_cap() {
    let dir = std::env::temp_dir().join(format!("owlette-host-log-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("rotate.log");
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(rotated_path(&path));

    let mut log = RotatingLog::open(path.clone(), 16);
    log.write(b"0123456789\n"); // 11 bytes, under the cap
    log.write(b"abcdefghij\n"); // would reach 22 - rotate first
    log.write(b"!\n");

    let current = fs::read_to_string(&path).expect("current");
    let sibling = fs::read_to_string(rotated_path(&path)).expect("sibling");
    assert_eq!(sibling, "0123456789\n");
    assert_eq!(current, "abcdefghij\n!\n");

    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn timestamps_are_iso_8601_utc() {
    assert_eq!(format_timestamp(0), "1970-01-01T00:00:00Z");
    assert_eq!(format_timestamp(946_684_800), "2000-01-01T00:00:00Z");
    // A leap day, and the last second of a leap year.
    assert_eq!(format_timestamp(1_582_934_400), "2020-02-29T00:00:00Z");
    assert_eq!(format_timestamp(1_609_459_199), "2020-12-31T23:59:59Z");
  }
}
