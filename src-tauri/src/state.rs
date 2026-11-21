use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::asset_protocol::asset_url;
use crate::conversations::{
    load::{load_conversation, read_conversation_from_jsonl, slice_conversation_page},
    save::save_original_sessions,
};
use crate::errors::{io_error, AppError, AppResult};
use crate::exports::scan_exports;
use crate::index_store::{index_export, ConversationLru, IndexedExport};
use crate::library::{
    assets::resolve_asset_for_item,
    export::{execute_image_export, plan_image_export, ImageExportPlan},
};
use crate::models::{
    Conversation, ConversationStats, ConversationSummary, ExportImagesProgress,
    ExportImagesResponse, ExportItem, ExportsResponse, LibraryResponseItem, LibraryStats,
    PagedResponse, PublicExport, PublicSettings, RefreshIndexItem, RefreshIndexResponse,
    RescanExportsResponse, ResolvedAsset, SaveOriginalImageResponse, SaveSessionsProgress,
    SaveSessionsResponse, SettingsResponse, StatsResponse, UpdateSettingsResponse, WindowSize,
};
use crate::paging::page_indices;
use crate::search::{
    collect_unique_project_ids, filter_conversation_indices_with_scope, filter_library_indices,
};
use crate::settings::{
    read_runtime_settings, resolve_source_root, write_runtime_settings, RuntimeSettings,
};

#[derive(Debug, Clone)]
pub struct AppState {
    inner: Arc<Mutex<StateInner>>,
    index_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    conversation_lru: Arc<Mutex<ConversationLru>>,
}

