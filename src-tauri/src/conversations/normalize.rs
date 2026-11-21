use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::models::{AssetRef, Conversation, ConversationMessage, MessagePart};
use crate::time::to_iso_time;

use super::text_cleanup::clean_message_text;

pub fn normalize_conversation(conversation: &Value) -> crate::errors::AppResult<Conversation> {
    normalize_conversation_with_fallback(conversation, "")
}

pub fn normalize_conversation_with_fallback(
    conversation: &Value,
    fallback_id: &str,
) -> crate::errors::AppResult<Conversation> {
    let ordered_nodes = get_ordered_nodes(conversation);
    let messages: Vec<_> = ordered_nodes
        .iter()
        .filter_map(normalize_node)
        .enumerate()
        .map(|(index, mut message)| {
            message.ordinal = index + 1;
            message
        })
        .collect();
    let (kind, project_id, gizmo_id, memory_scope) = classify_conversation_origin(conversation);
    Ok(Conversation {
        id: get_conversation_id(conversation, fallback_id),
        title: conversation
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled conversation")
            .to_string(),
        created_at: to_iso_time(
            conversation
                .get("create_time")
                .or_else(|| conversation.get("created_at"))
                .unwrap_or(&Value::Null),
        ),
        updated_at: to_iso_time(
            conversation
                .get("update_time")
                .or_else(|| conversation.get("updated_at"))
                .unwrap_or(&Value::Null),
        ),
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
        kind,
        project_id,
        gizmo_id,
        memory_scope,
        total_messages: messages.len(),
        messages,
        range: None,
    })
}

fn non_empty_trimmed_str<'a>(value: Option<&'a Value>) -> Option<&'a str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

pub(crate) fn classify_conversation_origin(
    conversation: &Value,
) -> (String, Option<String>, Option<String>, Option<String>) {
    let template_id = non_empty_trimmed_str(conversation.get("conversation_template_id"));
    let raw_gizmo_id = non_empty_trimmed_str(conversation.get("gizmo_id"));
    let effective_id = template_id.or(raw_gizmo_id);
    let gizmo_type = non_empty_trimmed_str(conversation.get("gizmo_type"));
    let memory_scope = non_empty_trimmed_str(conversation.get("memory_scope"));

    let is_project = effective_id.is_some_and(|id| id.starts_with("g-p-"))
        || gizmo_type == Some("snorlax")
        || memory_scope.is_some_and(|scope| scope.starts_with("project"));

    let (kind, project_id, gizmo_id) = if is_project {
        (
            "project",
            effective_id.map(str::to_string),
            effective_id.map(str::to_string),
        )
    } else if gizmo_type == Some("gpt") || effective_id.is_some_and(|id| id.starts_with("g-")) {
        ("custom_gpt", None, effective_id.map(str::to_string))
    } else {
        ("regular", None, None)
    };

    (
        kind.to_string(),
        project_id,
        gizmo_id,
        memory_scope.map(str::to_string),
    )
}

