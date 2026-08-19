//! The icon Windows shows for an executable, as a PNG the process list can draw.
//!
//! A row that says `touch` beside a green dot tells an operator which entry it
//! is; the TouchDesigner icon tells them at a glance, which is the whole point
//! of the collapsed rail where the name is not on screen at all.
//!
//! The shell is asked first (`SHGetFileInfoW`), so a `.bat` gets the script
//! icon and a file type with a registered handler gets that handler's — the
//! same image Explorer draws for the same path, which is what an operator is
//! comparing it against. When the shell declines, the file's own icon resource
//! is read directly (`ExtractIconExW`); see [`resource_icon`] for why that is
//! not a hypothetical fallback.
//!
//! Two things this deliberately does not do:
//!
//! * **It does not resolve a process's *document*.** The caller passes
//!   `exe_path`, so a `.toe` entry shows the TouchDesigner icon and a python
//!   script shows python's. That is the application the operator recognises; the
//!   document is what the `name` field is for.
//! * **It does not fail loudly.** A path that is gone, a target with no icon at
//!   all, a shell extension that misbehaves — each is `None`, and the list draws
//!   its lucide fallback. An icon is decoration; it can never be a reason a row
//!   does not appear.

use std::collections::HashMap;
use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
  DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
  BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, RGBQUAD,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
  ExtractIconExW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use crate::png;

/// Anything wider than this is not an icon, it is a bitmap something handed us
/// by mistake; refusing it keeps a bad shell extension from asking for a
/// gigabyte of scanlines.
const MAX_ICON_EDGE: u32 = 512;

/// Entries kept before the whole table is dropped.
///
/// One per configured process is the real load — a couple of dozen at most — so
/// this only ever trips if something starts asking about arbitrary paths. Clear
/// rather than evict: without an access order there is no least-recently-used to
/// pick, and re-extracting a handful of icons costs a millisecond each.
const CACHE_LIMIT: usize = 256;

/// What was extracted, and the file it was extracted from.
struct Cached {
  /// Modified time and size together: an in-place update that lands in the same
  /// millisecond is unlikely, and one that also keeps the exact byte count is
  /// not something an installer produces.
  modified: Option<SystemTime>,
  size: u64,
  /// `None` is a real answer — this file has no icon — and is cached as one, so
  /// a scriptless `.bat` is not re-probed on every render.
  icon: Option<String>,
}

static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
  CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The icon for `path`, base64-encoded PNG, or `None` when there is not one.
///
/// `config.json` stores forward slashes (`C:/apps/player.exe`) because the web
/// app writes them; the shell wants backslashes, and Windows paths compare
/// case-insensitively — so the path is normalised once, here, and that
/// normalised form is both what is passed to the shell and what keys the cache.
pub fn icon_base64(path: &str) -> Result<Option<String>, String> {
  let target = path.trim();
  if target.is_empty() {
    return Ok(None);
  }
  let target = target.replace('/', "\\");
  let key = target.to_lowercase();

  // A path that is not there has no icon, and no cache entry worth keeping: the
  // operator is probably still typing it.
  let Ok(metadata) = std::fs::metadata(&target) else {
    forget(&key);
    return Ok(None);
  };
  let modified = metadata.modified().ok();
  let size = metadata.len();

  if let Some(hit) = lookup(&key, modified, size) {
    return Ok(hit);
  }

  let icon = extract(&target)?;
  remember(key, modified, size, icon.clone());
  Ok(icon)
}

fn lookup(key: &str, modified: Option<SystemTime>, size: u64) -> Option<Option<String>> {
  let table = cache().lock().ok()?;
  let entry = table.get(key)?;
  (entry.modified == modified && entry.size == size).then(|| entry.icon.clone())
}

