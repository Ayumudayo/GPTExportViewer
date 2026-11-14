use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use unicode_normalization::UnicodeNormalization;

use crate::errors::{AppError, AppResult};
use crate::fs_guards::assert_safe_file_id;
use crate::state::AppState;

const ASSET_SCHEME_PREFIX: &str = "gpt-export-asset://library/";
const ASSET_SCHEME_LOCALHOST_PREFIX: &str = "gpt-export-asset://localhost/library/";
const WINDOWS_HTTP_PREFIX: &str = "http://gpt-export-asset.localhost/library/";
const WINDOWS_HTTPS_PREFIX: &str = "https://gpt-export-asset.localhost/library/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAssetUrl {
    pub export_id: String,
    pub file_id: String,
    pub thumbnail: bool,
}

pub fn parse_asset_url(url: &str) -> AppResult<ParsedAssetUrl> {
    let (base_url, query) = url.split_once('?').unwrap_or((url, ""));
    let rest = base_url
        .strip_prefix(ASSET_SCHEME_PREFIX)
        .or_else(|| base_url.strip_prefix(ASSET_SCHEME_LOCALHOST_PREFIX))
        .or_else(|| base_url.strip_prefix(WINDOWS_HTTP_PREFIX))
        .or_else(|| base_url.strip_prefix(WINDOWS_HTTPS_PREFIX))
        .ok_or(AppError::InvalidFileId)?;
    let mut parts = rest.split('/');
    let export_id = parts
        .next()
        .filter(|value| !value.is_empty())
        .ok_or(AppError::InvalidFileId)?;
    let file_id = parts
        .next()
        .filter(|value| !value.is_empty())
        .ok_or(AppError::InvalidFileId)?;
    if parts.next().is_some() {
        return Err(AppError::InvalidFileId);
    }

    let export_id = decode_segment(export_id)?;
    let file_id = decode_segment(file_id)?;
    assert_safe_file_id(&file_id)?;
    if export_id.is_empty() {
        return Err(AppError::InvalidFileId);
    }
    let thumbnail = query
        .split('&')
        .any(|part| part == "thumb=1" || part == "thumb=true");

    Ok(ParsedAssetUrl {
        export_id,
        file_id,
        thumbnail,
    })
}

fn decode_segment(value: &str) -> AppResult<String> {
    percent_decode_str(value)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| AppError::InvalidFileId)
}

pub(crate) fn asset_url(export_id: &str, file_id: &str) -> String {
    format!(
        "http://gpt-export-asset.localhost/library/{}/{}",
        utf8_percent_encode(export_id, NON_ALPHANUMERIC),
        utf8_percent_encode(file_id, NON_ALPHANUMERIC)
    )
}

pub(crate) fn asset_response(state: &AppState, uri: String) -> tauri::http::Response<Vec<u8>> {
    let result = parse_asset_url(&uri).and_then(|parsed| {
        if parsed.thumbnail {
            state.read_thumbnail_payload(&parsed.export_id, &parsed.file_id)
        } else {
            state.read_asset_payload(&parsed.export_id, &parsed.file_id)
        }
    });
    match result {
        Ok(asset) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(tauri::http::header::CONTENT_TYPE, asset.mime_type)
            .header(
                tauri::http::header::CONTENT_LENGTH,
                asset.bytes.len().to_string(),
            )
            .header(
                tauri::http::header::CONTENT_DISPOSITION,
                content_disposition_header(&asset.file_name),
            )
            .header("x-content-type-options", "nosniff")
            .header(tauri::http::header::CACHE_CONTROL, "private, max-age=3600")
            .body(asset.bytes)
            .expect("valid asset response"),
        Err(error) => {
            let status = match error {
                AppError::InvalidFileId | AppError::PathEscapesRoot => {
                    tauri::http::StatusCode::BAD_REQUEST
                }
                AppError::ExportNotFound | AppError::AssetNotFound => {
                    tauri::http::StatusCode::NOT_FOUND
                }
                _ => tauri::http::StatusCode::INTERNAL_SERVER_ERROR,
            };
            tauri::http::Response::builder()
                .status(status)
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    "text/plain; charset=utf-8",
                )
                .header("x-content-type-options", "nosniff")
                .body(status_text(status).as_bytes().to_vec())
                .expect("valid error response")
        }
    }
}

fn status_text(status: tauri::http::StatusCode) -> &'static str {
    match status {
        tauri::http::StatusCode::BAD_REQUEST => "invalid asset request",
        tauri::http::StatusCode::NOT_FOUND => "asset not found",
        _ => "asset unavailable",
    }
}

fn header_filename(value: &str) -> String {
    let filename: String = normalized_header_value(value)
        .chars()
        .map(|ch| {
            if ch.is_ascii_graphic()
                && !matches!(
                    ch,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | ';'
                )
            {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if filename.is_empty() {
        "download".to_string()
    } else {
        filename
    }
}

fn content_disposition_header(value: &str) -> String {
    format!(
        "inline; filename=\"{}\"; filename*=UTF-8''{}",
        header_filename(value),
        rfc5987_filename(value)
    )
}

fn rfc5987_filename(value: &str) -> String {
    let mut encoded = String::new();
    let normalized = normalized_header_value(value);
    for byte in normalized.as_bytes() {
        if is_rfc5987_attr_char(*byte) {
            encoded.push(*byte as char);
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    if encoded.is_empty() {
        "download".to_string()
    } else {
        encoded
    }
}

fn normalized_header_value(value: &str) -> String {
    value.trim().nfc().collect()
}

fn is_rfc5987_attr_char(byte: u8) -> bool {
    matches!(
        byte,
        b'a'..=b'z'
            | b'A'..=b'Z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'&'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
    )
}

#[cfg(test)]
mod tests {
    use super::{asset_url, content_disposition_header, parse_asset_url};

    #[test]
    fn content_disposition_encodes_unicode_filename_parameter() {
        let header = content_disposition_header("한글 이미지.png");
        assert!(header.contains("filename=\"______.png\""));
        assert!(header
            .contains("filename*=UTF-8''%ED%95%9C%EA%B8%80%20%EC%9D%B4%EB%AF%B8%EC%A7%80.png"));
    }

    #[test]
    fn content_disposition_uses_windows_safe_ascii_fallback() {
        assert_eq!(
            content_disposition_header("a:b?.png"),
            "inline; filename=\"a_b_.png\"; filename*=UTF-8''a%3Ab%3F.png"
        );
    }

    #[test]
    fn asset_url_percent_encodes_segments_for_windows_bridge() {
        let url = asset_url("export 1", "file-img_1");
        assert_eq!(
            url,
            "http://gpt-export-asset.localhost/library/export%201/file%2Dimg%5F1"
        );
        let parsed = parse_asset_url(&url).expect("generated url should parse");
        assert_eq!(parsed.export_id, "export 1");
        assert_eq!(parsed.file_id, "file-img_1");
        assert!(!parsed.thumbnail);
    }
}
