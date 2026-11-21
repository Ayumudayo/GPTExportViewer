use std::fs;
use std::path::{Path, PathBuf};

use gpt_export_viewer_lib::{
    asset_protocol, cache, conversations, exports, fs_guards, library, paging, settings, webview2,
};
use serde_json::json;
use sha1::{Digest, Sha1};
use tempfile::TempDir;

#[test]
fn foundations_source_root_validation_rejects_missing_paths() {
    let missing = PathBuf::from("Z:/definitely/missing/gpt-export-root");
    let error = settings::resolve_source_root(&missing).unwrap_err();
    assert_eq!(error.code(), "invalid_source_root");
}

#[test]
fn foundations_export_discovery_detects_nested_and_direct_exports() {
    let fixture = make_export_fixture();
    let exports = exports::scan_exports(fixture.root.path()).unwrap();
    let names: Vec<_> = exports.iter().map(|item| item.name.as_str()).collect();
    assert!(names.contains(&"chatgpt-export-good"));
    assert!(names.contains(&"chatgpt-export-partial"));

    let direct = exports::scan_exports(&fixture.good).unwrap();
    assert_eq!(direct.len(), 1);
    assert_eq!(direct[0].name, "chatgpt-export-good");
}

#[test]
fn foundations_stable_export_ids_are_deterministic() {
    let fixture = make_export_fixture();
    let left = exports::stable_export_id(&fixture.good);
    let right = exports::stable_export_id(&fixture.good);
    assert_eq!(left, right);
    assert_eq!(left.len(), 12);
}

#[test]
fn foundations_pagination_clamps_cursor_and_limit() {
    let values = vec![1, 2, 3, 4, 5];
    let page = paging::page_items(&values, 1, 2, 10);
    assert_eq!(page.items, vec![2, 3]);
    assert_eq!(page.page.cursor, 1);
    assert_eq!(page.page.limit, 2);
    assert_eq!(page.page.total, 5);
    assert_eq!(page.page.next_cursor.as_deref(), Some("3"));

    let clamped = paging::parse_pagination(Some(0), Some(500), 50, 100);
    assert_eq!(clamped.limit, 100);
}

#[test]
fn foundations_safe_file_ids_reject_path_traversal() {
    assert!(fs_guards::assert_safe_file_id("file-img-1").is_ok());
    assert!(fs_guards::assert_safe_file_id("..\\escape").is_err());
    assert!(fs_guards::assert_safe_file_id("../escape").is_err());
}

#[test]
fn foundations_safe_cache_names_preserve_unicode_and_normalize() {
    assert_eq!(fs_guards::safe_cache_name("U\u{0308}ber 한글"), "Über_한글");
}

#[test]
fn foundations_cache_writes_json_atomically_and_compares_fingerprints() {
    let temp = TempDir::new().unwrap();
    let cache_file = temp.path().join("nested/sample.json");
    cache::write_json_atomic(&cache_file, &json!({ "ok": true })).unwrap();
    let value: serde_json::Value = cache::read_json(&cache_file).unwrap().unwrap();
    assert_eq!(value, json!({ "ok": true }));

    let fingerprint = cache::file_fingerprint(&cache_file).unwrap();
    assert!(cache::fingerprints_equal(&fingerprint, &fingerprint));
}

#[test]
fn foundations_settings_path_uses_app_data_not_repo_cache() {
    let data_dir = settings::app_data_dir("GPTExportViewer").unwrap();
    assert!(data_dir.ends_with("GPTExportViewer"));
    assert!(!data_dir.to_string_lossy().contains(".cache"));
}

#[test]
fn foundations_webview2_version_rejects_older_runtime() {
    assert!(!webview2::is_version_at_least(
        "109.0.1518.78",
        "110.0.1531.0"
    ));
}

#[test]
fn foundations_webview2_version_accepts_minimum_and_newer_runtime() {
    assert!(webview2::is_version_at_least(
        "110.0.1531.0",
        "110.0.1531.0"
    ));
    assert!(webview2::is_version_at_least(
        "120.0.2210.77",
        "110.0.1531.0"
    ));
}

#[test]
fn conversations_read_array_or_object_shapes() {
    let fixture = make_export_fixture();
    let array_items = conversations::summary_index::read_conversation_array(
        &fixture.good.join("conversations.json"),
    )
    .unwrap();
    assert_eq!(array_items.len(), 3);

    let object_file = fixture.root.path().join("object-conversations.json");
    write_json(
        &object_file,
        &json!({ "conversations": [array_items[0].clone()] }),
    );
    let object_items = conversations::summary_index::read_conversation_array(&object_file).unwrap();
    assert_eq!(object_items.len(), 1);
}

#[test]
fn conversations_summary_index_sorts_and_counts_messages() {
    let fixture = make_export_fixture();
    let export_item = exports::describe_export(&fixture.good).unwrap();
    let index =
        conversations::summary_index::build_conversation_summary_index(&export_item).unwrap();
    assert_eq!(index.items.len(), 3);
    assert_eq!(index.items[0].title, "Parent only chain");
    assert_eq!(
        index
            .items
            .iter()
            .find(|item| item.id == "conv-1")
            .unwrap()
            .message_count,
        2
    );
    assert_eq!(index.stats.total_messages, 6);
}

#[test]
fn conversations_normalize_parent_only_mapping_in_parent_order() {
    let fixture = make_export_fixture();
    let conversations = conversations::summary_index::read_conversation_array(
        &fixture.good.join("conversations.json"),
    )
    .unwrap();
    let parent_only = conversations
        .iter()
        .find(|item| item["id"] == "conv-parent-only")
        .unwrap();
    let normalized = conversations::normalize::normalize_conversation(parent_only).unwrap();
    let texts: Vec<_> = normalized
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect();
    assert_eq!(
        texts,
        vec!["Root message", "Child message", "Grandchild message"]
    );
}

#[test]
fn conversations_normalize_multimodal_text_and_asset_refs() {
    let fixture = make_export_fixture();
    let conversations = conversations::summary_index::read_conversation_array(
        &fixture.good.join("conversations.json"),
    )
    .unwrap();
    let first = conversations
        .iter()
        .find(|item| item["id"] == "conv-1")
        .unwrap();
    let normalized = conversations::normalize::normalize_conversation(first).unwrap();
    assert_eq!(normalized.messages[1].text, "Here is image\nDone");
    assert!(normalized.messages[1]
        .asset_refs
        .iter()
        .any(|asset| asset.file_id == "file-img-1"));
}

