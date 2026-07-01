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
pub struct MessagePart {
    pub part_type: String,
    pub text: Option<String>,
    pub file_id: Option<String>,
    pub name: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
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
    #[serde(default)]
    pub asset_refs: Vec<AssetRef>,
    #[serde(default)]
    pub parts: Vec<MessagePart>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub file_id: String,
    pub display_name: String,
    pub filename: String,
    pub original_name: Option<String>,
    pub mime: String,
    pub size_bytes: u64,
    pub size_label: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: Option<String>,
    pub status: String,
    pub file_ref: String,
    pub exists: bool,
    pub source_conversation_id: Option<String>,
    pub source_message_id: Option<String>,
    pub source_state: String,
    pub in_chat: bool,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total_images: usize,
    pub linked_images: usize,
    pub library_only_images: usize,
    pub missing_source_images: usize,
    pub missing_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndex {
    pub items: Vec<LibraryItem>,
    pub stats: LibraryStats,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAsset {
    pub file_id: String,
    pub file_path: PathBuf,
    pub file_name: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicExport {
    pub id: String,
    pub name: String,
    pub modified_at: String,
    pub has_conversations: bool,
    pub has_library_files: bool,
    pub has_asset_names: bool,
    pub warnings: Vec<String>,
}

impl From<&ExportItem> for PublicExport {
    fn from(value: &ExportItem) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            modified_at: value.modified_at.clone(),
            has_conversations: value.has_conversations,
            has_library_files: value.has_library_files,
            has_asset_names: value.has_asset_names,
            warnings: value.warnings.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub source_root: Option<PathBuf>,
    pub cache_dir: PathBuf,
    pub export_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    pub settings: PublicSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportsResponse {
    pub exports: Vec<PublicExport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsResponse {
    pub settings: PublicSettings,
    pub exports: Vec<PublicExport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub hit: bool,
    pub dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatsResponse {
    pub export: PublicExport,
    pub conversations: ConversationStats,
    pub library: LibraryStats,
    pub cache: CacheStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PagedResponse<T, S> {
    pub export: PublicExport,
    pub items: Vec<T>,
    pub page: Page,
    pub stats: S,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResponseItem {
    #[serde(flatten)]
    pub item: LibraryItem,
    pub asset_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshIndexItem {
    pub export_id: String,
    pub cache_hit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshIndexResponse {
    pub indexed: Vec<RefreshIndexItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedSessionItem {
    pub conversation_id: String,
    pub title: String,
    pub path: PathBuf,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionsProgress {
    pub export_id: String,
    pub total: usize,
    pub completed: usize,
    pub current_conversation_id: Option<String>,
    pub current_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionsResponse {
    pub export: PublicExport,
    pub destination_dir: PathBuf,
    pub items: Vec<SavedSessionItem>,
    pub progress: SaveSessionsProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenFolderResponse {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveOriginalImageResponse {
    pub file_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub path: Option<PathBuf>,
    pub bytes_written: u64,
    pub canceled: bool,
}
