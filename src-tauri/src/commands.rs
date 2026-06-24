use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::errors::{io_error, AppResult};
use crate::models::{
    Conversation, ConversationStats, ConversationSummary, ExportsResponse, LibraryResponseItem,
    LibraryStats, OpenFolderResponse, PagedResponse, RefreshIndexResponse, SaveSessionsResponse,
    SettingsResponse, StatsResponse, UpdateSettingsResponse,
};
use crate::state::AppState;

#[tauri::command]
pub fn get_exports(state: State<'_, AppState>) -> AppResult<ExportsResponse> {
    state.get_exports_response()
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<SettingsResponse> {
    state.get_settings_response()
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    source_root: String,
) -> AppResult<UpdateSettingsResponse> {
    state.update_settings_response(source_root)
}

#[tauri::command]
pub fn get_stats(
    state: State<'_, AppState>,
    export_id: Option<String>,
) -> AppResult<StatsResponse> {
    state.get_stats_response(export_id)
}

#[tauri::command]
pub fn get_conversations(
    state: State<'_, AppState>,
    export_id: Option<String>,
    query: Option<String>,
    filter: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> AppResult<PagedResponse<ConversationSummary, ConversationStats>> {
    state.get_conversations_response(export_id, query, filter, cursor, limit)
}

#[tauri::command]
pub fn get_library(
    state: State<'_, AppState>,
    export_id: Option<String>,
    query: Option<String>,
    filter: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> AppResult<PagedResponse<LibraryResponseItem, LibraryStats>> {
    state.get_library_response(export_id, query, filter, cursor, limit)
}

#[tauri::command]
pub fn get_conversation(
    state: State<'_, AppState>,
    export_id: Option<String>,
    conversation_id: String,
    start: Option<usize>,
    limit: Option<usize>,
) -> AppResult<Conversation> {
    state.get_conversation_response(export_id, conversation_id, start, limit)
}

#[tauri::command]
pub fn refresh_index(
    state: State<'_, AppState>,
    export_id: Option<String>,
) -> AppResult<RefreshIndexResponse> {
    state.refresh_index_response(export_id)
}

#[tauri::command]
pub fn save_sessions(
    app: AppHandle,
    state: State<'_, AppState>,
    export_id: Option<String>,
    conversation_ids: Vec<String>,
) -> AppResult<SaveSessionsResponse> {
    state.save_sessions_response(export_id, conversation_ids, |progress| {
        let _ = app.emit("session-export-progress", progress);
    })
}

#[tauri::command]
pub fn open_saved_sessions_folder(
    state: State<'_, AppState>,
    export_id: Option<String>,
) -> AppResult<OpenFolderResponse> {
    let path = state.saved_sessions_dir_for_export(export_id)?;
    open_folder(&path)?;
    Ok(OpenFolderResponse { path })
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