#[test]
fn conversations_normalize_multimodal_parts_keep_user_image_order() {
    let conversation = json!({
        "id": "conv-with-user-image",
        "mapping": {
            "msg1": {
                "id": "msg1",
                "parent": null,
                "children": [],
                "message": {
                    "id": "m1",
                    "author": { "role": "user" },
                    "create_time": 1780990666.348,
                    "content": {
                        "content_type": "multimodal_text",
                        "parts": [
                            {
                                "asset_pointer": "sediment://file-user-image",
                                "content_type": "image_asset_pointer",
                                "height": 1536,
                                "width": 1024
                            },
                            "Please adjust this image"
                        ]
                    },
                    "metadata": {
                        "attachments": [
                            {
                                "height": 1536,
                                "id": "file-user-image",
                                "mime_type": "image/png",
                                "name": "input.png",
                                "source": "local",
                                "width": 1024
                            }
                        ]
                    }
                }
            }
        }
    });
    let normalized = conversations::normalize::normalize_conversation(&conversation).unwrap();
    let message = &normalized.messages[0];

    assert_eq!(message.text, "Please adjust this image");
    assert_eq!(message.asset_refs.len(), 1);
    assert_eq!(message.asset_refs[0].file_id, "file-user-image");
    assert_eq!(message.asset_refs[0].name.as_deref(), Some("input.png"));
    assert_eq!(message.parts.len(), 2);
    assert_eq!(message.parts[0].part_type, "image");
    assert_eq!(message.parts[0].file_id.as_deref(), Some("file-user-image"));
    assert_eq!(message.parts[0].name.as_deref(), Some("input.png"));
    assert_eq!(message.parts[0].mime_type.as_deref(), Some("image/png"));
    assert_eq!(message.parts[0].width, Some(1024));
    assert_eq!(message.parts[0].height, Some(1536));
    assert_eq!(message.parts[1].part_type, "text");
    assert_eq!(
        message.parts[1].text.as_deref(),
        Some("Please adjust this image")
    );
}

#[test]
fn conversations_legacy_cached_messages_without_parts_do_not_break_loading() {
    let fixture = make_export_fixture();
    let export_item = exports::describe_export(&fixture.good).unwrap();
    let conversations_fingerprint =
        cache::file_fingerprint(&export_item.paths.conversations).unwrap();
    let old_digest = legacy_conversation_cache_digest(
        "conv-1",
        &conversations_fingerprint.path.to_string_lossy(),
        conversations_fingerprint.size,
        conversations_fingerprint.mtime_ms,
        conversations_fingerprint.missing,
    );
    let legacy_cache_file = fixture
        .cache_dir
        .path()
        .join(&export_item.id)
        .join("conversations")
        .join(format!("conv-1-{old_digest}.json"));
    let legacy_cache = json!({
        "id": "conv-1",
        "title": "Legacy cached conversation",
        "createdAt": null,
        "updatedAt": null,
        "model": null,
        "archived": false,
        "starred": false,
        "totalMessages": 1,
        "messages": [
            {
                "id": "legacy",
                "nodeId": "legacy",
                "ordinal": 1,
                "role": "user",
                "author": "user",
                "createdAt": null,
                "contentType": "text",
                "text": "legacy cache should not be reused",
                "assetRefs": []
            }
        ]
    });
    cache::write_json_atomic(&legacy_cache_file, &legacy_cache).unwrap();

    let loaded = conversations::load::load_conversation(
        &export_item,
        "conv-1",
        fixture.cache_dir.path(),
        0,
        2,
    )
    .unwrap()
    .unwrap();

    assert_eq!(loaded.messages[0].text, "Please make an image");
    assert_eq!(loaded.messages[0].parts[0].part_type, "text");
}

#[test]
fn conversations_load_conversation_pages_messages_and_range() {
    let fixture = make_export_fixture();
    let export_item = exports::describe_export(&fixture.good).unwrap();
    let loaded = conversations::load::load_conversation(
        &export_item,
        "conv-parent-only",
        fixture.cache_dir.path(),
        0,
        2,
    )
    .unwrap()
    .unwrap();
    let texts: Vec<_> = loaded
        .messages
        .iter()
        .map(|message| message.text.as_str())
        .collect();
    assert_eq!(texts, vec!["Root message", "Child message"]);
    assert_eq!(loaded.range.unwrap().next_start, Some(2));
}

#[test]
fn conversations_malformed_json_returns_parse_failed() {
    let fixture = make_export_fixture();
    let malformed = fixture.root.path().join("malformed.json");
    fs::write(&malformed, "{ not json").unwrap();
    let error = conversations::summary_index::read_conversation_array(&malformed).unwrap_err();
    assert_eq!(error.code(), "parse_failed");
}

#[test]
fn library_index_keeps_images_and_resolves_source_states() {
    let fixture = make_export_fixture();
    let export_item = exports::describe_export(&fixture.good).unwrap();
    let index = library::index::build_library_index(
        &export_item,
        &["conv-1".to_string()].into_iter().collect(),
    )
    .unwrap();
    assert_eq!(index.items.len(), 2);
    let linked = index
        .items
        .iter()
        .find(|item| item.file_id == "file-img-1")
        .unwrap();
    let missing = index
        .items
        .iter()
        .find(|item| item.file_id == "file-img-missing")
        .unwrap();
    assert_eq!(linked.display_name, "renamed library.png");
    assert_eq!(linked.source_state, "linked");
    assert!(linked.exists);
    assert_eq!(linked.width, Some(1024));
    assert_eq!(linked.height, Some(1536));
    assert_eq!(missing.source_state, "missing-source-chat");
    assert!(!missing.exists);
    assert_eq!(missing.width, None);
    assert_eq!(missing.height, None);
    assert_eq!(index.stats.total_images, 2);
}

#[test]
fn library_asset_resolution_rejects_invalid_ids_and_sanitizes_missing_assets() {
    let fixture = make_export_fixture();
    let export_item = exports::describe_export(&fixture.good).unwrap();
    let index = library::index::build_library_index(
        &export_item,
        &["conv-1".to_string()].into_iter().collect(),
    )
    .unwrap();
    let asset = library::assets::resolve_asset(&export_item, "file-img-1", &index.items).unwrap();
    assert_eq!(asset.mime_type, "image/png");
    assert!(asset.file_path.ends_with("file-img-1.dat"));

    assert_eq!(
        library::assets::resolve_asset(&export_item, "..\\escape", &index.items)
            .unwrap_err()
            .code(),
        "invalid_file_id"
    );
    assert_eq!(
        library::assets::resolve_asset(&export_item, "file-img-missing", &index.items)
            .unwrap_err()
            .code(),
        "asset_not_found"
    );
}

