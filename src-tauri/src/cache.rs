use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::errors::{io_error, AppResult};
use crate::models::ExportItem;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub path: PathBuf,
    pub size: Option<u64>,
    pub mtime_ms: Option<u128>,
    pub missing: bool,
}

pub type ExportFingerprint = BTreeMap<String, FileFingerprint>;

pub fn read_json<T: DeserializeOwned>(file_path: &Path) -> AppResult<Option<T>> {
    match std::fs::read_to_string(file_path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| crate::errors::AppError::ParseFailed(error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(file_path, error)),
    }
}

pub fn write_json_atomic<T: Serialize + ?Sized>(file_path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let tmp = file_path.with_extension(format!("{}.tmp", std::process::id()));
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(value)
            .map_err(|error| crate::errors::AppError::CacheUnavailable(error.to_string()))?
    );
    std::fs::write(&tmp, body).map_err(|error| io_error(&tmp, error))?;
    std::fs::rename(&tmp, file_path).map_err(|error| io_error(file_path, error))?;
    Ok(())
}

pub fn file_fingerprint(file_path: &Path) -> AppResult<FileFingerprint> {
    match std::fs::metadata(file_path) {
        Ok(info) => {
            let mtime_ms = info
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis());
            Ok(FileFingerprint {
                path: file_path.to_path_buf(),
                size: Some(info.len()),
                mtime_ms,
                missing: false,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileFingerprint {
            path: file_path.to_path_buf(),
            size: None,
            mtime_ms: None,
            missing: true,
        }),
        Err(error) => Err(io_error(file_path, error)),
    }
}

pub fn export_fingerprint(export_item: &ExportItem) -> AppResult<ExportFingerprint> {
    let mut entries = BTreeMap::new();
    entries.insert(
        "conversations".to_string(),
        file_fingerprint(&export_item.paths.conversations)?,
    );
    entries.insert(
        "libraryFiles".to_string(),
        file_fingerprint(&export_item.paths.library_files)?,
    );
    entries.insert(
        "assetNames".to_string(),
        file_fingerprint(&export_item.paths.asset_names)?,
    );
    Ok(entries)
}

pub fn fingerprints_equal(left: &FileFingerprint, right: &FileFingerprint) -> bool {
    left == right
}