pub fn get_conversation_id(conversation: &Value, fallback: &str) -> String {
    conversation
        .get("id")
        .or_else(|| conversation.get("conversation_id"))
        .or_else(|| conversation.get("uuid"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub fn extract_message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.get("parts").and_then(Value::as_array) {
        return parts
            .iter()
            .map(part_to_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
    }
    for key in ["text", "result", "summary"] {
        if let Some(text) = content.get(key).and_then(Value::as_str) {
            return text.trim().to_string();
        }
    }
    String::new()
}

pub fn extract_asset_refs_from_pair(content: &Value, metadata: &Value) -> Vec<AssetRef> {
    let attachment_index = attachment_index(metadata);
    let mut wrapper = Map::new();
    wrapper.insert("content".to_string(), content.clone());
    wrapper.insert("metadata".to_string(), metadata.clone());
    extract_asset_refs_with_metadata(&Value::Object(wrapper), &attachment_index)
}

pub fn extract_asset_refs(value: &Value) -> Vec<AssetRef> {
    extract_asset_refs_with_metadata(value, &HashMap::new())
}

fn extract_asset_refs_with_metadata(
    value: &Value,
    attachment_index: &HashMap<String, AssetMetadata>,
) -> Vec<AssetRef> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    scan_asset_refs(value, attachment_index, &mut refs, &mut seen);
    refs
}

pub fn extract_message_parts_from_pair(content: &Value, metadata: &Value) -> Vec<MessagePart> {
    let attachment_index = attachment_index(metadata);
    if let Some(parts) = content.get("parts").and_then(Value::as_array) {
        return parts
            .iter()
            .filter_map(|part| part_to_message_part(part, &attachment_index, metadata))
            .collect();
    }

    let raw_text = extract_message_text(content);
    let cleaned = clean_message_text(&raw_text, metadata);
    if cleaned.trim().is_empty() {
        Vec::new()
    } else {
        vec![text_message_part(cleaned)]
    }
}

fn derive_message_text(parts: &[MessagePart], content: &Value, metadata: &Value) -> String {
    let text_from_parts: String = parts
        .iter()
        .filter(|part| part.part_type == "text")
        .filter_map(|part| part.text.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !text_from_parts.is_empty() {
        return text_from_parts;
    }
    let raw_text = extract_message_text(content);
    clean_message_text(&raw_text, metadata).trim().to_string()
}

fn normalize_node(node: &NodeValue) -> Option<ConversationMessage> {
    let message = node.value.get("message")?;
    let role = message
        .pointer("/author/role")
        .or_else(|| message.pointer("/author/name"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let content = &message["content"];
    let metadata = &message["metadata"];
    let content_type = message
        .pointer("/content/content_type")
        .and_then(Value::as_str)
        .map(str::to_string);

    if should_skip_before_cleaning(message, &role, content_type.as_deref()) {
        return None;
    }

    let asset_refs = extract_asset_refs_from_pair(content, metadata);
    let parts = extract_message_parts_from_pair(content, metadata);
    let text = derive_message_text(&parts, content, metadata);

    if should_skip_message_node(
        message,
        &role,
        content_type.as_deref(),
        &text,
        &parts,
        &asset_refs,
    ) {
        return None;
    }

    Some(ConversationMessage {
        id: message
            .get("id")
            .or_else(|| node.value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(&node.id)
            .to_string(),
        node_id: node.id.clone(),
        ordinal: 0,
        role: role.clone(),
        author: message
            .pointer("/author/name")
            .and_then(Value::as_str)
            .unwrap_or(&role)
            .to_string(),
        created_at: to_iso_time(
            message
                .get("create_time")
                .or_else(|| message.get("created_at"))
                .unwrap_or(&Value::Null),
        ),
        content_type,
        text,
        asset_refs,
        parts,
    })
}

fn should_skip_before_cleaning(
    message: &Value,
    role: &str,
    content_type: Option<&str>,
) -> bool {
    if message
        .pointer("/metadata/is_visually_hidden_from_conversation")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    if matches!(content_type, Some("thoughts" | "reasoning_recap")) {
        return true;
    }
    if role == "assistant" && content_type == Some("code") {
        return true;
    }
    if role == "system"
        && matches!(
            content_type,
            Some("user_editable_context" | "model_editable_context")
        )
    {
        return true;
    }
    if message
        .get("channel")
        .and_then(Value::as_str)
        .is_some_and(|channel| !channel.is_empty() && channel != "final")
    {
        return true;
    }
    if message
        .get("recipient")
        .and_then(Value::as_str)
        .is_some_and(|recipient| !recipient.is_empty() && recipient != "all")
    {
        return true;
    }
    false
}

fn should_skip_message_node(
    message: &Value,
    role: &str,
    content_type: Option<&str>,
    text: &str,
    parts: &[MessagePart],
    asset_refs: &[AssetRef],
) -> bool {
    if should_skip_before_cleaning(message, role, content_type) {
        return true;
    }
    text.trim().is_empty() && parts.is_empty() && asset_refs.is_empty()
}

#[derive(Clone)]
struct NodeValue {
    id: String,
    value: Value,
}

fn get_ordered_nodes(conversation: &Value) -> Vec<NodeValue> {
    let Some(mapping) = conversation.get("mapping").and_then(Value::as_object) else {
        return vec![];
    };
    let by_id: HashMap<String, NodeValue> = mapping
        .iter()
        .map(|(id, value)| {
            let mut node = value.clone();
            if let Some(object) = node.as_object_mut() {
                object
                    .entry("id")
                    .or_insert_with(|| Value::String(id.clone()));
            }
            (
                id.clone(),
                NodeValue {
                    id: id.clone(),
                    value: node,
                },
            )
        })
        .collect();

    if let Some(current_id) = conversation.get("current_node").and_then(Value::as_str) {
        if let Some(current) = by_id.get(current_id) {
            let mut chain = Vec::new();
            let mut seen = HashSet::new();
            let mut node = Some(current.clone());
            while let Some(item) = node {
                if !seen.insert(item.id.clone()) {
                    break;
                }
                chain.push(item.clone());
                node = item
                    .value
                    .get("parent")
                    .and_then(Value::as_str)
                    .and_then(|parent| by_id.get(parent))
                    .cloned();
            }
            chain.reverse();
            let ordered: Vec<_> = chain
                .into_iter()
                .filter(|item| item.value.get("message").is_some())
                .collect();
            if !ordered.is_empty() {
                return ordered;
            }
        }
    }

    let mut roots: Vec<_> = by_id
        .values()
        .filter(|node| {
            node.value
                .get("parent")
                .and_then(Value::as_str)
                .map(|parent| !by_id.contains_key(parent))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    roots.sort_by(compare_nodes);

    let children = derive_children_by_parent(&by_id);
    let mut visited = HashSet::new();
    let mut ordered = Vec::new();
    let roots = if roots.is_empty() {
        let mut values: Vec<_> = by_id.values().cloned().collect();
        values.sort_by(compare_nodes);
        values
    } else {
        roots
    };
    for root in roots {
        walk(&root, &by_id, &children, &mut visited, &mut ordered);
    }
    if ordered.is_empty() {
        let mut values: Vec<_> = by_id
            .values()
            .filter(|node| node.value.get("message").is_some())
            .cloned()
            .collect();
        values.sort_by(compare_nodes);
        values
    } else {
        ordered
    }
}

fn derive_children_by_parent(by_id: &HashMap<String, NodeValue>) -> HashMap<String, Vec<String>> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for node in by_id.values() {
        let Some(parent) = node.value.get("parent").and_then(Value::as_str) else {
            continue;
        };
        if by_id.contains_key(parent) {
            children
                .entry(parent.to_string())
                .or_default()
                .push(node.id.clone());
        }
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| {
            compare_nodes(by_id.get(left).unwrap(), by_id.get(right).unwrap())
        });
    }
    children
}

fn walk(
    node: &NodeValue,
    by_id: &HashMap<String, NodeValue>,
    derived_children: &HashMap<String, Vec<String>>,
    visited: &mut HashSet<String>,
    ordered: &mut Vec<NodeValue>,
) {
    if !visited.insert(node.id.clone()) {
        return;
    }
    if node.value.get("message").is_some() {
        ordered.push(node.clone());
    }
    for child_id in child_ids_for(node, derived_children) {
        if let Some(child) = by_id.get(&child_id) {
            walk(child, by_id, derived_children, visited, ordered);
        }
    }
}

fn child_ids_for(node: &NodeValue, derived_children: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    if let Some(children) = node.value.get("children").and_then(Value::as_array) {
        for child in children.iter().filter_map(Value::as_str) {
            if seen.insert(child.to_string()) {
                merged.push(child.to_string());
            }
        }
    }
    if let Some(children) = derived_children.get(&node.id) {
        for child in children {
            if seen.insert(child.to_string()) {
                merged.push(child.to_string());
            }
        }
    }
    merged
}

fn compare_nodes(left: &NodeValue, right: &NodeValue) -> std::cmp::Ordering {
    message_time(&left.value)
        .partial_cmp(&message_time(&right.value))
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn message_time(node: &Value) -> f64 {
    node.pointer("/message/create_time")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn part_to_text(part: &Value) -> String {
    if let Some(text) = part.as_str() {
        return text.to_string();
    }
    for key in ["text", "transcript", "caption"] {
        if let Some(text) = part.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

#[derive(Clone, Default)]
struct AssetMetadata {
    name: Option<String>,
    mime_type: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

fn text_message_part(text: String) -> MessagePart {
    MessagePart {
        part_type: "text".to_string(),
        text: Some(text),
        file_id: None,
        name: None,
        mime_type: None,
        width: None,
        height: None,
        exists: None,
    }
}

fn part_to_message_part(
    part: &Value,
    attachment_index: &HashMap<String, AssetMetadata>,
    metadata: &Value,
) -> Option<MessagePart> {
    if let Some(object) = part.as_object() {
        if is_asset_like_object(object) {
            if let Some(asset) = asset_ref_from_object(object, attachment_index) {
                let asset_meta = attachment_index.get(&asset.file_id);
                let mime_type = asset.mime_type.clone();
                let part_type = if is_image_part(object, mime_type.as_deref()) {
                    "image"
                } else {
                    "file"
                };
                return Some(MessagePart {
                    part_type: part_type.to_string(),
                    text: None,
                    file_id: Some(asset.file_id.clone()),
                    name: asset.name,
                    mime_type,
                    width: numeric_u32_field(object, &["width"])
                        .or_else(|| asset_meta.and_then(|item| item.width)),
                    height: numeric_u32_field(object, &["height"])
                        .or_else(|| asset_meta.and_then(|item| item.height)),
                    exists: None,
                });
            }
        }
    }

    let raw_text = part_to_text(part);
    let cleaned = clean_message_text(&raw_text, metadata);
    (!cleaned.trim().is_empty()).then(|| text_message_part(cleaned))
}

fn attachment_index(metadata: &Value) -> HashMap<String, AssetMetadata> {
    let mut index = HashMap::new();
    let Some(attachments) = metadata.get("attachments").and_then(Value::as_array) else {
        return index;
    };
    for attachment in attachments {
        let Some(object) = attachment.as_object() else {
            continue;
        };
        let Some(file_id) = file_id_from_object(object) else {
            continue;
        };
        index.insert(
            file_id,
            AssetMetadata {
                name: string_field(object, &["name", "file_name", "filename"]),
                mime_type: string_field(object, &["mime_type", "mimeType"]),
                width: numeric_u32_field(object, &["width"]),
                height: numeric_u32_field(object, &["height"]),
            },
        );
    }
    index
}

fn scan_asset_refs(
    value: &Value,
    attachment_index: &HashMap<String, AssetMetadata>,
    refs: &mut Vec<AssetRef>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                scan_asset_refs(item, attachment_index, refs, seen);
            }
        }
        Value::Object(object) => {
            if is_asset_like_object(object) {
                add_asset_ref(object, attachment_index, refs, seen);
            }
            for (key, child) in object {
                if matches!(key.as_str(), "text" | "prompt" | "title") {
                    continue;
                }
                scan_asset_refs(child, attachment_index, refs, seen);
            }
        }
        _ => {}
    }
}

fn add_asset_ref(
    object: &Map<String, Value>,
    attachment_index: &HashMap<String, AssetMetadata>,
    refs: &mut Vec<AssetRef>,
    seen: &mut HashSet<String>,
) {
    let Some(asset) = asset_ref_from_object(object, attachment_index) else {
        return;
    };
    if !seen.insert(asset.file_id.clone()) {
        return;
    }
    refs.push(asset);
}

fn asset_ref_from_object(
    object: &Map<String, Value>,
    attachment_index: &HashMap<String, AssetMetadata>,
) -> Option<AssetRef> {
    let file_id = file_id_from_object(object)?;
    let metadata = attachment_index.get(&file_id);
    Some(AssetRef {
        file_id,
        name: string_field(object, &["name", "file_name", "filename"])
            .or_else(|| metadata.and_then(|item| item.name.clone())),
        mime_type: string_field(object, &["mime_type", "mimeType"])
            .or_else(|| metadata.and_then(|item| item.mime_type.clone())),
    })
}

fn file_id_from_object(object: &Map<String, Value>) -> Option<String> {
    ["file_id", "fileId", "id", "asset_pointer", "assetPointer"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .and_then(normalize_file_id)
}

fn is_asset_like_object(object: &Map<String, Value>) -> bool {
    object.contains_key("file_id")
        || object.contains_key("fileId")
        || object.contains_key("asset_pointer")
        || object.contains_key("assetPointer")
        || (object.contains_key("id")
            && (object.contains_key("mime_type")
                || object.contains_key("mimeType")
                || object.contains_key("library_file_id")
                || object.contains_key("source")
                || (object.contains_key("width") && object.contains_key("height"))))
}

fn is_image_part(object: &Map<String, Value>, mime_type: Option<&str>) -> bool {
    object
        .get("content_type")
        .and_then(Value::as_str)
        .is_some_and(|content_type| content_type.contains("image"))
        || mime_type.is_some_and(|mime| mime.starts_with("image/"))
}

fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find_map(|value| match value {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn numeric_u32_field(object: &Map<String, Value>, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .filter_map(|key| object.get(*key))
        .find_map(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
}

fn normalize_file_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    if without_scheme.is_empty() {
        return None;
    }
    if let Some(index) = without_scheme
        .find("file-")
        .or_else(|| without_scheme.find("file_"))
    {
        let tail = &without_scheme[index..];
        let id: String = tail
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
            .collect();
        if !id.is_empty() {
            return Some(id);
        }
    }
    Some(without_scheme.to_string())
}

pub fn normalize_group_chat(chat: &Value, fallback_id: &str) -> Conversation {
    let id = chat
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_id)
        .to_string();
    let title = chat
        .get("name")
        .or_else(|| chat.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Group chat")
        .to_string();
    let created_at = to_iso_time(chat.get("created_at").unwrap_or(&Value::Null));
    let updated_at = ["last_action_at", "updated_at", "created_at"]
        .iter()
        .find_map(|key| chat.get(*key).and_then(to_iso_time));

    let raw_messages = chat
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let mut indexed_msgs: Vec<(usize, Option<String>, &Value)> = raw_messages
        .iter()
        .enumerate()
        .map(|(orig_idx, msg)| {
            let ts = to_iso_time(msg.get("created_at").unwrap_or(&Value::Null));
            (orig_idx, ts, msg)
        })
        .collect();
    indexed_msgs.sort_by(|left, right| match (&left.1, &right.1) {
        (Some(lt), Some(rt)) => lt.cmp(rt).then_with(|| right.0.cmp(&left.0)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => right.0.cmp(&left.0),
    });

    let empty_meta = Value::Null;
    let mut messages = Vec::new();
    for (orig_idx, created, msg) in indexed_msgs {
        let role = msg
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        let raw_text = msg
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = clean_message_text(raw_text, &empty_meta);
        let asset_refs: Vec<AssetRef> = msg
            .get("attachments")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|att| {
                        let obj = att.as_object()?;
                        let file_id = ["target_id", "file_id", "id"]
                            .iter()
                            .find_map(|key| obj.get(*key).and_then(Value::as_str))
                            .filter(|s| !s.is_empty())?
                            .to_string();
                        let name = ["title", "name", "file_name"]
                            .iter()
                            .find_map(|key| obj.get(*key).and_then(Value::as_str))
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        let mime_type = ["mime_type", "mimeType"]
                            .iter()
                            .find_map(|key| obj.get(*key).and_then(Value::as_str))
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        Some(AssetRef {
                            file_id,
                            name,
                            mime_type,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        if text.trim().is_empty() && asset_refs.is_empty() {
            continue;
        }
        let msg_id = msg
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{id}-msg-{orig_idx}"));
        let parts = if text.trim().is_empty() {
            Vec::new()
        } else {
            vec![text_message_part(text.clone())]
        };
        messages.push(ConversationMessage {
            id: msg_id.clone(),
            node_id: msg_id,
            ordinal: messages.len() + 1,
            role: role.clone(),
            author: role,
            created_at: created,
            content_type: Some("text".to_string()),
            text,
            asset_refs,
            parts,
        });
    }

    Conversation {
        id,
        title,
        created_at,
        updated_at,
        model: Some("group-chat".to_string()),
        archived: false,
        starred: false,
        kind: "group_chat".to_string(),
        project_id: None,
        gizmo_id: None,
        memory_scope: None,
        total_messages: messages.len(),
        messages,
        range: None,
    }
}

pub fn normalize_codex_task(task: &Value, fallback_id: &str) -> Conversation {
    let id = task
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_id)
        .to_string();
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Codex task")
        .to_string();
    let archived = task
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let turns = task
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let empty_meta = Value::Null;
    let mut messages = Vec::new();
    for (idx, turn) in turns.iter().enumerate() {
        let role = turn
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .to_string();

        let mut text_blocks = Vec::new();
        if let Some(input_items) = turn.get("input_items").and_then(Value::as_array) {
            for item in input_items {
                let extracted = extract_codex_content_text(item.get("content"));
                if !extracted.trim().is_empty() {
                    text_blocks.push(extracted);
                }
            }
        }
        if let Some(output_items) = turn.get("output_items").and_then(Value::as_array) {
            for item in output_items {
                if item.get("type").and_then(Value::as_str) == Some("message") {
                    let extracted = extract_codex_content_text(item.get("content"));
                    if !extracted.trim().is_empty() {
                        text_blocks.push(extracted);
                    }
                }
            }
            if text_blocks.is_empty() {
                for item in output_items {
                    if let Some(commit) = item
                        .pointer("/output_diff/commit_message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        text_blocks.push(commit.to_string());
                    }
                }
            }
        }

        let joined = text_blocks.join("\n\n");
        let text = clean_message_text(&joined, &empty_meta);
        if text.trim().is_empty() {
            continue;
        }
        let turn_id = turn
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{id}-turn-{idx}"));
        let parts = vec![text_message_part(text.clone())];
        messages.push(ConversationMessage {
            id: turn_id.clone(),
            node_id: turn_id,
            ordinal: messages.len() + 1,
            role: role.clone(),
            author: role,
            created_at: None,
            content_type: Some("text".to_string()),
            text,
            asset_refs: Vec::new(),
            parts,
        });
    }

    Conversation {
        id,
        title,
        created_at: None,
        updated_at: None,
        model: Some("codex".to_string()),
        archived,
        starred: false,
        kind: "codex".to_string(),
        project_id: None,
        gizmo_id: None,
        memory_scope: None,
        total_messages: messages.len(),
        messages,
        range: None,
    }
}

fn extract_codex_content_text(content: Option<&Value>) -> String {
    let Some(items) = content.and_then(Value::as_array) else {
        return String::new();
    };
    let mut out = String::new();
    for item in items {
        if item.get("content_type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                out.push_str(text);
            }
        }
    }
    out
}
