use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::ops::ControlFlow;
use std::path::Path;

use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::cache::temp_path_for;
use crate::errors::{io_error, AppError, AppResult};
use crate::models::{
    Conversation, ConversationIndex, ConversationStats, ConversationSummary, ExportItem,
};
use crate::time::generated_at;

use super::normalize::normalize_conversation_with_fallback;

const SEARCH_TEXT_CHAR_LIMIT: usize = 262_144;

pub struct IndexedConversationArtifacts {
    pub index: ConversationIndex,
    pub offsets: HashMap<String, (u64, u64)>,
    pub search_texts: HashMap<String, String>,
}

pub fn build_conversation_summary_index(export_item: &ExportItem) -> AppResult<ConversationIndex> {
    if !export_item.has_conversations {
        return Ok(empty_index());
    }
    let mut items = Vec::new();
    stream_conversation_values(&export_item.paths.conversations, |index, conversation| {
        let normalized = normalize_conversation_with_fallback(&conversation, &index.to_string())?;
        items.push(summarize_from_normalized(&normalized));
        Ok(ControlFlow::Continue(()))
    })?;
    Ok(finalize_conversation_index(items))
}

pub fn build_conversation_artifacts(
    export_item: &ExportItem,
    jsonl_path: &Path,
) -> AppResult<IndexedConversationArtifacts> {
    if let Some(parent) = jsonl_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }

    if !export_item.has_conversations {
        let tmp = temp_path_for(jsonl_path);
        std::fs::write(&tmp, b"").map_err(|error| io_error(&tmp, error))?;
        if let Err(error) = std::fs::rename(&tmp, jsonl_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(io_error(jsonl_path, error));
        }
        return Ok(IndexedConversationArtifacts {
            index: empty_index(),
            offsets: HashMap::new(),
            search_texts: HashMap::new(),
        });
    }

    let mut items = Vec::new();
    let mut offsets = HashMap::new();
    let mut search_texts = HashMap::new();

    let tmp = temp_path_for(jsonl_path);
    let write_result = (|| -> AppResult<()> {
        let file = std::fs::File::create(&tmp).map_err(|error| io_error(&tmp, error))?;
        let mut writer = std::io::BufWriter::with_capacity(256 * 1024, file);
        let mut current_offset = 0_u64;

        stream_conversation_values(&export_item.paths.conversations, |index, conversation| {
            let normalized =
                normalize_conversation_with_fallback(&conversation, &index.to_string())?;
            let line_bytes = serde_json::to_vec(&normalized)
                .map_err(|error| AppError::CacheUnavailable(error.to_string()))?;
            let len = line_bytes.len() as u64;
            writer
                .write_all(&line_bytes)
                .map_err(|error| io_error(&tmp, error))?;
            writer
                .write_all(b"\n")
                .map_err(|error| io_error(&tmp, error))?;
            offsets
                .entry(normalized.id.clone())
                .or_insert((current_offset, len));
            current_offset += len + 1;

            search_texts
                .entry(normalized.id.clone())
                .or_insert_with(|| build_conversation_search_text(&normalized));
            items.push(summarize_from_normalized(&normalized));
            Ok(ControlFlow::Continue(()))
        })?;
        writer.flush().map_err(|error| io_error(&tmp, error))?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&tmp, jsonl_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_error(jsonl_path, error));
    }

    Ok(IndexedConversationArtifacts {
        index: finalize_conversation_index(items),
        offsets,
        search_texts,
    })
}

pub fn stream_conversation_values<F>(file_path: &Path, mut on_item: F) -> AppResult<()>
where
    F: FnMut(usize, Value) -> AppResult<ControlFlow<()>>,
{
    let file = std::fs::File::open(file_path).map_err(|error| io_error(file_path, error))?;
    let reader = std::io::BufReader::with_capacity(256 * 1024, file);
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let mut callback_error: Option<AppError> = None;

    let result = TopLevelConversationsSeed {
        on_item: &mut on_item,
        error: &mut callback_error,
    }
    .deserialize(&mut deserializer);

    if let Some(error) = callback_error {
        return Err(error);
    }
    result.map_err(|error| AppError::ParseFailed(error.to_string()))?;
    deserializer
        .end()
        .map_err(|error| AppError::ParseFailed(error.to_string()))?;
    Ok(())
}

pub fn read_conversation_array(file_path: &Path) -> AppResult<Vec<Value>> {
    let mut conversations = Vec::new();
    stream_conversation_values(file_path, |_index, value| {
        conversations.push(value);
        Ok(ControlFlow::Continue(()))
    })?;
    Ok(conversations)
}

struct ConversationSeqSeed<'a, F> {
    on_item: &'a mut F,
    error: &'a mut Option<AppError>,
}

impl<'de, F> DeserializeSeed<'de> for ConversationSeqSeed<'_, F>
where
    F: FnMut(usize, Value) -> AppResult<ControlFlow<()>>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }
}

