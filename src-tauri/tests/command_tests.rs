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
    assert_eq!(
        item.path.parent().unwrap().file_name().unwrap().to_string_lossy(),
        "General"
    );
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

#[test]
fn commands_attach_generated_library_images_mark_missing_parts_and_save_supplementary_sessions() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let export_dir = root.path().join("modern-export");
    fs::create_dir_all(&export_dir).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-gen",
                "title": "Portrait Generation",
                "create_time": 1780000000,
                "update_time": 1780000500,
                "current_node": "n3",
                "default_model_slug": "gpt-6-thinking",
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "children": ["n2"],
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "create_time": 1780000010,
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "sediment://file_missing_upload", "content_type": "image_asset_pointer", "width": 800, "height": 1000 },
                                    "Make a portrait"
                                ]
                            }
                        }
                    },
                    "n2": {
                        "id": "n2",
                        "parent": "n1",
                        "children": ["n3"],
                        "message": {
                            "id": "m2",
                            "author": { "role": "assistant" },
                            "create_time": 1780000020,
                            "content": { "content_type": "thoughts", "thoughts": [{ "summary": "Thinking" }] }
                        }
                    },
                    "n3": {
                        "id": "n3",
                        "parent": "n2",
                        "children": [],
                        "message": {
                            "id": "m3",
                            "author": { "role": "user" },
                            "create_time": 1780000200,
                            "content": { "content_type": "text", "parts": ["Looks nice!"] }
                        }
                    }
                }
            }
        ]),
    );
    write_json(
        &export_dir.join("library_files.json"),
        &json!([
            {
                "file_id": "file_gen_ok",
                "file_name": "portrait_out.png",
                "mime_type": "image/png",
                "file_size_bytes": 8,
                "width": 1024,
                "height": 1536,
                "created_at": "2026-05-28T20:28:00.000Z",
                "state": "ready",
                "library_file_category": "image",
                "image_gen_generation_id": "gen_1",
                "origination_thread_id": "conv-gen",
                "origination_message_id": "missing-node-id"
            }
        ]),
    );
    write_json(
        &export_dir.join("conversation_asset_file_names.json"),
        &json!({}),
    );
    write_json(
        &export_dir.join("group_chats.json"),
        &json!({
            "chats": [
                {
                    "id": "gc-save",
                    "name": "Group Room",
                    "created_at": "2026-11-01T10:00:00Z",
                    "last_action_at": "2026-11-01T10:05:00Z",
                    "messages": [
                        { "id": "gm1", "role": "user", "text": "Hello room", "created_at": "2026-11-01T10:00:00Z", "attachments": [] }
                    ]
                }
            ]
        }),
    );
    write_json(
        &export_dir.join("codex.json"),
        &json!([
            {
                "id": "codex-save",
                "title": "Codex Fix",
                "archived": true,
                "turns": [
                    { "id": "t1", "role": "user", "input_items": [{ "type": "message", "content": [{ "content_type": "text", "text": "Fix" }] }] }
                ]
            }
        ]),
    );
    fs::write(
        export_dir.join("file_gen_ok.dat"),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .unwrap();

    let state = AppState::new_with_app_data(
        app_data.path(),
        Some(root.path().to_path_buf()),
    )
    .unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let conv = state
        .get_conversation_response(Some(export_id.clone()), "conv-gen".to_string(), Some(0), Some(10))
        .unwrap();
    assert_eq!(conv.total_messages, 3);
    assert_eq!(conv.messages[0].parts[0].exists, Some(false));
    assert_eq!(conv.messages[1].content_type.as_deref(), Some("generated_image"));
    assert_eq!(conv.messages[1].parts[0].file_id.as_deref(), Some("file_gen_ok"));
    assert_eq!(conv.messages[1].parts[0].exists, Some(true));
    assert_eq!(conv.messages[2].text, "Looks nice!");

    let lib = state
        .get_library_response(
            Some(export_id.clone()),
            Some("Portrait Generation".to_string()),
            Some("linked".to_string()),
            Some(0),
            Some(10),
        )
        .unwrap();
    assert_eq!(lib.items.len(), 1);
    assert_eq!(
        lib.items[0].item.source_conversation_title.as_deref(),
        Some("Portrait Generation")
    );

    let saved = state
        .save_sessions_response(
            Some(export_id),
            vec!["gc-save".to_string(), "codex-save".to_string()],
            |_| {},
        )
        .unwrap();
    assert_eq!(saved.items.len(), 2);
    assert!(saved.items.iter().all(|item| item.path.is_file()));
    assert!(saved.items.iter().all(|item| {
        item.path
            .parent()
            .and_then(|dir| dir.file_name())
            .is_some_and(|name| name == "Other")
    }));
}

