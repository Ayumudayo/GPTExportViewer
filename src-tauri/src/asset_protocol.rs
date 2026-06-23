use percent_encoding::percent_decode_str;

use crate::errors::{AppError, AppResult};
use crate::fs_guards::assert_safe_file_id;

const ASSET_SCHEME_PREFIX: &str = "gpt-export-asset://library/";
const WINDOWS_HTTP_PREFIX: &str = "http://gpt-export-asset.localhost/library/";
const WINDOWS_HTTPS_PREFIX: &str = "https://gpt-export-asset.localhost/library/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAssetUrl {
    pub export_id: String,
    pub file_id: String,
}

pub fn parse_asset_url(url: &str) -> AppResult<ParsedAssetUrl> {
    let rest = url
        .strip_prefix(ASSET_SCHEME_PREFIX)
        .or_else(|| url.strip_prefix(WINDOWS_HTTP_PREFIX))
        .or_else(|| url.strip_prefix(WINDOWS_HTTPS_PREFIX))
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

    let export_id = percent_decode_str(export_id)
        .decode_utf8_lossy()
        .to_string();
    let file_id = percent_decode_str(file_id).decode_utf8_lossy().to_string();
    assert_safe_file_id(&file_id)?;
    if export_id.is_empty() {
        return Err(AppError::InvalidFileId);
    }

    Ok(ParsedAssetUrl { export_id, file_id })
}
