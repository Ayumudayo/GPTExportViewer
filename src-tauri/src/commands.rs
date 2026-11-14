use std::path::Path;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::errors::{io_error, AppError, AppResult};
use crate::models::{
    Conversation, ConversationStats, ConversationSummary, ExportsResponse, LibraryResponseItem,
    LibraryStats, OpenFolderResponse, PagedResponse, RefreshIndexResponse, RescanExportsResponse,
    SaveOriginalImageResponse, SaveSessionsResponse, SettingsResponse, StatsResponse,
    UpdateSettingsResponse, WindowSize,
};
use crate::state::AppState;

async fn run_blocking<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::CacheUnavailable(format!("background task failed: {error}")))?
}

#[tauri::command]
pub async fn get_exports(state: State<'_, AppState>) -> AppResult<ExportsResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.get_exports_response()).await
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<SettingsResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.get_settings_response()).await
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    source_root: String,
) -> AppResult<UpdateSettingsResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.update_settings_response(source_root)).await
}

#[tauri::command]
pub async fn rescan_exports(state: State<'_, AppState>) -> AppResult<RescanExportsResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.rescan_exports_response()).await
}

#[tauri::command]
pub async fn update_preferences(
    state: State<'_, AppState>,
    selected_export_id: Option<String>,
    window_size: Option<WindowSize>,
) -> AppResult<SettingsResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.update_preferences_response(selected_export_id, window_size)).await
}

#[tauri::command]
pub async fn get_stats(
    state: State<'_, AppState>,
    export_id: Option<String>,
) -> AppResult<StatsResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.get_stats_response(export_id)).await
}

#[tauri::command]
pub async fn get_conversations(
    state: State<'_, AppState>,
    export_id: Option<String>,
    query: Option<String>,
    filter: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> AppResult<PagedResponse<ConversationSummary, ConversationStats>> {
    let state = state.inner().clone();
    run_blocking(move || state.get_conversations_response(export_id, query, filter, cursor, limit))
        .await
}

#[tauri::command]
pub async fn get_library(
    state: State<'_, AppState>,
    export_id: Option<String>,
    query: Option<String>,
    filter: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> AppResult<PagedResponse<LibraryResponseItem, LibraryStats>> {
    let state = state.inner().clone();
    run_blocking(move || state.get_library_response(export_id, query, filter, cursor, limit)).await
}

#[tauri::command]
pub async fn get_conversation(
    state: State<'_, AppState>,
    export_id: Option<String>,
    conversation_id: String,
    start: Option<usize>,
    limit: Option<usize>,
) -> AppResult<Conversation> {
    let state = state.inner().clone();
    run_blocking(move || state.get_conversation_response(export_id, conversation_id, start, limit))
        .await
}

#[tauri::command]
pub async fn refresh_index(
    state: State<'_, AppState>,
    export_id: Option<String>,
) -> AppResult<RefreshIndexResponse> {
    let state = state.inner().clone();
    run_blocking(move || state.refresh_index_response(export_id)).await
}

#[tauri::command]
pub async fn save_sessions(
    app: AppHandle,
    state: State<'_, AppState>,
    export_id: Option<String>,
    conversation_ids: Vec<String>,
) -> AppResult<SaveSessionsResponse> {
    let state = state.inner().clone();
    run_blocking(move || {
        state.save_sessions_response(export_id, conversation_ids, |progress| {
            let _ = app.emit("session-export-progress", progress);
        })
    })
    .await
}

#[tauri::command]
pub async fn open_saved_sessions_folder(
    state: State<'_, AppState>,
    export_id: Option<String>,
) -> AppResult<OpenFolderResponse> {
    let state = state.inner().clone();
    run_blocking(move || {
        let path = state.saved_sessions_dir_for_export(export_id)?;
        open_folder(&path)?;
        Ok(OpenFolderResponse { path })
    })
    .await
}

#[tauri::command]
pub async fn save_original_image(
    app: AppHandle,
    state: State<'_, AppState>,
    export_id: Option<String>,
    file_id: String,
) -> AppResult<SaveOriginalImageResponse> {
    let state_clone = state.inner().clone();
    let export_id_clone = export_id.clone();
    let file_id_clone = file_id.clone();
    let metadata = run_blocking(move || {
        state_clone.original_image_metadata(export_id_clone, &file_id_clone)
    })
    .await?;
    let selected_path = app
        .dialog()
        .file()
        .set_title("Save original image")
        .set_file_name(save_dialog_file_name(&metadata.file_name))
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"],
        )
        .blocking_save_file();

    let Some(selected_path) = selected_path else {
        return Ok(SaveOriginalImageResponse {
            file_id,
            file_name: metadata.file_name,
            mime_type: metadata.mime_type,
            path: None,
            bytes_written: 0,
            canceled: true,
        });
    };

    let destination_path = selected_path
        .into_path()
        .map_err(|error| AppError::InvalidSourceRoot(format!("Invalid save path: {error}")))?;
    let state_clone = state.inner().clone();
    run_blocking(move || state_clone.save_original_image_to_path(export_id, file_id, destination_path))
        .await
}

fn save_dialog_file_name(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    if sanitized.is_empty() {
        "image".to_string()
    } else {
        sanitized
    }
}

#[cfg(windows)]
fn open_folder(path: &Path) -> AppResult<()> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| io_error(path, error))
}

#[cfg(target_os = "macos")]
fn open_folder(path: &Path) -> AppResult<()> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| io_error(path, error))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn open_folder(path: &Path) -> AppResult<()> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| io_error(path, error))
}
