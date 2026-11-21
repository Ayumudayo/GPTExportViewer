use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::cache::temp_path_for;
use crate::errors::{io_error, AppError, AppResult};
use crate::library::index::{
    ConversationAssetLink, GeneratedLibraryImage, PreloadedLibraryContext,
};
use crate::models::{
    AssetRef, Conversation, ConversationIndex, ConversationMessage, ConversationStats,
    ConversationSummary, ExportItem, MessagePart, ProjectSummary,
};
use crate::time::generated_at;

use super::normalize::{
    get_conversation_id, normalize_codex_task, normalize_conversation_with_fallback,
    normalize_group_chat,
};

const SEARCH_TEXT_CHAR_LIMIT: usize = 262_144;

pub struct IndexedConversationArtifacts {
    pub index: ConversationIndex,
    pub offsets: HashMap<String, (u64, u64)>,
    pub search_texts: HashMap<String, String>,
    pub conversation_titles: HashMap<String, String>,
    pub conversation_assets: HashMap<String, ConversationAssetLink>,
}

pub fn build_conversation_summary_index(export_item: &ExportItem) -> AppResult<ConversationIndex> {
    let has_any = export_item.has_conversations
        || export_item.paths.group_chats.is_some()
        || export_item.paths.codex.is_some();
    if !has_any {
        return Ok(empty_index());
    }
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();
    if export_item.has_conversations {
        stream_export_conversation_values(export_item, |index, conversation| {
            let normalized =
                normalize_conversation_with_fallback(&conversation, &index.to_string())?;
            seen_ids.insert(normalized.id.clone());
            items.push(summarize_from_normalized(&normalized));
            Ok(ControlFlow::Continue(()))
        })?;
    }
    for normalized in load_supplementary_conversations(export_item, &seen_ids)? {
        items.push(summarize_from_normalized(&normalized));
    }
    Ok(finalize_conversation_index(items))
}

pub fn build_conversation_artifacts(
    export_item: &ExportItem,
    jsonl_path: &Path,
) -> AppResult<IndexedConversationArtifacts> {
    build_conversation_artifacts_with_context(
        export_item,
        jsonl_path,
        &PreloadedLibraryContext::default(),
    )
}

pub fn build_conversation_artifacts_with_context(
    export_item: &ExportItem,
    jsonl_path: &Path,
    preloaded: &PreloadedLibraryContext,
) -> AppResult<IndexedConversationArtifacts> {
    if let Some(parent) = jsonl_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }

    let has_any = export_item.has_conversations
        || export_item.paths.group_chats.is_some()
        || export_item.paths.codex.is_some();
    if !has_any {
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
            conversation_titles: HashMap::new(),
            conversation_assets: HashMap::new(),
        });
    }

    let mut items = Vec::new();
    let mut offsets = HashMap::new();
    let mut search_texts = HashMap::new();
    let mut conversation_titles = HashMap::new();
    let mut conversation_assets = HashMap::new();
    let mut seen_ids = HashSet::new();

    let tmp = temp_path_for(jsonl_path);
    let write_result = (|| -> AppResult<()> {
        let file = std::fs::File::create(&tmp).map_err(|error| io_error(&tmp, error))?;
        let mut writer = std::io::BufWriter::with_capacity(256 * 1024, file);
        let mut current_offset = 0_u64;

        let mut emit_normalized = |mut normalized: Conversation| -> AppResult<()> {
            let gen_images = preloaded
                .generated_by_thread
                .get(&normalized.id)
                .map(Vec::as_slice);
            enrich_and_attach_conversation_media(
                &mut normalized,
                &export_item.path,
                &preloaded.display_names_by_file_id,
                gen_images,
            );
            collect_conversation_assets(&normalized, &mut conversation_assets);
            conversation_titles
                .entry(normalized.id.clone())
                .or_insert_with(|| normalized.title.clone());

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
            Ok(())
        };

        if export_item.has_conversations {
            stream_export_conversation_values(export_item, |index, conversation| {
                let normalized =
                    normalize_conversation_with_fallback(&conversation, &index.to_string())?;
                seen_ids.insert(normalized.id.clone());
                emit_normalized(normalized)?;
                Ok(ControlFlow::Continue(()))
            })?;
        }

        for normalized in load_supplementary_conversations(export_item, &seen_ids)? {
            seen_ids.insert(normalized.id.clone());
            emit_normalized(normalized)?;
        }

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
        index: finalize_conversation_index_with_project_files(
            items,
            &preloaded.project_file_counts,
        ),
        offsets,
        search_texts,
        conversation_titles,
        conversation_assets,
    })
}

