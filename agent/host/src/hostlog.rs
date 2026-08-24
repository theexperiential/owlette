//! Two size-capped logs, neither of which may ever take the service down.
//!
//! * Child stdout/stderr go verbatim to `logs\service_stdout.log` /
//!   `service_stderr.log` — the filenames NSSM used, which the docs, runbooks
//!   and support flow all name.
//! * Host narration goes to `logs\service_host.log`: registration, spawns,
//!   exits and codes, backoff decisions, stop escalations.
//!
//! Every write is best-effort: a full disk, locked file or revoked permission
//! is swallowed. Losing a log line is survivable; losing the supervisor is not.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/// Per child stream, matching NSSM's `AppRotateBytes`. One sibling is kept, so
/// the worst case on disk is 40 MB across both streams.
pub const MAX_CHILD_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Host log cap — a bound on a pathological crash loop, not a normal ceiling.
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
  /// Open (or create) the log. Infallible by design: on failure the log starts
  /// closed and each write retries the open — a machine that cannot write a log
  /// still has to be supervised.
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
      // Drop the handle so the next write reopens instead of hammering a broken one.
      self.file = None;
      return;
    }
    let _ = file.flush();
    self.len += bytes.len() as u64;
  }

  /// Release the handle, move the file aside, let the next write reopen. A
  /// failed rename just means the file keeps growing and rotation retries —
  /// nothing here ever deletes live content.
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

/// Rotate only when the file has content AND the write would cross the cap, so
/// a single oversized line lands somewhere instead of rotating forever.
pub fn should_rotate(current_len: u64, incoming_len: u64, max_bytes: u64) -> bool {
  current_len > 0 && current_len.saturating_add(incoming_len) > max_bytes
}

/// The single rotation sibling: `service_stdout.log` → `service_stdout.log.1`.
pub fn rotated_path(path: &Path) -> PathBuf {
  let mut name = path.as_os_str().to_os_string();
  name.push(".1");
  PathBuf::from(name)
}

/// Copy a child's stream into a log until it closes. Whole lines only (a
/// rotation must never land mid-line) and byte-verbatim — no host framing.
///
/// The thread is deliberately DETACHED, not joined: a grandchild can hold the
/// pipe open after the agent exits and the supervisor must relaunch anyway. The
/// `Arc<Mutex<_>>` sink is shared across generations so a straggler and the new
/// child can write the same file safely.
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

/// Point the host log at `path`. First call wins, so a CLI verb cannot reopen
/// the file under a running service.
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
  // Also stderr, for `install.bat` and hand-run verbs; a no-op under the SCM.
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

/// ISO-8601 UTC, e.g. `2026-08-14T18:22:03Z`. UTC with an explicit `Z` so a
/// host line is never mistaken for one of the agent's local-time python lines.
/// Hand-rolled because a timestamp is not worth a dependency.
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
