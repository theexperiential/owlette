//! A minimal PNG encoder, plus the base64 that carries one over the IPC bridge.
//!
//! The only image this app produces is a 32×32 icon lifted from an executable —
//! not worth a new crate for ~100 lines of format.
//!
//! **Nothing here compresses.** deflate's "stored" block (length, complement,
//! bytes) is a legal member of the zlib stream PNG requires. At 4 KB per icon
//! the base64 overhead already exceeds anything deflate would save, and a
//! compressor is a lot of code to get wrong.
//!
//! Output is spec-conforming: signature, `IHDR`, one `IDAT`, `IEND`, each chunk
//! CRC'd, the zlib stream closed with its adler-32.

/// The eight bytes every PNG starts with (§5.2).
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Colour type 6: truecolour with alpha, 8 bits per sample.
const COLOR_TYPE_RGBA: u8 = 6;
const BIT_DEPTH: u8 = 8;

/// Largest payload one stored deflate block can carry (RFC 1951 §3.2.4).
const MAX_STORED_BLOCK: usize = u16::MAX as usize;

/// Encode straight (non-premultiplied) RGBA pixels as a base64 PNG.
///
/// `rgba` is top-down, 4 bytes per pixel. Returns `None` rather than a
/// half-formed file when the buffer doesn't match the stated dimensions.
pub fn rgba_as_base64_png(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
  Some(base64(&rgba_as_png(width, height, rgba)?))
}

/// The PNG bytes. Split out so the tests can walk the file.
fn rgba_as_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
  if width == 0 || height == 0 {
    return None;
  }
  let expected = (width as usize)
    .checked_mul(height as usize)?
    .checked_mul(4)?;
  if rgba.len() != expected {
    return None;
  }

  let mut png = Vec::with_capacity(expected + expected / 64 + 128);
  png.extend_from_slice(&SIGNATURE);

  let mut header = Vec::with_capacity(13);
  header.extend_from_slice(&width.to_be_bytes());
  header.extend_from_slice(&height.to_be_bytes());
  header.push(BIT_DEPTH);
  header.push(COLOR_TYPE_RGBA);
  header.push(0); // compression method: deflate, the only one there is
  header.push(0); // filter method: the only one there is
  header.push(0); // interlace: none
  chunk(&mut png, b"IHDR", &header);

  chunk(
    &mut png,
    b"IDAT",
    &zlib_stored(&scanlines(width, height, rgba)),
  );
  chunk(&mut png, b"IEND", &[]);
  Some(png)
}

/// Prefix every row with its filter byte. Filter 0 = none, so rows are verbatim
/// — which is what makes the stored-block approach viable.
fn scanlines(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
  let stride = width as usize * 4;
  let mut raw = Vec::with_capacity((stride + 1) * height as usize);
  for row in 0..height as usize {
    raw.push(0);
    raw.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
  }
  raw
}

/// Wrap `raw` in a zlib stream of stored deflate blocks.
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
  // 0x78 0x01: deflate, 32 KB window, no preset dict, fastest level. The pair
  // doubles as zlib's header check — 0x7801 divides by 31.
  let mut out = vec![0x78, 0x01];

  // An empty payload still needs one final empty block, hence loop-not-for.
  let mut offset = 0;
  loop {
    let end = (offset + MAX_STORED_BLOCK).min(raw.len());
    let block = &raw[offset..end];
    let final_block = end == raw.len();
    out.push(u8::from(final_block)); // BTYPE 00 (stored) + BFINAL
    let len = block.len() as u16;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&(!len).to_le_bytes());
    out.extend_from_slice(block);
    offset = end;
    if final_block {
      break;
    }
  }

  out.extend_from_slice(&adler32(raw).to_be_bytes());
  out
}

/// Append one chunk: length, type, data, CRC of the last two.
fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
  out.extend_from_slice(&(data.len() as u32).to_be_bytes());
  out.extend_from_slice(kind);
  out.extend_from_slice(data);

  let mut crc = crc32(kind);
  crc = crc32_continue(crc, data);
  out.extend_from_slice(&crc32_finish(crc).to_be_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
  crc32_continue(u32::MAX, bytes)
}