#[test]
fn commands_real_export_smoke_when_env_set() {
    let Some(real_path) = std::env::var_os("GPT_EXPORT_REAL_PATH") else {
        return;
    };
    let export_root = std::path::PathBuf::from(real_path);
    assert!(export_root.is_dir(), "GPT_EXPORT_REAL_PATH must point to a directory");

    let app_data = TempDir::new().unwrap();
    let state = AppState::new_with_app_data(app_data.path(), Some(export_root.clone())).unwrap();
    let exports = state.get_exports_response().unwrap().exports;
    assert!(!exports.is_empty(), "Expected at least one export");
    let export_id = exports[0].id.clone();

    let stats = state.get_stats_response(Some(export_id.clone())).unwrap();
    assert!(!stats.cache.hit, "Cold index should report cache miss");
    assert!(stats.conversations.total_conversations > 0);
    assert_eq!(
        stats.conversations.regular_conversations
            + stats.conversations.project_conversations
            + stats.conversations.custom_gpt_conversations
            + stats.conversations.group_chat_conversations
            + stats.conversations.codex_conversations,
        stats.conversations.total_conversations
    );

    let mut cursor = 0usize;
    let mut conv_ids = Vec::new();
    loop {
        let page = state
            .get_conversations_response(Some(export_id.clone()), None, Some("all".to_string()), Some(cursor), Some(100))
            .unwrap();
        for item in &page.items {
            assert!(
                !item.preview.contains('\u{E200}') && !item.preview.contains('\u{E201}'),
                "Preview leaked PUA token in {}: {}",
                item.id,
                item.preview
            );
            conv_ids.push(item.id.clone());
        }
        if page.page.next_cursor.is_none() {
            break;
        }
        cursor += page.items.len();
    }
    assert_eq!(conv_ids.len(), stats.conversations.total_conversations);
    assert_eq!(
        stats.conversations.regular_conversations
            + stats.conversations.project_conversations
            + stats.conversations.custom_gpt_conversations
            + stats.conversations.group_chat_conversations
            + stats.conversations.codex_conversations,
        stats.conversations.total_conversations,
        "Conversation kind buckets must partition total_conversations"
    );
    let project_page = state
        .get_conversations_filtered_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some("project".to_string()),
            None,
            Some(0),
            Some(100),
        )
        .unwrap();
    assert_eq!(project_page.page.total, stats.conversations.project_conversations);
    let mut grouped_sum = 0usize;
    for proj in &stats.conversations.projects {
        assert!(proj.id.starts_with("g-p-"));
        let single_proj_page = state
            .get_conversations_filtered_response(
                Some(export_id.clone()),
                None,
                Some("all".to_string()),
                Some("project".to_string()),
                Some(proj.id.clone()),
                Some(0),
                Some(100),
            )
            .unwrap();
        assert_eq!(single_proj_page.page.total, proj.conversation_count);
        grouped_sum += proj.conversation_count;
    }
    assert_eq!(grouped_sum, stats.conversations.project_conversations);

    let mut total_gen_attached = 0usize;
    let mut total_missing_img_parts = 0usize;
    for conv_id in &conv_ids {
        let mut start = 0usize;
        loop {
            let conv = state
                .get_conversation_response(Some(export_id.clone()), conv_id.clone(), Some(start), Some(200))
                .unwrap();
            for msg in &conv.messages {
                assert!(
                    !matches!(msg.content_type.as_deref(), Some("thoughts" | "reasoning_recap")),
                    "Internal reasoning message leaked in {conv_id}"
                );
                assert!(
                    !msg.text.contains('\u{E200}') && !msg.text.contains('\u{E201}') && !msg.text.contains('\u{E202}'),
                    "Message leaked PUA token in {conv_id} ({})",
                    msg.id
                );
                let prose = strip_code_blocks_for_test(&msg.text);
                for forbidden in [
                    "<Entity", "<Cite", "<Link", "<MapWidget", "<CodeCite", "<FileCite",
                    "<MemoryCite", "<AsyncImage", "<box", "<row", "<grid", "{#each",
                ] {
                    assert!(
                        !prose.contains(forbidden),
                        "Message leaked {forbidden} outside code in {conv_id} ({}):\n{}",
                        msg.id,
                        &prose[..prose.len().min(300)]
                    );
                }
                if msg.content_type.as_deref() == Some("generated_image") {
                    total_gen_attached += msg.parts.len();
                }
                for part in &msg.parts {
                    if part.part_type == "image" && part.exists == Some(false) {
                        total_missing_img_parts += 1;
                    }
                }
            }
            match conv.range.and_then(|r| r.next_start) {
                Some(next) => start = next,
                None => break,
            }
        }
    }

    let mut lib_cursor = 0usize;
    let mut lib_items = Vec::new();
    loop {
        let page = state
            .get_library_response(Some(export_id.clone()), None, Some("all".to_string()), Some(lib_cursor), Some(120))
            .unwrap();
        lib_items.extend(page.items);
        if page.page.next_cursor.is_none() {
            break;
        }
        lib_cursor += 120;
    }
    assert_eq!(lib_items.len(), stats.library.total_images);
    for pair in lib_items.windows(2) {
        assert!(
            pair[0].item.created_at >= pair[1].item.created_at,
            "Library items out of descending order: {:?} < {:?}",
            pair[0].item.created_at,
            pair[1].item.created_at
        );
    }
    for item in &lib_items {
        if item.item.in_chat {
            assert!(
                item.item.source_conversation_title.as_deref().is_some_and(|t| !t.is_empty()),
                "Linked image {} missing source_conversation_title",
                item.item.file_id
            );
        }
        if item.item.mime == "image/svg+xml" && item.item.exists {
            let thumb = state.read_thumbnail_payload(&export_id, &item.item.file_id).unwrap();
            assert_eq!(thumb.mime_type, "image/svg+xml");
        }
    }

    // Verify planning and read-only batch image extraction into TempDir on real data
    let (_pub_exp, export_plan) = state
        .plan_export_original_images(Some(export_id.clone()), "export", None, None)
        .unwrap();
    assert_eq!(export_plan.candidates.len(), stats.library.total_images);
    if let Some(first_proj) = stats.conversations.projects.first() {
        let (_p, proj_plan) = state
            .plan_export_original_images(
                Some(export_id.clone()),
                "project",
                None,
                Some(first_proj.id.clone()),
            )
            .unwrap();
        if proj_plan.existing_count > 0 {
            let real_out = TempDir::new().unwrap();
            let mut progress_hits = 0usize;
            let res = state
                .export_original_images_to_dir(
                    Some(export_id.clone()),
                    "project",
                    None,
                    Some(first_proj.id.clone()),
                    real_out.path().to_path_buf(),
                    |_| progress_hits += 1,
                )
                .unwrap();
            assert_eq!(res.exported_count, proj_plan.existing_count);
            assert!(res.total_bytes > 0);
            assert!(progress_hits >= 1);
            let out_dir = res.destination_dir.as_ref().unwrap();
            assert_no_empty_dirs(out_dir);
            assert_eq!(collect_files_recursive(out_dir).len(), res.exported_count);
        }
    }

    // Verify warm disk cache hit
    let warm_state = AppState::new_with_app_data(app_data.path(), Some(export_root)).unwrap();
    let warm_stats = warm_state.get_stats_response(Some(export_id)).unwrap();
    assert!(warm_stats.cache.hit, "Warm reload should hit disk cache");

    let other_count = stats.conversations.custom_gpt_conversations
        + stats.conversations.group_chat_conversations
        + stats.conversations.codex_conversations;
    eprintln!(
        "REAL_EXPORT_OK conversations={} regular={} projects={} project_chats={} other={} messages={} library_images={} linked={} gen_attached={} missing_img_parts={} newest_lib_at={:?}",
        stats.conversations.total_conversations,
        stats.conversations.regular_conversations,
        stats.conversations.projects.len(),
        stats.conversations.project_conversations,
        other_count,
        stats.conversations.total_messages,
        stats.library.total_images,
        stats.library.linked_images,
        total_gen_attached,
        total_missing_img_parts,
        lib_items.first().and_then(|item| item.item.created_at.as_deref())
    );
}

