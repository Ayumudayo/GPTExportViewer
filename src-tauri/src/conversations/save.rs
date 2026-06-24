use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::cache::write_json_atomic;
use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::safe_cache_name;
use crate::models::{ExportItem, SaveSessionsProgress, SavedSessionItem};
use crate::time::to_iso_time;

use super::normalize::get_conversation_id;
use super::summary_index::read_conversation_array;

pub fn save_original_sessions(
    export: &ExportItem,
    destination_dir: &Path,
    conversation_ids: &[String],
    mut on_progress: impl FnMut(SaveSessionsProgress),
) -> AppResult<Vec<SavedSessionItem>> {
    if conversation_ids.is_empty() {
        return Ok(Vec::new());
    }

    let conversations = read_conversation_array(&export.paths.conversations)?;
    let by_id: HashMap<String, &Value> = conversations
        .iter()
        .enumerate()
        .map(|(index, conversation)| {
            (
                get_conversation_id(conversation, &index.to_string()),
                conversation,
            )
        })
        .collect();

    let mut requested = Vec::with_capacity(conversation_ids.len());
    for conversation_id in conversation_ids {
        let Some(conversation) = by_id.get(conversation_id) else {
            return Err(AppError::ConversationNotFound);
        };
        requested.push((conversation_id.clone(), (*conversation).clone()));
    }

    std::fs::create_dir_all(destination_dir).map_err(|error| io_error(destination_dir, error))?;

    let total = requested.len();
    let mut items = Vec::with_capacity(total);
    for (index, (conversation_id, conversation)) in requested.into_iter().enumerate() {
        let title = conversation_title(&conversation);
        let file_path =
            destination_dir.join(file_name_for(&conversation, &title, &conversation_id));
        write_json_atomic(&file_path, &conversation)?;

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
