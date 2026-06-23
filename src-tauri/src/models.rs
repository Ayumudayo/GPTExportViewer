use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub cursor: usize,
    pub limit: usize,
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PagedItems<T> {
    pub items: Vec<T>,
    pub page: Page,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportPaths {
    pub root: PathBuf,
    pub conversations: PathBuf,
    pub library_files: PathBuf,
    pub asset_names: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub paths: ExportPaths,
    pub modified_at: String,
    pub modified_at_ms: u128,
    pub has_conversations: bool,
    pub has_library_files: bool,
    pub has_asset_names: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub file_id: String,
    pub name: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub id: String,
    pub node_id: String,
    pub ordinal: usize,
    pub role: String,
    pub author: String,
    pub created_at: Option<String>,
    pub content_type: Option<String>,
    pub text: String,
    pub asset_refs: Vec<AssetRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub model: Option<String>,
    pub archived: bool,
    pub starred: bool,
    pub total_messages: usize,
    pub messages: Vec<ConversationMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<MessageRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageRange {
    pub start: usize,
    pub limit: usize,
    pub total: usize,
    pub next_start: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub message_count: usize,
    pub attachment_count: usize,
    pub model: Option<String>,
    pub archived: bool,
    pub starred: bool,
    pub preview: String,
    pub last_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStats {
    pub total_conversations: usize,
    pub total_messages: usize,
    pub total_attachments: usize,
    pub archived: usize,
    pub starred: usize,
    pub max_messages: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationIndex {
    pub items: Vec<ConversationSummary>,
    pub stats: ConversationStats,
    pub generated_at: String,
}
