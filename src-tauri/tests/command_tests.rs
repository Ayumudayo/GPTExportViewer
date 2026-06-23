use std::fs;
use std::path::Path;

use gpt_export_manager_lib::state::AppState;
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
        .starts_with("gpt-export-asset://library/"));

    let conversation = state
        .get_conversation_response(Some(export_id), "conv-1".to_string(), Some(0), Some(1))
        .unwrap();
    assert_eq!(conversation.messages.len(), 1);
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
    assert_eq!(one.indexed[0].cache_hit, false);

    let all = state.refresh_index_response(None).unwrap();
    assert_eq!(all.indexed.len(), 1);
    assert_eq!(all.indexed[0].cache_hit, false);
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
                "title": "Archived notes",
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
                "created_at": "2024-03-09T16:00:02Z",
                "state": "ready",
                "library_file_category": "image",
                "origination_thread_id": "conv-1",
                "origination_message_id": "m2"
            },
            {
                "file_id": "file-img-2",
                "file_name": "standalone.png",
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
