use std::io::Read;
use std::path::Path;

const MAX_HEADER_BYTES: usize = 64 * 1024;

pub fn read_image_dimensions(path: &Path, mime: &str) -> Option<(u32, u32)> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut bytes = vec![0; MAX_HEADER_BYTES];
    let count = file.read(&mut bytes).ok()?;
    bytes.truncate(count);
    image_dimensions_from_bytes(&bytes, mime)
}

fn image_dimensions_from_bytes(bytes: &[u8], mime: &str) -> Option<(u32, u32)> {
    if mime == "image/png" || bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return png_dimensions(bytes);
    }
    if mime == "image/gif" || bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return gif_dimensions(bytes);
    }
    if mime == "image/jpeg" || bytes.starts_with(&[0xff, 0xd8]) {
        return jpeg_dimensions(bytes);
    }
    if mime == "image/webp" || bytes.get(0..4) == Some(b"RIFF") {
        return webp_dimensions(bytes);
    }
    if mime == "image/svg+xml" || looks_like_svg(bytes) {
        return svg_dimensions(bytes);
    }
    None
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let prefix_len = bytes.len().min(256);
    let lower = String::from_utf8_lossy(&bytes[..prefix_len])
        .trim_start_matches('\u{FEFF}')
        .trim_start()
        .to_ascii_lowercase();
    lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg"))
}

fn svg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let text = String::from_utf8_lossy(bytes);
    let lower = text.to_ascii_lowercase();
    let svg_start = lower.find("<svg")?;
    let tag_rest = &text[svg_start..];
    let tag_end = tag_rest.find('>')?;
    let tag_slice = &tag_rest[..tag_end];

    let width = extract_svg_attr(tag_slice, "width").and_then(parse_svg_length);
    let height = extract_svg_attr(tag_slice, "height").and_then(parse_svg_length);
    if let (Some(w), Some(h)) = (width, height) {
        return nonzero_dimensions(w, h);
    }

    if let Some(view_box) = extract_svg_attr(tag_slice, "viewBox")
        .or_else(|| extract_svg_attr(tag_slice, "viewbox"))
    {
        let nums: Vec<f64> = view_box
            .split(|ch: char| ch.is_whitespace() || ch == ',')
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse::<f64>().ok())
            .collect();
        if nums.len() >= 4 && nums[2].is_finite() && nums[3].is_finite() {
            let w = nums[2].round();
            let h = nums[3].round();
            if w > 0.0 && h > 0.0 && w <= u32::MAX as f64 && h <= u32::MAX as f64 {
                return nonzero_dimensions(w as u32, h as u32);
            }
        }
    }
    None
}

fn extract_svg_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let needle = name.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find(&needle) {
        let pos = search_from + rel;
        let prev_ok = pos == 0
            || tag[..pos]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_whitespace());
        let after = &tag[pos + needle.len()..];
        let trimmed_eq = after.trim_start();
        if prev_ok && trimmed_eq.starts_with('=') {
            let val_rest = trimmed_eq[1..].trim_start();
            let quote = val_rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let inner = &val_rest[1..];
                let end = inner.find(quote)?;
                return Some(&inner[..end]);
            }
        }
        search_from = pos + needle.len();
    }
    None
}

fn parse_svg_length(raw: &str) -> Option<u32> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.ends_with('%') {
        return None;
    }
    let numeric = trimmed
        .strip_suffix("px")
        .unwrap_or(trimmed)
        .trim();
    let val = numeric.parse::<f64>().ok()?;
    if !val.is_finite() || val <= 0.0 || val > u32::MAX as f64 {
        return None;
    }
    let rounded = val.round() as u32;
    (rounded > 0).then_some(rounded)
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    if bytes.get(12..16) != Some(b"IHDR") {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    nonzero_dimensions(width, height)
}

fn gif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 10 {
        return None;
    }
    let width = u16::from_le_bytes(bytes.get(6..8)?.try_into().ok()?) as u32;
    let height = u16::from_le_bytes(bytes.get(8..10)?.try_into().ok()?) as u32;
    nonzero_dimensions(width, height)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut index = 2;
    while index + 4 <= bytes.len() {
        while index < bytes.len() && bytes[index] == 0xff {
            index += 1;
        }
        if index >= bytes.len() {
            return None;
        }
        let marker = bytes[index];
        index += 1;
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        if index + 2 > bytes.len() {
            return None;
        }
        let segment_len =
            u16::from_be_bytes(bytes.get(index..index + 2)?.try_into().ok()?) as usize;
        if segment_len < 2 || index + segment_len > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if segment_len < 7 {
                return None;
            }
            let height =
                u16::from_be_bytes(bytes.get(index + 3..index + 5)?.try_into().ok()?) as u32;
            let width =
                u16::from_be_bytes(bytes.get(index + 5..index + 7)?.try_into().ok()?) as u32;
            return nonzero_dimensions(width, height);
        }
        index += segment_len;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 30 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WEBP") {
        return None;
    }
    match bytes.get(12..16)? {
        b"VP8X" if bytes.len() >= 30 => {
            let width = 1 + read_u24_le(bytes.get(24..27)?)?;
            let height = 1 + read_u24_le(bytes.get(27..30)?)?;
            nonzero_dimensions(width, height)
        }
        b"VP8L" if bytes.len() >= 25 && bytes.get(20).copied() == Some(0x2f) => {
            let b0 = bytes[21] as u32;
            let b1 = bytes[22] as u32;
            let b2 = bytes[23] as u32;
            let b3 = bytes[24] as u32;
            let width = 1 + (((b1 & 0x3f) << 8) | b0);
            let height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
            nonzero_dimensions(width, height)
        }
        b"VP8 " if bytes.len() >= 30 && bytes.get(23..26) == Some(&[0x9d, 0x01, 0x2a]) => {
            let width = u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?) as u32 & 0x3fff;
            let height = u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?) as u32 & 0x3fff;
            nonzero_dimensions(width, height)
        }
        _ => None,
    }
}

fn read_u24_le(bytes: &[u8]) -> Option<u32> {
    Some(
        (bytes.first().copied()? as u32)
            | ((bytes.get(1).copied()? as u32) << 8)
            | ((bytes.get(2).copied()? as u32) << 16),
    )
}

fn nonzero_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    (width > 0 && height > 0).then_some((width, height))
}
