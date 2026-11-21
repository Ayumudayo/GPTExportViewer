use std::io::Read;
use std::path::Path;

use crate::errors::{io_error, AppResult};

pub fn sniff_mime(path: &Path, fallback: Option<&str>) -> AppResult<String> {
    let mut file = std::fs::File::open(path).map_err(|error| io_error(path, error))?;
    let mut header = [0_u8; 256];
    let count = file
        .read(&mut header)
        .map_err(|error| io_error(path, error))?;
    let bytes = &header[..count];

    let detected = if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if is_svg_header(bytes) {
        Some("image/svg+xml")
    } else {
        None
    };

    Ok(detected
        .or(fallback)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string())
}

fn is_svg_header(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_start_matches('\u{FEFF}').trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg"))
}

pub fn infer_mime_from_name(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".bmp") {
        Some("image/bmp")
    } else if lower.ends_with(".avif") {
        Some("image/avif")
    } else if lower.ends_with(".svg") {
        Some("image/svg+xml")
    } else {
        None
    }
}