fn remember(key: String, modified: Option<SystemTime>, size: u64, icon: Option<String>) {
  let Ok(mut table) = cache().lock() else {
    return;
  };
  if table.len() >= CACHE_LIMIT {
    table.clear();
  }
  table.insert(
    key,
    Cached {
      modified,
      size,
      icon,
    },
  );
}

fn forget(key: &str) {
  if let Ok(mut table) = cache().lock() {
    table.remove(key);
  }
}

// ─── win32 ──────────────────────────────────────────────────────────────────

/// COM on the calling thread, for as long as this lives.
///
/// The shell resolves an icon through handlers that are COM objects, and a
/// command runs on whichever async-runtime worker took it — a thread that has
/// never initialised COM. `RPC_E_CHANGED_MODE` (another mode already in force)
/// is not an error to us: the thread has an apartment, which is all the shell
/// needs. It is the one outcome we must *not* balance with an uninitialise.
struct ComScope(bool);

impl ComScope {
  fn enter() -> Self {
    let outcome = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    Self(outcome.is_ok())
  }
}

impl Drop for ComScope {
  fn drop(&mut self) {
    if self.0 {
      unsafe { CoUninitialize() };
    }
  }
}

/// An `HICON` that is destroyed however the extraction ends.
struct OwnedIcon(HICON);

impl Drop for OwnedIcon {
  fn drop(&mut self) {
    if !self.0.is_invalid() {
      let _ = unsafe { DestroyIcon(self.0) };
    }
  }
}

/// `GetIconInfo` hands back two bitmaps and makes them the caller's to delete.
struct OwnedBitmap(HBITMAP);

impl Drop for OwnedBitmap {
  fn drop(&mut self) {
    if !self.0.is_invalid() {
      let _ = unsafe { DeleteObject(self.0.into()) };
    }
  }
}

/// The screen DC, released however the extraction ends.
struct ScreenDc(HDC);

impl ScreenDc {
  fn get() -> Option<Self> {
    let dc = unsafe { GetDC(None) };
    (!dc.is_invalid()).then_some(Self(dc))
  }
}

impl Drop for ScreenDc {
  fn drop(&mut self) {
    unsafe { ReleaseDC(None, self.0) };
  }
}

