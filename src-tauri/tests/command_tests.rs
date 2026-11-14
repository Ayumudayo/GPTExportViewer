use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use gpt_export_viewer_lib::models::{SaveSessionsProgress, WindowSize};
use gpt_export_viewer_lib::state::AppState;
use serde_json::json;
use tempfile::TempDir;

#[test]
fn commands_get_exports_and_settings_return_discovered_exports() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();

    let settings = state.get_settings_response().unwrap().settings;
    assert_eq!(settings.source_root.as_deref(), Some(fixture.root.path()));
    assert!(settings.cache_dir.ends_with("cache"));
    assert_eq!(settings.export_count, 1);

    let exports = state.get_exports_response().unwrap().exports;
    assert_eq!(exports.len(), 1);
    assert_eq!(exports[0].name, "chatgpt-export-good");
    assert_eq!(exports[0].warnings.len(), 0);
}

#[test]
fn commands_update_settings_rescans_and_clears_stale_indexes() {
    let fixture = make_command_fixture();
    let alternate_root = TempDir::new().unwrap();
    let alternate_export = alternate_root.path().join("alternate-export");
    fs::create_dir_all(&alternate_export).unwrap();
    write_json(&alternate_export.join("conversations.json"), &json!([]));
    write_json(&alternate_export.join("library_files.json"), &json!([]));
    write_json(
        &alternate_export.join("conversation_asset_file_names.json"),
        &json!({}),
    );

    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let old_export_id = state.get_exports_response().unwrap().exports[0].id.clone();
    state
        .get_stats_response(Some(old_export_id.clone()))
        .unwrap();

    let payload = state
        .update_settings_response(alternate_root.path().to_string_lossy().to_string())
        .unwrap();
    assert_eq!(payload.exports.len(), 1);
    assert_eq!(payload.exports[0].name, "alternate-export");
    assert_eq!(
        payload.settings.source_root.as_deref(),
        Some(alternate_root.path())
    );
    assert_eq!(
        state
            .get_stats_response(Some(old_export_id))
            .unwrap_err()
            .code(),
        "export_not_found"
    );
}

#[test]
fn commands_rescan_exports_tracks_folder_changes_and_reconciles_selection() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let original_export = state.get_exports_response().unwrap().exports[0].clone();
    state
        .update_preferences_response(Some(original_export.id.clone()), None)
        .unwrap();

    let added_export_dir = fixture.root.path().join("second-export");
    fs::create_dir_all(&added_export_dir).unwrap();
    write_export_fixture(&added_export_dir);

    let added = state.rescan_exports_response().unwrap();
    assert_eq!(added.exports.len(), 2);
    assert_eq!(
        added.settings.selected_export_id.as_deref(),
        Some(original_export.id.as_str())
    );

    fs::remove_dir_all(fixture.root.path().join("chatgpt-export-good")).unwrap();
    let removed = state.rescan_exports_response().unwrap();
    assert_eq!(removed.exports.len(), 1);
    assert_eq!(removed.exports[0].name, "second-export");
    assert_eq!(
        removed.settings.selected_export_id.as_deref(),
        Some(removed.exports[0].id.as_str())
    );
    assert_eq!(
        state
            .get_stats_response(Some(original_export.id))
            .unwrap_err()
            .code(),
        "export_not_found"
    );
}

#[test]
fn commands_rescan_clears_stale_exports_when_source_root_disappears() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();
    state
        .update_preferences_response(Some(export_id), None)
        .unwrap();

    fs::remove_dir_all(fixture.root.path()).unwrap();
    let error = state.rescan_exports_response().unwrap_err();
    assert_eq!(error.code(), "invalid_source_root");

    let settings = state.get_settings_response().unwrap().settings;
    assert_eq!(settings.source_root, None);
    assert_eq!(settings.export_count, 0);
    assert_eq!(settings.selected_export_id, None);
    assert_eq!(state.get_exports_response().unwrap().exports.len(), 0);
}

#[test]
fn commands_preferences_persist_selected_export_and_window_size() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();
    let window_size = WindowSize {
        width: 1440,
        height: 900,
    };

    let saved = state
        .update_preferences_response(Some(export_id.clone()), Some(window_size.clone()))
        .unwrap();
    assert_eq!(saved.settings.selected_export_id.as_deref(), Some(export_id.as_str()));
    assert_eq!(saved.settings.window_size.as_ref(), Some(&window_size));

    let restored = AppState::new_with_app_data(fixture.app_data.path(), None).unwrap();
    let settings = restored.get_settings_response().unwrap().settings;
    assert_eq!(settings.source_root.as_deref(), Some(fixture.root.path()));
    assert_eq!(settings.selected_export_id.as_deref(), Some(export_id.as_str()));
    assert_eq!(settings.window_size.as_ref(), Some(&window_size));
}

