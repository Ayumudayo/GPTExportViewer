pub mod asset_protocol;
pub mod cache;
pub mod commands;
pub mod conversations;
pub mod errors;
pub mod exports;
pub mod fs_guards;
pub mod library;
pub mod models;
pub mod paging;
pub mod settings;
pub mod state;
pub mod time;
pub mod webview2;

pub fn run() {
    if let Err(error) = webview2::preflight_webview2_runtime() {
        show_startup_error(&error.to_string());
        return;
    }

    let app_state = match state::AppState::new("GPTExportManager", Some(default_source_root())) {
        Ok(state) => state,
        Err(error) => {
            show_startup_error(&error.to_string());
            return;
        }
    };
    let protocol_state = app_state.clone();

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("gpt-export-asset", move |_ctx, request| {
            asset_response(&protocol_state, request.uri().to_string())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_exports,
            commands::get_settings,
            commands::update_settings,
            commands::get_stats,
            commands::get_conversations,
            commands::get_library,
            commands::get_conversation,
            commands::refresh_index,
            commands::save_sessions,
            commands::open_saved_sessions_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running GPTExportManager");
}

fn default_source_root() -> std::path::PathBuf {
    std::path::PathBuf::from(r"E:\OpenAI\Exports")
}

fn asset_response(state: &state::AppState, uri: String) -> tauri::http::Response<Vec<u8>> {
    match asset_protocol::parse_asset_url(&uri)
        .and_then(|parsed| state.read_asset_payload(&parsed.export_id, &parsed.file_id))
    {
        Ok(asset) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(tauri::http::header::CONTENT_TYPE, asset.mime_type)
            .header(
                tauri::http::header::CONTENT_LENGTH,
                asset.bytes.len().to_string(),
            )
            .header(
                tauri::http::header::CONTENT_DISPOSITION,
                format!("inline; filename=\"{}\"", header_filename(&asset.file_name)),
            )
            .header("x-content-type-options", "nosniff")
            .header(tauri::http::header::CACHE_CONTROL, "private, max-age=3600")
            .body(asset.bytes)
            .expect("valid asset response"),
        Err(error) => {
            let status = match error {
                errors::AppError::InvalidFileId | errors::AppError::PathEscapesRoot => {
                    tauri::http::StatusCode::BAD_REQUEST
                }
                errors::AppError::ExportNotFound | errors::AppError::AssetNotFound => {
                    tauri::http::StatusCode::NOT_FOUND
                }
                _ => tauri::http::StatusCode::INTERNAL_SERVER_ERROR,
            };
            tauri::http::Response::builder()
                .status(status)
                .header(
                    tauri::http::header::CONTENT_TYPE,
                    "text/plain; charset=utf-8",
                )
                .header("x-content-type-options", "nosniff")
                .body(status_text(status).as_bytes().to_vec())
                .expect("valid error response")
        }
    }
}

fn status_text(status: tauri::http::StatusCode) -> &'static str {
    match status {
        tauri::http::StatusCode::BAD_REQUEST => "invalid asset request",
        tauri::http::StatusCode::NOT_FOUND => "asset not found",
        _ => "asset unavailable",
    }
}

fn header_filename(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_graphic() && !matches!(ch, '"' | '\\' | ';') {
                ch
            } else {
                '_'
            }
        })
        .collect()
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
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("{message}");
}