#[test]
fn commands_filter_conversations_by_scope_project_id_and_persist_project_aliases() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let export_dir = root.path().join("project-scope-export");
    fs::create_dir_all(&export_dir).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-reg",
                "title": "General Topic",
                "create_time": 1710000000,
                "update_time": 1710000100,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["General question"] } } }
                }
            },
            {
                "id": "conv-p1",
                "title": "Quiz Alpha",
                "conversation_template_id": "g-p-alpha123456",
                "create_time": 1710000200,
                "update_time": 1710000300,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Alpha body"] } } }
                }
            },
            {
                "id": "conv-p2",
                "title": "Notes Beta",
                "conversation_template_id": "g-p-beta789012",
                "create_time": 1710000400,
                "update_time": 1710000500,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Beta body"] } } }
                }
            }
        ]),
    );
    write_json(
        &export_dir.join("codex.json"),
        &json!([
            {
                "id": "cx-job",
                "title": "Fix Lint",
                "turns": [{ "id": "t1", "role": "user", "input_items": [{ "content": [{ "content_type": "text", "text": "Fix lint" }] }] }]
            }
        ]),
    );

    let state = AppState::new_with_app_data(app_data.path(), Some(root.path().to_path_buf())).unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let reg = state
        .get_conversations_filtered_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some("regular".to_string()),
            None,
            Some(0),
            Some(50),
        )
        .unwrap();
    assert_eq!(reg.items.len(), 1);
    assert_eq!(reg.items[0].id, "conv-reg");

    let projs = state
        .get_conversations_filtered_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some("project".to_string()),
            None,
            Some(0),
            Some(50),
        )
        .unwrap();
    assert_eq!(projs.items.len(), 2);

    let alpha_only = state
        .get_conversations_filtered_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some("project".to_string()),
            Some("g-p-alpha123456".to_string()),
            Some(0),
            Some(50),
        )
        .unwrap();
    assert_eq!(alpha_only.items.len(), 1);
    assert_eq!(alpha_only.items[0].id, "conv-p1");

    let both_projects = state
        .get_conversations_filtered_multi_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some("project".to_string()),
            Some(vec![
                "g-p-alpha123456".to_string(),
                "g-p-beta789012".to_string(),
            ]),
            Some(0),
            Some(50),
        )
        .unwrap();
    let mut both_ids: Vec<&str> = both_projects.items.iter().map(|i| i.id.as_str()).collect();
    both_ids.sort_unstable();
    assert_eq!(both_ids, vec!["conv-p1", "conv-p2"]);

    let other = state
        .get_conversations_filtered_response(
            Some(export_id.clone()),
            None,
            Some("all".to_string()),
            Some("other".to_string()),
            None,
            Some(0),
            Some(50),
        )
        .unwrap();
    assert_eq!(other.items.len(), 1);
    assert_eq!(other.items[0].id, "cx-job");

    let mut aliases = std::collections::BTreeMap::new();
    aliases.insert("g-p-alpha123456".to_string(), "Server Quiz".to_string());
    aliases.insert("g-p-beta789012".to_string(), "UI Study".to_string());
    let pref_res = state
        .update_preferences_full_response(None, None, Some(aliases))
        .unwrap();
    assert_eq!(
        pref_res.settings.project_aliases.get("g-p-alpha123456").map(String::as_str),
        Some("Server Quiz")
    );

    let alias_search = state
        .get_conversations_filtered_response(
            Some(export_id.clone()),
            Some("server quiz".to_string()),
            Some("all".to_string()),
            Some("all".to_string()),
            None,
            Some(0),
            Some(50),
        )
        .unwrap();
    assert_eq!(alias_search.items.len(), 1);
    assert_eq!(alias_search.items[0].id, "conv-p1");

    let mut clear = std::collections::BTreeMap::new();
    clear.insert("g-p-beta789012".to_string(), "   ".to_string());
    let updated = state.update_preferences_full_response(None, None, Some(clear)).unwrap();
    assert!(!updated.settings.project_aliases.contains_key("g-p-beta789012"));

    let reloaded = AppState::new_with_app_data(app_data.path(), Some(root.path().to_path_buf())).unwrap();
    let reloaded_aliases = reloaded.get_settings_response().unwrap().settings.project_aliases;
    assert_eq!(reloaded_aliases.get("g-p-alpha123456").map(String::as_str), Some("Server Quiz"));
    assert!(!reloaded_aliases.contains_key("g-p-beta789012"));
}