#[test]
fn commands_first_run_without_source_root_starts_empty() {
    let app_data = TempDir::new().unwrap();
    let state = AppState::new_with_app_data(app_data.path(), None).unwrap();

    let settings = state.get_settings_response().unwrap().settings;
    assert_eq!(settings.source_root, None);
    assert_eq!(settings.export_count, 0);
    assert_eq!(settings.selected_export_id, None);
    assert_eq!(state.get_exports_response().unwrap().exports.len(), 0);
    assert_eq!(
        state.rescan_exports_response().unwrap_err().code(),
        "invalid_source_root"
    );
}

#[test]
fn commands_get_conversations_library_and_conversation_pages() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let conversations = state
        .get_conversations_response(
            Some(export_id.clone()),
            Some("alpha".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(1),
        )
        .unwrap();
    assert_eq!(conversations.items.len(), 1);
    assert_eq!(conversations.items[0].title, "Alpha image work");
    assert_eq!(conversations.stats.total_conversations, 2);

    let unicode_conversations = state
        .get_conversations_response(
            Some(export_id.clone()),
            Some("u\u{0308}ber".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(unicode_conversations.items.len(), 1);
    assert_eq!(unicode_conversations.items[0].title, "Über 한글 메모");

    let library = state
        .get_library_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some(0),
            Some(1),
        )
        .unwrap();
    assert_eq!(library.items.len(), 1);
    assert_eq!(library.page.next_cursor.as_deref(), Some("1"));
    assert!(library.items[0]
        .asset_url
        .starts_with("http://gpt-export-asset.localhost/library/"));
    let full_library = state
        .get_library_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    let linked_image = full_library
        .items
        .iter()
        .find(|item| item.item.file_id == "file-img-1")
        .unwrap();
    assert_eq!(linked_image.item.width, Some(1024));
    assert_eq!(linked_image.item.height, Some(1536));

    let unicode_library = state
        .get_library_response(
            Some(export_id.clone()),
            Some("u\u{0308}ber".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(unicode_library.items.len(), 1);
    assert_eq!(
        unicode_library.items[0].item.display_name,
        "Über 이미지.png"
    );

    let conversation = state
        .get_conversation_response(Some(export_id), "conv-1".to_string(), Some(0), Some(1))
        .unwrap();
    assert_eq!(conversation.messages.len(), 1);
    let serialized_message = serde_json::to_value(&conversation.messages[0]).unwrap();
    assert_eq!(serialized_message["parts"][0]["partType"], "text");
    assert_eq!(conversation.range.unwrap().next_start, Some(1));
}

#[test]
fn commands_conversation_cache_invalidates_when_export_file_changes() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let first = state
        .get_conversation_response(
            Some(export_id.clone()),
            "conv-1".to_string(),
            Some(0),
            Some(1),
        )
        .unwrap();
    assert_eq!(first.messages[0].text, "Please make an image");

    let conversations_file = fixture
        .root
        .path()
        .join("chatgpt-export-good")
        .join("conversations.json");
    let mut conversations: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&conversations_file).unwrap()).unwrap();
    conversations[0]["mapping"]["msg1"]["message"]["content"]["parts"][0] =
        json!("Changed image prompt");
    write_json(&conversations_file, &conversations);

    state
        .refresh_index_response(Some(export_id.clone()))
        .unwrap();
    let updated = state
        .get_conversation_response(Some(export_id), "conv-1".to_string(), Some(0), Some(1))
        .unwrap();
    assert_eq!(updated.messages[0].text, "Changed image prompt");
}

#[test]
fn commands_refresh_index_rebuilds_single_and_all_exports() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let one = state.refresh_index_response(Some(export_id)).unwrap();
    assert_eq!(one.indexed.len(), 1);
    assert!(!one.indexed[0].cache_hit);

    let all = state.refresh_index_response(None).unwrap();
    assert_eq!(all.indexed.len(), 1);
    assert!(!all.indexed[0].cache_hit);
}

