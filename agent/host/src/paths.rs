//! Where everything lives, and what the supervised child is.
//!
//! The host is self-locating: it ships at `{install_root}\tools\owlette-host.exe`
//! (the slot `nssm.exe` used to occupy), so the install root is two directories
//! up from the binary. Nothing is read from the registry — a service whose
//! configuration lives in two places is a service that can disagree with itself.
//!
//! The data directory is resolved separately, from `%ProgramData%`, because
//! `install.bat` has always kept logs/config/cache under `%ProgramData%\Owlette`
//! even when the payload is installed elsewhere via `/DIR=`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Service name. Unchanged from the NSSM registration on purpose: every other
/// component addresses the service by this name (`shared_utils.SERVICE_NAME`,
/// the desktop app's `service_ctl.rs`, the update recovery watchdog, docs).
pub const SERVICE_NAME: &str = "OwletteService";

/// What Services.msc shows. Matches the NSSM registration byte for byte.
pub const DISPLAY_NAME: &str = "Owlette Service";

/// Service description, also unchanged from the NSSM registration.
pub const DESCRIPTION: &str = "Owlette process monitoring and management service";

/// Services that must be running before the agent starts. Same three NSSM was
/// given: TCP/IP, the DNS client and the network location awareness service, so
/// a cold boot does not hand the agent a stack with no route.
pub const DEPENDENCIES: [&str; 3] = ["Tcpip", "Dnscache", "NlaSvc"];

/// The child process the host supervises.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpec {
  /// The embedded interpreter, `{root}\python\python.exe`.
  pub program: PathBuf,
  /// Its single argument, `{root}\agent\src\owlette_runner.py`.
  pub script: PathBuf,
  /// Working directory, `{root}\agent\src` — NSSM's `AppDirectory`.
  pub working_dir: PathBuf,
}

impl ChildSpec {
  /// The command line as it is logged. Not used to launch anything (the child
  /// is spawned from the fields above, so no quoting rules apply), only so the
  /// host log records exactly what it started.
  pub fn command_line(&self) -> String {
    format!(
      "\"{}\" \"{}\"",
      self.program.display(),
      self.script.display()
    )
  }
}

/// Build the child specification for an install root.
pub fn child_spec(install_root: &Path) -> ChildSpec {
  ChildSpec {
    program: install_root.join("python").join("python.exe"),
    script: install_root
      .join("agent")
      .join("src")
      .join("owlette_runner.py"),
    working_dir: install_root.join("agent").join("src"),
  }
}

/// The install root for a host binary at `{root}\tools\owlette-host.exe`.
///
/// Falls back to the binary's own directory if it somehow has no grandparent,
/// which keeps a developer running the exe out of `target\release` from
/// panicking — it will simply fail to find python and say so.
pub fn install_root_from_exe(exe: &Path) -> PathBuf {
  exe
    .parent()
    .and_then(|tools| tools.parent())
    .map(Path::to_path_buf)
    .unwrap_or_else(|| exe.parent().unwrap_or(exe).to_path_buf())
}

/// The install root of the running host binary.
pub fn install_root() -> std::io::Result<PathBuf> {
  Ok(install_root_from_exe(&std::env::current_exe()?))
}

/// `%ProgramData%\Owlette` — where config, logs, cache and tmp live.
pub fn data_dir() -> PathBuf {
  let program_data =
    std::env::var_os("ProgramData").unwrap_or_else(|| OsString::from(r"C:\ProgramData"));
  PathBuf::from(program_data).join("Owlette")
}

/// `%ProgramData%\Owlette\logs`.
pub fn log_dir() -> PathBuf {
  data_dir().join("logs")
}

/// True when a service's registered image is NSSM.
///
/// The argument is the raw `ImagePath` (which includes any arguments), because
/// that is what `QueryServiceConfig` hands back — so this is a substring test,
/// not a file-name comparison.
pub fn image_is_nssm(image_path: &str) -> bool {
  image_path.to_ascii_lowercase().contains("nssm.exe")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_child_is_the_embedded_interpreter_running_the_runner() {
    let spec = child_spec(Path::new(r"C:\ProgramData\Owlette"));
    assert_eq!(
      spec.program,
      PathBuf::from(r"C:\ProgramData\Owlette\python\python.exe")
    );
    assert_eq!(
      spec.script,
      PathBuf::from(r"C:\ProgramData\Owlette\agent\src\owlette_runner.py")
    );
    // NSSM's AppDirectory was agent\src, and owlette_runner.py's sys.path
    // insert assumes it.
    assert_eq!(
      spec.working_dir,
      PathBuf::from(r"C:\ProgramData\Owlette\agent\src")
    );
  }

  #[test]
  fn the_logged_command_line_quotes_both_paths() {
    let spec = child_spec(Path::new(r"C:\Program Files\Owlette"));
    assert_eq!(
      spec.command_line(),
      r#""C:\Program Files\Owlette\python\python.exe" "C:\Program Files\Owlette\agent\src\owlette_runner.py""#
    );
  }

  #[test]
  fn the_install_root_is_two_directories_above_the_binary() {
    assert_eq!(
      install_root_from_exe(Path::new(r"C:\ProgramData\Owlette\tools\owlette-host.exe")),
      PathBuf::from(r"C:\ProgramData\Owlette")
    );
  }

  #[test]
  fn a_binary_with_no_grandparent_falls_back_to_its_own_directory() {
    assert_eq!(
      install_root_from_exe(Path::new(r"C:\owlette-host.exe")),
      PathBuf::from(r"C:\")
    );
  }

  #[test]
  fn an_nssm_image_path_is_recognised_with_or_without_arguments() {
    assert!(image_is_nssm(r"C:\ProgramData\Owlette\tools\nssm.exe"));
    assert!(image_is_nssm(r"C:\ProgramData\Owlette\tools\NSSM.EXE"));
    assert!(image_is_nssm(
      r#""C:\Owlette\tools\nssm.exe" OwletteService"#
    ));
    assert!(!image_is_nssm(
      r#""C:\ProgramData\Owlette\tools\owlette-host.exe" run"#
    ));
  }
}