#[test]
fn library_asset_resolution_rejects_linked_assets() {
    let fixture = make_export_fixture();
    let export_item = exports::describe_export(&fixture.good).unwrap();
    let outside = fixture.root.path().join("outside.png");
    fs::write(&outside, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
    std::fs::hard_link(&outside, fixture.good.join("file-img-linked.dat")).unwrap();

    let error = library::assets::resolve_asset(&export_item, "file-img-linked", &[])
        .unwrap_err()
        .code()
        .to_string();
    assert_eq!(error, "asset_not_found");
}

#[test]
fn library_mime_sniffing_detects_common_image_types() {
    let fixture = make_export_fixture();
    assert_eq!(
        library::mime::sniff_mime(&fixture.good.join("file-img-1.dat"), None).unwrap(),
        "image/png"
    );
}

#[test]
fn library_asset_protocol_accepts_only_library_urls() {
    let parsed =
        asset_protocol::parse_asset_url("gpt-export-asset://library/export%201/file-img-1")
            .unwrap();
    assert_eq!(parsed.export_id, "export 1");
    assert_eq!(parsed.file_id, "file-img-1");
    assert!(!parsed.thumbnail);

    let parsed_thumb = asset_protocol::parse_asset_url(
        "http://gpt-export-asset.localhost/library/export%201/file-img-1?thumb=1",
    )
    .unwrap();
    assert_eq!(parsed_thumb.export_id, "export 1");
    assert_eq!(parsed_thumb.file_id, "file-img-1");
    assert!(parsed_thumb.thumbnail);
    let windows_bridge = asset_protocol::parse_asset_url(
        "http://gpt-export-asset.localhost/library/export%201/file-img-1",
    )
    .unwrap();
    assert_eq!(windows_bridge.export_id, "export 1");
    assert_eq!(windows_bridge.file_id, "file-img-1");
    let reverted_windows_bridge = asset_protocol::parse_asset_url(
        "gpt-export-asset://localhost/library/export%201/file-img-1",
    )
    .unwrap();
    assert_eq!(reverted_windows_bridge.export_id, "export 1");
    assert_eq!(reverted_windows_bridge.file_id, "file-img-1");
    let unicode =
        asset_protocol::parse_asset_url("gpt-export-asset://library/%C3%9Cber-export/file-img-1")
            .unwrap();
    assert_eq!(unicode.export_id, "Über-export");
    assert!(asset_protocol::parse_asset_url("gpt-export-asset://other/export/file").is_err());
    assert!(asset_protocol::parse_asset_url("file:///C:/secret.png").is_err());
    assert!(asset_protocol::parse_asset_url("gpt-export-asset://library/%FF/file-img-1").is_err());
    assert!(
        asset_protocol::parse_asset_url("gpt-export-asset://library/export/..%5Cescape?thumb=1")
            .is_err()
    );
}

#[test]
fn foundations_export_modified_at_uses_rfc3339_utc() {
    let fixture = make_export_fixture();
    let scanned = exports::scan_exports(&fixture.good).unwrap();
    assert_eq!(scanned.len(), 1);
    let modified_at = &scanned[0].modified_at;
    assert!(
        modified_at.contains('T') && modified_at.ends_with('Z'),
        "expected RFC3339 UTC timestamp, got {modified_at}"
    );
    assert!(
        modified_at.parse::<chrono::DateTime<chrono::Utc>>().is_ok(),
        "modified_at should parse as RFC3339: {modified_at}"
    );
}

#[test]
fn conversations_filter_hidden_and_empty_system_nodes_and_write_jsonl_offsets() {
    let root = TempDir::new().unwrap();
    let cache_dir = TempDir::new().unwrap();
    let export_dir = root.path().join("filtered-export");
    fs::create_dir_all(&export_dir).unwrap();
    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-filtered",
                "title": "Hidden Node Test",
                "create_time": 1710000000,
                "update_time": 1710000100,
                "current_node": "n5",
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "children": ["n2"],
                        "message": {
                            "id": "sys-empty",
                            "author": { "role": "system" },
                            "content": { "content_type": "text", "parts": [""] }
                        }
                    },
                    "n2": {
                        "id": "n2",
                        "parent": "n1",
                        "children": ["n3"],
                        "message": {
                            "id": "sys-hidden",
                            "author": { "role": "system" },
                            "metadata": { "is_visually_hidden_from_conversation": true },
                            "content": { "content_type": "text", "parts": ["Secret system instruction"] }
                        }
                    },
                    "n3": {
                        "id": "n3",
                        "parent": "n2",
                        "children": ["n4"],
                        "message": {
                            "id": "sys-ctx",
                            "author": { "role": "system" },
                            "content": {
                                "content_type": "user_editable_context",
                                "user_profile": "Profile text"
                            }
                        }
                    },
                    "n4": {
                        "id": "n4",
                        "parent": "n3",
                        "children": ["n5"],
                        "message": {
                            "id": "u1",
                            "author": { "role": "user" },
                            "content": { "content_type": "text", "parts": ["Visible question"] }
                        }
                    },
                    "n5": {
                        "id": "n5",
                        "parent": "n4",
                        "children": [],
                        "message": {
                            "id": "a1",
                            "author": { "role": "assistant" },
                            "content": { "content_type": "text", "parts": ["Visible answer"] }
                        }
                    }
                }
            }
        ]),
    );

    let export_item = exports::scan_exports(&export_dir).unwrap().remove(0);
    let jsonl_path = cache_dir.path().join("conversations-normalized.jsonl");
    let artifacts =
        conversations::summary_index::build_conversation_artifacts(&export_item, &jsonl_path)
            .unwrap();

    assert_eq!(artifacts.index.items.len(), 1);
    let summary = &artifacts.index.items[0];
    assert_eq!(summary.message_count, 2);

    let &(offset, len) = artifacts.offsets.get("conv-filtered").unwrap();
    let loaded = conversations::load::read_conversation_from_jsonl(&jsonl_path, offset, len).unwrap();
    assert_eq!(loaded.total_messages, 2);
    assert_eq!(summary.message_count, loaded.total_messages);
    assert_eq!(loaded.messages.len(), 2);
    assert_eq!(loaded.messages[0].ordinal, 1);
    assert_eq!(loaded.messages[0].text, "Visible question");
    assert_eq!(loaded.messages[1].ordinal, 2);
    assert_eq!(loaded.messages[1].text, "Visible answer");
}

struct Fixture {
    root: TempDir,
    cache_dir: TempDir,
    good: PathBuf,
}