pub fn stream_export_conversation_values<F>(
    export_item: &ExportItem,
    mut on_item: F,
) -> AppResult<()>
where
    F: FnMut(usize, Value) -> AppResult<ControlFlow<()>>,
{
    let mut files: Vec<&Path> = export_item
        .paths
        .conversation_files
        .iter()
        .map(PathBuf::as_path)
        .collect();
    if files.is_empty() && export_item.paths.conversations.is_file() {
        files.push(&export_item.paths.conversations);
    }

    let mut running_index = 0usize;
    let mut seen_ids = HashSet::new();
    let mut aborted = false;

    for file_path in files {
        if aborted {
            break;
        }
        stream_conversation_values(file_path, |_local_idx, value| {
            let idx = running_index;
            running_index += 1;
            let id = get_conversation_id(&value, &idx.to_string());
            if !seen_ids.insert(id) {
                return Ok(ControlFlow::Continue(()));
            }
            match on_item(idx, value)? {
                ControlFlow::Continue(()) => Ok(ControlFlow::Continue(())),
                ControlFlow::Break(()) => {
                    aborted = true;
                    Ok(ControlFlow::Break(()))
                }
            }
        })?;
    }
    Ok(())
}

pub(crate) fn load_supplementary_conversations(
    export_item: &ExportItem,
    seen_ids: &HashSet<String>,
) -> AppResult<Vec<Conversation>> {
    let mut out = Vec::new();
    let mut local_seen = seen_ids.clone();

    if let Some(group_path) = &export_item.paths.group_chats {
        let bytes = std::fs::read(group_path).map_err(|error| io_error(group_path, error))?;
        let parsed: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::ParseFailed(format!("{}: {error}", group_path.display())))?;
        let chats = parsed
            .get("chats")
            .and_then(Value::as_array)
            .or_else(|| parsed.as_array());
        if let Some(chats) = chats {
            for (idx, chat) in chats.iter().enumerate() {
                let conv = normalize_group_chat(chat, &format!("group-chat-{idx}"));
                if local_seen.insert(conv.id.clone()) {
                    out.push(conv);
                }
            }
        }
    }

    if let Some(codex_path) = &export_item.paths.codex {
        let bytes = std::fs::read(codex_path).map_err(|error| io_error(codex_path, error))?;
        let parsed: Value = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::ParseFailed(format!("{}: {error}", codex_path.display())))?;
        let tasks = parsed
            .as_array()
            .or_else(|| parsed.get("tasks").and_then(Value::as_array));
        if let Some(tasks) = tasks {
            for (idx, task) in tasks.iter().enumerate() {
                let conv = normalize_codex_task(task, &format!("codex-{idx}"));
                if local_seen.insert(conv.id.clone()) {
                    out.push(conv);
                }
            }
        }
    }

    Ok(out)
}

