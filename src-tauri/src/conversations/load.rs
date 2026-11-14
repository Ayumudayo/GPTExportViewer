use std::io::{Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::cache::{file_fingerprint, read_json, write_json_compact_atomic, FileFingerprint};
use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::safe_cache_name;
use crate::models::{Conversation, ExportItem, MessageRange};

use super::normalize::{get_conversation_id, normalize_conversation_with_fallback};
use super::summary_index::stream_conversation_values;

const CONVERSATION_CACHE_SCHEMA_VERSION: &[u8] = b"conversation-cache-v3";

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
            let mut found: Option<(usize, Value)> = None;
            stream_conversation_values(&export_item.paths.conversations, |index, conversation| {
                if get_conversation_id(&conversation, &index.to_string()) == conversation_id {
                    found = Some((index, conversation));
                    return Ok(ControlFlow::Break(()));
                }
                Ok(ControlFlow::Continue(()))
            })?;
            let Some((index, found)) = found else {
                return Ok(None);
            };
            let normalized = normalize_conversation_with_fallback(&found, &index.to_string())?;
            write_json_compact_atomic(&cache_file, &normalized)?;
            normalized
        }
    };

    Ok(Some(slice_conversation_page(&normalized, start, limit)))
}

pub fn slice_conversation_page(
    normalized: &Conversation,
    start: usize,
    limit: usize,
) -> Conversation {
    let safe_limit = limit.clamp(1, 200);
    let safe_start = start;
    let total = normalized.total_messages;
    let messages = normalized
        .messages
        .iter()
        .skip(safe_start)
        .take(safe_limit)
        .cloned()
        .collect();
    Conversation {
        id: normalized.id.clone(),
        title: normalized.title.clone(),
        created_at: normalized.created_at.clone(),
        updated_at: normalized.updated_at.clone(),
        model: normalized.model.clone(),
        archived: normalized.archived,
        starred: normalized.starred,
        total_messages: total,
        messages,
        range: Some(MessageRange {
            start: safe_start,
            limit: safe_limit,
            total,
            next_start: (safe_start + safe_limit < total).then_some(safe_start + safe_limit),
        }),
    }
}

pub fn read_conversation_from_jsonl(
    jsonl_path: &Path,
    offset: u64,
    len: u64,
) -> AppResult<Conversation> {
    let mut file = std::fs::File::open(jsonl_path).map_err(|error| io_error(jsonl_path, error))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_error(jsonl_path, error))?;
    let reader = std::io::BufReader::new(file.take(len));
    serde_json::from_reader(reader).map_err(|error| AppError::ParseFailed(error.to_string()))
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
