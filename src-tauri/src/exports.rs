use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sha1::{Digest, Sha1};

use crate::errors::{io_error, AppResult};
use crate::fs_guards::resolve_absolute;
use crate::models::{ExportItem, ExportPaths};

const CONVERSATIONS_FILE: &str = "conversations.json";
const LIBRARY_FILES_FILE: &str = "library_files.json";
const ASSET_NAMES_FILE: &str = "conversation_asset_file_names.json";

pub fn scan_exports(root_path: &Path) -> AppResult<Vec<ExportItem>> {
    let root = resolve_absolute(root_path);
    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(&root).map_err(|error| io_error(&root, error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_error(&root, error))?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| io_error(&path, error))?
            .is_dir()
        {
            candidates.push(path);
        }
    }
    if root.join(CONVERSATIONS_FILE).exists() {
        candidates.insert(0, root.clone());
    }

    let mut exports = Vec::new();
    for directory in candidates {
        let item = describe_export(&directory)?;
        if item.has_conversations || item.has_library_files || item.has_asset_names {
            exports.push(item);
        }
    }
    exports.sort_by(|left, right| {
        right
            .modified_at_ms
            .cmp(&left.modified_at_ms)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(exports)
}

pub fn describe_export(directory: &Path) -> AppResult<ExportItem> {
    let path = resolve_absolute(directory);
    let info = std::fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    let paths = ExportPaths {
        root: path.clone(),
        conversations: path.join(CONVERSATIONS_FILE),
        library_files: path.join(LIBRARY_FILES_FILE),
        asset_names: path.join(ASSET_NAMES_FILE),
    };
    let has_conversations = paths.conversations.exists();
    let has_library_files = paths.library_files.exists();
    let has_asset_names = paths.asset_names.exists();
    let mut warnings = Vec::new();
    if !has_conversations {
        warnings.push(format!("missing {CONVERSATIONS_FILE}"));
    }
    if !has_library_files {
        warnings.push(format!("missing {LIBRARY_FILES_FILE}"));
    }
    if !has_asset_names {
        warnings.push(format!("missing {ASSET_NAMES_FILE}"));
    }

    let modified = info.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let modified_at_ms = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    Ok(ExportItem {
        id: stable_export_id(&path),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        path: path.clone(),
        paths,
        modified_at: system_time_to_iso_like(modified),
        modified_at_ms,
        has_conversations,
        has_library_files,
        has_asset_names,
        warnings,
    })
}

pub fn stable_export_id(path: &Path) -> String {
    let resolved = resolve_absolute(path);
    let mut hasher = Sha1::new();
    hasher.update(resolved.to_string_lossy().as_bytes());
    format!("{:x}", hasher.finalize())[..12].to_string()
}

fn system_time_to_iso_like(value: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(value)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