impl<'de, F> Visitor<'de> for ConversationSeqSeed<'_, F>
where
    F: FnMut(usize, Value) -> AppResult<ControlFlow<()>>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a conversations array")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut index = 0usize;
        while let Some(value) = seq.next_element::<Value>()? {
            match (self.on_item)(index, value) {
                Ok(ControlFlow::Continue(())) => {
                    index += 1;
                }
                Ok(ControlFlow::Break(())) => {
                    while seq.next_element::<IgnoredAny>()?.is_some() {}
                    return Ok(());
                }
                Err(err) => {
                    *self.error = Some(err);
                    return Err(de::Error::custom("stream aborted"));
                }
            }
        }
        Ok(())
    }

    fn visit_bool<E>(self, _v: bool) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_i64<E>(self, _v: i64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_u64<E>(self, _v: u64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_f64<E>(self, _v: f64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_str<E>(self, _v: &str) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }
    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(())
    }
}

struct TopLevelConversationsSeed<'a, F> {
    on_item: &'a mut F,
    error: &'a mut Option<AppError>,
}

impl<'de, F> DeserializeSeed<'de> for TopLevelConversationsSeed<'_, F>
where
    F: FnMut(usize, Value) -> AppResult<ControlFlow<()>>,
{
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }
}

impl<'de, F> Visitor<'de> for TopLevelConversationsSeed<'_, F>
where
    F: FnMut(usize, Value) -> AppResult<ControlFlow<()>>,
{
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a conversation array or object with a conversations array")
    }

    fn visit_seq<A>(self, seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        ConversationSeqSeed {
            on_item: self.on_item,
            error: self.error,
        }
        .visit_seq(seq)
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut handled_conversations = false;
        while let Some(key) = map.next_key::<Cow<'de, str>>()? {
            if !handled_conversations && key == "conversations" {
                handled_conversations = true;
                map.next_value_seed(ConversationSeqSeed {
                    on_item: self.on_item,
                    error: self.error,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }

    fn visit_bool<E>(self, _v: bool) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_i64<E>(self, _v: i64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_u64<E>(self, _v: u64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_f64<E>(self, _v: f64) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_str<E>(self, _v: &str) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }
    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }
}

fn finalize_conversation_index(mut items: Vec<ConversationSummary>) -> ConversationIndex {
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
        max_messages: items
            .iter()
            .map(|item| item.message_count)
            .max()
            .unwrap_or(0),
    };
    ConversationIndex {
        items,
        stats,
        generated_at: generated_at(),
    }
}

fn summarize_from_normalized(conversation: &Conversation) -> ConversationSummary {
    let first_text = conversation
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .find(|text| !text.trim().is_empty())
        .unwrap_or("");
    let unique_attachments: HashSet<&str> = conversation
        .messages
        .iter()
        .flat_map(|message| message.asset_refs.iter().map(|asset| asset.file_id.as_str()))
        .collect();
    let created_at = conversation.created_at.clone();
    let updated_at = conversation
        .updated_at
        .clone()
        .or_else(|| created_at.clone());

    ConversationSummary {
        id: conversation.id.clone(),
        title: conversation.title.clone(),
        created_at,
        updated_at,
        message_count: conversation.total_messages,
        attachment_count: unique_attachments.len(),
        model: conversation.model.clone(),
        archived: conversation.archived,
        starred: conversation.starred,
        preview: first_text.chars().take(240).collect(),
        last_role: conversation
            .messages
            .last()
            .map(|message| message.role.clone()),
    }
}

fn build_conversation_search_text(conversation: &Conversation) -> String {
    let mut out = String::new();
    let mut char_count = 0usize;
    let mut push_segment = |segment: &str| -> bool {
        if char_count >= SEARCH_TEXT_CHAR_LIMIT {
            return true;
        }
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            return false;
        }
        if !out.is_empty() && char_count < SEARCH_TEXT_CHAR_LIMIT {
            out.push('\n');
            char_count += 1;
        }
        let mut prev_space = true;
        for ch in trimmed.to_lowercase().nfc() {
            if char_count >= SEARCH_TEXT_CHAR_LIMIT {
                break;
            }
            if ch.is_whitespace() {
                if !prev_space {
                    out.push(' ');
                    char_count += 1;
                    prev_space = true;
                }
            } else {
                out.push(ch);
                char_count += 1;
                prev_space = false;
            }
        }
        if out.ends_with(' ') {
            out.pop();
            char_count = char_count.saturating_sub(1);
        }
        char_count >= SEARCH_TEXT_CHAR_LIMIT
    };

    push_segment(&conversation.title);
    if let Some(model) = conversation.model.as_deref() {
        push_segment(model);
    }
    push_segment(&conversation.id);
    for message in &conversation.messages {
        if push_segment(&message.text) {
            break;
        }
    }
    out
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