fn wide(text: &str) -> Vec<u16> {
  OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// The shell's icon for `path` — what Explorer draws for the same file.
///
/// Handles everything an association can decide: a `.bat` gets the script icon,
/// a document gets its handler's. It is the first choice for exactly that
/// reason, and it is also the one that can decline.
fn shell_icon(path: &str) -> Option<OwnedIcon> {
  let wide_path = wide(path);
  let mut info = SHFILEINFOW::default();
  let handled = unsafe {
    SHGetFileInfoW(
      PCWSTR(wide_path.as_ptr()),
      FILE_ATTRIBUTE_NORMAL,
      Some(&mut info),
      std::mem::size_of::<SHFILEINFOW>() as u32,
      // The large icon is 32×32, which is the size a 16 px row draws crisply on
      // a 200 % display and downsamples cleanly on a 100 % one. The small icon
      // would be soft on every machine with a scaled display, which is most of
      // the fleet.
      SHGFI_ICON | SHGFI_LARGEICON,
    )
  };
  if handled == 0 || info.hIcon.is_invalid() {
    log::debug!("the shell produced no icon for {path} (result={handled})");
    return None;
  }
  Some(OwnedIcon(info.hIcon))
}

/// The first icon in the file's own resources, read without the shell.
///
/// The fallback, and not a theoretical one: `SHGetFileInfoW` returns success
/// with a null handle for some executables inside this process while producing
/// the icon perfectly well for the same file from a plain console process —
/// TouchDesigner is one, which is the single most likely icon in this fleet.
/// Whatever the shell is doing there, the icon *is* in the file, and this is
/// the call that reads it.
fn resource_icon(path: &str) -> Option<OwnedIcon> {
  let wide_path = wide(path);
  let mut large = HICON::default();
  let extracted =
    unsafe { ExtractIconExW(PCWSTR(wide_path.as_ptr()), 0, Some(&mut large), None, 1) };
  if extracted == 0 || large.is_invalid() {
    log::debug!("no icon resource in {path} (result={extracted})");
    return None;
  }
  Some(OwnedIcon(large))
}

/// One extraction at a time, process-wide.
///
/// Every row asks for its icon in the same frame, and the shell answers a
/// concurrent `SHGetFileInfoW` by *succeeding* with a null icon handle — which
/// looks exactly like a file that has no icon, and produced a generic glyph on
/// whichever row happened to lose the race. Extraction is a millisecond and the
/// answer is cached, so a queue costs nothing worth measuring.
static EXTRACTION: Mutex<()> = Mutex::new(());

/// Ask for `path`'s icon and encode it.
fn extract(path: &str) -> Result<Option<String>, String> {
  // A poisoned lock means another extraction panicked mid-Win32-call; the guard
  // is still ours to take, and refusing every icon after that helps nobody.
  let _queue = EXTRACTION
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let _com = ComScope::enter();

  let Some(icon) = shell_icon(path).or_else(|| resource_icon(path)) else {
    // The row is about to draw a generic glyph for a file that exists. Said
    // once per path (the answer is cached), and at a level that is on in the
    // field — a silent fallback is one nobody can diagnose from a screenshot.
    log::info!("no icon for {path}: the shell declined and the file has none of its own");
    return Ok(None);
  };

  let Some((width, height, rgba)) = pixels(icon.0)? else {
    return Ok(None);
  };
  let encoded = png::rgba_as_base64_png(width, height, &rgba);
  if encoded.is_none() {
    log::warn!("could not encode the {width}x{height} icon for {path}");
  }
  Ok(encoded)
}

/// An icon's colour bitmap as straight RGBA, top-down.
fn pixels(icon: HICON) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
  let mut info = ICONINFO::default();
  unsafe { GetIconInfo(icon, &mut info) }
    .map_err(|error| format!("GetIconInfo failed: {error}"))?;

  let colour = OwnedBitmap(info.hbmColor);
  let mask = OwnedBitmap(info.hbmMask);

  // A 1-bit icon (a cursor, or something very old) carries its image in the
  // mask alone. Nothing in a process list looks like that; the fallback glyph
  // is a better answer than a black square.
  if colour.0.is_invalid() {
    log::debug!("the icon has no colour bitmap — only a mask");
    return Ok(None);
  }

  let mut bitmap = BITMAP::default();
  let read = unsafe {
    GetObjectW(
      colour.0.into(),
      std::mem::size_of::<BITMAP>() as i32,
      Some(&mut bitmap as *mut BITMAP as *mut c_void),
    )
  };
  if read == 0 {
    return Err("GetObjectW could not measure the icon bitmap".into());
  }

  let (width, height) = (bitmap.bmWidth, bitmap.bmHeight.abs());
  if width <= 0 || height <= 0 || width as u32 > MAX_ICON_EDGE || height as u32 > MAX_ICON_EDGE {
    log::debug!("the icon bitmap is {width}x{height}, which is not an icon");
    return Ok(None);
  }
  let (width, height) = (width as u32, height as u32);

  let Some(dc) = ScreenDc::get() else {
    return Err("no screen device context".into());
  };

  let mut bgra = vec![0u8; (width as usize) * (height as usize) * 4];
  let mut header = rgba_header(width, height);
  let lines = unsafe {
    GetDIBits(
      dc.0,
      colour.0,
      0,
      height,
      Some(bgra.as_mut_ptr() as *mut c_void),
      &mut header,
      DIB_RGB_COLORS,
    )
  };
  if lines == 0 {
    return Err("GetDIBits could not read the icon bitmap".into());
  }

  // Icons written before Windows XP have no alpha channel at all: every alpha
  // byte is zero, and the shape lives in the AND mask instead. Taking that
  // literally would draw a fully transparent icon, which is how this is usually
  // discovered — as an icon that "does not load".
  if bgra.iter().skip(3).step_by(4).all(|&alpha| alpha == 0) {
    match mask_alpha(&dc, mask.0, width, height) {
      Some(alpha) => apply_alpha(&mut bgra, &alpha),
      // No mask either: assume the icon is simply opaque rather than dropping
      // it, since we do have colour for every pixel.
      None => bgra.iter_mut().skip(3).step_by(4).for_each(|a| *a = 0xff),
    }
  }

  bgra_to_rgba(&mut bgra);
  Ok(Some((width, height, bgra)))
}

