//! Where everything lives, and what the supervised child is.
//!
//! Self-locating: the host ships at `{install_root}\tools\owlette-host.exe` (nssm.exe's old slot),
//! so the install root is two directories up. Nothing comes from the registry — configuration in
//! two places is configuration that can disagree with itself.
//!
//! The data directory resolves separately from `%ProgramData%`: install.bat keeps logs/config/cache
//! under `%ProgramData%\Owlette` even when the payload goes elsewhere via `/DIR=`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Unchanged from the NSSM registration: `shared_utils.SERVICE_NAME`, the desktop app's
/// `service_ctl.rs`, the update recovery watchdog and the docs all address the service by it.
pub const SERVICE_NAME: &str = "OwletteService";

/// Shown in Services.msc; matches the NSSM registration byte for byte.
pub const DISPLAY_NAME: &str = "Owlette Service";

/// Unchanged from the NSSM registration.
pub const DESCRIPTION: &str = "Owlette process monitoring and management service";

/// Same three NSSM was given — TCP/IP, DNS client, network location awareness — so a cold boot
/// cannot hand the agent a stack with no route.
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
  /// For the log only — the child is spawned from the fields above, so no quoting rules apply.
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

/// Install root for a host binary at `{root}\tools\owlette-host.exe`. Falls back to the binary's
/// own directory when there is no grandparent, so running out of `target\release` fails to find
/// python rather than panicking.
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

/// Takes the raw `ImagePath` including arguments (what `QueryServiceConfig` returns), so this is a
/// substring test rather than a file-name comparison.
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
    // NSSM's AppDirectory was agent\src, and owlette_runner.py's sys.path insert assumes it.
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
