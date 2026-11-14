use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::path::Path;

use serde_json::Value;

use crate::cache::write_json_atomic;
use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::safe_cache_name;
use crate::models::{ExportItem, SaveSessionsProgress, SavedSessionItem};
use crate::time::to_iso_time;

use super::normalize::get_conversation_id;
use super::summary_index::stream_conversation_values;

pub fn save_original_sessions(
    export: &ExportItem,
    destination_dir: &Path,
    conversation_ids: &[String],
    mut on_progress: impl FnMut(SaveSessionsProgress),
) -> AppResult<Vec<SavedSessionItem>> {
    if conversation_ids.is_empty() {
        return Ok(Vec::new());
    }

    let needed: HashSet<&str> = conversation_ids.iter().map(String::as_str).collect();
    let mut found_by_id: HashMap<String, Value> = HashMap::with_capacity(needed.len());
    stream_conversation_values(&export.paths.conversations, |index, conversation| {
        let id = get_conversation_id(&conversation, &index.to_string());
        if needed.contains(id.as_str()) {
            found_by_id.entry(id).or_insert(conversation);
            if found_by_id.len() == needed.len() {
                return Ok(ControlFlow::Break(()));
            }
        }
        Ok(ControlFlow::Continue(()))
    })?;

    let mut requested = Vec::with_capacity(conversation_ids.len());
    for conversation_id in conversation_ids {
        let Some(conversation) = found_by_id.get(conversation_id) else {
            return Err(AppError::ConversationNotFound);
        };
        requested.push((conversation_id.clone(), conversation));
    }

    std::fs::create_dir_all(destination_dir).map_err(|error| io_error(destination_dir, error))?;

    let total = requested.len();
    let mut items = Vec::with_capacity(total);
    for (index, (conversation_id, conversation)) in requested.into_iter().enumerate() {
        let title = conversation_title(conversation);
        let file_path =
            destination_dir.join(file_name_for(conversation, &title, &conversation_id));
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
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Untitled conversation")
        .to_string()
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