/// A top-down 32-bit `BITMAPINFO`, which is what asks `GetDIBits` to convert
/// whatever the bitmap actually is into BGRA rows in the order we want them.
fn rgba_header(width: u32, height: u32) -> BITMAPINFO {
  BITMAPINFO {
    bmiHeader: BITMAPINFOHEADER {
      biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: width as i32,
      // Negative: rows top-down, matching PNG's order. A positive height would
      // hand back the image upside down.
      biHeight: -(height as i32),
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB.0,
      ..Default::default()
    },
    bmiColors: [RGBQUAD::default(); 1],
  }
}

/// A 1-bit DIB needs a two-entry colour table, which `BITMAPINFO` has no room
/// for — its `bmiColors` is declared as one. This is the same allocation with
/// the space the shape actually needs.
#[repr(C)]
struct MonochromeInfo {
  header: BITMAPINFOHEADER,
  colours: [RGBQUAD; 2],
}

/// Per-pixel alpha derived from an icon's AND mask: a set bit means the
/// background shows through, which is what `DrawIcon` does with it.
fn mask_alpha(dc: &ScreenDc, mask: HBITMAP, width: u32, height: u32) -> Option<Vec<u8>> {
  if mask.is_invalid() {
    return None;
  }

  // Rows of a DIB are padded to four bytes, whatever the depth.
  let stride = (width as usize).div_ceil(32) * 4;
  let mut bits = vec![0u8; stride * height as usize];
  let mut info = MonochromeInfo {
    header: BITMAPINFOHEADER {
      biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: width as i32,
      biHeight: -(height as i32),
      biPlanes: 1,
      biBitCount: 1,
      biCompression: BI_RGB.0,
      ..Default::default()
    },
    colours: [RGBQUAD::default(); 2],
  };

  let lines = unsafe {
    GetDIBits(
      dc.0,
      mask,
      0,
      height,
      Some(bits.as_mut_ptr() as *mut c_void),
      &mut info as *mut MonochromeInfo as *mut BITMAPINFO,
      DIB_RGB_COLORS,
    )
  };
  if lines == 0 {
    return None;
  }

  Some(alpha_from_mask_bits(&bits, width, height))
}

/// Expand packed mask bits into one alpha byte per pixel.
fn alpha_from_mask_bits(bits: &[u8], width: u32, height: u32) -> Vec<u8> {
  let stride = (width as usize).div_ceil(32) * 4;
  let mut alpha = Vec::with_capacity((width * height) as usize);
  for row in 0..height as usize {
    for column in 0..width as usize {
      let byte = bits
        .get(row * stride + column / 8)
        .copied()
        .unwrap_or_default();
      let transparent = byte & (0x80 >> (column % 8)) != 0;
      alpha.push(if transparent { 0x00 } else { 0xff });
    }
  }
  alpha
}

/// Write one alpha byte per pixel into a BGRA buffer.
fn apply_alpha(bgra: &mut [u8], alpha: &[u8]) {
  for (pixel, &value) in bgra.chunks_exact_mut(4).zip(alpha) {
    pixel[3] = value;
  }
}

