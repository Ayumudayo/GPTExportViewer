pub mod asset_protocol;
pub mod cache;
pub mod commands;
pub mod conversations;
pub mod errors;
pub mod exports;
pub mod fs_guards;
pub mod index_store;
pub mod library;
pub mod models;
pub mod paging;
pub mod search;
pub mod settings;
pub mod state;
pub mod time;
pub mod webview2;

use tauri::Manager;

pub fn run() {
    if let Err(error) = webview2::preflight_webview2_runtime() {
        show_startup_error(&error.to_string());
        return;
    }

    let app_state = match state::AppState::new("GPTExportViewer", None) {
        Ok(state) => state,
        Err(error) => {
            show_startup_error(&error.to_string());
            return;
        }
    };
    let protocol_state = app_state.clone();
    let setup_state = app_state.clone();

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(settings_res) = setup_state.get_settings_response() {
                    if let Some(saved) = settings_res.settings.window_size {
                        let (mut width, mut height) = (saved.width, saved.height);
                        if let Ok(Some(monitor)) = window.current_monitor() {
                            let monitor_size = monitor.size();
                            let scale = monitor.scale_factor();
                            let min_w = (980.0 * scale).round() as u32;
                            let min_h = (620.0 * scale).round() as u32;
                            width = width.clamp(min_w.min(monitor_size.width), monitor_size.width);
                            height =
                                height.clamp(min_h.min(monitor_size.height), monitor_size.height);
                        } else {
                            width = width.max(980);
                            height = height.max(620);
                        }
                        let _ = window.set_size(tauri::PhysicalSize::new(width, height));
                    }
                }
            }
            Ok(())
        })
        .register_uri_scheme_protocol("gpt-export-asset", move |_ctx, request| {
            asset_protocol::asset_response(&protocol_state, request.uri().to_string())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_exports,
            commands::get_settings,
            commands::update_settings,
            commands::rescan_exports,
            commands::update_preferences,
            commands::get_stats,
            commands::get_conversations,
            commands::get_library,
            commands::get_conversation,
            commands::refresh_index,
            commands::save_sessions,
            commands::open_saved_sessions_folder,
            commands::save_original_image,
            commands::export_original_images,
            commands::open_exported_images_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running GPTExportViewer");
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    let title = wide("GPTExportViewer");
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