#[test]
fn commands_export_original_images_by_chat_project_and_export_scopes() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let export_dir = root.path().join("batch-images-export");
    fs::create_dir_all(&export_dir).unwrap();

    let png_bytes_a = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02];
    let png_bytes_b = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03, 0x04, 0x05];
    let svg_bytes = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"></svg>".to_vec();
    let jpeg_bytes = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    let proj_lib_png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x07];
    let lib_only_png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09];

    fs::write(export_dir.join("file_chat_a.dat"), &png_bytes_a).unwrap();
    fs::write(export_dir.join("file_chat_dup.dat"), &png_bytes_b).unwrap();
    fs::write(export_dir.join("file_proj_svg.dat"), &svg_bytes).unwrap();
    fs::write(export_dir.join("file_proj_conv_only.dat"), &jpeg_bytes).unwrap();
    fs::write(export_dir.join("file_proj_lib_only.dat"), &proj_lib_png).unwrap();
    fs::write(export_dir.join("file_lib_only.dat"), &lib_only_png).unwrap();
    fs::write(export_dir.join("file_notes_md.dat"), b"# Not an image").unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-chat",
                "title": "Chat: Pics?",
                "create_time": 1710000000,
                "update_time": 1710000100,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_chat_a", "content_type": "image_asset_pointer" },
                                    { "asset_pointer": "file-service://file_chat_dup", "content_type": "image_asset_pointer" },
                                    { "asset_pointer": "file-service://file_chat_missing", "content_type": "image_asset_pointer" },
                                    "look"
                                ]
                            },
                            "metadata": {
                                "attachments": [
                                    { "id": "file_chat_a", "name": "image.png", "mimeType": "image/png" },
                                    { "id": "file_chat_dup", "name": "image.png", "mimeType": "image/png" },
                                    { "id": "file_chat_missing", "name": "missing.png", "mimeType": "image/png" },
                                    { "id": "file_notes_md", "name": "notes.md", "mimeType": "text/markdown" }
                                ]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-proj",
                "title": "Project Diagram Chat",
                "conversation_template_id": "g-p-alpha123456",
                "create_time": 1710000200,
                "update_time": 1710000300,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m2",
                            "author": { "role": "assistant" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "sediment://file_proj_conv_only", "content_type": "image_asset_pointer" }
                                ]
                            }
                        }
                    }
                }
            }
        ]),
    );

    write_json(
        &export_dir.join("library_files.json"),
        &json!([
            {
                "file_id": "file_chat_a",
                "file_name": "image.png",
                "mime_type": "image/png",
                "library_file_category": "image",
                "origination_thread_id": "conv-chat"
            },
            {
                "file_id": "file_chat_dup",
                "file_name": "image.png",
                "mime_type": "image/png",
                "library_file_category": "image",
                "origination_thread_id": "conv-chat"
            },
            {
                "file_id": "file_proj_svg",
                "file_name": "arch-diagram",
                "mime_type": "image/svg+xml",
                "library_file_category": "image",
                "gizmo_id": "g-p-alpha123456",
                "is_project": true,
                "image_gen_generation_id": "gen_svg_1",
                "origination_thread_id": "conv-proj"
            },
            {
                "file_id": "file_proj_lib_only",
                "file_name": "proj-lib.png",
                "mime_type": "image/png",
                "library_file_category": "image",
                "gizmo_id": "g-p-alpha123456",
                "is_project": true
            },
            {
                "file_id": "file_lib_only",
                "file_name": "standalone.png",
                "mime_type": "image/png",
                "library_file_category": "image"
            }
        ]),
    );
    write_json(
        &export_dir.join("conversation_asset_file_names.json"),
        &json!({ "file_proj_conv_only.dat": "photo-shot" }),
    );

    let state =
        AppState::new_with_app_data(app_data.path(), Some(root.path().to_path_buf())).unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let mut aliases = std::collections::BTreeMap::new();
    aliases.insert("g-p-alpha123456".to_string(), "Server Quiz".to_string());
    state
        .update_preferences_full_response(None, None, Some(aliases))
        .unwrap();

    // 1. Specific conversation scope: single chat saves directly into date-prefixed <YYYY-MM-DD>_<title>-images folder
    let out_chat = TempDir::new().unwrap();
    let mut chat_events = Vec::new();
    let chat_res = state
        .export_original_images_to_dir(
            Some(export_id.clone()),
            "conversations",
            Some(vec!["conv-chat".to_string()]),
            None,
            out_chat.path().to_path_buf(),
            |p| chat_events.push(p),
        )
        .unwrap();
    assert_eq!(chat_res.scope, "conversations");
    assert_eq!(chat_res.exported_count, 2);
    assert_eq!(chat_res.skipped_missing, 1);
    assert_eq!(
        chat_res.total_bytes,
        (png_bytes_a.len() + png_bytes_b.len()) as u64
    );
    let chat_dir = chat_res.destination_dir.as_ref().unwrap();
    assert!(chat_dir
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("2024-03-09_Chat_Pics"));
    assert_eq!(std::fs::read(chat_dir.join("image.png")).unwrap(), png_bytes_a);
    assert_eq!(
        std::fs::read(chat_dir.join("image (2).png")).unwrap(),
        png_bytes_b
    );
    assert!(!chat_dir.join("notes.md").exists());
    assert_no_empty_dirs(chat_dir);
    assert_eq!(chat_events.len(), 2);

    // 2. Project scope: separates chat session folders and _Project Library
    let out_proj = TempDir::new().unwrap();
    let proj_res = state
        .export_original_images_to_dir(
            Some(export_id.clone()),
            "project",
            None,
            Some("g-p-alpha123456".to_string()),
            out_proj.path().to_path_buf(),
            |_| {},
        )
        .unwrap();
    assert_eq!(proj_res.scope_label, "Server Quiz");
    assert_eq!(proj_res.exported_count, 3);
    assert_eq!(proj_res.skipped_missing, 0);
    let proj_dir = proj_res.destination_dir.as_ref().unwrap();
    assert!(proj_dir
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("Server_Quiz"));
    assert_eq!(
        std::fs::read(
            proj_dir
                .join("2024-03-09_Project_Diagram_Chat")
                .join("arch-diagram.svg")
        )
        .unwrap(),
        svg_bytes
    );
    assert_eq!(
        std::fs::read(
            proj_dir
                .join("2024-03-09_Project_Diagram_Chat")
                .join("photo-shot.jpg")
        )
        .unwrap(),
        jpeg_bytes
    );
    assert_eq!(
        std::fs::read(proj_dir.join("_Project Library").join("proj-lib.png")).unwrap(),
        proj_lib_png
    );
    assert_no_empty_dirs(proj_dir);

    // 3. Whole-export scope: organizes by General/, Projects/<alias>/, _Project Library/, and _Library/
    let out_all = TempDir::new().unwrap();
    let all_res = state
        .export_original_images_to_dir(
            Some(export_id),
            "export",
            None,
            None,
            out_all.path().to_path_buf(),
            |_| {},
        )
        .unwrap();
    assert_eq!(all_res.exported_count, 6);
    assert_eq!(all_res.skipped_missing, 0);
    let all_dir = all_res.destination_dir.as_ref().unwrap();
    assert_eq!(
        std::fs::read(
            all_dir
                .join("General")
                .join("2024-03-09_Chat_Pics")
                .join("image.png")
        )
        .unwrap(),
        png_bytes_a
    );
    assert_eq!(
        std::fs::read(
            all_dir
                .join("General")
                .join("2024-03-09_Chat_Pics")
                .join("image (2).png")
        )
        .unwrap(),
        png_bytes_b
    );
    assert_eq!(
        std::fs::read(
            all_dir
                .join("Projects")
                .join("Server_Quiz")
                .join("2024-03-09_Project_Diagram_Chat")
                .join("arch-diagram.svg")
        )
        .unwrap(),
        svg_bytes
    );
    assert_eq!(
        std::fs::read(
            all_dir
                .join("Projects")
                .join("Server_Quiz")
                .join("2024-03-09_Project_Diagram_Chat")
                .join("photo-shot.jpg")
        )
        .unwrap(),
        jpeg_bytes
    );
    assert_eq!(
        std::fs::read(
            all_dir
                .join("Projects")
                .join("Server_Quiz")
                .join("_Project Library")
                .join("proj-lib.png")
        )
        .unwrap(),
        proj_lib_png
    );
    assert_eq!(
        std::fs::read(all_dir.join("_Library").join("standalone.png")).unwrap(),
        lib_only_png
    );
    assert_eq!(collect_files_recursive(all_dir).len(), 6);
    assert_no_empty_dirs(all_dir);

    // 4. Folder open path validation: allows exported directory, rejects arbitrary directory
    assert!(state
        .resolve_exported_images_dir(&all_dir.to_string_lossy())
        .is_ok());
    let unrelated = TempDir::new().unwrap();
    let err = state
        .resolve_exported_images_dir(&unrelated.path().to_string_lossy())
        .unwrap_err();
    assert!(matches!(err, gpt_export_viewer_lib::errors::AppError::PathEscapesRoot));
}

