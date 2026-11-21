use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;

use crate::errors::{io_error, AppError, AppResult};
use crate::library::{
    dimensions::read_image_dimensions,
    mime::{infer_mime_from_name, sniff_mime},
};
use crate::models::{ExportItem, LibraryIndex, LibraryItem, LibraryStats};
use crate::time::{generated_at, to_iso_time};

#[derive(Debug, Clone)]
pub struct GeneratedLibraryImage {
    pub file_id: String,
    pub display_name: String,
    pub mime_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: Option<String>,
    pub origination_message_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConversationAssetLink {
    pub conversation_id: String,
    pub message_id: String,
    pub project_id: Option<String>,
    pub name: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PreloadedLibraryContext {
    pub name_map: HashMap<String, String>,
    pub display_names_by_file_id: HashMap<String, String>,
    pub generated_by_thread: HashMap<String, Vec<GeneratedLibraryImage>>,
    pub project_file_counts: HashMap<String, usize>,
    pub raw_files: Vec<Value>,
}

const LIBRARY_TIME_KEYS: &[&str] = &[
    "created_at",
    "createdAt",
    "record_creation_time",
    "recordCreationTime",
    "file_upload_time",
    "fileUploadTime",
    "version_created_at",
    "versionCreatedAt",
    "file_processed_time",
    "fileProcessedTime",
    "create_time",
    "createTime",
    "created_time",
    "createdTime",
    "modified_at",
    "modifiedAt",
];

pub fn preload_library_context(export_item: &ExportItem) -> AppResult<PreloadedLibraryContext> {
    let raw_files = if export_item.has_library_files {
        read_library_array(&export_item.paths.library_files)?
    } else {
        Vec::new()
    };
    let name_map = if export_item.has_asset_names {
        read_name_map(&export_item.paths.asset_names)?
    } else {
        HashMap::new()
    };

    let mut display_names_by_file_id = HashMap::new();
    for (stored_name, display_name) in &name_map {
        let fid = stored_name
            .strip_suffix(".dat")
            .unwrap_or(stored_name.as_str());
        if !fid.is_empty() && !display_name.trim().is_empty() {
            display_names_by_file_id.insert(fid.to_string(), display_name.clone());
        }
    }

    let mut generated_by_thread: HashMap<String, Vec<GeneratedLibraryImage>> = HashMap::new();
    let mut project_file_counts: HashMap<String, usize> = HashMap::new();
    for file in &raw_files {
        if let Some(gid) = string_field(file, &["gizmo_id", "gizmoId"]) {
            let is_project = gid.starts_with("g-p-")
                || file.get("is_project").and_then(Value::as_bool) == Some(true);
            if is_project {
                *project_file_counts.entry(gid).or_insert(0) += 1;
            }
        }
        let Some(file_id) = string_field(file, &["file_id", "fileId", "id"]) else {
            continue;
        };
        if file_id.is_empty() {
            continue;
        }
        let stored_name = format!("{file_id}.dat");
        let display_name = name_map
            .get(&stored_name)
            .cloned()
            .or_else(|| string_field(file, &["file_name", "fileName", "name"]));
        if let Some(ref name) = display_name {
            display_names_by_file_id
                .entry(file_id.clone())
                .or_insert_with(|| name.clone());
        }

        if !is_image_file(file) {
            continue;
        }
        if string_field(file, &["image_gen_generation_id", "imageGenGenerationId"]).is_none() {
            continue;
        }
        let Some(thread_id) =
            string_field(file, &["origination_thread_id", "originationThreadId"])
        else {
            continue;
        };
        let stored_path = export_item.path.join(&stored_name);
        if !stored_path.is_file() {
            continue;
        }

        let resolved_name = display_name.unwrap_or_else(|| stored_name.clone());
        let mime_type = string_field(file, &["mime_type", "mimeType"])
            .or_else(|| infer_mime_from_name(&resolved_name).map(str::to_string))
            .unwrap_or_else(|| "image/png".to_string());
        let (width, height) = dimension_fields(file)
            .or_else(|| read_image_dimensions(&stored_path, &mime_type))
            .unzip();
        let created_at = optional_time_field(file, LIBRARY_TIME_KEYS);
        let origination_message_id = string_field(
            file,
            &[
                "origination_message_id",
                "originationMessageId",
                "message_id",
                "messageId",
            ],
        );

        generated_by_thread
            .entry(thread_id)
            .or_default()
            .push(GeneratedLibraryImage {
                file_id,
                display_name: resolved_name,
                mime_type,
                width,
                height,
                created_at,
                origination_message_id,
            });
    }

    for images in generated_by_thread.values_mut() {
        images.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.file_id.cmp(&right.file_id))
        });
    }

    Ok(PreloadedLibraryContext {
        name_map,
        display_names_by_file_id,
        generated_by_thread,
        project_file_counts,
        raw_files,
    })
}

