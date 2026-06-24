use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::cache::{export_fingerprint, read_json, write_json_atomic, ExportFingerprint};
use crate::conversations::{
    load::load_conversation, save::save_original_sessions,
    summary_index::build_conversation_summary_index,
};
use crate::errors::{io_error, AppError, AppResult};
use crate::exports::scan_exports;
use crate::library::{assets::resolve_asset, index::build_library_index};
use crate::models::{
    CacheStatus, Conversation, ConversationIndex, ConversationStats, ConversationSummary,
    ExportItem, ExportsResponse, LibraryIndex, LibraryResponseItem, LibraryStats, PagedResponse,
    PublicExport, PublicSettings, RefreshIndexItem, RefreshIndexResponse, SaveSessionsProgress,
    SaveSessionsResponse, SettingsResponse, StatsResponse, UpdateSettingsResponse,
};
use crate::paging::page_items;
use crate::settings::{
    read_runtime_settings, resolve_source_root, write_runtime_settings, RuntimeSettings,
};

#[derive(Debug, Clone)]
pub struct AppState {
    inner: Arc<Mutex<StateInner>>,
}

#[derive(Debug)]
struct StateInner {
    source_root: Option<PathBuf>,
    cache_dir: PathBuf,
    saved_sessions_dir: PathBuf,
    settings_file: PathBuf,
    exports: Vec<ExportItem>,
    indexes: HashMap<String, IndexedExport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CacheMeta {
    version: u8,
    export_id: String,
    export_path: PathBuf,
    generated_at: String,
    fingerprint: ExportFingerprint,
}

#[derive(Debug, Clone)]
struct IndexedExport {
    conversation_index: ConversationIndex,
    library_index: LibraryIndex,
    cache: CacheStatus,
}

#[derive(Debug, Clone)]
pub struct AssetPayload {
    pub file_name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

impl AppState {
    pub fn new(app_name: &str, default_source_root: Option<PathBuf>) -> AppResult<Self> {
        let app_data_dir = crate::settings::ensure_app_data_dir(app_name)?;
        Self::new_with_app_data(&app_data_dir, default_source_root)
    }

    pub fn new_with_app_data(
        app_data_dir: &Path,
        default_source_root: Option<PathBuf>,
    ) -> AppResult<Self> {
        std::fs::create_dir_all(app_data_dir).map_err(|error| io_error(app_data_dir, error))?;
        let cache_dir = app_data_dir.join("cache");
        std::fs::create_dir_all(&cache_dir).map_err(|error| io_error(&cache_dir, error))?;
        let saved_sessions_dir = app_data_dir.join("Saved Sessions");
        let settings_file = app_data_dir.join("settings.json");
        let settings = read_runtime_settings(&settings_file)?;
        let source_root = choose_source_root(settings.source_root, default_source_root);
        let exports = match &source_root {
            Some(root) => scan_exports(root)?,
            None => Vec::new(),
        };

        Ok(Self {
            inner: Arc::new(Mutex::new(StateInner {
                source_root,
                cache_dir,
                saved_sessions_dir,
                settings_file,
                exports,
                indexes: HashMap::new(),
            })),
        })
    }

    pub fn get_settings_response(&self) -> AppResult<SettingsResponse> {
        let inner = self.lock()?;
        Ok(SettingsResponse {
            settings: public_settings(&inner),
        })
    }

    pub fn get_exports_response(&self) -> AppResult<ExportsResponse> {
        let inner = self.lock()?;
        Ok(ExportsResponse {
            exports: public_exports(&inner.exports),
        })
    }

    pub fn update_settings_response(
        &self,
        source_root: String,
    ) -> AppResult<UpdateSettingsResponse> {
        let trimmed = source_root.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidSourceRoot("empty source root".to_string()));
        }
        let resolved_root = resolve_source_root(Path::new(trimmed))?;
        let exports = scan_exports(&resolved_root)?;

        let mut inner = self.lock()?;
        write_runtime_settings(
            &inner.settings_file,
            &RuntimeSettings {
                source_root: Some(resolved_root.clone()),
            },
        )?;
        inner.source_root = Some(resolved_root);
        inner.exports = exports;
        inner.indexes.clear();

        Ok(UpdateSettingsResponse {
            settings: public_settings(&inner),
            exports: public_exports(&inner.exports),
        })
    }

    pub fn get_stats_response(&self, export_id: Option<String>) -> AppResult<StatsResponse> {
        let mut inner = self.lock()?;
        let export = requested_export(&inner, export_id)?;
        let indexed = ensure_index_locked(&mut inner, &export.id, false)?;
        Ok(StatsResponse {
            export: PublicExport::from(&export),
            conversations: indexed.conversation_index.stats,
            library: indexed.library_index.stats,
            cache: indexed.cache,
        })
    }

