pub mod cache;
pub mod errors;
pub mod exports;
pub mod fs_guards;
pub mod models;
pub mod paging;
pub mod settings;
pub mod state;
pub mod time;
pub mod webview2;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    source_root: Option<String>,
    cache_dir: Option<String>,
    export_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsResponse {
    settings: Settings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportsResponse {
    exports: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    cursor: usize,
    limit: usize,
    total: usize,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PagedResponse {
    export: Option<serde_json::Value>,
    items: Vec<serde_json::Value>,
    page: Page,
    stats: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationResponse {
    id: String,
    title: String,
    total_messages: usize,
    messages: Vec<serde_json::Value>,
    range: serde_json::Value,
}

#[tauri::command]
async fn get_exports() -> ExportsResponse {
    ExportsResponse { exports: vec![] }
}

#[tauri::command]
async fn get_settings() -> SettingsResponse {
    SettingsResponse {
        settings: Settings {
            source_root: None,
            cache_dir: None,
            export_count: 0,
        },
    }
}

#[tauri::command]
async fn update_settings(source_root: String) -> serde_json::Value {
    serde_json::json!({
        "settings": {
            "sourceRoot": source_root,
            "cacheDir": null,
            "exportCount": 0
        },
        "exports": []
    })
}

#[tauri::command]
async fn get_stats(_export_id: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "export": null,
        "conversations": {},
        "library": {},
        "cache": { "hit": false, "dir": null }
    })
}

#[tauri::command]
async fn get_conversations(
    _export_id: Option<String>,
    _query: Option<String>,
    _filter: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> PagedResponse {
    empty_page(cursor.unwrap_or(0), limit.unwrap_or(80))
}

#[tauri::command]
async fn get_library(
    _export_id: Option<String>,
    _query: Option<String>,
    _filter: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> PagedResponse {
    empty_page(cursor.unwrap_or(0), limit.unwrap_or(120))
}

#[tauri::command]
async fn get_conversation(
    _export_id: Option<String>,
    conversation_id: String,
    start: Option<usize>,
    limit: Option<usize>,
) -> ConversationResponse {
    ConversationResponse {
        id: conversation_id,
        title: "Conversation".to_string(),
        total_messages: 0,
        messages: vec![],
        range: serde_json::json!({
            "start": start.unwrap_or(0),
            "limit": limit.unwrap_or(120),
            "total": 0,
            "nextStart": null
        }),
    }
}

#[tauri::command]
async fn refresh_index(_export_id: Option<String>) -> serde_json::Value {
    serde_json::json!({ "indexed": [] })
}

fn empty_page(cursor: usize, limit: usize) -> PagedResponse {
    PagedResponse {
        export: None,
        items: vec![],
        page: Page {
            cursor,
            limit,
            total: 0,
            next_cursor: None,
        },
        stats: serde_json::json!({}),
    }
}

pub fn run() {
    if let Err(error) = webview2::preflight_webview2_runtime() {
        show_startup_error(&error.to_string());
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_exports,
            get_settings,
            update_settings,
            get_stats,
            get_conversations,
            get_library,
            get_conversation,
            refresh_index
        ])
        .run(tauri::generate_context!())
        .expect("error while running GPTExportManager");
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    let title = wide("GPTExportManager");
    let body = wide(message);
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("{message}");
}