pub fn build_library_index(
    export_item: &ExportItem,
    conversation_ids: &HashSet<String>,
) -> AppResult<LibraryIndex> {
    if !export_item.has_library_files {
        return Ok(empty_index());
    }
    let preloaded = preload_library_context(export_item)?;
    let titles: HashMap<String, String> = conversation_ids
        .iter()
        .map(|id| (id.clone(), String::new()))
        .collect();
    build_library_index_with_context(export_item, &preloaded, &titles, &HashMap::new())
}

pub fn build_library_index_with_context(
    export_item: &ExportItem,
    preloaded: &PreloadedLibraryContext,
    conversation_titles: &HashMap<String, String>,
    conversation_assets: &HashMap<String, ConversationAssetLink>,
) -> AppResult<LibraryIndex> {
    if !export_item.has_library_files && conversation_assets.is_empty() {
        return Ok(empty_index());
    }

    let mut items = Vec::new();
    let mut seen_file_ids = HashSet::new();

    for file in &preloaded.raw_files {
        if !is_image_file(file) {
            continue;
        }
        let Some(file_id) = string_field(file, &["file_id", "fileId", "id"]) else {
            continue;
        };
        if file_id.is_empty() || !seen_file_ids.insert(file_id.clone()) {
            continue;
        }

        let stored_name = format!("{file_id}.dat");
        let stored_path = export_item.path.join(&stored_name);
        let exists = stored_path.is_file();

        let explicit_thread_id = string_field(
            file,
            &[
                "origination_thread_id",
                "originationThreadId",
                "conversation_id",
                "conversationId",
                "thread_id",
                "threadId",
            ],
        );
        let explicit_msg_id = string_field(
            file,
            &[
                "origination_message_id",
                "originationMessageId",
                "message_id",
                "messageId",
            ],
        );
        let fallback_link = conversation_assets.get(&file_id);
        let (source_conversation_id, source_message_id) = match explicit_thread_id {
            Some(ref tid) if conversation_titles.contains_key(tid) => {
                (Some(tid.clone()), explicit_msg_id)
            }
            Some(tid) => {
                if let Some(link) = fallback_link {
                    (
                        Some(link.conversation_id.clone()),
                        Some(link.message_id.clone()),
                    )
                } else {
                    (Some(tid), explicit_msg_id)
                }
            }
            None => {
                if let Some(link) = fallback_link {
                    (
                        Some(link.conversation_id.clone()),
                        Some(link.message_id.clone()),
                    )
                } else {
                    (None, explicit_msg_id)
                }
            }
        };

        let project_id = string_field(file, &["gizmo_id", "gizmoId"])
            .filter(|gid| {
                gid.starts_with("g-p-")
                    || file.get("is_project").and_then(Value::as_bool) == Some(true)
            })
            .or_else(|| fallback_link.and_then(|link| link.project_id.clone()));

        let linked = source_conversation_id
            .as_ref()
            .is_some_and(|source_id| conversation_titles.contains_key(source_id));
        let source_conversation_title = source_conversation_id
            .as_ref()
            .and_then(|source_id| conversation_titles.get(source_id))
            .filter(|title| !title.is_empty())
            .cloned();

        let display_name = preloaded
            .name_map
            .get(&stored_name)
            .cloned()
            .or_else(|| string_field(file, &["file_name", "fileName", "name"]))
            .unwrap_or_else(|| stored_name.clone());
        let mime = string_field(file, &["mime_type", "mimeType"])
            .or_else(|| infer_mime_from_name(&display_name).map(str::to_string))
            .or_else(|| exists.then(|| sniff_mime(&stored_path, None).ok()).flatten())
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let mut size_bytes = numeric_field(
            file,
            &[
                "file_size_bytes",
                "fileSizeBytes",
                "size_bytes",
                "sizeBytes",
                "size",
            ],
        );
        if size_bytes == 0 && exists {
            size_bytes = std::fs::metadata(&stored_path)
                .map(|info| info.len())
                .unwrap_or(0);
        }
        let metadata_dimensions = dimension_fields(file);
        let file_dimensions = exists
            .then(|| read_image_dimensions(&stored_path, &mime))
            .flatten();
        let (width, height) = metadata_dimensions.or(file_dimensions).unzip();
        let created_at = optional_time_field(file, LIBRARY_TIME_KEYS);
        let status = string_field(file, &["state", "status"]).unwrap_or_else(|| {
            if exists {
                "ready".to_string()
            } else {
                "missing".to_string()
            }
        });
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
            original_name: string_field(file, &["file_name", "fileName"]),
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
            source_conversation_title,
            source_message_id,
            source_state: source_state.to_string(),
            in_chat: linked,
            project_id,
        });
    }

    for (file_id, link) in conversation_assets {
        if seen_file_ids.contains(file_id) {
            continue;
        }
        let stored_name = format!("{file_id}.dat");
        let stored_path = export_item.path.join(&stored_name);
        if !stored_path.is_file() {
            continue;
        }
        let display_name = preloaded
            .name_map
            .get(&stored_name)
            .cloned()
            .or_else(|| link.name.clone())
            .unwrap_or_else(|| stored_name.clone());
        let mime = link
            .mime_type
            .clone()
            .filter(|m| !m.is_empty())
            .or_else(|| infer_mime_from_name(&display_name).map(str::to_string))
            .or_else(|| sniff_mime(&stored_path, None).ok())
            .unwrap_or_else(|| "application/octet-stream".to_string());
        if !mime.starts_with("image/") {
            continue;
        }
        seen_file_ids.insert(file_id.clone());

        let size_bytes = std::fs::metadata(&stored_path)
            .map(|info| info.len())
            .unwrap_or(0);
        let (width, height) = link
            .width
            .zip(link.height)
            .or_else(|| read_image_dimensions(&stored_path, &mime))
            .unzip();
        let created_at = link
            .created_at
            .clone()
            .or_else(|| file_modified_iso(&stored_path));
        let source_conversation_title = conversation_titles
            .get(&link.conversation_id)
            .filter(|title| !title.is_empty())
            .cloned();

        items.push(LibraryItem {
            id: file_id.clone(),
            file_id: file_id.clone(),
            display_name: display_name.clone(),
            filename: display_name,
            original_name: link.name.clone(),
            mime,
            size_bytes,
            size_label: format_bytes(size_bytes),
            width,
            height,
            created_at,
            status: "ready".to_string(),
            file_ref: stored_name,
            exists: true,
            source_conversation_id: Some(link.conversation_id.clone()),
            source_conversation_title,
            source_message_id: Some(link.message_id.clone()),
            source_state: "linked".to_string(),
            in_chat: true,
            project_id: link.project_id.clone(),
        });
    }

    items.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.file_id.cmp(&right.file_id))
    });
    Ok(LibraryIndex {
        stats: stats_for(&items),
        items,
        generated_at: generated_at(),
    })
}

fn file_modified_iso(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        chrono::DateTime::<chrono::Utc>::from(modified)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
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