#[test]
fn commands_export_original_images_supports_multiple_projects_and_deduplicates() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let export_dir = root.path().join("multi-proj-images-export");
    fs::create_dir_all(&export_dir).unwrap();

    let bytes_a = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11];
    let bytes_b = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x22];
    let bytes_shared = vec![0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x33];
    let bytes_other = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44];

    fs::write(export_dir.join("file_p1.dat"), &bytes_a).unwrap();
    fs::write(export_dir.join("file_p2.dat"), &bytes_b).unwrap();
    fs::write(export_dir.join("file_shared.dat"), &bytes_shared).unwrap();
    fs::write(export_dir.join("file_other.dat"), &bytes_other).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-p1",
                "title": "Project 1 Chat",
                "conversation_template_id": "g-p-alpha123456",
                "create_time": 1710000000,
                "update_time": 1710000100,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_p1", "content_type": "image_asset_pointer" },
                                    { "asset_pointer": "file-service://file_shared", "content_type": "image_asset_pointer" }
                                ]
                            },
                            "metadata": {
                                "attachments": [
                                    { "id": "file_p1", "name": "alpha.png", "mimeType": "image/png" },
                                    { "id": "file_shared", "name": "shared.gif", "mimeType": "image/gif" }
                                ]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-p2",
                "title": "Project 2 Chat",
                "conversation_template_id": "g-p-beta789012",
                "create_time": 1710000200,
                "update_time": 1710000300,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m2",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_p2", "content_type": "image_asset_pointer" },
                                    { "asset_pointer": "file-service://file_shared", "content_type": "image_asset_pointer" }
                                ]
                            },
                            "metadata": {
                                "attachments": [
                                    { "id": "file_p2", "name": "beta.jpg", "mimeType": "image/jpeg" },
                                    { "id": "file_shared", "name": "shared.gif", "mimeType": "image/gif" }
                                ]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-reg",
                "title": "Regular Chat",
                "create_time": 1710000400,
                "update_time": 1710000500,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m3",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_other", "content_type": "image_asset_pointer" }
                                ]
                            }
                        }
                    }
                }
            }
        ]),
    );
    write_json(
        &export_dir.join("library_files.json"),
        &json!([
            {
                "file_id": "file_p1",
                "file_name": "alpha.png",
                "mime_type": "image/png",
                "library_file_category": "image",
                "gizmo_id": "g-p-alpha123456",
                "is_project": true,
                "origination_thread_id": "conv-p1"
            },
            {
                "file_id": "file_other",
                "file_name": "other.png",
                "mime_type": "image/png",
                "library_file_category": "image",
                "origination_thread_id": "conv-reg"
            }
        ]),
    );

    let state =
        AppState::new_with_app_data(app_data.path(), Some(root.path().to_path_buf())).unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let out_dir = TempDir::new().unwrap();
    let res = state
        .export_original_images_to_dir_multi(
            Some(export_id),
            "project",
            None,
            Some(vec![
                "g-p-alpha123456".to_string(),
                "g-p-beta789012".to_string(),
                "g-p-alpha123456".to_string(),
            ]),
            out_dir.path().to_path_buf(),
            |_| {},
        )
        .unwrap();

    assert_eq!(res.scope, "project");
    assert_eq!(res.scope_label, "2 projects");
    assert_eq!(res.exported_count, 4);
    assert_eq!(res.skipped_missing, 0);
    let dest = res.destination_dir.as_ref().unwrap();
    assert_eq!(
        dest.file_name().unwrap().to_string_lossy(),
        "2-projects-images"
    );
    let p1_sess = dest.join("Project_alpha1").join("2024-03-09_Project_1_Chat");
    let p2_sess = dest.join("Project_beta78").join("2024-03-09_Project_2_Chat");
    assert_eq!(std::fs::read(p1_sess.join("alpha.png")).unwrap(), bytes_a);
    assert_eq!(
        std::fs::read(p1_sess.join("shared.gif")).unwrap(),
        bytes_shared
    );
    assert_eq!(std::fs::read(p2_sess.join("beta.jpg")).unwrap(), bytes_b);
    assert_eq!(
        std::fs::read(p2_sess.join("shared.gif")).unwrap(),
        bytes_shared
    );
    assert!(!dest.join("other.png").exists());
    assert_eq!(collect_files_recursive(dest).len(), 4);
    assert_no_empty_dirs(dest);
}