/// Windows hands back blue-green-red-alpha; PNG wants red-green-blue-alpha.
fn bgra_to_rgba(pixels: &mut [u8]) {
  for pixel in pixels.chunks_exact_mut(4) {
    pixel.swap(0, 2);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_mask_bit_that_is_set_means_the_background_shows_through() {
    // One 8-pixel row: the first four pixels masked out, the last four kept.
    // A row is padded to four bytes even when it needs one.
    let bits = [0b1111_0000, 0, 0, 0];
    assert_eq!(
      alpha_from_mask_bits(&bits, 8, 1),
      [0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]
    );
  }

  #[test]
  fn the_mask_is_read_a_padded_row_at_a_time() {
    // 33 pixels wide: two rows of eight bytes (32 bits rounded up to 64), so
    // reading it as five bytes per row would smear row two into row one.
    let mut bits = vec![0u8; 8 * 2];
    bits[0] = 0b1000_0000; // first pixel of row one
    bits[8] = 0b0100_0000; // second pixel of row two

    let alpha = alpha_from_mask_bits(&bits, 33, 2);
    assert_eq!(alpha.len(), 66);
    assert_eq!(alpha[0], 0x00);
    assert_eq!(alpha[1], 0xff);
    assert_eq!(alpha[33], 0xff);
    assert_eq!(alpha[34], 0x00);
  }

  #[test]
  fn a_truncated_mask_reads_as_opaque_rather_than_panicking() {
    // GetDIBits has written fewer rows than it claimed before now; an icon with
    // a missing corner beats an app that stops.
    assert_eq!(alpha_from_mask_bits(&[], 2, 1), [0xff, 0xff]);
  }

  #[test]
  fn alpha_lands_on_the_fourth_byte_of_every_pixel() {
    let mut bgra = vec![1, 2, 3, 0, 4, 5, 6, 0];
    apply_alpha(&mut bgra, &[0x80, 0xff]);
    assert_eq!(bgra, [1, 2, 3, 0x80, 4, 5, 6, 0xff]);
  }

  #[test]
  fn the_channel_swap_leaves_green_and_alpha_alone() {
    let mut pixels = vec![0x11, 0x22, 0x33, 0x44];
    bgra_to_rgba(&mut pixels);
    assert_eq!(pixels, [0x33, 0x22, 0x11, 0x44]);
  }

  #[test]
  fn a_path_that_is_not_there_has_no_icon() {
    assert_eq!(icon_base64("C:\\nowhere\\at\\all.exe"), Ok(None));
    assert_eq!(icon_base64(""), Ok(None));
    assert_eq!(icon_base64("   "), Ok(None));
  }

  #[test]
  fn a_forward_slashed_path_is_the_same_file_as_a_backslashed_one() {
    // `config.json` is written with forward slashes by the web app and by the
    // drop classifier, and the shell will not take them — so this spelling is
    // the one the app actually asks about, not an edge case.
    let exe = std::env::current_exe().expect("current exe");
    let forward = exe.to_string_lossy().replace('\\', "/");
    assert!(forward.contains('/'), "{forward}");

    let icon = icon_base64(&forward).expect("extraction");
    assert!(icon.is_some(), "no icon for the forward-slashed {forward}");
    assert_eq!(icon_base64(&exe.to_string_lossy()), Ok(icon));
  }

  #[test]
  fn a_real_executable_yields_a_png() {
    // The test binary itself: it has no icon resource of its own, so this also
    // covers the path where the shell substitutes the generic one.
    let exe = std::env::current_exe().expect("current exe");
    let path = exe.to_string_lossy().into_owned();

    let icon = icon_base64(&path).expect("extraction").expect("an icon");
    assert!(
      icon.starts_with("iVBORw0KGgo"),
      "not a png: {}",
      &icon[..16]
    );

    // …and the second call answers from the cache, with the same bytes. A
    // forward-slashed spelling of the same file is the same cache entry.
    assert_eq!(icon_base64(&path.replace('\\', "/")), Ok(Some(icon)));
  }
}