#[test]
fn commands_malformed_export_json_surfaces_parse_failed() {
    let fixture = make_command_fixture();
    let bad_export = fixture.root.path().join("bad-export");
    fs::create_dir_all(&bad_export).unwrap();
    fs::write(bad_export.join("conversations.json"), "{ not json").unwrap();
    write_json(&bad_export.join("library_files.json"), &json!([]));
    write_json(
        &bad_export.join("conversation_asset_file_names.json"),
        &json!({}),
    );

    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let bad_id = state
        .get_exports_response()
        .unwrap()
        .exports
        .iter()
        .find(|item| item.name == "bad-export")
        .unwrap()
        .id
        .clone();
    let error = state
        .get_conversations_response(
            Some(bad_id),
            None,
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap_err();
    assert_eq!(error.code(), "parse_failed");
}

#[test]
fn commands_save_single_session_writes_original_json_under_app_data() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let response = state
        .save_sessions_response(Some(export_id.clone()), vec!["conv-1".to_string()], |_| {})
        .unwrap();

    assert_eq!(response.items.len(), 1);
    let item = &response.items[0];
    assert_eq!(item.conversation_id, "conv-1");
    assert_eq!(item.format, "original");
    assert!(response.destination_dir.ends_with(&export_id));
    assert!(item.path.starts_with(&response.destination_dir));
    assert_eq!(response.progress.completed, 1);
    assert_eq!(response.progress.total, 1);

    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&item.path).unwrap()).unwrap();
    assert_eq!(saved["id"], "conv-1");
    assert!(saved.get("mapping").is_some());
    assert!(saved.get("messages").is_none());
}

#[test]
fn commands_save_multiple_sessions_writes_each_file_and_reports_progress() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();
    let captured = Arc::new(Mutex::new(Vec::<SaveSessionsProgress>::new()));
    let progress = Arc::clone(&captured);

    let response = state
        .save_sessions_response(
            Some(export_id),
            vec!["conv-1".to_string(), "conv-2".to_string()],
            move |item| progress.lock().unwrap().push(item.clone()),
        )
        .unwrap();

    assert_eq!(response.items.len(), 2);
    assert!(response.items.iter().all(|item| item.path.exists()));
    assert_eq!(
        response.items[1]
            .path
            .file_name()
            .unwrap()
            .to_string_lossy(),
        "2024-03-09-16-16-40.000--Über_한글_메모-conv-2.json"
    );

    let captured = captured.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert_eq!(captured[0].completed, 1);
    assert_eq!(captured[0].total, 2);
    assert_eq!(captured[1].completed, 2);
    assert_eq!(captured[1].total, 2);
}

#[test]
fn commands_save_sessions_rejects_missing_session_before_writing() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let error = state
        .save_sessions_response(Some(export_id), vec!["missing".to_string()], |_| {})
        .unwrap_err();

    assert_eq!(error.code(), "conversation_not_found");
    assert!(!fixture.app_data.path().join("Saved Sessions").exists());
}

#[test]
fn commands_save_original_image_copies_resolved_asset_to_destination() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();
    let destination = fixture
        .app_data
        .path()
        .join("Saved Images")
        .join("library.png");

    let response = state
        .save_original_image_to_path(
            Some(export_id),
            "file-img-1".to_string(),
            destination.clone(),
        )
        .unwrap();

    assert_eq!(response.file_id, "file-img-1");
    assert_eq!(response.file_name, "renamed library.png");
    assert_eq!(response.mime_type, "image/png");
    assert_eq!(response.path.as_deref(), Some(destination.as_path()));
    assert_eq!(response.bytes_written, 8);
    assert!(!response.canceled);
    assert_eq!(
        fs::read(destination).unwrap(),
        fs::read(
            fixture
                .root
                .path()
                .join("chatgpt-export-good")
                .join("file-img-1.dat")
        )
        .unwrap()
    );
}

#[test]
fn commands_save_original_image_rejects_invalid_file_ids() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();
    let destination = fixture.app_data.path().join("escape.png");

    let error = state
        .save_original_image_to_path(Some(export_id), "..\\escape".to_string(), destination)
        .unwrap_err();

    assert_eq!(error.code(), "invalid_file_id");
}

