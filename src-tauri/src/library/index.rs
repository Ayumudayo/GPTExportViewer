use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;

use crate::errors::{io_error, AppError, AppResult};
use crate::library::{dimensions::read_image_dimensions, mime::infer_mime_from_name};
use crate::models::{ExportItem, LibraryIndex, LibraryItem, LibraryStats};
use crate::time::{generated_at, to_iso_time};

pub fn build_library_index(
    export_item: &ExportItem,
    conversation_ids: &HashSet<String>,
) -> AppResult<LibraryIndex> {
    if !export_item.has_library_files {
        return Ok(empty_index());
    }

    let files = read_library_array(&export_item.paths.library_files)?;
    let name_map = if export_item.has_asset_names {
        read_name_map(&export_item.paths.asset_names)?
    } else {
        HashMap::new()
    };

    let mut items = Vec::new();
    for file in files {
        if !is_image_file(&file) {
            continue;
        }
        let Some(file_id) = string_field(&file, &["file_id", "fileId", "id"]) else {
            continue;
        };
        if file_id.is_empty() {
            continue;
        }

        let stored_name = format!("{file_id}.dat");
        let stored_path = export_item.path.join(&stored_name);
        let exists = stored_path.is_file();
        let source_conversation_id = string_field(
            &file,
            &[
                "origination_thread_id",
                "originationThreadId",
                "conversation_id",
                "conversationId",
                "thread_id",
                "threadId",
            ],
        );
        let linked = source_conversation_id
            .as_ref()
            .is_some_and(|source_id| conversation_ids.contains(source_id));
        let display_name = name_map
            .get(&stored_name)
            .cloned()
            .or_else(|| string_field(&file, &["file_name", "fileName", "name"]))
            .unwrap_or_else(|| stored_name.clone());
        let mime = string_field(&file, &["mime_type", "mimeType"])
            .or_else(|| infer_mime_from_name(&display_name).map(str::to_string))
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let size_bytes = numeric_field(
            &file,
            &[
                "file_size_bytes",
                "fileSizeBytes",
                "size_bytes",
                "sizeBytes",
                "size",
            ],
        );
        let metadata_dimensions = dimension_fields(&file);
        let file_dimensions = exists
            .then(|| read_image_dimensions(&stored_path, &mime))
            .flatten();
        let (width, height) = metadata_dimensions.or(file_dimensions).unzip();
        let created_at = optional_time_field(
            &file,
            &[
                "created_at",
                "createdAt",
                "create_time",
                "createTime",
                "created_time",
                "createdTime",
            ],
        );
        let status = string_field(&file, &["state", "status"]).unwrap_or_else(|| {
            if exists {
                "ready".to_string()
            } else {
                "missing".to_string()
            }
        });
        let source_message_id = string_field(
            &file,
            &[
                "origination_message_id",
                "originationMessageId",
                "message_id",
                "messageId",
            ],
        );
        let source_state = if linked {
            "linked"
        } else if source_conversation_id.is_some() {
            "missing-source-chat"
        } else {
            "library-only"
        };

        items.push(LibraryItem {
            id: file_id.clone(),
            file_id,
            display_name: display_name.clone(),
            filename: display_name.clone(),
            original_name: string_field(&file, &["file_name", "fileName"]),
            mime,
            size_bytes,
            size_label: format_bytes(size_bytes),
            width,
            height,
            created_at,
            status,
            file_ref: stored_name,
            exists,
            source_conversation_id,
            source_message_id,
            source_state: source_state.to_string(),
            in_chat: linked,
        });
    }

    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(LibraryIndex {
        stats: stats_for(&items),
        items,
        generated_at: generated_at(),
    })
}

pub fn read_library_array(file_path: &Path) -> AppResult<Vec<Value>> {
    let parsed = read_json(file_path)?;
    match parsed {
        Value::Array(items) => Ok(items),
        Value::Object(mut map) => {
            for key in ["files", "library_files", "libraryFiles"] {
                if let Some(Value::Array(items)) = map.remove(key) {
                    return Ok(items);
                }
            }
            Ok(Vec::new())
        }
        _ => Ok(Vec::new()),
    }
}

pub fn read_name_map(file_path: &Path) -> AppResult<HashMap<String, String>> {
    let parsed = read_json(file_path)?;
    if let Some(object) = parsed.as_object() {
        return Ok(object
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|name| (key.clone(), name.to_string())))
            .collect());
    }

    let mut map = HashMap::new();
    if let Some(items) = parsed.as_array() {
        for item in items {
            let key = string_field(item, &["file_name", "fileName", "file", "path"]);
            let value = string_field(item, &["original_name", "originalName", "name"]);
            if let (Some(key), Some(value)) = (key, value) {
                map.insert(key, value);
            }
        }
    }
    Ok(map)
}

fn read_json(file_path: &Path) -> AppResult<Value> {
    let bytes = std::fs::read(file_path).map_err(|error| io_error(file_path, error))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::ParseFailed(format!("{}: {error}", file_path.display())))
}

fn is_image_file(file: &Value) -> bool {
    if string_field(file, &["mime_type", "mimeType"]).is_some_and(|mime| mime.starts_with("image/"))
    {
        return true;
    }
    if string_field(
        file,
        &["library_file_category", "libraryFileCategory", "category"],
    )
    .is_some_and(|category| category.eq_ignore_ascii_case("image"))
    {
        return true;
    }
    string_field(file, &["file_name", "fileName", "name"])
        .and_then(|name| infer_mime_from_name(&name).map(str::to_string))
        .is_some()
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| match value {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn numeric_field(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_f64()
                    .filter(|number| number.is_finite() && *number > 0.0)
                    .map(|number| number as u64)
            })
        })
        .unwrap_or(0)
}

fn numeric_u32_field(value: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| {
            value
                .as_u64()
                .and_then(|number| u32::try_from(number).ok())
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|number| {
                            number.is_finite() && *number > 0.0 && *number <= u32::MAX as f64
                        })
                        .map(|number| number as u32)
                })
        })
        .filter(|number| *number > 0)
}

fn dimension_fields(value: &Value) -> Option<(u32, u32)> {
    let width = numeric_u32_field(value, &["width", "image_width", "imageWidth"])?;
    let height = numeric_u32_field(value, &["height", "image_height", "imageHeight"])?;
    Some((width, height))
}

fn optional_time_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(to_iso_time)
}

fn stats_for(items: &[LibraryItem]) -> LibraryStats {
    LibraryStats {
        total_images: items.len(),
        linked_images: items
            .iter()
            .filter(|item| item.source_state == "linked")
            .count(),
        library_only_images: items
            .iter()
            .filter(|item| item.source_state == "library-only")
            .count(),
        missing_source_images: items
            .iter()
            .filter(|item| item.source_state == "missing-source-chat")
            .count(),
        missing_files: items.iter().filter(|item| !item.exists).count(),
    }
}

fn empty_index() -> LibraryIndex {
    LibraryIndex {
        items: Vec::new(),
        stats: LibraryStats {
            total_images: 0,
            linked_images: 0,
            library_only_images: 0,
            missing_source_images: 0,
            missing_files: 0,
        },
        generated_at: generated_at(),
    }
}

fn format_bytes(value: u64) -> String {
    if value == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB"];
    let mut size = value as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < units.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if size >= 10.0 || unit == 0 {
        format!("{:.0} {}", size, units[unit])
    } else {
        format!("{:.1} {}", size, units[unit])
    }
}
