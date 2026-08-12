//! Layout of the owlette ProgramData tree.
//!
//! Mirrors `shared_utils.get_data_path()` (`agent/src/shared_utils.py:900-941`):
//! the root is `%PROGRAMDATA%\Owlette`, falling back to `C:\ProgramData\Owlette`
//! when the variable is missing or empty. Reading the environment variable
//! instead of hardcoding the drive keeps the desktop app pointed at exactly the
//! tree the service uses, and lets tests redirect the whole tree elsewhere by
//! passing a different root.

use std::path::{Component, Path, PathBuf};

/// Directory created under `%PROGRAMDATA%`.
const DATA_DIR_NAME: &str = "Owlette";

/// Relative paths of the seam files, in the same spelling the TypeScript
/// wrappers use. Separators are normalised by [`resolve_in_root`], so the
/// forward slashes here are deliberate — they match the Python constants
/// (`shared_utils.CONFIG_PATH`, `shared_utils.RESULT_FILE_PATH`,
/// `owlette_service._write_service_status`).
pub const CONFIG_REL: &str = "config/config.json";
pub const APP_STATES_REL: &str = "tmp/app_states.json";
pub const SERVICE_STATUS_REL: &str = "tmp/service_status.json";
pub const GUI_PID_REL: &str = "tmp/gui.pid";

/// Absolute path of the owlette data root.
pub fn data_root() -> PathBuf {
  let program_data = std::env::var_os("PROGRAMDATA")
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "C:\\ProgramData".into());
  Path::new(&program_data).join(DATA_DIR_NAME)
}

/// Resolve a caller-supplied path against the data root.
///
/// Relative paths are joined onto the root; absolute paths are accepted only
/// when they land inside it. `..` is rejected outright rather than normalised,
/// so no frontend string can address (or overwrite) a file outside the owlette
/// tree — the JSON commands are the app's only filesystem write surface.
pub fn resolve_in_root(root: &Path, requested: &str) -> Result<PathBuf, String> {
  let trimmed = requested.trim();
  if trimmed.is_empty() {
    return Err("path is empty".to_string());
  }

  let requested_path = Path::new(trimmed);
  let joined = if requested_path.is_absolute() {
    requested_path.to_path_buf()
  } else {
    root.join(requested_path)
  };

  // `components()` drops `.` segments and keeps `..` ones, which is exactly the
  // distinction we want to make here.
  let mut normalized = PathBuf::new();
  for component in joined.components() {
    match component {
      Component::ParentDir => return Err(format!("path must not contain '..': {trimmed}")),
      Component::CurDir => {}
      other => normalized.push(other.as_os_str()),
    }
  }

  let root_key = compare_key(root);
  let candidate_key = compare_key(&normalized);
  if candidate_key == root_key || candidate_key.starts_with(&format!("{root_key}\\")) {
    Ok(normalized)
  } else {
    Err(format!(
      "path escapes the owlette data directory: {}",
      normalized.display()
    ))
  }
}

/// Windows path comparison key: separators unified, case folded, no trailing
/// separator. Used for containment checks and for matching watcher events
/// against the files we care about.
pub fn compare_key(path: &Path) -> String {
  path
    .to_string_lossy()
    .replace('/', "\\")
    .trim_end_matches('\\')
    .to_lowercase()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn root() -> PathBuf {
    PathBuf::from("C:\\ProgramData\\Owlette")
  }

  #[test]
  fn relative_paths_resolve_under_the_root() {
    let resolved = resolve_in_root(&root(), CONFIG_REL).expect("should resolve");
    assert_eq!(resolved, root().join("config").join("config.json"));
  }

  #[test]
  fn absolute_paths_inside_the_root_are_accepted() {
    let absolute = "C:\\ProgramData\\Owlette\\tmp\\app_states.json";
    let resolved = resolve_in_root(&root(), absolute).expect("should resolve");
    assert_eq!(compare_key(&resolved), absolute.to_lowercase());
  }

  #[test]
  fn case_and_separator_differences_do_not_break_containment() {
    let resolved = resolve_in_root(&root(), "c:/programdata/owlette/tmp/service_status.json")
      .expect("should resolve");
    assert_eq!(
      compare_key(&resolved),
      "c:\\programdata\\owlette\\tmp\\service_status.json"
    );
  }

  #[test]
  fn parent_segments_are_rejected() {
    let err = resolve_in_root(&root(), "config/../../secrets.json").expect_err("should reject");
    assert!(err.contains(".."), "unexpected error: {err}");
  }

  #[test]
  fn paths_outside_the_root_are_rejected() {
    let err = resolve_in_root(&root(), "C:\\Windows\\System32\\drivers\\etc\\hosts")
      .expect_err("should reject");
    assert!(err.contains("escapes"), "unexpected error: {err}");
  }

  #[test]
  fn a_sibling_directory_with_the_root_as_a_prefix_is_rejected() {
    let err = resolve_in_root(&root(), "C:\\ProgramData\\OwletteBackup\\config.json")
      .expect_err("should reject");
    assert!(err.contains("escapes"), "unexpected error: {err}");
  }

  #[test]
  fn empty_paths_are_rejected() {
    assert!(resolve_in_root(&root(), "   ").is_err());
  }

  #[test]
  fn data_root_follows_the_programdata_variable() {
    // Same fallback shared_utils.get_data_path() uses.
    let root = data_root();
    assert!(
      root.ends_with(DATA_DIR_NAME),
      "unexpected root: {}",
      root.display()
    );
  }
}