#[derive(Debug)]
struct StateInner {
    source_root: Option<PathBuf>,
    cache_dir: PathBuf,
    saved_sessions_dir: PathBuf,
    settings_file: PathBuf,
    exports: Vec<ExportItem>,
    indexes: HashMap<String, Arc<IndexedExport>>,
    selected_export_id: Option<String>,
    window_size: Option<WindowSize>,
    project_aliases: BTreeMap<String, String>,
    exported_image_dirs: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct AssetPayload {
    pub file_name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct OriginalImageMetadata {
    pub file_name: String,
    pub mime_type: String,
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
        let source_root = choose_source_root(settings.source_root.clone(), default_source_root);
        let exports = match &source_root {
            Some(root) => scan_exports(root)?,
            None => Vec::new(),
        };
        let selected_export_id = reconcile_selected_export(settings.selected_export_id, &exports);

        Ok(Self {
            inner: Arc::new(Mutex::new(StateInner {
                source_root,
                cache_dir,
                saved_sessions_dir,
                settings_file,
                exports,
                indexes: HashMap::new(),
                selected_export_id,
                window_size: settings.window_size,
                project_aliases: sanitize_project_aliases(settings.project_aliases),
                exported_image_dirs: Vec::new(),
            })),
            index_locks: Arc::new(Mutex::new(HashMap::new())),
            conversation_lru: Arc::new(Mutex::new(ConversationLru::default())),
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

        let response = {
            let mut inner = self.lock()?;
            inner.source_root = Some(resolved_root);
            inner.exports = exports;
            inner.indexes.clear();
            inner.selected_export_id =
                reconcile_selected_export(inner.selected_export_id.clone(), &inner.exports);
            persist_runtime_settings(&inner)?;

            UpdateSettingsResponse {
                settings: public_settings(&inner),
                exports: public_exports(&inner.exports),
            }
        };
        if let Ok(mut lru) = self.conversation_lru.lock() {
            lru.clear();
        }
        Ok(response)
    }

    pub fn rescan_exports_response(&self) -> AppResult<RescanExportsResponse> {
        let source_root = {
            let inner = self.lock()?;
            inner
                .source_root
                .clone()
                .ok_or_else(|| AppError::InvalidSourceRoot("source root not configured".to_string()))?
        };
        let scan_result = resolve_source_root(&source_root)
            .and_then(|resolved| scan_exports(&resolved).map(|exports| (resolved, exports)));
        let (resolved_root, exports) = match scan_result {
            Ok(result) => result,
            Err(error) => {
                {
                    let mut inner = self.lock()?;
                    inner.source_root = None;
                    inner.exports.clear();
                    inner.indexes.clear();
                    inner.selected_export_id = None;
                    persist_runtime_settings(&inner)?;
                }
                if let Ok(mut lru) = self.conversation_lru.lock() {
                    lru.clear();
                }
                return Err(error);
            }
        };

        let response = {
            let mut inner = self.lock()?;
            inner.source_root = Some(resolved_root);
            inner.exports = exports;
            inner.indexes.clear();
            inner.selected_export_id =
                reconcile_selected_export(inner.selected_export_id.clone(), &inner.exports);
            persist_runtime_settings(&inner)?;

            RescanExportsResponse {
                settings: public_settings(&inner),
                exports: public_exports(&inner.exports),
            }
        };
        if let Ok(mut lru) = self.conversation_lru.lock() {
            lru.clear();
        }
        Ok(response)
    }

    pub fn update_preferences_response(
        &self,
        selected_export_id: Option<String>,
        window_size: Option<WindowSize>,
    ) -> AppResult<SettingsResponse> {
        self.update_preferences_full_response(selected_export_id, window_size, None)
    }

    pub fn update_preferences_full_response(
        &self,
        selected_export_id: Option<String>,
        window_size: Option<WindowSize>,
        project_aliases: Option<BTreeMap<String, String>>,
    ) -> AppResult<SettingsResponse> {
        let mut inner = self.lock()?;
        if let Some(export_id) = selected_export_id {
            let trimmed = export_id.trim();
            if trimmed.is_empty() {
                inner.selected_export_id = None;
            } else if inner.exports.iter().any(|item| item.id == trimmed) {
                inner.selected_export_id = Some(trimmed.to_string());
            } else {
                return Err(AppError::ExportNotFound);
            }
        }
        if let Some(size) = valid_window_size(window_size) {
            inner.window_size = Some(size);
        }
        if let Some(updates) = project_aliases {
            for (raw_key, raw_value) in updates {
                let key = raw_key.trim();
                if key.is_empty() {
                    continue;
                }
                let cleaned: String = raw_value.trim().chars().take(80).collect();
                if cleaned.is_empty() {
                    inner.project_aliases.remove(key);
                } else {
                    inner.project_aliases.insert(key.to_string(), cleaned);
                }
            }
        }
        persist_runtime_settings(&inner)?;

        Ok(SettingsResponse {
            settings: public_settings(&inner),
        })
    }

    pub fn get_stats_response(&self, export_id: Option<String>) -> AppResult<StatsResponse> {
        let (export, indexed) = self.ensure_index(export_id, false)?;
        Ok(StatsResponse {
            export: PublicExport::from(&export),
            conversations: indexed.conversation_index.stats.clone(),
            library: indexed.library_index.stats.clone(),
            cache: indexed.cache.clone(),
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
        self.get_conversations_filtered_response(export_id, query, filter, None, None, cursor, limit)
    }

    pub fn get_conversations_filtered_response(
        &self,
        export_id: Option<String>,
        query: Option<String>,
        filter: Option<String>,
        scope: Option<String>,
        project_id: Option<String>,
        cursor: Option<usize>,
        limit: Option<usize>,
    ) -> AppResult<PagedResponse<ConversationSummary, ConversationStats>> {
        self.get_conversations_filtered_multi_response(
            export_id,
            query,
            filter,
            scope,
            project_id.map(|value| vec![value]),
            cursor,
            limit,
        )
    }

    pub fn get_conversations_filtered_multi_response(
        &self,
        export_id: Option<String>,
        query: Option<String>,
        filter: Option<String>,
        scope: Option<String>,
        project_ids: Option<Vec<String>>,
        cursor: Option<usize>,
        limit: Option<usize>,
    ) -> AppResult<PagedResponse<ConversationSummary, ConversationStats>> {
        let (export, indexed) = self.ensure_index(export_id, false)?;
        let project_aliases = {
            let inner = self.lock()?;
            inner.project_aliases.clone()
        };
        let normalized_project_ids = collect_unique_project_ids(None, project_ids.as_deref());
        let matching_indices = filter_conversation_indices_with_scope(
            &indexed.conversation_index.items,
            &indexed.conversation_search_list,
            query.as_deref(),
            filter.as_deref(),
            scope.as_deref(),
            &normalized_project_ids,
            &project_aliases,
        );
        let page = page_indices(
            &matching_indices,
            cursor.unwrap_or(0),
            limit.unwrap_or(30),
            100,
            |idx| indexed.conversation_index.items[idx].clone(),
        );
        Ok(PagedResponse {
            export: PublicExport::from(&export),
            items: page.items,
            page: page.page,
            stats: indexed.conversation_index.stats.clone(),
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
        let (export, indexed) = self.ensure_index(export_id, false)?;
        let matching_indices = filter_library_indices(
            &indexed.library_index.items,
            &indexed.library_search_texts,
            query.as_deref(),
            filter.as_deref(),
        );
        let page = page_indices(
            &matching_indices,
            cursor.unwrap_or(0),
            limit.unwrap_or(60),
            120,
            |idx| {
                let item = indexed.library_index.items[idx].clone();
                LibraryResponseItem {
                    asset_url: asset_url(&export.id, &item.file_id),
                    item,
                }
            },
        );
        Ok(PagedResponse {
            export: PublicExport::from(&export),
            items: page.items,
            page: page.page,
            stats: indexed.library_index.stats.clone(),
        })
    }

    pub fn get_conversation_response(
        &self,
        export_id: Option<String>,
        conversation_id: String,
        start: Option<usize>,
        limit: Option<usize>,
    ) -> AppResult<Conversation> {
        let (export, indexed) = self.ensure_index(export_id, false)?;
        let start_val = start.unwrap_or(0);
        let limit_val = limit.unwrap_or(100);

        if let Ok(mut lru) = self.conversation_lru.lock() {
            if let Some(conv) = lru.get(&export.id, &conversation_id) {
                return Ok(slice_conversation_page(&conv, start_val, limit_val));
            }
        }

        if let Some(&(offset, len)) = indexed.conversation_offsets.get(&conversation_id) {
            if indexed.conversation_jsonl_path.is_file() {
                let conv = Arc::new(read_conversation_from_jsonl(
                    &indexed.conversation_jsonl_path,
                    offset,
                    len,
                )?);
                let page = slice_conversation_page(&conv, start_val, limit_val);
                if let Ok(mut lru) = self.conversation_lru.lock() {
                    lru.insert(export.id.clone(), conversation_id, conv);
                }
                return Ok(page);
            }
        }

        if indexed.conversation_jsonl_path.is_file() {
            return Err(AppError::ConversationNotFound);
        }

        let cache_dir = {
            let inner = self.lock()?;
            inner.cache_dir.clone()
        };
        load_conversation(&export, &conversation_id, &cache_dir, start_val, limit_val)?
            .ok_or(AppError::ConversationNotFound)
    }

    pub fn refresh_index_response(
        &self,
        export_id: Option<String>,
    ) -> AppResult<RefreshIndexResponse> {
        let targets = {
            let inner = self.lock()?;
            if let Some(export_id) = export_id {
                vec![requested_export(&inner, Some(export_id))?]
            } else {
                inner.exports.clone()
            }
        };
        let mut indexed = Vec::with_capacity(targets.len());
        for export in targets {
            let (_, refreshed) = self.ensure_index(Some(export.id.clone()), true)?;
            if let Ok(mut lru) = self.conversation_lru.lock() {
                lru.remove_export(&export.id);
            }
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
        let project_aliases = inner.project_aliases.clone();
        drop(inner);

        let mut progress = SaveSessionsProgress {
            export_id: public_export.id.clone(),
            total: conversation_ids.len(),
            completed: 0,
            current_conversation_id: None,
            current_title: None,
        };
        let items = save_original_sessions(
            &export,
            &destination_dir,
            &conversation_ids,
            &project_aliases,
            |item| {
                progress = item.clone();
                on_progress(item);
            },
        )?;

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
        let (_export, resolved) =
            self.resolve_asset_for_export(Some(export_id.to_string()), file_id)?;

        let bytes = std::fs::read(&resolved.file_path)
            .map_err(|error| io_error(&resolved.file_path, error))?;
        Ok(AssetPayload {
            file_name: resolved.file_name,
            mime_type: resolved.mime_type,
            bytes,
        })
    }

    pub fn read_thumbnail_payload(&self, export_id: &str, file_id: &str) -> AppResult<AssetPayload> {
        let (export, resolved) =
            self.resolve_asset_for_export(Some(export_id.to_string()), file_id)?;
        let cache_dir = {
            let inner = self.lock()?;
            inner.cache_dir.clone()
        };
        let export_cache_dir = cache_dir.join(&export.id);
        let (mime_type, bytes) =
            crate::library::thumbnails::read_or_create_thumbnail(&resolved, &export_cache_dir)?;
        Ok(AssetPayload {
            file_name: resolved.file_name,
            mime_type,
            bytes,
        })
    }

    pub fn original_image_metadata(
        &self,
        export_id: Option<String>,
        file_id: &str,
    ) -> AppResult<OriginalImageMetadata> {
        let (_export, resolved) = self.resolve_asset_for_export(export_id, file_id)?;
        Ok(OriginalImageMetadata {
            file_name: resolved.file_name,
            mime_type: resolved.mime_type,
        })
    }

    pub fn save_original_image_to_path(
        &self,
        export_id: Option<String>,
        file_id: String,
        destination_path: PathBuf,
    ) -> AppResult<SaveOriginalImageResponse> {
        let (_export, resolved) = self.resolve_asset_for_export(export_id, &file_id)?;

        if let Some(parent) = destination_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        }
        let bytes_written = std::fs::copy(&resolved.file_path, &destination_path)
            .map_err(|error| io_error(&destination_path, error))?;

        Ok(SaveOriginalImageResponse {
            file_id: resolved.file_id,
            file_name: resolved.file_name,
            mime_type: resolved.mime_type,
            path: Some(destination_path),
            bytes_written,
            canceled: false,
        })
    }

    pub fn plan_export_original_images(
        &self,
        export_id: Option<String>,
        scope: &str,
        conversation_ids: Option<Vec<String>>,
        project_id: Option<String>,
    ) -> AppResult<(PublicExport, ImageExportPlan)> {
        self.plan_export_original_images_multi(
            export_id,
            scope,
            conversation_ids,
            project_id.map(|value| vec![value]),
        )
    }

    pub fn plan_export_original_images_multi(
        &self,
        export_id: Option<String>,
        scope: &str,
        conversation_ids: Option<Vec<String>>,
        project_ids: Option<Vec<String>>,
    ) -> AppResult<(PublicExport, ImageExportPlan)> {
        let (export, _indexed, plan) = self.resolve_image_export_plan(
            export_id,
            scope,
            conversation_ids.as_deref(),
            project_ids.as_deref(),
        )?;
        Ok((PublicExport::from(&export), plan))
    }

    pub fn export_original_images_to_dir(
        &self,
        export_id: Option<String>,
        scope: &str,
        conversation_ids: Option<Vec<String>>,
        project_id: Option<String>,
        destination_root: PathBuf,
        on_progress: impl FnMut(ExportImagesProgress),
    ) -> AppResult<ExportImagesResponse> {
        self.export_original_images_to_dir_multi(
            export_id,
            scope,
            conversation_ids,
            project_id.map(|value| vec![value]),
            destination_root,
            on_progress,
        )
    }

    pub fn export_original_images_to_dir_multi(
        &self,
        export_id: Option<String>,
        scope: &str,
        conversation_ids: Option<Vec<String>>,
        project_ids: Option<Vec<String>>,
        destination_root: PathBuf,
        on_progress: impl FnMut(ExportImagesProgress),
    ) -> AppResult<ExportImagesResponse> {
        let (export, indexed, plan) = self.resolve_image_export_plan(
            export_id,
            scope,
            conversation_ids.as_deref(),
            project_ids.as_deref(),
        )?;
        let response =
            execute_image_export(&export, &indexed, &plan, &destination_root, on_progress)?;
        if let Some(ref dir) = response.destination_dir {
            let canonical = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.clone());
            let mut inner = self.lock()?;
            inner.exported_image_dirs.retain(|existing| existing != &canonical);
            inner.exported_image_dirs.push(canonical);
            if inner.exported_image_dirs.len() > 32 {
                let overflow = inner.exported_image_dirs.len() - 32;
                inner.exported_image_dirs.drain(..overflow);
            }
        }
        Ok(response)
    }

    fn resolve_image_export_plan(
        &self,
        export_id: Option<String>,
        scope: &str,
        conversation_ids: Option<&[String]>,
        project_ids: Option<&[String]>,
    ) -> AppResult<(ExportItem, Arc<IndexedExport>, ImageExportPlan)> {
        let (export, indexed) = self.ensure_index(export_id, false)?;
        let project_aliases = {
            let inner = self.lock()?;
            inner.project_aliases.clone()
        };
        let normalized_project_ids = collect_unique_project_ids(None, project_ids);
        let plan = plan_image_export(
            &export,
            &indexed,
            &project_aliases,
            scope,
            conversation_ids,
            &normalized_project_ids,
            |cid| self.load_conversation_full(&export, &indexed, cid),
        )?;
        Ok((export, indexed, plan))
    }

    pub fn resolve_exported_images_dir(&self, path: &str) -> AppResult<PathBuf> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(AppError::PathEscapesRoot);
        }
        let candidate =
            std::fs::canonicalize(trimmed).map_err(|_| AppError::PathEscapesRoot)?;
        if !candidate.is_dir() {
            return Err(AppError::PathEscapesRoot);
        }
        let inner = self.lock()?;
        if inner
            .exported_image_dirs
            .iter()
            .any(|recorded| recorded == &candidate)
        {
            Ok(candidate)
        } else {
            Err(AppError::PathEscapesRoot)
        }
    }

    fn load_conversation_full(
        &self,
        export: &ExportItem,
        indexed: &IndexedExport,
        conversation_id: &str,
    ) -> AppResult<Option<Conversation>> {
        if let Ok(mut lru) = self.conversation_lru.lock() {
            if let Some(conv) = lru.get(&export.id, conversation_id) {
                return Ok(Some((*conv).clone()));
            }
        }
        if let Some(&(offset, len)) = indexed.conversation_offsets.get(conversation_id) {
            if indexed.conversation_jsonl_path.is_file() {
                let conv = Arc::new(read_conversation_from_jsonl(
                    &indexed.conversation_jsonl_path,
                    offset,
                    len,
                )?);
                let cloned = (*conv).clone();
                if let Ok(mut lru) = self.conversation_lru.lock() {
                    lru.insert(export.id.clone(), conversation_id.to_string(), conv);
                }
                return Ok(Some(cloned));
            }
        }
        if indexed.conversation_jsonl_path.is_file() {
            return Ok(None);
        }
        let cache_dir = {
            let inner = self.lock()?;
            inner.cache_dir.clone()
        };
        load_conversation(export, conversation_id, &cache_dir, 0, usize::MAX)
    }

    fn resolve_asset_for_export(
        &self,
        export_id: Option<String>,
        file_id: &str,
    ) -> AppResult<(ExportItem, ResolvedAsset)> {
        let (export, indexed) = self.ensure_index(export_id, false)?;
        let item = indexed
            .library_by_file_id
            .get(file_id)
            .and_then(|&idx| indexed.library_index.items.get(idx));
        let resolved = resolve_asset_for_item(&export, file_id, item)?;
        Ok((export, resolved))
    }

    fn ensure_index(
        &self,
        export_id: Option<String>,
        force: bool,
    ) -> AppResult<(ExportItem, Arc<IndexedExport>)> {
        let export = {
            let inner = self.lock()?;
            let export = requested_export(&inner, export_id)?;
            if !force {
                if let Some(indexed) = inner.indexes.get(&export.id) {
                    return Ok((export, Arc::clone(indexed)));
                }
            }
            export
        };

        let build_lock = self.index_build_lock(&export.id)?;
        let _guard = build_lock
            .lock()
            .map_err(|_| AppError::CacheUnavailable("index build lock poisoned".to_string()))?;

        let cache_dir = {
            let inner = self.lock()?;
            let current_export = requested_export(&inner, Some(export.id.clone()))?;
            if current_export.path != export.path {
                return Err(AppError::ExportNotFound);
            }
            if !force {
                if let Some(indexed) = inner.indexes.get(&export.id) {
                    return Ok((current_export, Arc::clone(indexed)));
                }
            }
            inner.cache_dir.clone()
        };

        let indexed = Arc::new(index_export(&export, &cache_dir, force)?);

        let mut inner = self.lock()?;
        let still_present = inner
            .exports
            .iter()
            .any(|item| item.id == export.id && item.path == export.path);
        if !still_present {
            return Err(AppError::ExportNotFound);
        }
        inner
            .indexes
            .insert(export.id.clone(), Arc::clone(&indexed));
        Ok((export, indexed))
    }

    fn index_build_lock(&self, export_id: &str) -> AppResult<Arc<Mutex<()>>> {
        let mut locks = self
            .index_locks
            .lock()
            .map_err(|_| AppError::CacheUnavailable("index lock map poisoned".to_string()))?;
        Ok(Arc::clone(
            locks
                .entry(export_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
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

fn reconcile_selected_export(
    selected_export_id: Option<String>,
    exports: &[ExportItem],
) -> Option<String> {
    selected_export_id
        .filter(|export_id| exports.iter().any(|item| item.id == *export_id))
        .or_else(|| exports.first().map(|item| item.id.clone()))
}

fn valid_window_size(window_size: Option<WindowSize>) -> Option<WindowSize> {
    window_size.filter(|size| size.width >= 320 && size.height >= 240)
}

fn persist_runtime_settings(inner: &StateInner) -> AppResult<()> {
    write_runtime_settings(
        &inner.settings_file,
        &RuntimeSettings {
            source_root: inner.source_root.clone(),
            selected_export_id: inner.selected_export_id.clone(),
            window_size: inner.window_size.clone(),
            project_aliases: inner.project_aliases.clone(),
        },
    )
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

fn public_settings(inner: &StateInner) -> PublicSettings {
    PublicSettings {
        source_root: inner.source_root.clone(),
        cache_dir: inner.cache_dir.clone(),
        export_count: inner.exports.len(),
        selected_export_id: inner.selected_export_id.clone(),
        window_size: inner.window_size.clone(),
        project_aliases: inner.project_aliases.clone(),
    }
}

fn sanitize_project_aliases(raw: BTreeMap<String, String>) -> BTreeMap<String, String> {
    raw.into_iter()
        .filter_map(|(raw_key, raw_value)| {
            let key = raw_key.trim();
            let value: String = raw_value.trim().chars().take(80).collect();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some((key.to_string(), value))
            }
        })
        .collect()
}

fn public_exports(exports: &[ExportItem]) -> Vec<PublicExport> {
    exports.iter().map(PublicExport::from).collect()
}
