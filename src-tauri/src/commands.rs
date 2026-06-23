use tauri::State;

use crate::errors::AppResult;
use crate::models::{
    Conversation, ConversationStats, ConversationSummary, ExportsResponse, LibraryResponseItem,
    LibraryStats, PagedResponse, RefreshIndexResponse, SettingsResponse, StatsResponse,
    UpdateSettingsResponse,
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