fn make_export_fixture() -> Fixture {
    let root = TempDir::new().unwrap();
    let cache_dir = TempDir::new().unwrap();
    let good = root.path().join("chatgpt-export-good");
    let partial = root.path().join("chatgpt-export-partial");
    fs::create_dir_all(&good).unwrap();
    fs::create_dir_all(&partial).unwrap();

    write_json(
        &good.join("conversations.json"),
        &json!([
            {
                "id": "conv-1",
                "conversation_id": "thread-1",
                "title": "Alpha image work",
                "create_time": 1710000000,
                "update_time": 1710000600,
                "current_node": "msg2",
                "default_model_slug": "gpt-4o",
                "is_archived": false,
                "is_starred": true,
                "mapping": {
                    "root": { "id": "root", "parent": null, "children": ["msg1"] },
                    "msg1": {
                        "id": "msg1",
                        "parent": "root",
                        "children": ["msg2"],
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "create_time": 1710000001,
                            "content": { "content_type": "text", "parts": ["Please make an image"] },
                            "metadata": {
                                "attachments": [{ "file_id": "file-input", "name": "input.png", "mime_type": "image/png" }]
                            }
                        }
                    },
                    "msg2": {
                        "id": "msg2",
                        "parent": "msg1",
                        "children": [],
                        "message": {
                            "id": "m2",
                            "author": { "role": "assistant" },
                            "create_time": 1710000002,
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [{ "content_type": "text", "text": "Here is image" }, "Done"]
                            },
                            "metadata": {
                                "attachments": [{ "file_id": "file-img-1", "name": "library.png", "mime_type": "image/png" }]
                            }
                        }
                    }
                }
            },
            {
                "id": "conv-2",
                "title": "Beta notes",
                "create_time": 1710000900,
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
                            "create_time": 1710000901,
                            "content": { "text": "Loose text shape" }
                        }
                    }
                }
            },
            {
                "id": "conv-parent-only",
                "title": "Parent only chain",
                "create_time": 1710001100,
                "update_time": 1710001300,
                "mapping": {
                    "parentRoot": {
                        "id": "parentRoot",
                        "parent": null,
                        "message": {
                            "id": "pm1",
                            "author": { "role": "user" },
                            "create_time": 1710001101,
                            "content": { "content_type": "text", "parts": ["Root message"] }
                        }
                    },
                    "parentChild": {
                        "id": "parentChild",
                        "parent": "parentRoot",
                        "message": {
                            "id": "pm2",
                            "author": { "role": "assistant" },
                            "create_time": 1710001102,
                            "content": { "content_type": "text", "parts": ["Child message"] }
                        }
                    },
                    "parentGrandchild": {
                        "id": "parentGrandchild",
                        "parent": "parentChild",
                        "message": {
                            "id": "pm3",
                            "author": { "role": "user" },
                            "create_time": 1710001103,
                            "content": { "content_type": "text", "parts": ["Grandchild message"] }
                        }
                    }
                }
            }
        ]),
    );
    write_json(
        &good.join("library_files.json"),
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
                "file_id": "file-doc-1",
                "file_name": "notes.txt",
                "mime_type": "text/plain",
                "file_size_bytes": 4,
                "created_at": "2024-03-09T16:00:04Z",
                "state": "ready",
                "library_file_category": "file"
            },
            {
                "file_id": "file-img-missing",
                "file_name": "missing.png",
                "mime_type": "image/png",
                "file_size_bytes": 99,
                "created_at": "2024-03-09T16:00:05Z",
                "state": "ready",
                "library_file_category": "image",
                "origination_thread_id": "missing-conv"
            }
        ]),
    );
    write_json(
        &good.join("conversation_asset_file_names.json"),
        &json!({ "file-img-1.dat": "renamed library.png" }),
    );
    fs::write(
        good.join("file-img-1.dat"),
        png_header_with_dimensions(1024, 1536),
    )
    .unwrap();
    write_json(&partial.join("conversations.json"), &json!([]));

    Fixture {
        root,
        cache_dir,
        good,
    }
}

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .unwrap();
}

