use std::path::Path;

use serde_json::Value;

use crate::errors::{io_error, AppError, AppResult};
use crate::models::{ConversationIndex, ConversationStats, ConversationSummary, ExportItem};
use crate::time::{generated_at, to_iso_time};

use super::normalize::{extract_asset_refs_from_pair, extract_message_text, get_conversation_id};

pub fn build_conversation_summary_index(export_item: &ExportItem) -> AppResult<ConversationIndex> {
    if !export_item.has_conversations {
        return Ok(empty_index());
    }
    let conversations = read_conversation_array(&export_item.paths.conversations)?;
    let mut items: Vec<_> = conversations
        .iter()
        .enumerate()
        .map(|(index, conversation)| summarize_conversation(conversation, index))
        .collect();
    items.sort_by(|left, right| {
        let left_time = left.updated_at.as_ref().or(left.created_at.as_ref());
        let right_time = right.updated_at.as_ref().or(right.created_at.as_ref());
        right_time.cmp(&left_time)
    });
    let stats = ConversationStats {
        total_conversations: items.len(),
        total_messages: items.iter().map(|item| item.message_count).sum(),
        total_attachments: items.iter().map(|item| item.attachment_count).sum(),
        archived: items.iter().filter(|item| item.archived).count(),
        starred: items.iter().filter(|item| item.starred).count(),
        max_messages: items.iter().map(|item| item.message_count).max().unwrap_or(0),
    };
    Ok(ConversationIndex {
        items,
        stats,
        generated_at: generated_at(),
    })
}

pub fn read_conversation_array(file_path: &Path) -> AppResult<Vec<Value>> {
    let content = std::fs::read_to_string(file_path).map_err(|error| io_error(file_path, error))?;
    let parsed: Value = serde_json::from_str(&content).map_err(|error| AppError::ParseFailed(error.to_string()))?;
    if let Some(array) = parsed.as_array() {
        return Ok(array.clone());
    }
    if let Some(array) = parsed.get("conversations").and_then(Value::as_array) {
        return Ok(array.clone());
    }
    Ok(vec![])
}

fn summarize_conversation(conversation: &Value, index: usize) -> ConversationSummary {
    let nodes = conversation
        .get("mapping")
        .and_then(Value::as_object)
        .map(|mapping| {
            mapping
                .values()
                .filter(|node| node.get("message").is_some())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let first_text = nodes
        .iter()
        .map(|node| extract_message_text(&node["message"]["content"]))
        .find(|text| !text.is_empty())
        .unwrap_or_default();
    let asset_refs = nodes
        .iter()
        .flat_map(|node| extract_asset_refs_from_pair(&node["message"]["content"], &node["message"]["metadata"]))
        .collect::<Vec<_>>();
    let created_at = to_iso_time(
        conversation
            .get("create_time")
            .or_else(|| conversation.get("created_at"))
            .unwrap_or(&Value::Null),
    );
    let updated_at = to_iso_time(
        conversation
            .get("update_time")
            .or_else(|| conversation.get("updated_at"))
            .unwrap_or(&Value::Null),
    )
    .or_else(|| created_at.clone());

    ConversationSummary {
        id: get_conversation_id(conversation, &index.to_string()),
        title: conversation
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled conversation")
            .to_string(),
        created_at,
        updated_at,
        message_count: nodes.len(),
        attachment_count: asset_refs.len(),
        model: conversation
            .get("default_model_slug")
            .or_else(|| conversation.get("model_slug"))
            .and_then(Value::as_str)
            .map(str::to_string),
        archived: conversation
            .get("is_archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        starred: conversation
            .get("is_starred")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        preview: first_text.chars().take(240).collect(),
        last_role: nodes
            .last()
            .and_then(|node| node.pointer("/message/author/role"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn empty_index() -> ConversationIndex {
    ConversationIndex {
        items: vec![],
        stats: ConversationStats {
            total_conversations: 0,
            total_messages: 0,
            total_attachments: 0,
            archived: 0,
            starred: 0,
            max_messages: 0,
        },
        generated_at: generated_at(),
    }
}
