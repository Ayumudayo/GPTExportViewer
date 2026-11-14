use std::io::Write;
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};

use crate::cache::{file_fingerprint, temp_path_for};
use crate::errors::{io_error, AppResult};
use crate::fs_guards::safe_cache_name;
use crate::models::ResolvedAsset;

const THUMBNAIL_BYPASS_BYTES: u64 = 48 * 1024;
const THUMBNAIL_SMALL_IMAGE_BYTES: usize = 96 * 1024;
const THUMBNAIL_MAX_EDGE: u32 = 384;
const THUMBNAIL_JPEG_QUALITY: u8 = 82;

pub fn read_or_create_thumbnail(
    resolved: &ResolvedAsset,
    export_cache_dir: &Path,
) -> AppResult<(String, Vec<u8>)> {
    if resolved.size <= THUMBNAIL_BYPASS_BYTES {
        let bytes = std::fs::read(&resolved.file_path)
            .map_err(|error| io_error(&resolved.file_path, error))?;
        return Ok((resolved.mime_type.clone(), bytes));
    }

    let fp = file_fingerprint(&resolved.file_path)?;
    let stem = format!(
        "{}-{}-{}",
        safe_cache_name(&resolved.file_id),
        fp.size.unwrap_or(0),
        fp.mtime_ms.unwrap_or(0)
    );
    let thumbs_dir = export_cache_dir.join("thumbs");
    let jpg_path = thumbs_dir.join(format!("{stem}.jpg"));
    if jpg_path.is_file() {
        if let Ok(bytes) = std::fs::read(&jpg_path) {
            return Ok(("image/jpeg".to_string(), bytes));
        }
    }
    let png_path = thumbs_dir.join(format!("{stem}.png"));
    if png_path.is_file() {
        if let Ok(bytes) = std::fs::read(&png_path) {
            return Ok(("image/png".to_string(), bytes));
        }
    }

    let raw_bytes = std::fs::read(&resolved.file_path)
        .map_err(|error| io_error(&resolved.file_path, error))?;
    let Ok(decoded) = image::load_from_memory(&raw_bytes) else {
        return Ok((resolved.mime_type.clone(), raw_bytes));
    };

    if decoded.width() <= THUMBNAIL_MAX_EDGE
        && decoded.height() <= THUMBNAIL_MAX_EDGE
        && raw_bytes.len() <= THUMBNAIL_SMALL_IMAGE_BYTES
    {
        return Ok((resolved.mime_type.clone(), raw_bytes));
    }

    let thumb = decoded.thumbnail(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE);
    let has_transparency = thumb.color().has_alpha()
        && thumb
            .to_rgba8()
            .pixels()
            .any(|pixel| pixel.0[3] < u8::MAX);

    let mut encoded = Vec::new();
    let (mime_type, cache_path) = if has_transparency {
        let rgba = thumb.to_rgba8();
        let encoder = PngEncoder::new_with_quality(
            &mut encoded,
            CompressionType::Fast,
            FilterType::Adaptive,
        );
        if rgba.write_with_encoder(encoder).is_err() {
            return Ok((resolved.mime_type.clone(), raw_bytes));
        }
        ("image/png".to_string(), png_path)
    } else {
        let rgb = thumb.to_rgb8();
        let encoder = JpegEncoder::new_with_quality(&mut encoded, THUMBNAIL_JPEG_QUALITY);
        if rgb.write_with_encoder(encoder).is_err() {
            return Ok((resolved.mime_type.clone(), raw_bytes));
        }
        ("image/jpeg".to_string(), jpg_path)
    };

    write_thumbnail_cache(&cache_path, &encoded);
    Ok((mime_type, encoded))
}

fn write_thumbnail_cache(cache_path: &Path, bytes: &[u8]) {
    if let Some(parent) = cache_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let tmp = temp_path_for(cache_path);
    let write_ok = std::fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.flush()
    });
    if write_ok.is_err() || std::fs::rename(&tmp, cache_path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}