    pub fn get_conversations_response(
        &self,
        export_id: Option<String>,
        query: Option<String>,
        filter: Option<String>,
        cursor: Option<usize>,
        limit: Option<usize>,
    ) -> AppResult<PagedResponse<ConversationSummary, ConversationStats>> {
        let mut inner = self.lock()?;
        let export = requested_export(&inner, export_id)?;
        let indexed = ensure_index_locked(&mut inner, &export.id, false)?;
        let filtered = filter_conversations(
            &indexed.conversation_index.items,
            query.as_deref(),
            filter.as_deref(),
        );
        let page = page_items(&filtered, cursor.unwrap_or(0), limit.unwrap_or(30), 100);
        Ok(PagedResponse {
            export: PublicExport::from(&export),
            items: page.items,
            page: page.page,
            stats: indexed.conversation_index.stats,
        })
    }

    pub fn get_library_response(
        &self,
        export_id: Option<String>,
        query: Option<String>,
        filter: Option<String>,
        cursor: Option<usize>,
        limit: Option<usize>,
    ) -> AppResult<PagedResponse<LibraryResponseItem, LibraryStats>> {
        let mut inner = self.lock()?;
        let export = requested_export(&inner, export_id)?;
        let indexed = ensure_index_locked(&mut inner, &export.id, false)?;
        let filtered = filter_library(
            &indexed.library_index.items,
            query.as_deref(),
            filter.as_deref(),
        );
        let with_urls: Vec<_> = filtered
            .into_iter()
            .map(|item| LibraryResponseItem {
                asset_url: asset_url(&export.id, &item.file_id),
                item,
            })
            .collect();
        let page = page_items(&with_urls, cursor.unwrap_or(0), limit.unwrap_or(60), 120);
        Ok(PagedResponse {
            export: PublicExport::from(&export),
            items: page.items,
            page: page.page,
            stats: indexed.library_index.stats,
        })
    }

    pub fn get_conversation_response(
        &self,
        export_id: Option<String>,
        conversation_id: String,
        start: Option<usize>,
        limit: Option<usize>,
    ) -> AppResult<Conversation> {
        let inner = self.lock()?;
        let export = requested_export(&inner, export_id)?;
        let cache_dir = inner.cache_dir.clone();
        drop(inner);
        load_conversation(
            &export,
            &conversation_id,
            &cache_dir,
            start.unwrap_or(0),
            limit.unwrap_or(100),
        )?
        .ok_or(AppError::ConversationNotFound)
    }

    pub fn refresh_index_response(
        &self,
        export_id: Option<String>,
    ) -> AppResult<RefreshIndexResponse> {
        let mut inner = self.lock()?;
        let targets = if let Some(export_id) = export_id {
            vec![requested_export(&inner, Some(export_id))?]
        } else {
            inner.exports.clone()
        };
        let mut indexed = Vec::new();
        for export in targets {
            let refreshed = ensure_index_locked(&mut inner, &export.id, true)?;
            indexed.push(RefreshIndexItem {
                export_id: export.id,
                cache_hit: refreshed.cache.hit,
            });
        }
        Ok(RefreshIndexResponse { indexed })
    }

    pub fn save_sessions_response(
        &self,
        export_id: Option<String>,
        conversation_ids: Vec<String>,
        mut on_progress: impl FnMut(SaveSessionsProgress),
    ) -> AppResult<SaveSessionsResponse> {
        let inner = self.lock()?;
        let export = requested_export(&inner, export_id)?;
        let public_export = PublicExport::from(&export);
        let destination_dir = inner.saved_sessions_dir.join(&export.id);
        drop(inner);

        let mut progress = SaveSessionsProgress {
            export_id: public_export.id.clone(),
            total: conversation_ids.len(),
            completed: 0,
            current_conversation_id: None,
            current_title: None,
        };
        let items = save_original_sessions(&export, &destination_dir, &conversation_ids, |item| {
            progress = item.clone();
            on_progress(item);
        })?;

        Ok(SaveSessionsResponse {
            export: public_export,
            destination_dir,
            items,
            progress,
        })
    }

    pub fn saved_sessions_dir_for_export(&self, export_id: Option<String>) -> AppResult<PathBuf> {
        let inner = self.lock()?;
        let export = requested_export(&inner, export_id)?;
        let destination_dir = inner.saved_sessions_dir.join(&export.id);
        drop(inner);

        std::fs::create_dir_all(&destination_dir)
            .map_err(|error| io_error(&destination_dir, error))?;
        Ok(destination_dir)
    }

    pub fn read_asset_payload(&self, export_id: &str, file_id: &str) -> AppResult<AssetPayload> {
        let mut inner = self.lock()?;
        let export = requested_export(&inner, Some(export_id.to_string()))?;
        let indexed = ensure_index_locked(&mut inner, &export.id, false)?;
        let resolved = resolve_asset(&export, file_id, &indexed.library_index.items)?;
        drop(inner);

        let bytes = std::fs::read(&resolved.file_path)
            .map_err(|error| io_error(&resolved.file_path, error))?;
        Ok(AssetPayload {
            file_name: resolved.file_name,
            mime_type: resolved.mime_type,
            bytes,
        })
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, StateInner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::CacheUnavailable("state lock poisoned".to_string()))
    }
}

fn choose_source_root(
    saved: Option<PathBuf>,
    default_source_root: Option<PathBuf>,
) -> Option<PathBuf> {
    [saved, default_source_root]
        .into_iter()
        .flatten()
        .find_map(|candidate| resolve_source_root(&candidate).ok())
}

