//! Mutex-protected JSON reads and writes against the owlette data tree.
//!
//! This is the desktop side of the service↔GUI seam. The Python service and the
//! legacy tkinter GUI coordinate every access to `config.json` /
//! `app_states.json` through a Windows named mutex and an atomic
//! temp-file-plus-rename write (`agent/src/shared_utils.py`: `_CrossProcessLock`
//! at :92-115, `read_json_from_file` at :1841, `write_json_to_file` at :1892).
//! We reimplement that contract exactly rather than inventing a new one, so the
//! two processes stay interoperable while both are in the field.
//!
//! Deliberate deviations from the Python implementation, both in the safe
//! direction:
//!
//! * A read whose content will not parse is retried (a torn read during the
//!   service's rename) and then fails, where Python returns `{}`. Returning an
//!   empty document to a UI that then writes the file back would erase the
//!   operator's configuration.
//! * Temp files are unique per process and per call instead of a fixed
//!   `<name>.tmp`, so two writers can never share a scratch file.

use std::fmt;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
  CreateMutexW, OpenMutexW, ReleaseMutex, WaitForSingleObject, MUTEX_MODIFY_STATE,
  SYNCHRONIZATION_SYNCHRONIZE,
};

/// Name of the cross-process mutex. Byte-identical to the Python constant —
/// a typo here silently disables all coordination.
const MUTEX_NAME: PCWSTR = w!("Global\\OwletteJsonFileMutex");

/// Wait budget for the mutex, mirroring `_CrossProcessLock(timeout_ms=2000)`.
const MUTEX_WAIT_MS: u32 = 2000;

/// Retry budget for the file operation itself, mirroring the Python
/// `max_retries=3` / `initial_delay=0.1` exponential backoff (100/200 ms).
const MAX_ATTEMPTS: u32 = 3;
const INITIAL_BACKOFF: Duration = Duration::from_millis(100);

/// Python writes these files with `json.dump(..., indent=4)`. Matching the
/// indent keeps the on-disk bytes stable across a mixed fleet where either
/// process may write last.
const INDENT: &[u8] = b"    ";

/// Serial for temp file names, so concurrent writes in this process cannot
/// collide on a scratch file.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Process-wide mutex handle, created once and held for the life of the
/// process exactly like the Python module global `_json_file_mutex`.
static JSON_MUTEX: OnceLock<Option<SharedMutex>> = OnceLock::new();

struct SharedMutex(HANDLE);

// SAFETY: a mutex HANDLE is a kernel object handle, valid process-wide and
// usable from any thread. Ownership of the *lock* is per-thread, which is why
// `LockGuard` below is deliberately !Send; the handle itself is not.
unsafe impl Send for SharedMutex {}
unsafe impl Sync for SharedMutex {}

/// How the cross-process lock behaved for one operation. Surfaced to the
/// frontend so contention is observable instead of invisible.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockOutcome {
  /// The mutex was held for the whole operation.
  Acquired,
  /// Acquired, but the previous owner died without releasing it. We own the
  /// mutex and must release it, same as Python's `WAIT_ABANDONED` branch.
  Abandoned,
  /// The 2 s budget elapsed. Python proceeds unlocked here and so do we — the
  /// write is still atomic, so the worst case is a lost update, never a torn
  /// file.
  Timeout,
  /// The mutex could not be created or opened at all (the Python fallback path
  /// sets `_json_file_mutex = False` for the same condition).
  Unavailable,
}

impl LockOutcome {
  /// True when the operation ran without the cross-process lock held.
  pub fn is_unprotected(self) -> bool {
    matches!(self, LockOutcome::Timeout | LockOutcome::Unavailable)
  }
}

/// Result of a successful [`write_json`].
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
  pub lock: LockOutcome,
  /// Time spent waiting on the mutex.
  pub waited_ms: u64,
  /// Attempts used, 1 on the happy path.
  pub attempts: u32,
  /// Bytes written to disk.
  pub bytes: u64,
}

#[derive(Debug)]
pub enum JsonIoError {
  Io {
    path: PathBuf,
    source: std::io::Error,
  },
  Parse {
    path: PathBuf,
    detail: String,
  },
  Encode(serde_json::Error),
}

impl fmt::Display for JsonIoError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      JsonIoError::Io { path, source } => write!(f, "{}: {source}", path.display()),
      JsonIoError::Parse { path, detail } => {
        write!(f, "{} contains invalid JSON: {detail}", path.display())
      }
      JsonIoError::Encode(source) => write!(f, "could not encode JSON: {source}"),
    }
  }
}