#[test]
fn commands_export_multi_sessions_separates_folders_handles_title_collisions_and_skips_empty() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let export_dir = root.path().join("multi-sessions-export");
    fs::create_dir_all(&export_dir).unwrap();

    let png_a = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10];
    let png_b = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x20];
    fs::write(export_dir.join("file_s1.dat"), &png_a).unwrap();
    fs::write(export_dir.join("file_s2.dat"), &png_b).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-same-1",
                "title": "Same Title",
                "create_time": 1710000100,
                "update_time": 1710000100,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_s1", "content_type": "image_asset_pointer" }
                                ]
                            },
                            "metadata": {
                                "attachments": [{ "id": "file_s1", "name": "image.png", "mimeType": "image/png" }]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-same-2",
                "title": "Same Title",
                "create_time": 1710000100,
                "update_time": 1710000100,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m2",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_s2", "content_type": "image_asset_pointer" }
                                ]
                            },
                            "metadata": {
                                "attachments": [{ "id": "file_s2", "name": "image.png", "mimeType": "image/png" }]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-missing-only",
                "title": "Missing Only Session",
                "create_time": 1710000100,
                "update_time": 1710000100,
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "message": {
                            "id": "m3",
                            "author": { "role": "user" },
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "file-service://file_missing", "content_type": "image_asset_pointer" }
                                ]
                            },
                            "metadata": {
                                "attachments": [{ "id": "file_missing", "name": "gone.png", "mimeType": "image/png" }]
                            }
                        }
                    }
                }
            }
        ]),
    );

    let state =
        AppState::new_with_app_data(app_data.path(), Some(root.path().to_path_buf())).unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let out_dir = TempDir::new().unwrap();
    let res = state
        .export_original_images_to_dir(
            Some(export_id),
            "conversations",
            Some(vec![
                "conv-same-1".to_string(),
                "conv-same-2".to_string(),
                "conv-missing-only".to_string(),
            ]),
            None,
            out_dir.path().to_path_buf(),
            |_| {},
        )
        .unwrap();

    assert_eq!(res.scope_label, "3 sessions");
    assert_eq!(res.exported_count, 2);
    assert_eq!(res.skipped_missing, 1);
    let dest = res.destination_dir.as_ref().unwrap();
    assert_eq!(
        dest.file_name().unwrap().to_string_lossy(),
        "3-sessions-images"
    );
    assert_eq!(
        std::fs::read(dest.join("2024-03-09_Same_Title").join("image.png")).unwrap(),
        png_a
    );
    assert_eq!(
        std::fs::read(dest.join("2024-03-09_Same_Title (2)").join("image.png")).unwrap(),
        png_b
    );
    assert!(!dest.join("2024-03-09_Missing_Only_Session").exists());
    assert_eq!(std::fs::read_dir(dest).unwrap().count(), 2);
    assert_no_empty_dirs(dest);
}