pub fn enrich_and_attach_conversation_media(
    conversation: &mut Conversation,
    export_root: &Path,
    display_names: &HashMap<String, String>,
    generated_images: Option<&[GeneratedLibraryImage]>,
) {
    let mut existing_file_ids = HashSet::new();
    let mut existing_msg_ids = HashSet::new();

    for message in &mut conversation.messages {
        existing_msg_ids.insert(message.id.clone());
        for part in &mut message.parts {
            let Some(file_id) = part.file_id.clone() else {
                continue;
            };
            existing_file_ids.insert(file_id.clone());
            if part.part_type == "image" || part.part_type == "file" {
                let exists = export_root.join(format!("{file_id}.dat")).is_file();
                part.exists = Some(exists);
                if part.name.as_deref().is_none_or(|name| name.trim().is_empty()) {
                    if let Some(name) = display_names.get(&file_id) {
                        part.name = Some(name.clone());
                    }
                }
            }
        }
        for asset in &mut message.asset_refs {
            existing_file_ids.insert(asset.file_id.clone());
            if asset.name.as_deref().is_none_or(|name| name.trim().is_empty()) {
                if let Some(name) = display_names.get(&asset.file_id) {
                    asset.name = Some(name.clone());
                }
            }
        }
    }

    if let Some(gen_images) = generated_images {
        let missing_gen: Vec<&GeneratedLibraryImage> = gen_images
            .iter()
            .filter(|img| !existing_file_ids.contains(&img.file_id))
            .collect();
        if !missing_gen.is_empty() {
            let mut groups: Vec<Vec<&GeneratedLibraryImage>> = Vec::new();
            for img in missing_gen {
                let same_group = groups.last().is_some_and(|group| {
                    let prev_msg_id = group[0].origination_message_id.as_deref();
                    let cur_msg_id = img.origination_message_id.as_deref();
                    prev_msg_id.is_some() && prev_msg_id == cur_msg_id
                });
                if same_group {
                    groups.last_mut().unwrap().push(img);
                } else {
                    groups.push(vec![img]);
                }
            }

            let mut gen_messages = Vec::with_capacity(groups.len());
            for group in groups {
                let first = group[0];
                let candidate_id = first
                    .origination_message_id
                    .as_ref()
                    .filter(|id| !id.is_empty() && !existing_msg_ids.contains(*id))
                    .cloned()
                    .unwrap_or_else(|| format!("lib-gen-{}", first.file_id));
                let msg_id = if existing_msg_ids.insert(candidate_id.clone()) {
                    candidate_id
                } else {
                    let fallback = format!("lib-gen-{}", first.file_id);
                    existing_msg_ids.insert(fallback.clone());
                    fallback
                };

                let parts: Vec<MessagePart> = group
                    .iter()
                    .map(|img| MessagePart {
                        part_type: "image".to_string(),
                        text: None,
                        file_id: Some(img.file_id.clone()),
                        name: Some(img.display_name.clone()),
                        mime_type: Some(img.mime_type.clone()),
                        width: img.width,
                        height: img.height,
                        exists: Some(true),
                    })
                    .collect();
                let asset_refs: Vec<AssetRef> = group
                    .iter()
                    .map(|img| AssetRef {
                        file_id: img.file_id.clone(),
                        name: Some(img.display_name.clone()),
                        mime_type: Some(img.mime_type.clone()),
                    })
                    .collect();

                gen_messages.push(ConversationMessage {
                    id: msg_id.clone(),
                    node_id: msg_id,
                    ordinal: 0,
                    role: "assistant".to_string(),
                    author: "assistant".to_string(),
                    created_at: first.created_at.clone(),
                    content_type: Some("generated_image".to_string()),
                    text: String::new(),
                    asset_refs,
                    parts,
                });
            }

            insert_messages_chronologically(&mut conversation.messages, gen_messages);
        }
    }

    for (index, message) in conversation.messages.iter_mut().enumerate() {
        message.ordinal = index + 1;
    }
    conversation.total_messages = conversation.messages.len();
}

fn insert_messages_chronologically(
    messages: &mut Vec<ConversationMessage>,
    additions: Vec<ConversationMessage>,
) {
    let orig_times: Vec<Option<DateTime<Utc>>> = messages
        .iter()
        .map(|msg| parse_iso_opt(msg.created_at.as_deref()))
        .collect();
    let mut insertions: Vec<(usize, ConversationMessage)> = Vec::with_capacity(additions.len());

    for addition in additions {
        let pos = if let Some(add_time) = parse_iso_opt(addition.created_at.as_deref()) {
            orig_times
                .iter()
                .position(|orig| orig.is_some_and(|t| t > add_time))
                .unwrap_or(messages.len())
        } else {
            messages.len()
        };
        insertions.push((pos, addition));
    }

    let mut offset = 0usize;
    let mut last_orig_pos = 0usize;
    for (pos, addition) in insertions {
        let clamped_pos = pos.max(last_orig_pos);
        last_orig_pos = clamped_pos;
        let target_idx = (clamped_pos + offset).min(messages.len());
        messages.insert(target_idx, addition);
        offset += 1;
    }
}

