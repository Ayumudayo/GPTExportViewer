use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::models::{AssetRef, Conversation, ConversationMessage};
use crate::time::to_iso_time;

pub fn normalize_conversation(conversation: &Value) -> crate::errors::AppResult<Conversation> {
    let ordered_nodes = get_ordered_nodes(conversation);
    let messages: Vec<_> = ordered_nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| normalize_node(node, index))
        .collect();
    Ok(Conversation {
        id: get_conversation_id(conversation, ""),
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
        total_messages: messages.len(),
        messages,
        range: None,
    })
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
    let mut wrapper = Map::new();
    wrapper.insert("content".to_string(), content.clone());
    wrapper.insert("metadata".to_string(), metadata.clone());
    extract_asset_refs(&Value::Object(wrapper))
}

pub fn extract_asset_refs(value: &Value) -> Vec<AssetRef> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    scan_asset_refs(value, &mut refs, &mut seen);
    refs
}

fn normalize_node(node: &NodeValue, index: usize) -> Option<ConversationMessage> {
    let message = node.value.get("message")?;
    let role = message
        .pointer("/author/role")
        .or_else(|| message.pointer("/author/name"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let text = extract_message_text(&message["content"]);
    Some(ConversationMessage {
        id: message
            .get("id")
            .or_else(|| node.value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(&node.id)
            .to_string(),
        node_id: node.id.clone(),
        ordinal: index + 1,
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
        content_type: message
            .pointer("/content/content_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        text,
        asset_refs: extract_asset_refs_from_pair(&message["content"], &message["metadata"]),
    })
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
                object.entry("id").or_insert_with(|| Value::String(id.clone()));
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
            children.entry(parent.to_string()).or_default().push(node.id.clone());
        }
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| compare_nodes(by_id.get(left).unwrap(), by_id.get(right).unwrap()));
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

fn scan_asset_refs(value: &Value, refs: &mut Vec<AssetRef>, seen: &mut HashSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                scan_asset_refs(item, refs, seen);
            }
        }
        Value::Object(object) => {
            if object.contains_key("file_id")
                || object.contains_key("fileId")
                || object.contains_key("asset_pointer")
                || object.contains_key("assetPointer")
            {
                add_asset_ref(object, refs, seen);
            }
            for (key, child) in object {
                if matches!(key.as_str(), "text" | "prompt" | "title") {
                    continue;
                }
                scan_asset_refs(child, refs, seen);
            }
        }
        _ => {}
    }
}

fn add_asset_ref(object: &Map<String, Value>, refs: &mut Vec<AssetRef>, seen: &mut HashSet<String>) {
    let file_id = ["file_id", "fileId", "id", "asset_pointer", "assetPointer"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .and_then(normalize_file_id);
    let Some(file_id) = file_id else {
        return;
    };
    let name = ["name", "file_name", "filename"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::to_string);
    let key = format!("{}:{}", file_id, name.clone().unwrap_or_default());
    if !seen.insert(key) {
        return;
    }
    refs.push(AssetRef {
        file_id,
        name,
        mime_type: ["mime_type", "mimeType"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str))
            .map(str::to_string),
    });
}

fn normalize_file_id(value: &str) -> Option<String> {
    if let Some(index) = value.find("file-").or_else(|| value.find("file_")) {
        let tail = &value[index..];
        let id: String = tail
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
            .collect();
        if !id.is_empty() {
            return Some(id);
        }
    }
    (!value.is_empty()).then(|| value.to_string())
}
