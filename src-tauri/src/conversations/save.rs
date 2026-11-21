use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::ControlFlow;
use std::path::Path;

use serde_json::Value;

use crate::cache::write_json_atomic;
use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::{build_project_folder_map, safe_cache_name};
use crate::models::{ExportItem, SaveSessionsProgress, SavedSessionItem};
use crate::time::to_iso_time;

use super::normalize::{classify_conversation_origin, get_conversation_id};
use super::summary_index::stream_export_conversation_values;

type RawSessionEntry = (Value, String, Option<String>);

pub fn save_original_sessions(
    export: &ExportItem,
    destination_dir: &Path,
    conversation_ids: &[String],
    project_aliases: &BTreeMap<String, String>,
    mut on_progress: impl FnMut(SaveSessionsProgress),
) -> AppResult<Vec<SavedSessionItem>> {
    if conversation_ids.is_empty() {
        return Ok(Vec::new());
    }

    let needed: HashSet<&str> = conversation_ids.iter().map(String::as_str).collect();
    let mut found_by_id: HashMap<String, RawSessionEntry> = HashMap::with_capacity(needed.len());
    if export.has_conversations {
        stream_export_conversation_values(export, |index, conversation| {
            let id = get_conversation_id(&conversation, &index.to_string());
            if needed.contains(id.as_str()) {
                let (kind, project_id, _, _) = classify_conversation_origin(&conversation);
                found_by_id
                    .entry(id)
                    .or_insert((conversation, kind, project_id));
                if found_by_id.len() == needed.len() {
                    return Ok(ControlFlow::Break(()));
                }
            }
            Ok(ControlFlow::Continue(()))
        })?;
    }

    if found_by_id.len() < needed.len() {
        collect_supplementary_raw(export, &needed, &mut found_by_id)?;
    }

    let mut requested = Vec::with_capacity(conversation_ids.len());
    let mut project_ids = Vec::new();
    for conversation_id in conversation_ids {
        let Some((conversation, kind, project_id)) = found_by_id.get(conversation_id) else {
            return Err(AppError::ConversationNotFound);
        };
        if let Some(pid) = project_id {
            project_ids.push(pid.clone());
        }
        requested.push((
            conversation_id.clone(),
            conversation,
            kind.as_str(),
            project_id.as_deref(),
        ));
    }
    let project_folder_map = build_project_folder_map(&project_ids, project_aliases);

    let total = requested.len();
    let mut items = Vec::with_capacity(total);
    for (index, (conversation_id, conversation, kind, project_id)) in
        requested.into_iter().enumerate()
    {
        let title = conversation_title(conversation);
        let category_dir = match kind {
            "project" => {
                let proj_seg = project_id
                    .and_then(|pid| project_folder_map.get(pid))
                    .map(String::as_str)
                    .unwrap_or("_Unassigned");
                destination_dir.join("Projects").join(proj_seg)
            }
            "regular" => destination_dir.join("General"),
            _ => destination_dir.join("Other"),
        };
        std::fs::create_dir_all(&category_dir).map_err(|error| io_error(&category_dir, error))?;
        let file_path =
            category_dir.join(file_name_for(conversation, &title, &conversation_id));
        write_json_atomic(&file_path, conversation)?;

        items.push(SavedSessionItem {
            conversation_id: conversation_id.clone(),
            title: title.clone(),
            path: file_path,
            format: "original".to_string(),
        });
        on_progress(SaveSessionsProgress {
            export_id: export.id.clone(),
            total,
            completed: index + 1,
            current_conversation_id: Some(conversation_id),
            current_title: Some(title),
        });
    }

    Ok(items)
}

fn conversation_title(conversation: &Value) -> String {
    conversation
        .get("title")
        .or_else(|| conversation.get("name"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Untitled conversation")
        .to_string()
}

fn collect_supplementary_raw(
    export: &ExportItem,
    needed: &HashSet<&str>,
    found_by_id: &mut HashMap<String, RawSessionEntry>,
) -> AppResult<()> {
    if let Some(group_path) = &export.paths.group_chats {
        let bytes = std::fs::read(group_path).map_err(|error| io_error(group_path, error))?;
        let parsed: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::ParseFailed(format!("{}: {error}", group_path.display())))?;
        let chats = parsed
            .get("chats")
            .and_then(Value::as_array)
            .or_else(|| parsed.as_array());
        if let Some(chats) = chats {
            for (idx, chat) in chats.iter().enumerate() {
                let id = chat
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("group-chat-{idx}"));
                if needed.contains(id.as_str()) {
                    found_by_id
                        .entry(id)
                        .or_insert_with(|| (chat.clone(), "group_chat".to_string(), None));
                    if found_by_id.len() == needed.len() {
                        return Ok(());
                    }
                }
            }
        }
    }

    if let Some(codex_path) = &export.paths.codex {
        let bytes = std::fs::read(codex_path).map_err(|error| io_error(codex_path, error))?;
        let parsed: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::ParseFailed(format!("{}: {error}", codex_path.display())))?;
        let tasks = parsed
            .as_array()
            .or_else(|| parsed.get("tasks").and_then(Value::as_array));
        if let Some(tasks) = tasks {
            for (idx, task) in tasks.iter().enumerate() {
                let id = task
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("codex-{idx}"));
                if needed.contains(id.as_str()) {
                    found_by_id
                        .entry(id)
                        .or_insert_with(|| (task.clone(), "codex".to_string(), None));
                    if found_by_id.len() == needed.len() {
                        return Ok(());
                    }
                }
            }
        }
    }

    Ok(())
}

fn file_name_for(conversation: &Value, title: &str, conversation_id: &str) -> String {
    format!(
        "{}-{}-{}.json",
        date_segment(conversation),
        safe_cache_name(title),
        safe_cache_name(conversation_id)
    )
}

fn date_segment(conversation: &Value) -> String {
    let date = ["update_time", "updated_at", "create_time", "created_at"]
        .iter()
        .find_map(|key| conversation.get(*key).and_then(to_iso_time))
        .unwrap_or_else(|| "unknown-date".to_string());
    date.chars()
        .map(|ch| {
            if matches!(ch, ':' | 'T' | 'Z') {
                '-'
            } else {
                ch
            }
        })
        .collect()
}