fn png_header_with_dimensions(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::from([0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes
}

fn legacy_conversation_cache_digest(
    conversation_id: &str,
    fingerprint_path: &str,
    fingerprint_size: Option<u64>,
    fingerprint_mtime_ms: Option<u128>,
    fingerprint_missing: bool,
) -> String {
    let mut hasher = Sha1::new();
    hasher.update(conversation_id.as_bytes());
    hasher.update(fingerprint_path.as_bytes());
    hasher.update(fingerprint_size.unwrap_or_default().to_le_bytes());
    hasher.update(fingerprint_mtime_ms.unwrap_or_default().to_le_bytes());
    hasher.update([u8::from(fingerprint_missing)]);
    format!("{:x}", hasher.finalize())[..16].to_string()
}

#[test]
fn library_thumbnail_generator_downscales_and_caches_large_images() {
    let temp = tempfile::tempdir().unwrap();
    let src_path = temp.path().join("large.png");
    let cache_dir = temp.path().join("cache");

    let img = image::RgbImage::from_fn(1200, 900, |x, y| {
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
    image::DynamicImage::ImageRgb8(img)
        .save_with_format(&src_path, image::ImageFormat::Png)
        .unwrap();

    let src_len = std::fs::metadata(&src_path).unwrap().len();
    assert!(
        src_len > 48 * 1024,
        "synthetic source PNG should exceed 48KB bypass threshold (got {src_len})"
    );

    let resolved = gpt_export_viewer_lib::models::ResolvedAsset {
        file_id: "file-large-1".to_string(),
        file_path: src_path.clone(),
        file_name: "large.png".to_string(),
        mime_type: "image/png".to_string(),
        size: src_len,
    };

    let (mime, bytes) =
        gpt_export_viewer_lib::library::thumbnails::read_or_create_thumbnail(&resolved, &cache_dir)
            .unwrap();
    assert_eq!(mime, "image/jpeg");

    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width(), 384);
    assert_eq!(decoded.height(), 288);

    let thumbs_dir = cache_dir.join("thumbs");
    let cached_entries: Vec<_> = std::fs::read_dir(&thumbs_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jpg"))
        .collect();
    assert_eq!(cached_entries.len(), 1);
    assert_eq!(std::fs::read(cached_entries[0].path()).unwrap(), bytes);

    let (mime_cached, bytes_cached) =
        gpt_export_viewer_lib::library::thumbnails::read_or_create_thumbnail(&resolved, &cache_dir)
            .unwrap();
    assert_eq!(mime_cached, "image/jpeg");
    assert_eq!(bytes_cached, bytes);
}

#[test]
fn conversations_skip_thoughts_reasoning_recap_nonfinal_and_empty_turns() {
    let conv = json!({
        "id": "conv-modern-skip",
        "title": "Modern Skip Test",
        "create_time": 1780000000,
        "update_time": 1780000500,
        "current_node": "n8",
        "mapping": {
            "n0": { "id": "n0", "parent": null, "children": ["n1"] },
            "n1": {
                "id": "n1",
                "parent": "n0",
                "children": ["n2"],
                "message": {
                    "id": "m1",
                    "author": { "role": "user" },
                    "content": { "content_type": "text", "parts": [""] },
                    "metadata": {
                        "attachments": [{ "id": "file_att1", "name": "handoff.md", "mime_type": "text/markdown" }]
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
                    "content": { "content_type": "thoughts", "thoughts": [{ "summary": "Thinking", "content": "Secret" }] }
                }
            },
            "n3": {
                "id": "n3",
                "parent": "n2",
                "children": ["n4"],
                "message": {
                    "id": "m3",
                    "author": { "role": "assistant" },
                    "content": { "content_type": "reasoning_recap", "content": "Thought for 5s" }
                }
            },
            "n4": {
                "id": "n4",
                "parent": "n3",
                "children": ["n5"],
                "message": {
                    "id": "m4",
                    "author": { "role": "assistant" },
                    "content": { "content_type": "text", "parts": [""] }
                }
            },
            "n5": {
                "id": "n5",
                "parent": "n4",
                "children": ["n6"],
                "message": {
                    "id": "m5",
                    "author": { "role": "assistant" },
                    "channel": "commentary",
                    "content": { "content_type": "text", "parts": ["Commentary channel hidden"] }
                }
            },
            "n6": {
                "id": "n6",
                "parent": "n5",
                "children": ["n7"],
                "message": {
                    "id": "m6",
                    "author": { "role": "assistant" },
                    "recipient": "python",
                    "content": { "content_type": "code", "text": "print(1)" }
                }
            },
            "n7": {
                "id": "n7",
                "parent": "n6",
                "children": ["n8"],
                "message": {
                    "id": "m7",
                    "author": { "role": "assistant" },
                    "content": { "content_type": "text", "parts": ["\u{E200}memcite\u{E201}"] }
                }
            },
            "n8": {
                "id": "n8",
                "parent": "n7",
                "children": [],
                "message": {
                    "id": "m8",
                    "author": { "role": "assistant" },
                    "channel": "final",
                    "recipient": "all",
                    "content": { "content_type": "text", "parts": ["Final visible answer"] }
                }
            }
        }
    });

    let normalized = conversations::normalize::normalize_conversation(&conv).unwrap();
    assert_eq!(normalized.total_messages, 2);
    assert_eq!(normalized.messages[0].id, "m1");
    assert_eq!(normalized.messages[0].asset_refs[0].file_id, "file_att1");
    assert_eq!(normalized.messages[1].id, "m8");
    assert_eq!(normalized.messages[1].text, "Final visible answer");
}

#[test]
fn conversations_clean_pua_tokens_rich_tags_and_widgets_preserving_code() {
    let raw = [
        "Hello \u{E200}memcite\u{E201}\u{E200}entity\u{E202}[\"other\",\"TOSE\",\"Test\"]\u{E201}!",
        "Check \u{E200}cite\u{E202}turn0search0\u{E201} and \u{E200}genui\u{E202}{\"citation\":{\"ref\":\"turn1view0\"}}\u{E201}.",
        "Visit \u{E200}url\u{E202}Docs\u{E202}https://example.com/docs?utm_source=chatgpt.com\u{E201} and \u{E200}url\u{E202}Thread\u{E202}turn0search0\u{E201}.",
        "Inline <Entity category=\"software\" value=\"spark\"/> with <Cite ref=\"turn0search0\"/> and <Link url=\"https://example.com/a?utm_source=chatgpt.com\" title=\"Alpha\"/> and <Link url=\"https://example.com/b\">Beta</Link>.",
        "<CodeCite citation_id=\"1\"/><FileCite ref=\"turn0file0\"/><MemoryCite /><AsyncImage query=\"x\"/>",
        "<MapWidgetV2 points={[{\"id\":\"a\",\"name\":\"Colosseum\",\"address\":\"Rome, Italy\"}]} carousel={{visibility:\"hidden\"}}/>",
        "<box border radius=\"xl\" padding={3}>",
        "  <row align=\"center\" gap={2}>",
        "    <icon name=\"check-circle\" color=\"success\"/>",
        "    <title>Status</title>",
        "    <badge color=\"success\">OK</badge>",
        "  </row>",
        "  <divider color=\"subtle\"/>",
        "  <grid columns={2}>",
        "    {#each [{t:\"One\",d:\"Desc 1\"},{t:\"Two\",d:\"Desc 2\"}] as x}",
        "      <box><text>{x.t}</text><text>{x.d}</text></box>",
        "    {/each}",
        "  </grid>",
        "  <list marker=\"number\">",
        "    <list-item>First step</list-item>",
        "    <list-item>",
        "      Second step",
        "      ```text",
        "      <config>\\keep_me<int>",
        "      ```",
        "    </list-item>",
        "  </list>",
        "  <table>",
        "    <table-row><table-cell>Col</table-cell><table-cell>Val</table-cell></table-row>",
        "    <table-row><table-cell>A</table-cell><table-cell>1 | 2</table-cell></table-row>",
        "  </table>",
        "  <svg viewBox=\"0 0 100 100\">",
        "    <rect x=\"0\" y=\"0\" width=\"100\" height=\"100\"/>",
        "    <text x=\"50\" y=\"50\">Diagram Label</text>",
        "  </svg>",
        "</box>",
        "Inline code `std::vector<int>` stays untouched."
    ]
    .join("\n");

    let metadata = json!({
        "content_references": [
            {
                "type": "client_defined_widget"
            },
            {
                "type": "grouped_webpages",
                "items": [
                    {
                        "attribution": "ExifTool",
                        "title": "ExifTool FAQ",
                        "url": "https://exiftool.org/faq.html?utm_source=chatgpt.com",
                        "refs": [{ "turn_index": 0, "ref_type": "search", "ref_index": 0 }]
                    },
                    {
                        "attribution": "Probe",
                        "title": "Probe",
                        "url": "https://example.com/probe",
                        "refs": [{ "turn_index": 1, "ref_type": "view", "ref_index": 0 }]
                    }
                ]
            }
        ]
    });

    let cleaned = conversations::text_cleanup::clean_message_text(&raw, &metadata);
    assert!(!cleaned.contains('\u{E200}') && !cleaned.contains('\u{E201}') && !cleaned.contains('\u{E202}'));
    assert!(!cleaned.contains("<Entity"));
    assert!(!cleaned.contains("<Cite"));
    assert!(!cleaned.contains("<Link"));
    assert!(!cleaned.contains("<MapWidget"));
    assert!(!cleaned.contains("<CodeCite"));
    assert!(!cleaned.contains("<FileCite"));
    assert!(!cleaned.contains("<MemoryCite"));
    assert!(!cleaned.contains("<AsyncImage"));
    assert!(!cleaned.contains("<box"));
    assert!(!cleaned.contains("<svg"));
    assert!(!cleaned.contains("{#each"));
    assert!(cleaned.contains("TOSE"));
    assert!(cleaned.contains("([ExifTool](https://exiftool.org/faq.html))"));
    assert!(cleaned.contains("([Probe](https://example.com/probe))"));
    assert!(cleaned.contains("[Docs](https://example.com/docs)"));
    assert!(cleaned.contains("[Thread](https://exiftool.org/faq.html)"));
    assert!(cleaned.contains("spark"));
    assert!(cleaned.contains("[Alpha](https://example.com/a)"));
    assert!(cleaned.contains("[Beta](https://example.com/b)"));
    assert!(cleaned.contains("- **Colosseum** — Rome, Italy"));
    assert!(cleaned.contains("✓ **Status** · `OK`"));
    assert!(cleaned.contains("One"));
    assert!(cleaned.contains("Desc 2"));
    assert!(cleaned.contains("1. First step"));
    assert!(cleaned.contains("2. Second step"));
    assert!(cleaned.contains("```text\n<config>\\keep_me<int>\n```"));
    assert!(cleaned.contains("| Col | Val |\n| --- | --- |\n| A | 1 \\| 2 |"));
    assert!(cleaned.contains("- Diagram Label"));
    assert!(cleaned.contains("`std::vector<int>`"));

    let fence_pua = [
        "```",
        "code line",
        "```\u{E200}filecite\u{E202}turn2file0\u{E201}",
        "After <Entity value=\"keep\"/> and `<keep_code>` prose",
        "```",
        "other code",
        "```\u{E200}cite\u{E202}turn0search0\u{E201}",
    ]
    .join("\n");
    let fence_cleaned = conversations::text_cleanup::clean_message_text(&fence_pua, &metadata);
    assert!(!fence_cleaned.contains('\u{E200}'));
    assert!(!fence_cleaned.contains("<Entity"));
    assert!(fence_cleaned.contains("```\ncode line\n```\nAfter keep and `<keep_code>` prose"));
    assert!(fence_cleaned.contains("```\nother code\n```\n\n([ExifTool](https://exiftool.org/faq.html))"));
}

#[test]
fn library_svg_support_timestamp_fallbacks_and_conversation_only_assets() {
    let root = TempDir::new().unwrap();
    let export_dir = root.path().join("modern-lib-export");
    fs::create_dir_all(&export_dir).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-modern",
                "title": "Modern Library Session",
                "create_time": 1780000000,
                "update_time": 1780000100,
                "current_node": "n1",
                "mapping": {
                    "n1": {
                        "id": "n1",
                        "parent": null,
                        "children": [],
                        "message": {
                            "id": "m1",
                            "author": { "role": "user" },
                            "create_time": 1780000050,
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    { "asset_pointer": "sediment://file_no_orig", "content_type": "image_asset_pointer", "width": 320, "height": 240 },
                                    { "asset_pointer": "sediment://file_conv_only", "content_type": "image_asset_pointer" }
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
                "file_id": "file_svg_1",
                "file_name": "diagram.svg",
                "mime_type": "image/svg+xml",
                "record_creation_time": "2026-11-18T16:04:02.000Z",
                "state": "ready",
                "library_file_category": "image"
            },
            {
                "file_id": "file_no_orig",
                "file_name": "upload-without-orig.png",
                "mime_type": "image/png",
                "file_upload_time": "2026-11-17T10:00:00Z",
                "state": "ready",
                "library_file_category": "image"
            }
        ]),
    );

    write_json(
        &export_dir.join("conversation_asset_file_names.json"),
        &json!({ "file_conv_only.dat": "chat-only-pic.png" }),
    );

    fs::write(
        export_dir.join("file_svg_1.dat"),
        br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360"/></svg>"#,
    )
    .unwrap();
    fs::write(
        export_dir.join("file_no_orig.dat"),
        png_header_with_dimensions(320, 240),
    )
    .unwrap();
    fs::write(
        export_dir.join("file_conv_only.dat"),
        png_header_with_dimensions(800, 600),
    )
    .unwrap();

    assert_eq!(
        library::mime::sniff_mime(&export_dir.join("file_svg_1.dat"), None).unwrap(),
        "image/svg+xml"
    );
    assert_eq!(
        library::dimensions::read_image_dimensions(&export_dir.join("file_svg_1.dat"), "image/svg+xml"),
        Some((640, 360))
    );

    let export_item = exports::describe_export(&export_dir).unwrap();
    let cache_dir = TempDir::new().unwrap();
    let preloaded = library::index::preload_library_context(&export_item).unwrap();
    let artifacts = conversations::summary_index::build_conversation_artifacts_with_context(
        &export_item,
        &cache_dir.path().join("convs.jsonl"),
        &preloaded,
    )
    .unwrap();
    let lib_index = library::index::build_library_index_with_context(
        &export_item,
        &preloaded,
        &artifacts.conversation_titles,
        &artifacts.conversation_assets,
    )
    .unwrap();

    assert_eq!(lib_index.items.len(), 3);
    assert_eq!(lib_index.items[0].file_id, "file_svg_1");
    assert_eq!(lib_index.items[0].width, Some(640));
    assert_eq!(lib_index.items[0].height, Some(360));
    assert_eq!(lib_index.items[0].created_at.as_deref(), Some("2026-11-18T16:04:02.000Z"));

    let fallback_linked = lib_index
        .items
        .iter()
        .find(|item| item.file_id == "file_no_orig")
        .unwrap();
    assert_eq!(fallback_linked.source_state, "linked");
    assert_eq!(fallback_linked.source_conversation_id.as_deref(), Some("conv-modern"));
    assert_eq!(
        fallback_linked.source_conversation_title.as_deref(),
        Some("Modern Library Session")
    );

    let synth = lib_index
        .items
        .iter()
        .find(|item| item.file_id == "file_conv_only")
        .unwrap();
    assert_eq!(synth.display_name, "chat-only-pic.png");
    assert_eq!(synth.source_state, "linked");
    assert_eq!(synth.width, Some(800));
    assert_eq!(synth.height, Some(600));
    assert_eq!(
        synth.source_conversation_title.as_deref(),
        Some("Modern Library Session")
    );
}

#[test]
fn exports_discover_sharded_conversations_group_chats_and_codex() {
    let root = TempDir::new().unwrap();
    let export_dir = root.path().join("sharded-export");
    fs::create_dir_all(&export_dir).unwrap();

    write_json(
        &export_dir.join("export_manifest.json"),
        &json!({
            "version": 1,
            "logical_files": {
                "conversations.json": {
                    "files": ["conversations-000.json", "conversations-001.json"],
                    "shard_count": 2,
                    "sharded": true
                }
            }
        }),
    );
    write_json(
        &export_dir.join("conversations-000.json"),
        &json!([
            {
                "id": "conv-shard-0",
                "title": "Shard Zero",
                "create_time": 1710000000,
                "update_time": 1710000010,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Zero"] } } }
                }
            }
        ]),
    );
    write_json(
        &export_dir.join("conversations-001.json"),
        &json!([
            {
                "id": "conv-shard-1",
                "title": "Shard One",
                "create_time": 1710000100,
                "update_time": 1710000110,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["One"] } } }
                }
            }
        ]),
    );
    write_json(
        &export_dir.join("group_chats.json"),
        &json!({
            "chats": [
                {
                    "id": "gc-1",
                    "name": "Team Room",
                    "created_at": "2026-10-29T07:33:30Z",
                    "last_action_at": "2026-11-07T08:00:30Z",
                    "messages": [
                        { "id": "gm2", "role": "user", "text": "Second newest", "created_at": "2026-11-07T08:00:30Z", "attachments": [] },
                        { "id": "gm1", "role": "user", "text": "First oldest", "created_at": "2026-10-29T07:33:45Z", "attachments": [] }
                    ]
                }
            ]
        }),
    );
    write_json(
        &export_dir.join("codex.json"),
        &json!([
            {
                "id": "task-1",
                "title": "Codex Task",
                "archived": true,
                "turns": [
                    { "id": "t1", "role": "user", "input_items": [{ "type": "message", "content": [{ "content_type": "text", "text": "Fix bug" }] }] },
                    { "id": "t2", "role": "assistant", "output_items": [{ "type": "message", "content": [{ "content_type": "text", "text": "Fixed it." }] }] }
                ]
            }
        ]),
    );

    let export_item = exports::scan_exports(&export_dir).unwrap().remove(0);
    assert!(export_item.has_conversations);
    assert_eq!(export_item.paths.conversation_files.len(), 2);
    assert!(export_item.paths.group_chats.is_some());
    assert!(export_item.paths.codex.is_some());

    let cache_dir = TempDir::new().unwrap();
    let jsonl = cache_dir.path().join("all.jsonl");
    let artifacts = conversations::summary_index::build_conversation_artifacts(&export_item, &jsonl).unwrap();
    assert_eq!(artifacts.index.items.len(), 4);

    let &(gc_off, gc_len) = artifacts.offsets.get("gc-1").unwrap();
    let gc_loaded = conversations::load::read_conversation_from_jsonl(&jsonl, gc_off, gc_len).unwrap();
    assert_eq!(gc_loaded.title, "Team Room");
    assert_eq!(gc_loaded.messages[0].text, "First oldest");
    assert_eq!(gc_loaded.messages[1].text, "Second newest");

    let &(cx_off, cx_len) = artifacts.offsets.get("task-1").unwrap();
    let cx_loaded = conversations::load::read_conversation_from_jsonl(&jsonl, cx_off, cx_len).unwrap();
    assert_eq!(cx_loaded.title, "Codex Task");
    assert!(cx_loaded.archived);
    assert_eq!(cx_loaded.messages[0].text, "Fix bug");
    assert_eq!(cx_loaded.messages[1].text, "Fixed it.");
}

