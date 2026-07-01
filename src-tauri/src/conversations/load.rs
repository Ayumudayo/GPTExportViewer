use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

use crate::cache::{file_fingerprint, read_json, write_json_atomic, FileFingerprint};
use crate::errors::AppResult;
use crate::fs_guards::safe_cache_name;
use crate::models::{Conversation, ExportItem, MessageRange};

use super::normalize::{get_conversation_id, normalize_conversation};
use super::summary_index::read_conversation_array;

const CONVERSATION_CACHE_SCHEMA_VERSION: &[u8] = b"conversation-cache-v2";

pub fn load_conversation(
    export_item: &ExportItem,
    conversation_id: &str,
    cache_dir: &Path,
    start: usize,
    limit: usize,
) -> AppResult<Option<Conversation>> {
    let fingerprint = file_fingerprint(&export_item.paths.conversations)?;
    let cache_file =
        conversation_cache_path(cache_dir, &export_item.id, conversation_id, &fingerprint);
    let normalized = match read_json::<Conversation>(&cache_file)? {
        Some(conversation) => conversation,
        None => {
            let conversations = read_conversation_array(&export_item.paths.conversations)?;
            let found = conversations
                .iter()
                .enumerate()
                .find(|(index, conversation)| {
                    get_conversation_id(conversation, &index.to_string()) == conversation_id
                })
                .map(|(_, conversation)| conversation);
            let Some(found) = found else {
                return Ok(None);
            };
            let normalized = normalize_conversation(found)?;
            write_json_atomic(&cache_file, &normalized)?;
            normalized
        }
    };

    let safe_limit = limit.clamp(1, 200);
    let safe_start = start;
    let total = normalized.total_messages;
    let mut page = normalized.clone();
    page.messages = normalized
        .messages
        .iter()
        .skip(safe_start)
        .take(safe_limit)
        .cloned()
        .collect();
    page.range = Some(MessageRange {
        start: safe_start,
        limit: safe_limit,
        total,
        next_start: (safe_start + safe_limit < total).then_some(safe_start + safe_limit),
    });
    Ok(Some(page))
}

fn conversation_cache_path(
    cache_dir: &Path,
    export_id: &str,
    conversation_id: &str,
    fingerprint: &FileFingerprint,
) -> PathBuf {
    let digest = {
        let mut hasher = Sha1::new();
        hasher.update(CONVERSATION_CACHE_SCHEMA_VERSION);
        hasher.update(conversation_id.as_bytes());
        hasher.update(fingerprint.path.to_string_lossy().as_bytes());
        hasher.update(fingerprint.size.unwrap_or_default().to_le_bytes());
        hasher.update(fingerprint.mtime_ms.unwrap_or_default().to_le_bytes());
        hasher.update([u8::from(fingerprint.missing)]);
        format!("{:x}", hasher.finalize())[..16].to_string()
    };
    cache_dir
        .join(export_id)
        .join("conversations")
        .join(format!(
            "{}-{digest}.json",
            safe_cache_name(conversation_id)
        ))
}