#[test]
fn commands_save_sessions_organizes_by_general_project_alias_and_other() {
    let root = TempDir::new().unwrap();
    let app_data = TempDir::new().unwrap();
    let export_dir = root.path().join("organized-sessions-export");
    fs::create_dir_all(&export_dir).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-reg",
                "title": "Regular Chat",
                "create_time": 1710000100,
                "update_time": 1710000100,
                "mapping": {}
            },
            {
                "id": "conv-proj",
                "title": "Project Chat",
                "conversation_template_id": "g-p-alpha123456",
                "create_time": 1710000200,
                "update_time": 1710000200,
                "mapping": {}
            },
            {
                "id": "conv-gpt",
                "title": "GPT Helper",
                "gizmo_id": "g-custom999",
                "gizmo_type": "gpt",
                "create_time": 1710000300,
                "update_time": 1710000300,
                "mapping": {}
            }
        ]),
    );

    let state =
        AppState::new_with_app_data(app_data.path(), Some(root.path().to_path_buf())).unwrap();
    let export_id = state.get_exports_response().unwrap().exports[0].id.clone();

    let mut aliases = std::collections::BTreeMap::new();
    aliases.insert("g-p-alpha123456".to_string(), "Server Quiz".to_string());
    state
        .update_preferences_full_response(None, None, Some(aliases))
        .unwrap();

    let saved = state
        .save_sessions_response(
            Some(export_id),
            vec![
                "conv-reg".to_string(),
                "conv-proj".to_string(),
                "conv-gpt".to_string(),
            ],
            |_| {},
        )
        .unwrap();

    assert_eq!(saved.items.len(), 3);
    assert!(saved.items[0].path.starts_with(saved.destination_dir.join("General")));
    assert!(saved.items[1]
        .path
        .starts_with(saved.destination_dir.join("Projects").join("Server_Quiz")));
    assert!(saved.items[2].path.starts_with(saved.destination_dir.join("Other")));
    assert_no_empty_dirs(&saved.destination_dir);
}

fn collect_files_recursive(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(collect_files_recursive(&path));
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files
}

fn assert_no_empty_dirs(dir: &Path) {
    let entries: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        !entries.is_empty(),
        "Directory must not be empty: {}",
        dir.display()
    );
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            assert_no_empty_dirs(&path);
        }
    }
}

fn strip_code_blocks_for_test(input: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in input.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            let mut in_tick = false;
            for ch in line.chars() {
                if ch == '`' {
                    in_tick = !in_tick;
                } else if !in_tick {
                    out.push(ch);
                }
            }
            out.push('\n');
        }
    }
    out
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