#[test]
fn conversations_classify_regular_project_custom_gpt_group_chat_and_codex_with_project_stats() {
    let root = TempDir::new().unwrap();
    let export_dir = root.path().join("mixed-kinds-export");
    fs::create_dir_all(&export_dir).unwrap();

    write_json(
        &export_dir.join("conversations.json"),
        &json!([
            {
                "id": "conv-regular",
                "title": "Regular Talk",
                "create_time": 1710000000,
                "update_time": 1710000010,
                "memory_scope": "global_enabled",
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Hi"] } } }
                }
            },
            {
                "id": "conv-proj-1",
                "title": "Server Quiz 1",
                "conversation_template_id": "g-p-6ad9093a00d08191b3079e881628bf24",
                "memory_scope": "global_enabled",
                "create_time": 1710000100,
                "update_time": 1710000200,
                "is_archived": false,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Quiz"] } } }
                }
            },
            {
                "id": "conv-proj-2",
                "title": "Project V2 Chat",
                "conversation_template_id": "g-p-6ae615e03ea8819192e67016a714bd97",
                "memory_scope": "project_v2",
                "create_time": 1710000300,
                "update_time": 1710000350,
                "is_archived": true,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Hello"] } } }
                }
            },
            {
                "id": "conv-gpt",
                "title": "Translator GPT",
                "gizmo_id": "g-translator99",
                "gizmo_type": "gpt",
                "create_time": 1710000400,
                "update_time": 1710000450,
                "mapping": {
                    "n1": { "id": "n1", "parent": null, "message": { "id": "m1", "author": { "role": "user" }, "content": { "content_type": "text", "parts": ["Translate"] } } }
                }
            }
        ]),
    );
    write_json(
        &export_dir.join("library_files.json"),
        &json!([
            {
                "file_id": "file_proj_doc",
                "file_name": "Notes.html",
                "mime_type": "text/html",
                "gizmo_id": "g-p-6ad9093a00d08191b3079e881628bf24",
                "is_project": true
            },
            {
                "file_id": "file_proj_img",
                "file_name": "diagram.png",
                "mime_type": "image/png",
                "library_file_category": "image",
                "gizmo_id": "g-p-6ad9093a00d08191b3079e881628bf24",
                "is_project": true
            }
        ]),
    );
    write_json(
        &export_dir.join("group_chats.json"),
        &json!({
            "chats": [
                {
                    "id": "gc-room",
                    "name": "Group Room",
                    "created_at": "2026-11-01T00:00:00Z",
                    "last_action_at": "2026-11-01T01:00:00Z",
                    "messages": [{ "id": "gm1", "role": "user", "text": "Group msg", "created_at": "2026-11-01T01:00:00Z" }]
                }
            ]
        }),
    );
    write_json(
        &export_dir.join("codex.json"),
        &json!([
            {
                "id": "cx-1",
                "title": "Codex Job",
                "turns": [{ "id": "t1", "role": "user", "input_items": [{ "content": [{ "content_type": "text", "text": "Run tests" }] }] }]
            }
        ]),
    );

    let export_item = exports::describe_export(&export_dir).unwrap();
    let cache_dir = TempDir::new().unwrap();
    let preloaded = library::index::preload_library_context(&export_item).unwrap();
    let jsonl = cache_dir.path().join("all.jsonl");
    let artifacts = conversations::summary_index::build_conversation_artifacts_with_context(
        &export_item,
        &jsonl,
        &preloaded,
    )
    .unwrap();
    let lib_index = library::index::build_library_index_with_context(
        &export_item,
        &preloaded,
        &artifacts.conversation_titles,
        &artifacts.conversation_assets,
    )
    .unwrap();

    let stats = &artifacts.index.stats;
    assert_eq!(stats.total_conversations, 6);
    assert_eq!(stats.regular_conversations, 1);
    assert_eq!(stats.project_conversations, 2);
    assert_eq!(stats.custom_gpt_conversations, 1);
    assert_eq!(stats.group_chat_conversations, 1);
    assert_eq!(stats.codex_conversations, 1);
    assert_eq!(stats.projects.len(), 2);

    assert_eq!(stats.projects[0].id, "g-p-6ae615e03ea8819192e67016a714bd97");
    assert_eq!(stats.projects[0].conversation_count, 1);
    assert_eq!(stats.projects[0].archived_count, 1);
    assert_eq!(stats.projects[0].sample_title.as_deref(), Some("Project V2 Chat"));

    assert_eq!(stats.projects[1].id, "g-p-6ad9093a00d08191b3079e881628bf24");
    assert_eq!(stats.projects[1].conversation_count, 1);
    assert_eq!(stats.projects[1].file_count, 2);

    assert_eq!(lib_index.items.len(), 1);
    assert_eq!(
        lib_index.items[0].project_id.as_deref(),
        Some("g-p-6ad9093a00d08191b3079e881628bf24")
    );
}