impl std::error::Error for JsonIoError {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    match self {
      JsonIoError::Io { source, .. } => Some(source),
      JsonIoError::Encode(source) => Some(source),
      JsonIoError::Parse { .. } => None,
    }
  }
}

/// Read a JSON document under the cross-process lock.
///
/// A missing or empty file yields an empty object, matching
/// `read_json_from_file` — the service creates `app_states.json` lazily and the
/// UI must render before it exists. Unreadable or unparseable content is
/// retried and then reported as an error (see the module note).
pub fn read_json(path: &Path) -> Result<Value, JsonIoError> {
  let guard = acquire_lock();
  guard.warn_if_unprotected(path, "read");

  let mut backoff = INITIAL_BACKOFF;
  let mut last_error: Option<JsonIoError> = None;

  for attempt in 1..=MAX_ATTEMPTS {
    match fs::read_to_string(path) {
      Ok(text) => {
        if text.trim().is_empty() {
          return Ok(Value::Object(Map::new()));
        }
        match serde_json::from_str::<Value>(&text) {
          Ok(value) => return Ok(value),
          Err(err) => {
            // Most likely a read that landed mid-rename; retry before giving up.
            last_error = Some(JsonIoError::Parse {
              path: path.to_path_buf(),
              detail: err.to_string(),
            });
          }
        }
      }
      Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Value::Object(Map::new())),
      Err(err) => {
        last_error = Some(JsonIoError::Io {
          path: path.to_path_buf(),
          source: err,
        });
      }
    }

    if attempt < MAX_ATTEMPTS {
      thread::sleep(backoff);
      backoff *= 2;
    }
  }

  Err(last_error.expect("a failed attempt always records an error"))
}

/// Write a JSON document atomically under the cross-process lock.
///
/// The document is serialised before the lock is taken (encoding cannot fail
/// under contention, and holding the mutex across it would only lengthen the
/// window the service waits on). The temp file is created in the destination
/// directory so the rename stays on one volume and therefore atomic.
pub fn write_json(path: &Path, value: &Value) -> Result<WriteOutcome, JsonIoError> {
  let text = to_pretty_json(value)?;

  let parent = path
    .parent()
    .filter(|parent| !parent.as_os_str().is_empty());
  match parent {
    Some(parent) if parent.is_dir() => {}
    Some(parent) => {
      return Err(JsonIoError::Io {
        path: parent.to_path_buf(),
        source: std::io::Error::new(ErrorKind::NotFound, "directory does not exist"),
      })
    }
    None => {
      return Err(JsonIoError::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(ErrorKind::InvalidInput, "path has no parent directory"),
      })
    }
  }

  let guard = acquire_lock();
  guard.warn_if_unprotected(path, "write");

  let mut backoff = INITIAL_BACKOFF;
  let mut last_error: Option<JsonIoError> = None;

  for attempt in 1..=MAX_ATTEMPTS {
    let temp = temp_path(path);
    match write_then_rename(&temp, path, text.as_bytes()) {
      Ok(()) => {
        return Ok(WriteOutcome {
          lock: guard.outcome,
          waited_ms: guard.waited.as_millis() as u64,
          attempts: attempt,
          bytes: text.len() as u64,
        })
      }
      Err(err) => {
        // A failed rename leaves the scratch file behind; a failed create may
        // have left a partial one. Either way it must not linger next to the
        // real file, where the service's directory watcher would see it.
        let _ = fs::remove_file(&temp);
        last_error = Some(err);
      }
    }

    if attempt < MAX_ATTEMPTS {
      thread::sleep(backoff);
      backoff *= 2;
    }
  }

  Err(last_error.expect("a failed attempt always records an error"))
}

/// Serialise with Python's `indent=4` shape so a desktop write and a service
/// write produce the same bytes for the same document.
///
/// Line endings are part of that: `write_json_to_file` opens the scratch file in
/// text mode (`open(temp_path, 'w')`), so every `\n` `json.dump` emits reaches
/// disk as `\r\n`. serde_json emits bare `\n`, so we translate. Nothing inside a
/// JSON string can be a literal newline — the encoder escapes those as `\\n` —
/// so a blanket replacement only ever touches the formatter's own breaks.
fn to_pretty_json(value: &Value) -> Result<String, JsonIoError> {
  let mut buffer = Vec::new();
  let formatter = serde_json::ser::PrettyFormatter::with_indent(INDENT);
  let mut serializer = serde_json::Serializer::with_formatter(&mut buffer, formatter);
  value
    .serialize(&mut serializer)
    .map_err(JsonIoError::Encode)?;
  // serde_json only ever emits UTF-8, so this cannot fail for a value it just
  // serialised.
  let text = String::from_utf8(buffer).expect("serde_json emits valid utf-8");
  Ok(text.replace('\n', "\r\n"))
}