fn parse_iso_opt(value: Option<&str>) -> Option<DateTime<Utc>> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn collect_conversation_assets(
    conversation: &Conversation,
    out: &mut HashMap<String, ConversationAssetLink>,
) {
    for message in &conversation.messages {
        for part in &message.parts {
            let Some(file_id) = part.file_id.as_ref().filter(|id| !id.is_empty()) else {
                continue;
            };
            out.entry(file_id.clone())
                .or_insert_with(|| ConversationAssetLink {
                    conversation_id: conversation.id.clone(),
                    message_id: message.id.clone(),
                    project_id: conversation.project_id.clone(),
                    name: part.name.clone(),
                    mime_type: part.mime_type.clone(),
                    width: part.width,
                    height: part.height,
                    created_at: message.created_at.clone(),
                });
        }
        for asset in &message.asset_refs {
            if asset.file_id.is_empty() {
                continue;
            }
            out.entry(asset.file_id.clone())
                .or_insert_with(|| ConversationAssetLink {
                    conversation_id: conversation.id.clone(),
                    message_id: message.id.clone(),
                    project_id: conversation.project_id.clone(),
                    name: asset.name.clone(),
                    mime_type: asset.mime_type.clone(),
                    width: None,
                    height: None,
                    created_at: message.created_at.clone(),
                });
        }
    }
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

fn finalize_conversation_index(items: Vec<ConversationSummary>) -> ConversationIndex {
    finalize_conversation_index_with_project_files(items, &HashMap::new())
}

fn finalize_conversation_index_with_project_files(
    mut items: Vec<ConversationSummary>,
    project_file_counts: &HashMap<String, usize>,
) -> ConversationIndex {
    items.sort_by(|left, right| {
        let left_time = left.updated_at.as_ref().or(left.created_at.as_ref());
        let right_time = right.updated_at.as_ref().or(right.created_at.as_ref());
        right_time.cmp(&left_time)
    });

    let regular_conversations = items.iter().filter(|item| item.kind == "regular").count();
    let project_conversations = items.iter().filter(|item| item.kind == "project").count();
    let custom_gpt_conversations = items
        .iter()
        .filter(|item| item.kind == "custom_gpt")
        .count();
    let group_chat_conversations = items
        .iter()
        .filter(|item| item.kind == "group_chat")
        .count();
    let codex_conversations = items.iter().filter(|item| item.kind == "codex").count();

    let mut project_groups: HashMap<String, ProjectSummary> = HashMap::new();
    for item in &items {
        if item.kind != "project" {
            continue;
        }
        let Some(pid) = item
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let entry = project_groups
            .entry(pid.to_string())
            .or_insert_with(|| ProjectSummary {
                id: pid.to_string(),
                conversation_count: 0,
                archived_count: 0,
                latest_updated_at: item.updated_at.clone().or_else(|| item.created_at.clone()),
                sample_title: Some(item.title.trim().to_string()).filter(|t| !t.is_empty()),
                file_count: project_file_counts.get(pid).copied().unwrap_or(0),
            });
        entry.conversation_count += 1;
        if item.archived {
            entry.archived_count += 1;
        }
        if entry.sample_title.is_none() {
            entry.sample_title = Some(item.title.trim().to_string()).filter(|t| !t.is_empty());
        }
    }
    let mut projects: Vec<ProjectSummary> = project_groups.into_values().collect();
    projects.sort_by(|left, right| {
        right
            .latest_updated_at
            .cmp(&left.latest_updated_at)
            .then_with(|| right.conversation_count.cmp(&left.conversation_count))
            .then_with(|| left.id.cmp(&right.id))
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
        regular_conversations,
        project_conversations,
        custom_gpt_conversations,
        group_chat_conversations,
        codex_conversations,
        projects,
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
        kind: conversation.kind.clone(),
        project_id: conversation.project_id.clone(),
        gizmo_id: conversation.gizmo_id.clone(),
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
    if let Some(project_id) = conversation.project_id.as_deref() {
        push_segment(project_id);
    }
    if let Some(gizmo_id) = conversation.gizmo_id.as_deref() {
        push_segment(gizmo_id);
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
            regular_conversations: 0,
            project_conversations: 0,
            custom_gpt_conversations: 0,
            group_chat_conversations: 0,
            codex_conversations: 0,
            projects: Vec::new(),
        },
        generated_at: generated_at(),
    }
}