#[test]
fn library_export_sanitizes_and_deduplicates_original_image_filenames() {
    let dir = TempDir::new().unwrap();
    let mut used = std::collections::HashSet::new();

    assert_eq!(
        library::export::sanitize_image_filename("file_abc.dat", "file_abc", "image/webp"),
        "file_abc.webp"
    );
    assert_eq!(
        library::export::sanitize_image_filename("f61d0d67-922a", "f61d0d67", "image/jpeg"),
        "f61d0d67-922a.jpg"
    );
    assert_eq!(
        library::export::sanitize_image_filename("Report v1.2", "file_rv", "image/png"),
        "Report v1.2.png"
    );
    assert_eq!(
        library::export::sanitize_image_filename("CON.png", "file_con_1", "image/png"),
        "file_con_1.png"
    );
    assert_eq!(
        library::export::sanitize_image_filename(" diagram<1>:final?.svg ", "file_s1", "image/svg+xml"),
        "diagram_1__final_.svg"
    );

    let first = library::export::unique_image_filename(
        dir.path(),
        &mut used,
        "image.png",
        "file_1",
        "image/png",
    );
    let second = library::export::unique_image_filename(
        dir.path(),
        &mut used,
        "IMAGE.PNG",
        "file_2",
        "image/png",
    );
    fs::write(dir.path().join("image (3).png"), b"existing").unwrap();
    let third = library::export::unique_image_filename(
        dir.path(),
        &mut used,
        "image.png",
        "file_3",
        "image/png",
    );
    assert_eq!(first, "image.png");
    assert_eq!(second, "IMAGE (2).png");
    assert_eq!(third, "image (4).png");
}