fn temp_path(path: &Path) -> PathBuf {
  let file_name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| "owlette".to_string());
  let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
  path.with_file_name(format!("{file_name}.{}.{seq}.tmp", std::process::id()))
}

fn write_then_rename(temp: &Path, dest: &Path, bytes: &[u8]) -> Result<(), JsonIoError> {
  let io_err = |path: &Path, source: std::io::Error| JsonIoError::Io {
    path: path.to_path_buf(),
    source,
  };

  {
    let mut file = File::create(temp).map_err(|err| io_err(temp, err))?;
    file.write_all(bytes).map_err(|err| io_err(temp, err))?;
    // Flush to disk before the rename: a kiosk that loses power mid-write must
    // never come back with a present-but-empty config.json.
    file.sync_all().map_err(|err| io_err(temp, err))?;
  }

  // On Windows this is MoveFileEx(MOVEFILE_REPLACE_EXISTING) — the same atomic
  // replace `os.replace()` performs on the Python side.
  fs::rename(temp, dest).map_err(|err| io_err(dest, err))
}

/// RAII holder for the named mutex.
///
/// Not `Send` by construction: Windows mutex ownership is per-thread, so the
/// thread that waited must be the thread that releases. Every caller runs
/// acquire → operate → drop inside one synchronous function body, which keeps
/// that guarantee even though the commands execute on the async runtime's
/// worker threads.
struct LockGuard {
  /// `Some` only when we own the mutex and therefore owe a release.
  handle: Option<HANDLE>,
  outcome: LockOutcome,
  waited: Duration,
  _not_send: PhantomData<*const ()>,
}

impl LockGuard {
  fn warn_if_unprotected(&self, path: &Path, operation: &str) {
    if self.outcome.is_unprotected() {
      log::warn!(
        "owlette json {operation} on {} proceeding without the cross-process lock ({:?} after {} ms)",
        path.display(),
        self.outcome,
        self.waited.as_millis()
      );
    }
  }
}

impl Drop for LockGuard {
  fn drop(&mut self) {
    if let Some(handle) = self.handle {
      // SAFETY: we own the mutex (the wait returned owned or abandoned) and are
      // releasing it on the acquiring thread.
      unsafe {
        let _ = ReleaseMutex(handle);
      }
    }
  }
}

fn acquire_lock() -> LockGuard {
  let started = Instant::now();

  let Some(handle) = json_mutex() else {
    return LockGuard {
      handle: None,
      outcome: LockOutcome::Unavailable,
      waited: started.elapsed(),
      _not_send: PhantomData,
    };
  };

  // SAFETY: `handle` is a live mutex handle owned by this process for its
  // lifetime.
  let result = unsafe { WaitForSingleObject(handle, MUTEX_WAIT_MS) };
  let waited = started.elapsed();

  if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
    let outcome = if result == WAIT_ABANDONED {
      LockOutcome::Abandoned
    } else {
      LockOutcome::Acquired
    };
    LockGuard {
      handle: Some(handle),
      outcome,
      waited,
      _not_send: PhantomData,
    }
  } else {
    // WAIT_TIMEOUT or WAIT_FAILED: we do not own the mutex, so we must not
    // release it.
    LockGuard {
      handle: None,
      outcome: LockOutcome::Timeout,
      waited,
      _not_send: PhantomData,
    }
  }
}

