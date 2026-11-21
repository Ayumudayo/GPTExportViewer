use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::errors::{io_error, AppResult};
use crate::fs_guards::{resolve_absolute, resolve_inside};
use crate::models::{ExportItem, ExportPaths};

const CONVERSATIONS_FILE: &str = "conversations.json";
const LIBRARY_FILES_FILE: &str = "library_files.json";
const ASSET_NAMES_FILE: &str = "conversation_asset_file_names.json";
const MANIFEST_FILE: &str = "export_manifest.json";
const GROUP_CHATS_FILE: &str = "group_chats.json";
const CODEX_FILE: &str = "codex.json";

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
    if is_direct_export_dir(&root) {
        candidates.insert(0, root.clone());
    }

    let mut exports = Vec::new();
    for directory in candidates {
        let item = describe_export(&directory)?;
        if item.has_conversations
            || item.has_library_files
            || item.has_asset_names
            || item.paths.group_chats.is_some()
            || item.paths.codex.is_some()
        {
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

fn is_direct_export_dir(root: &Path) -> bool {
    !discover_conversation_files(root).is_empty()
        || root.join(LIBRARY_FILES_FILE).is_file()
        || root.join(ASSET_NAMES_FILE).is_file()
        || root.join(GROUP_CHATS_FILE).is_file()
        || root.join(CODEX_FILE).is_file()
}

pub fn discover_conversation_files(directory: &Path) -> Vec<PathBuf> {
    let manifest_path = directory.join(MANIFEST_FILE);
    if manifest_path.is_file() {
        if let Ok(bytes) = std::fs::read(&manifest_path) {
            if let Ok(manifest) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(files) = manifest
                    .pointer("/logical_files/conversations.json/files")
                    .and_then(Value::as_array)
                {
                    let mut resolved = Vec::new();
                    for entry in files.iter().filter_map(Value::as_str) {
                        if let Ok(target) = resolve_inside(directory, entry) {
                            if target.is_file() {
                                resolved.push(target);
                            }
                        }
                    }
                    if !resolved.is_empty() {
                        return resolved;
                    }
                }
            }
        }
    }

    let direct = directory.join(CONVERSATIONS_FILE);
    if direct.is_file() {
        return vec![direct];
    }

    let mut sharded: Vec<(usize, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if let Some(shard_index) = parse_conversation_shard_index(file_name) {
                sharded.push((shard_index, path));
            }
        }
    }
    sharded.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    sharded.into_iter().map(|(_, path)| path).collect()
}

fn parse_conversation_shard_index(file_name: &str) -> Option<usize> {
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_prefix("conversations-")?.strip_suffix(".json")?;
    if stem.is_empty() || !stem.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    stem.parse::<usize>().ok()
}

pub fn describe_export(directory: &Path) -> AppResult<ExportItem> {
    let path = resolve_absolute(directory);
    let info = std::fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    let conversation_files = discover_conversation_files(&path);
    let conversations = conversation_files
        .first()
        .cloned()
        .unwrap_or_else(|| path.join(CONVERSATIONS_FILE));
    let group_chats_path = path.join(GROUP_CHATS_FILE);
    let codex_path = path.join(CODEX_FILE);
    let paths = ExportPaths {
        root: path.clone(),
        conversations,
        library_files: path.join(LIBRARY_FILES_FILE),
        asset_names: path.join(ASSET_NAMES_FILE),
        conversation_files,
        group_chats: group_chats_path.is_file().then_some(group_chats_path),
        codex: codex_path.is_file().then_some(codex_path),
    };
    let has_conversations = !paths.conversation_files.is_empty();
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