#[test]
fn conversations_normalize_file_service_uri_preserves_actual_file_id() {
    let raw = json!({
        "id": "conv-file-service",
        "title": "URI Schemes",
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
                            { "asset_pointer": "file-service://file-Abc123", "content_type": "image_asset_pointer" },
                            { "asset_pointer": "file-service://file_0001", "content_type": "image_asset_pointer" },
                            { "asset_pointer": "sediment://file_0002", "content_type": "image_asset_pointer" }
                        ]
                    }
                }
            }
        }
    });
    let conv = conversations::normalize::normalize_conversation(&raw).unwrap();
    assert_eq!(conv.messages.len(), 1);
    let ids: Vec<_> = conv.messages[0]
        .parts
        .iter()
        .filter_map(|part| part.file_id.as_deref())
        .collect();
    assert_eq!(ids, vec!["file-Abc123", "file_0001", "file_0002"]);
}

#[test]
fn foundations_folder_naming_helpers_format_dates_aliases_and_collisions() {
    assert_eq!(
        fs_guards::iso_date_prefix(Some("2026-11-18T16:29:11Z")),
        Some("2026-11-18")
    );
    assert_eq!(fs_guards::iso_date_prefix(Some("unknown-date")), None);
    assert_eq!(
        fs_guards::session_folder_base(
            "CON",
            "conv-con",
            Some("2026-11-18T16:29:11Z"),
            None,
        ),
        "2026-11-18_export"
    );
    assert_eq!(
        fs_guards::session_folder_base(
            "UI & Quiz: Part 1?",
            "conv-1",
            None,
            Some("2026-03-14T10:00:00Z"),
        ),
        "2026-03-14_UI_&_Quiz_Part_1"
    );
    assert_eq!(fs_guards::safe_folder_segment("NUL", "fallback", 48), "export");
    let long_seg = fs_guards::safe_folder_segment(&"가".repeat(60), "fallback", 48);
    assert_eq!(long_seg.chars().count(), 48);

    let mut aliases = std::collections::BTreeMap::new();
    aliases.insert("g-p-aaa111".to_string(), "Study Notes".to_string());
    aliases.insert("g-p-bbb222".to_string(), "study notes".to_string());
    let map = fs_guards::build_project_folder_map(
        &[
            "g-p-bbb222".to_string(),
            "g-p-aaa111".to_string(),
            "g-p-ccc333".to_string(),
        ],
        &aliases,
    );
    assert_eq!(map.get("g-p-aaa111").map(String::as_str), Some("Study_Notes"));
    assert_eq!(map.get("g-p-bbb222").map(String::as_str), Some("study_notes (2)"));
    assert_eq!(map.get("g-p-ccc333").map(String::as_str), Some("Project_ccc333"));
}