fn json_mutex() -> Option<HANDLE> {
  JSON_MUTEX
    .get_or_init(|| {
      // SAFETY: both calls take a static wide string and return either a valid
      // handle or an error; no pointers are retained by the OS.
      unsafe {
        match CreateMutexW(None, false, MUTEX_NAME) {
          Ok(handle) => Some(SharedMutex(handle)),
          Err(create_error) => {
            // Expected on any machine where the service got there first: it
            // creates the object with an explicit descriptor that grants
            // Authenticated Users exactly SYNCHRONIZE | MUTEX_MODIFY_STATE
            // (`shared_utils._JSON_MUTEX_SDDL`), and `CreateMutexW` asks for
            // MUTEX_ALL_ACCESS. Opening it with the two rights we actually need
            // is the path that descriptor exists for; the python side has the
            // same fallback.
            match OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE | MUTEX_MODIFY_STATE, false, MUTEX_NAME) {
              Ok(handle) => Some(SharedMutex(handle)),
              Err(open_error) => {
                log::error!(
                  "could not obtain the owlette json mutex (create: {create_error}; open: {open_error}) \
                   — json access will proceed unlocked"
                );
                None
              }
            }
          }
        }
      }
    })
    .as_ref()
    .map(|mutex| mutex.0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// Per-test scratch directory under the OS temp dir, removed on drop.
  struct Scratch(PathBuf);

  impl Scratch {
    fn new(label: &str) -> Self {
      let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
      let dir = std::env::temp_dir().join(format!(
        "owlette-desktop-test-{}-{label}-{seq}",
        std::process::id()
      ));
      fs::create_dir_all(&dir).expect("scratch dir");
      Self(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
      self.0.join(name)
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn round_trips_a_document() {
    let scratch = Scratch::new("roundtrip");
    let path = scratch.path("config.json");
    let document =
      json!({ "processes": [{ "id": "a", "name": "td" }], "firebase": { "enabled": true } });

    let outcome = write_json(&path, &document).expect("write");
    assert_eq!(outcome.attempts, 1);
    assert!(outcome.bytes > 0);

    assert_eq!(read_json(&path).expect("read"), document);
  }

  #[test]
  fn writes_python_compatible_formatting_and_preserves_key_order() {
    let scratch = Scratch::new("format");
    let path = scratch.path("config.json");
    // Insertion order here is deliberately not alphabetical: serde_json's
    // `preserve_order` feature is what stops a desktop write from reshuffling
    // the operator's config (and the untouchable `firebase` block).
    let document: Value =
      serde_json::from_str(r#"{"zeta":1,"alpha":{"nested":true}}"#).expect("parse");

    write_json(&path, &document).expect("write");

    // CRLF, four-space indent, no trailing newline — byte-for-byte what
    // `json.dump(..., indent=4)` into a text-mode file produces on Windows.
    let text = fs::read_to_string(&path).expect("read back");
    assert_eq!(
      text,
      "{\r\n    \"zeta\": 1,\r\n    \"alpha\": {\r\n        \"nested\": true\r\n    }\r\n}"
    );
  }

  #[test]
  fn string_values_containing_escapes_are_not_disturbed_by_the_crlf_pass() {
    let scratch = Scratch::new("escapes");
    let path = scratch.path("config.json");
    // A path with a newline in it is pathological but legal, and it is exactly
    // what a naive newline translation would corrupt.
    let document = json!({ "note": "line one\nline two", "path": "C:\\a\\b" });

    write_json(&path, &document).expect("write");

    let text = fs::read_to_string(&path).expect("read back");
    assert!(
      text.contains(r#""note": "line one\nline two""#),
      "escaped newline was rewritten: {text:?}"
    );
    assert_eq!(read_json(&path).expect("read"), document);
  }

  #[test]
  fn leaves_no_temp_files_behind() {
    let scratch = Scratch::new("temps");
    let path = scratch.path("app_states.json");

    write_json(
      &path,
      &json!({ "1234": { "id": "a", "status": "RUNNING" } }),
    )
    .expect("write");

    let entries: Vec<_> = fs::read_dir(&scratch.0)
      .expect("read dir")
      .filter_map(Result::ok)
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(entries, vec!["app_states.json".to_string()]);
  }

  #[test]
  fn a_missing_file_reads_as_an_empty_document() {
    let scratch = Scratch::new("missing");
    let value = read_json(&scratch.path("nope.json")).expect("read");
    assert_eq!(value, json!({}));
  }

  #[test]
  fn an_empty_file_reads_as_an_empty_document() {
    let scratch = Scratch::new("empty");
    let path = scratch.path("service_status.json");
    fs::write(&path, "   \n").expect("seed");
    assert_eq!(read_json(&path).expect("read"), json!({}));
  }

  #[test]
  fn a_torn_document_is_retried_and_then_reported() {
    let scratch = Scratch::new("torn");
    let path = scratch.path("config.json");
    fs::write(&path, "{\"processes\": [").expect("seed");

    let error = read_json(&path).expect_err("should fail rather than report an empty config");
    assert!(
      matches!(error, JsonIoError::Parse { .. }),
      "unexpected: {error}"
    );
  }

  #[test]
  fn writing_into_a_missing_directory_fails_fast() {
    let scratch = Scratch::new("nodir");
    let path = scratch.path("nested").join("config.json");
    let error = write_json(&path, &json!({})).expect_err("should fail");
    assert!(
      matches!(error, JsonIoError::Io { .. }),
      "unexpected: {error}"
    );
  }

  #[test]
  fn a_guard_only_holds_a_handle_when_it_owns_the_lock() {
    // The safety invariant behind Drop: we must never release a mutex we do
    // not own. Whether we *can* own it still depends on the machine — an agent
    // older than the SDDL fix leaves the object with LocalSystem's default
    // DACL, and a non-elevated app legitimately lands on Unavailable (which the
    // write outcome reports) rather than failing.
    let guard = acquire_lock();
    assert_eq!(
      guard.handle.is_some(),
      !guard.outcome.is_unprotected(),
      "guard held a handle it does not own: {:?}",
      guard.outcome
    );
    println!(
      "cross-process mutex outcome on this machine: {:?} after {} ms",
      guard.outcome,
      guard.waited.as_millis()
    );
  }

  /// Contention check against the real Python holder: both sides run the same
  /// protocol, so this proves the wait/release half of the seam end to end.
  ///
  /// Ignored by default: it needs the deployed interpreter and touches the live
  /// `Global\` mutex, so it only means anything on a machine with the agent
  /// installed. It no longer needs an elevated shell — the service now creates
  /// the object with a descriptor that lets Authenticated Users wait on it.
  ///
  /// The holder falls back to `OpenMutex` for the same reason this module does:
  /// `CreateMutex` asks for MUTEX_ALL_ACCESS, which that descriptor withholds
  /// from ordinary users on purpose.
  ///
  /// Run with:
  /// `cargo test --lib -- --ignored --exact json_io::tests::mutex_contention_with_python_holder --nocapture`
  #[test]
  #[ignore = "needs the deployed agent interpreter and an elevated shell"]
  fn mutex_contention_with_python_holder() {
    use std::process::{Command, Stdio};

    let python = PathBuf::from("C:\\ProgramData\\Owlette\\python\\python.exe");
    assert!(
      python.is_file(),
      "missing interpreter: {}",
      python.display()
    );

    let scratch = Scratch::new("contention");
    let script = scratch.path("hold_lock.py");
    let ready = scratch.path("ready.flag");
    fs::write(
      &script,
      format!(
        "import time, win32event\n\
         NAME = 'Global\\\\OwletteJsonFileMutex'\n\
         SYNCHRONIZE, MUTEX_MODIFY_STATE = 0x00100000, 0x0001\n\
         try:\n    \
             handle = win32event.CreateMutex(None, False, NAME)\n\
         except Exception:\n    \
             handle = win32event.OpenMutex(SYNCHRONIZE | MUTEX_MODIFY_STATE, False, NAME)\n\
         result = win32event.WaitForSingleObject(handle, 2000)\n\
         assert result in (0, 128), 'holder could not take the mutex: %s' % result\n\
         open(r'{}', 'w').close()\n\
         time.sleep(1.0)\n\
         win32event.ReleaseMutex(handle)\n",
        ready.display()
      ),
    )
    .expect("write holder script");

    let mut holder = Command::new(&python)
      .arg(&script)
      .stdout(Stdio::null())
      .stderr(Stdio::piped())
      .spawn()
      .expect("spawn python holder");

    // Wait for the holder to confirm it owns the mutex before we contend.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut holder_ready = false;
    while Instant::now() < deadline {
      if ready.exists() {
        holder_ready = true;
        break;
      }
      thread::sleep(Duration::from_millis(20));
    }
    if !holder_ready {
      let _ = holder.kill();
      let output = holder.wait_with_output().expect("holder output");
      panic!(
        "python holder never acquired the mutex (elevated shell?): {}",
        String::from_utf8_lossy(&output.stderr)
      );
    }

    let path = scratch.path("config.json");
    let outcome = write_json(&path, &json!({ "contended": true })).expect("write");
    holder.wait().expect("holder exit");

    println!(
      "contended write: lock={:?} waited_ms={} attempts={}",
      outcome.lock, outcome.waited_ms, outcome.attempts
    );
    assert_eq!(
      outcome.lock,
      LockOutcome::Acquired,
      "expected to acquire after the python holder released"
    );
    assert!(
      outcome.waited_ms >= 500,
      "expected to block on the python holder, waited {} ms",
      outcome.waited_ms
    );
    assert_eq!(
      read_json(&path).expect("read"),
      json!({ "contended": true })
    );
  }
}