#[test]
fn commands_saved_sessions_dir_for_export_returns_app_data_folder() {
    let fixture = make_command_fixture();
    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let dir = state
        .saved_sessions_dir_for_export(Some(export_id.clone()))
        .unwrap();

    assert_eq!(
        dir,
        fixture
            .app_data
            .path()
            .join("Saved Sessions")
            .join(export_id)
    );
    assert!(dir.exists());
}

#[test]
fn commands_conversations_search_matches_full_text_past_preview_limit_and_invalidates_jsonl_store() {
    let fixture = make_command_fixture();
    let export_dir = fixture.root.path().join("chatgpt-export-good");
    let long_prefix = "prefix ".repeat(70);
    let long_message = format!("{long_prefix}UniqueNeedleBeyondPreview500 tail");
    assert!(long_message.len() > 500);

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-long",
                "title": "Long search target",
                "create_time": 1710000000,
                "update_time": 1710000600,
                "current_node": "msg1",
                "default_model_slug": "gpt-4o",
                "is_archived": false,
                "mapping": {
                    "msg1": {
                        "id": "msg1",
                        "parent": null,
                        "children": [],
                        "message": {
                            "id": "m1",
                            "author": { "role": "assistant" },
                            "content": { "content_type": "text", "parts": [long_message] }
                        }
                    }
                }
            }
        ]),
    );

    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let found = state
        .get_conversations_response(
            Some(export_id.clone()),
            Some("UniqueNeedleBeyondPreview500".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, "conv-long");

    let conversation = state
        .get_conversation_response(
            Some(export_id.clone()),
            "conv-long".to_string(),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(conversation.total_messages, 1);
    assert!(conversation.messages[0]
        .text
        .contains("UniqueNeedleBeyondPreview500"));

    // Verify warm disk-cache reload before file modification (rescan clears memory cache only).
    state.rescan_exports_response().unwrap();
    assert!(state.get_stats_response(Some(export_id.clone())).unwrap().cache.hit);

    // Modify conversations.json to confirm JSONL store + search index invalidate automatically on fingerprint mismatch.
    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-long",
                "title": "Updated long session",
                "create_time": 1710000000,
                "update_time": 1710000900,
                "current_node": "msg1",
                "mapping": {
                    "msg1": {
                        "id": "msg1",
                        "parent": null,
                        "children": [],
                        "message": {
                            "id": "m1",
                            "author": { "role": "assistant" },
                            "content": { "content_type": "text", "parts": ["UpdatedSecondNeedle only"] }
                        }
                    }
                }
            }
        ]),
    );
    state.rescan_exports_response().unwrap();

    let after_update_old = state
        .get_conversations_response(
            Some(export_id.clone()),
            Some("UniqueNeedleBeyondPreview500".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(after_update_old.items.len(), 0);

    let after_update_new = state
        .get_conversations_response(
            Some(export_id.clone()),
            Some("UpdatedSecondNeedle".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(after_update_new.items.len(), 1);
    assert_eq!(after_update_new.items[0].title, "Updated long session");

    let updated_conversation = state
        .get_conversation_response(
            Some(export_id),
            "conv-long".to_string(),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(updated_conversation.messages[0].text, "UpdatedSecondNeedle only");
}

#[test]
fn commands_search_matches_text_past_65kb_boundary() {
    let fixture = make_command_fixture();
    let export_dir = fixture.root.path().join("chatgpt-export-good");
    let long_prefix = "chunk ".repeat(14_000);
    let long_message = format!("{long_prefix}DeepNeedleBeyond80KB tail");
    assert!(long_message.len() > 80_000);

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-80kb",
                "title": "80KB search target",
                "create_time": 1710000000,
                "update_time": 1710000600,
                "current_node": "msg1",
                "default_model_slug": "gpt-4o",
                "is_archived": false,
                "mapping": {
                    "msg1": {
                        "id": "msg1",
                        "parent": null,
                        "children": [],
                        "message": {
                            "id": "m1",
                            "author": { "role": "assistant" },
                            "content": { "content_type": "text", "parts": [long_message] }
                        }
                    }
                }
            }
        ]),
    );

    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let found = state
        .get_conversations_response(
            Some(export_id),
            Some("DeepNeedleBeyond80KB".to_string()),
            Some("all".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, "conv-80kb");
}

#[test]
fn commands_read_thumbnail_payload_serves_resized_jpeg_for_large_png() {
    let fixture = make_command_fixture();
    let export_dir = fixture.root.path().join("chatgpt-export-good");

    let img = image::RgbImage::from_fn(1024, 768, |x, y| {
        let mut h = x
            .wrapping_mul(374_761_393)
            .wrapping_add(y.wrapping_mul(668_265_263));
        h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
        image::Rgb([
            (h & 0xff) as u8,
            ((h >> 8) & 0xff) as u8,
            ((h >> 16) & 0xff) as u8,
        ])
    });
    let mut png_bytes = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    assert!(
        png_bytes.len() > 48 * 1024,
        "synthetic PNG must exceed 48KB bypass threshold (got {})",
        png_bytes.len()
    );

    fs::write(export_dir.join("file-img-1.dat"), &png_bytes).unwrap();
    write_json(
        &export_dir.join("library_files.json"),
        &json!([
            {
                "file_id": "file-img-1",
                "file_name": "library generated.png",
                "mime_type": "image/png",
                "file_size_bytes": png_bytes.len(),
                "width": 1024,
                "height": 768,
                "created_at": "2024-03-09T16:00:02Z",
                "state": "ready",
                "library_file_category": "image",
                "origination_thread_id": "conv-1",
                "origination_message_id": "m2"
            }
        ]),
    );

    let state = AppState::new_with_app_data(
        fixture.app_data.path(),
        Some(fixture.root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let payload = state
        .read_thumbnail_payload(&export_id, "file-img-1")
        .unwrap();
    assert_eq!(payload.mime_type, "image/jpeg");

    let decoded = image::load_from_memory(&payload.bytes).unwrap();
    assert_eq!(decoded.width(), 384);
    assert_eq!(decoded.height(), 288);
}

struct Fixture {
    root: TempDir,
    app_data: TempDir,
}

fn make_command_fixture() -> Fixture {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let good = root.path().join("chatgpt-export-good");
    fs::create_dir_all(&good).unwrap();
    write_export_fixture(&good);
    Fixture { root, app_data }
}

fn write_export_fixture(root: &Path) {
    write_json(
        &root.join("conversations.json"),
        &json!([
            {
                "id": "conv-1",
                "title": "Alpha image work",
                "create_time": 1710000000,
                "update_time": 1710000600,
                "current_node": "msg2",
                "default_model_slug": "gpt-4o",
                "is_archived": false,
                "mapping": {
                    "root": { "id": "root", "parent": null, "children": ["msg1"] },
                    "msg1": {
                        "id": "msg1",
                        "parent": "root",
                        "children": ["msg2"],
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "content": { "content_type": "text", "parts": ["Please make an image"] }
                        }
                    },
                    "msg2": {
                        "id": "msg2",
                        "parent": "msg1",
                        "children": [],
                        "message": {
                            "id": "m2",
                            "author": { "role": "assistant" },
                            "content": { "content_type": "text", "parts": ["Here is image"] },
                            "metadata": {
                                "attachments": [{ "file_id": "file-img-1", "name": "library.png", "mime_type": "image/png" }]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-2",
                "title": "Über 한글 메모",
                "create_time": 1710001000,
                "update_time": 1710001000,
                "is_archived": true,
                "mapping": {
                    "node1": {
                        "id": "node1",
                        "parent": null,
                        "children": [],
                        "message": {
                            "id": "m3",
                            "author": { "role": "user" },
                            "content": { "content_type": "text", "parts": ["Archived text"] }
                        }
                    }
                }
            }
        ]),
    );
    write_json(
        &root.join("library_files.json"),
        &json!([
            {
                "file_id": "file-img-1",
                "file_name": "library generated.png",
                "mime_type": "image/png",
                "file_size_bytes": 8,
                "width": 1024,
                "height": 1536,
                "created_at": "2024-03-09T16:00:02Z",
                "state": "ready",
                "library_file_category": "image",
                "origination_thread_id": "conv-1",
                "origination_message_id": "m2"
            },
            {
                "file_id": "file-img-2",
                "file_name": "Über 이미지.png",
                "mime_type": "image/png",
                "file_size_bytes": 8,
                "created_at": "2024-03-09T16:00:03Z",
                "state": "ready",
                "library_file_category": "image"
            }
        ]),
    );
    write_json(
        &root.join("conversation_asset_file_names.json"),
        &json!({ "file-img-1.dat": "renamed library.png" }),
    );
    fs::write(
        root.join("file-img-1.dat"),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .unwrap();
    fs::write(
        root.join("file-img-2.dat"),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .unwrap();
}

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .unwrap();
}