/// PNG/IEEE CRC, reflected, bitwise — three chunks doesn't justify a 256-entry
/// table.
fn crc32_continue(mut crc: u32, bytes: &[u8]) -> u32 {
  const POLYNOMIAL: u32 = 0xedb8_8320;
  for &byte in bytes {
    crc ^= byte as u32;
    for _ in 0..8 {
      let carry = crc & 1;
      crc >>= 1;
      if carry != 0 {
        crc ^= POLYNOMIAL;
      }
    }
  }
  crc
}

fn crc32_finish(crc: u32) -> u32 {
  crc ^ u32::MAX
}

fn adler32(bytes: &[u8]) -> u32 {
  const MODULO: u32 = 65_521;
  let mut low: u32 = 1;
  let mut high: u32 = 0;
  for &byte in bytes {
    low = (low + byte as u32) % MODULO;
    high = (high + low) % MODULO;
  }
  (high << 16) | low
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648 §4), as a `data:` URL expects.
fn base64(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for group in bytes.chunks(3) {
    let a = group[0] as u32;
    let b = group.get(1).copied().unwrap_or(0) as u32;
    let c = group.get(2).copied().unwrap_or(0) as u32;
    let triple = (a << 16) | (b << 8) | c;

    out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
    out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
    out.push(if group.len() > 1 {
      ALPHABET[(triple >> 6) as usize & 63] as char
    } else {
      '='
    });
    out.push(if group.len() > 2 {
      ALPHABET[triple as usize & 63] as char
    } else {
      '='
    });
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  /// One chunk as the file carries it, already CRC-checked.
  struct Chunk {
    kind: String,
    data: Vec<u8>,
  }

  /// Walk a PNG, verifying the signature and every CRC.
  fn chunks(png: &[u8]) -> Vec<Chunk> {
    assert_eq!(&png[..8], &SIGNATURE, "png signature");

    let mut chunks = Vec::new();
    let mut at = 8;
    while at < png.len() {
      let length = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
      let kind = String::from_utf8(png[at + 4..at + 8].to_vec()).expect("chunk type is ascii");
      let data = png[at + 8..at + 8 + length].to_vec();
      let stored = u32::from_be_bytes(png[at + 8 + length..at + 12 + length].try_into().unwrap());
      assert_eq!(
        stored,
        crc32_finish(crc32_continue(crc32(kind.as_bytes()), &data)),
        "crc of the {kind} chunk"
      );
      chunks.push(Chunk { kind, data });
      at += 12 + length;
    }
    assert_eq!(at, png.len(), "no trailing bytes");
    chunks
  }

  /// Undo `zlib_stored`, checking the wrapper as it goes.
  fn inflate_stored(stream: &[u8]) -> Vec<u8> {
    assert_eq!(&stream[..2], &[0x78, 0x01], "zlib header");
    assert_eq!(
      (u16::from_be_bytes([stream[0], stream[1]])) % 31,
      0,
      "zlib header check bits"
    );

    let mut raw = Vec::new();
    let mut at = 2;
    loop {
      let header = stream[at];
      assert_eq!(header & 0b110, 0, "stored block type");
      let length = u16::from_le_bytes([stream[at + 1], stream[at + 2]]);
      let complement = u16::from_le_bytes([stream[at + 3], stream[at + 4]]);
      assert_eq!(complement, !length, "stored length complement");
      raw.extend_from_slice(&stream[at + 5..at + 5 + length as usize]);
      at += 5 + length as usize;
      if header & 1 == 1 {
        break;
      }
    }

    assert_eq!(
      u32::from_be_bytes(stream[at..at + 4].try_into().unwrap()),
      adler32(&raw),
      "adler-32 of the payload"
    );
    assert_eq!(at + 4, stream.len(), "no trailing bytes in the zlib stream");
    raw
  }

  #[test]
  fn a_one_pixel_image_is_a_whole_png() {
    let png = rgba_as_png(1, 1, &[0xff, 0x00, 0x00, 0xff]).expect("encodes");
    let chunks = chunks(&png);

    let kinds: Vec<&str> = chunks.iter().map(|chunk| chunk.kind.as_str()).collect();
    assert_eq!(kinds, ["IHDR", "IDAT", "IEND"]);

    let header = &chunks[0].data;
    assert_eq!(u32::from_be_bytes(header[0..4].try_into().unwrap()), 1);
    assert_eq!(u32::from_be_bytes(header[4..8].try_into().unwrap()), 1);
    assert_eq!(header[8], BIT_DEPTH);
    assert_eq!(header[9], COLOR_TYPE_RGBA);
    assert_eq!(&header[10..13], &[0, 0, 0]);

    assert_eq!(inflate_stored(&chunks[1].data), [0, 0xff, 0x00, 0x00, 0xff]);
    assert!(chunks[2].data.is_empty());
  }

  #[test]
  fn the_terminator_matches_the_one_every_png_ends_with() {
    // IEND is empty, so its twelve bytes are identical in every PNG — a wrong
    // CRC shows up here.
    let png = rgba_as_png(1, 1, &[0; 4]).expect("encodes");
    assert_eq!(
      &png[png.len() - 12..],
      &[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]
    );
  }

  #[test]
  fn every_row_keeps_its_filter_byte_and_its_pixels() {
    let rgba: Vec<u8> = (0..24).collect();
    let png = rgba_as_png(3, 2, &rgba).expect("encodes");
    let raw = inflate_stored(&chunks(&png)[1].data);

    assert_eq!(raw[0], 0);
    assert_eq!(&raw[1..13], &rgba[0..12]);
    assert_eq!(raw[13], 0);
    assert_eq!(&raw[14..26], &rgba[12..24]);
    assert_eq!(raw.len(), 26);
  }

  #[test]
  fn an_image_past_one_block_is_split_and_still_reassembles() {
    // 256×256 RGBA is 263 KB of scanlines — five stored blocks. Nothing in the
    // icon path is this big yet; the encoder must not silently truncate when
    // something is.
    let edge = 256;
    let rgba: Vec<u8> = (0..edge * edge * 4).map(|i| (i % 251) as u8).collect();
    let png = rgba_as_png(edge as u32, edge as u32, &rgba).expect("encodes");

    let payload = &chunks(&png)[1].data;
    let blocks = (payload.len() - 6) / MAX_STORED_BLOCK + 1;
    assert!(blocks > 1, "expected several blocks, got {blocks}");

    let raw = inflate_stored(payload);
    assert_eq!(raw.len(), (edge * 4 + 1) * edge);
    assert_eq!(&raw[1..edge * 4 + 1], &rgba[..edge * 4]);
  }

  #[test]
  fn a_buffer_that_does_not_match_its_dimensions_is_refused() {
    assert!(rgba_as_png(2, 2, &[0; 15]).is_none());
    assert!(rgba_as_png(2, 2, &[0; 17]).is_none());
    assert!(rgba_as_png(0, 4, &[]).is_none());
    assert!(rgba_as_png(4, 0, &[]).is_none());
    assert!(rgba_as_png(u32::MAX, u32::MAX, &[0; 16]).is_none());
  }

  #[test]
  fn base64_matches_the_rfc_test_vectors() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foob"), "Zm9vYg==");
    assert_eq!(base64(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    // Whole alphabet, so a transposed table entry can't hide.
    assert_eq!(&base64(&(0u8..=255).collect::<Vec<u8>>())[..8], "AAECAwQF");
  }

  #[test]
  fn the_base64_png_starts_with_the_signature_a_decoder_looks_for() {
    let encoded = rgba_as_base64_png(1, 1, &[0; 4]).expect("encodes");
    // Base64 of the signature bytes — what every PNG data URL opens with.
    assert!(encoded.starts_with("iVBORw0KGgo"), "{encoded}");
    assert!(rgba_as_base64_png(1, 1, &[0; 3]).is_none());
  }
}
