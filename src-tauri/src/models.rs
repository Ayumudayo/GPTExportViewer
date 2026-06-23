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
