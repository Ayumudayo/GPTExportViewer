use std::fs;
use std::path::{Path, PathBuf};

use gpt_export_manager_lib::{cache, exports, fs_guards, paging, settings, webview2};
use serde_json::json;
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
    let data_dir = settings::app_data_dir("GPTExportManager").unwrap();
    assert!(data_dir.ends_with("GPTExportManager"));
    assert!(!data_dir.to_string_lossy().contains(".cache"));
}

#[test]
fn foundations_webview2_version_rejects_older_runtime() {
    assert!(!webview2::is_version_at_least("109.0.1518.78", "110.0.1531.0"));
}

#[test]
fn foundations_webview2_version_accepts_minimum_and_newer_runtime() {
    assert!(webview2::is_version_at_least("110.0.1531.0", "110.0.1531.0"));
    assert!(webview2::is_version_at_least("120.0.2210.77", "110.0.1531.0"));
}

struct Fixture {
    root: TempDir,
    good: PathBuf,
}

fn make_export_fixture() -> Fixture {
    let root = TempDir::new().unwrap();
    let good = root.path().join("chatgpt-export-good");
    let partial = root.path().join("chatgpt-export-partial");
    fs::create_dir_all(&good).unwrap();
    fs::create_dir_all(&partial).unwrap();

    write_json(
        &good.join("conversations.json"),
        &json!([
            {
                "id": "conv-1",
                "title": "Alpha",
                "create_time": 1710000000,
                "update_time": 1710000600,
                "mapping": {}
            }
        ]),
    );
    write_json(&good.join("library_files.json"), &json!([]));
    write_json(&good.join("conversation_asset_file_names.json"), &json!({}));
    write_json(&partial.join("conversations.json"), &json!([]));

    Fixture { root, good }
}

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value).unwrap())).unwrap();
}