fn requested_export(inner: &StateInner, export_id: Option<String>) -> AppResult<ExportItem> {
    let requested_id = export_id.or_else(|| inner.exports.first().map(|item| item.id.clone()));
    let Some(requested_id) = requested_id else {
        return Err(AppError::ExportNotFound);
    };
    inner
        .exports
        .iter()
        .find(|item| item.id == requested_id)
        .cloned()
        .ok_or(AppError::ExportNotFound)
}

fn ensure_index_locked(
    inner: &mut StateInner,
    export_id: &str,
    force: bool,
) -> AppResult<IndexedExport> {
    if !force {
        if let Some(indexed) = inner.indexes.get(export_id) {
            return Ok(indexed.clone());
        }
    }

    let export = requested_export(inner, Some(export_id.to_string()))?;
    let indexed = index_export(&export, &inner.cache_dir, force)?;
    inner.indexes.insert(export_id.to_string(), indexed.clone());
    Ok(indexed)
}

fn index_export(export: &ExportItem, cache_dir: &Path, force: bool) -> AppResult<IndexedExport> {
    let export_cache_dir = cache_dir.join(&export.id);
    let meta_file = export_cache_dir.join("meta.json");
    let conversations_file = export_cache_dir.join("conversation-summaries.json");
    let library_file = export_cache_dir.join("library-images.json");
    let fingerprint = export_fingerprint(export)?;

    if !force {
        if let Some(meta) = read_json::<CacheMeta>(&meta_file)? {
            if meta.version == 1 && meta.export_id == export.id && meta.fingerprint == fingerprint {
                let conversation_index = read_json::<ConversationIndex>(&conversations_file)?;
                let library_index = read_json::<LibraryIndex>(&library_file)?;
                if let (Some(conversation_index), Some(library_index)) =
                    (conversation_index, library_index)
                {
                    return Ok(IndexedExport {
                        conversation_index,
                        library_index,
                        cache: CacheStatus {
                            hit: true,
                            dir: export_cache_dir,
                        },
                    });
                }
            }
        }
    }

    let conversation_index = build_conversation_summary_index(export)?;
    let conversation_ids: HashSet<_> = conversation_index
        .items
        .iter()
        .map(|item| item.id.clone())
        .collect();
    let library_index = build_library_index(export, &conversation_ids)?;
    write_json_atomic(&conversations_file, &conversation_index)?;
    write_json_atomic(&library_file, &library_index)?;
    write_json_atomic(
        &meta_file,
        &CacheMeta {
            version: 1,
            export_id: export.id.clone(),
            export_path: export.path.clone(),
            generated_at: crate::time::generated_at(),
            fingerprint,
        },
    )?;

    Ok(IndexedExport {
        conversation_index,
        library_index,
        cache: CacheStatus {
            hit: false,
            dir: export_cache_dir,
        },
    })
}

fn public_settings(inner: &StateInner) -> PublicSettings {
    PublicSettings {
        source_root: inner.source_root.clone(),
        cache_dir: inner.cache_dir.clone(),
        export_count: inner.exports.len(),
    }
}

fn public_exports(exports: &[ExportItem]) -> Vec<PublicExport> {
    exports.iter().map(PublicExport::from).collect()
}

fn filter_conversations(
    items: &[ConversationSummary],
    query: Option<&str>,
    filter: Option<&str>,
) -> Vec<ConversationSummary> {
    let query = normalized_query(query);
    let filter = filter.unwrap_or("all");
    items
        .iter()
        .filter(|item| {
            if filter == "archived" && !item.archived {
                return false;
            }
            if filter == "active" && item.archived {
                return false;
            }
            let Some(query) = query.as_deref() else {
                return true;
            };
            [
                Some(item.title.as_str()),
                Some(item.preview.as_str()),
                item.model.as_deref(),
                Some(item.id.as_str()),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_ascii_lowercase().contains(query))
        })
        .cloned()
        .collect()
}

fn filter_library(
    items: &[crate::models::LibraryItem],
    query: Option<&str>,
    filter: Option<&str>,
) -> Vec<crate::models::LibraryItem> {
    let query = normalized_query(query);
    let filter = filter.unwrap_or("all");
    items
        .iter()
        .filter(|item| {
            if filter != "all" && item.source_state != filter {
                return false;
            }
            let Some(query) = query.as_deref() else {
                return true;
            };
            [
                Some(item.display_name.as_str()),
                Some(item.mime.as_str()),
                Some(item.file_id.as_str()),
                item.source_conversation_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_ascii_lowercase().contains(query))
        })
        .cloned()
        .collect()
}

fn normalized_query(query: Option<&str>) -> Option<String> {
    query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn asset_url(export_id: &str, file_id: &str) -> String {
    format!(
        "gpt-export-asset://library/{}/{}",
        percent_encoding::utf8_percent_encode(export_id, percent_encoding::NON_ALPHANUMERIC),
        percent_encoding::utf8_percent_encode(file_id, percent_encoding::NON_ALPHANUMERIC)
    )
}
