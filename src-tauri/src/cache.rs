use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::errors::{io_error, AppResult};
use crate::models::ExportItem;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    match std::fs::read(file_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| crate::errors::AppError::ParseFailed(error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(file_path, error)),
    }
}

pub fn write_json_atomic<T: Serialize + ?Sized>(file_path: &Path, value: &T) -> AppResult<()> {
    write_atomic_with(file_path, |writer| {
        serde_json::to_writer_pretty(&mut *writer, value)
            .map_err(|error| crate::errors::AppError::CacheUnavailable(error.to_string()))?;
        writer
            .write_all(b"\n")
            .map_err(|error| io_error(file_path, error))
    })
}

pub fn write_json_compact_atomic<T: Serialize + ?Sized>(
    file_path: &Path,
    value: &T,
) -> AppResult<()> {
    write_atomic_with(file_path, |writer| {
        serde_json::to_writer(writer, value)
            .map_err(|error| crate::errors::AppError::CacheUnavailable(error.to_string()))
    })
}

pub fn temp_path_for(file_path: &Path) -> PathBuf {
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut os_str = file_path.as_os_str().to_os_string();
    os_str.push(format!(".{}.{seq}.tmp", std::process::id()));
    PathBuf::from(os_str)
}

fn write_atomic_with(
    file_path: &Path,
    write_fn: impl FnOnce(&mut std::io::BufWriter<std::fs::File>) -> AppResult<()>,
) -> AppResult<()> {
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let tmp = temp_path_for(file_path);
    let write_result = (|| -> AppResult<()> {
        let file = std::fs::File::create(&tmp).map_err(|error| io_error(&tmp, error))?;
        let mut writer = std::io::BufWriter::new(file);
        write_fn(&mut writer)?;
        writer.flush().map_err(|error| io_error(&tmp, error))?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&tmp, file_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_error(file_path, error));
    }
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
    if export_item.paths.conversation_files.len() <= 1 {
        let target = export_item
            .paths
            .conversation_files
            .first()
            .unwrap_or(&export_item.paths.conversations);
        entries.insert("conversations".to_string(), file_fingerprint(target)?);
    } else {
        entries.insert(
            "conversations".to_string(),
            file_fingerprint(&export_item.paths.conversation_files[0])?,
        );
        for (idx, path) in export_item.paths.conversation_files.iter().enumerate() {
            entries.insert(format!("conversations:{idx}"), file_fingerprint(path)?);
        }
    }
    entries.insert(
        "libraryFiles".to_string(),
        file_fingerprint(&export_item.paths.library_files)?,
    );
    entries.insert(
        "assetNames".to_string(),
        file_fingerprint(&export_item.paths.asset_names)?,
    );
    if let Some(path) = &export_item.paths.group_chats {
        entries.insert("groupChats".to_string(), file_fingerprint(path)?);
    }
    if let Some(path) = &export_item.paths.codex {
        entries.insert("codex".to_string(), file_fingerprint(path)?);
    }
    Ok(entries)
}

pub fn fingerprints_equal(left: &FileFingerprint, right: &FileFingerprint) -> bool {
    left == right
}
