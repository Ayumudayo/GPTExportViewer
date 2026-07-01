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
    assert_eq!(linked.exists, true);
    assert_eq!(linked.width, Some(1024));
    assert_eq!(linked.height, Some(1536));
    assert_eq!(missing.source_state, "missing-source-chat");
    assert_eq!(missing.exists, false);
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
