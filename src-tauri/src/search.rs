use std::collections::{BTreeMap, HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

use crate::models::{ConversationSummary, LibraryItem};

pub(crate) fn build_conversation_search_list(
    items: &[ConversationSummary],
    search_texts: &HashMap<String, String>,
) -> Vec<String> {
    items
        .iter()
        .map(|item| search_texts.get(&item.id).cloned().unwrap_or_default())
        .collect()
}

pub(crate) fn build_library_lookup(items: &[LibraryItem]) -> (HashMap<String, usize>, Vec<String>) {
    let mut by_id = HashMap::with_capacity(items.len());
    let mut search_texts = Vec::with_capacity(items.len());
    for (idx, item) in items.iter().enumerate() {
        by_id.entry(item.file_id.clone()).or_insert(idx);
        by_id.entry(item.id.clone()).or_insert(idx);
        let mut search = String::new();
        for part in library_search_fields(item).into_iter().flatten() {
            if !search.is_empty() {
                search.push('\n');
            }
            search.push_str(&normalized_search_text(part));
        }
        search_texts.push(search);
    }
    (by_id, search_texts)
}

pub(crate) fn collect_unique_project_ids(
    project_id: Option<&str>,
    project_ids: Option<&[String]>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in project_ids.unwrap_or(&[]).iter().map(String::as_str).chain(project_id) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    }
    out
}

#[cfg(test)]
pub(crate) fn filter_conversation_indices(
    items: &[ConversationSummary],
    search_list: &[String],
    query: Option<&str>,
    filter: Option<&str>,
) -> Vec<usize> {
    filter_conversation_indices_with_scope(
        items,
        search_list,
        query,
        filter,
        None,
        &[],
        &BTreeMap::new(),
    )
}

pub(crate) fn filter_conversation_indices_with_scope(
    items: &[ConversationSummary],
    search_list: &[String],
    query: Option<&str>,
    filter: Option<&str>,
    scope: Option<&str>,
    project_ids: &[String],
    project_aliases: &BTreeMap<String, String>,
) -> Vec<usize> {
    let query = normalized_query(query);
    let filter = filter.unwrap_or("all");
    let scope = scope.unwrap_or("all");
    let project_id_set: HashSet<&str> = project_ids
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    items
        .iter()
        .enumerate()
        .filter(|(idx, item)| {
            if filter == "archived" && !item.archived {
                return false;
            }
            if filter == "active" && item.archived {
                return false;
            }
            let scope_matches = match scope {
                "regular" => item.kind == "regular",
                "project" => item.kind == "project",
                "custom_gpt" => item.kind == "custom_gpt",
                "group_chat" => item.kind == "group_chat",
                "codex" => item.kind == "codex",
                "other" => matches!(item.kind.as_str(), "custom_gpt" | "group_chat" | "codex"),
                _ => true,
            };
            if !scope_matches {
                return false;
            }
            if !project_id_set.is_empty()
                && !item
                    .project_id
                    .as_deref()
                    .is_some_and(|pid| project_id_set.contains(pid))
            {
                return false;
            }
            let Some(query) = query.as_deref() else {
                return true;
            };
            let alias = item
                .project_id
                .as_deref()
                .and_then(|pid| project_aliases.get(pid))
                .map(String::as_str);
            if alias.is_some_and(|value| normalized_search_text(value).contains(query)) {
                return true;
            }
            if let Some(search_text) = search_list.get(*idx).filter(|text| !text.is_empty()) {
                return search_text.contains(query);
            }
            [
                Some(item.title.as_str()),
                Some(item.preview.as_str()),
                item.model.as_deref(),
                Some(item.id.as_str()),
                item.project_id.as_deref(),
                item.gizmo_id.as_deref(),
                alias,
            ]
            .into_iter()
            .flatten()
            .any(|value| normalized_search_text(value).contains(query))
        })
        .map(|(idx, _)| idx)
        .collect()
}

pub(crate) fn filter_library_indices(
    items: &[LibraryItem],
    search_texts: &[String],
    query: Option<&str>,
    filter: Option<&str>,
) -> Vec<usize> {
    let query = normalized_query(query);
    let filter = filter.unwrap_or("all");
    items
        .iter()
        .enumerate()
        .filter(|(idx, item)| {
            if filter != "all" && item.source_state != filter {
                return false;
            }
            let Some(query) = query.as_deref() else {
                return true;
            };
            if let Some(search_text) = search_texts.get(*idx) {
                return search_text.contains(query);
            }
            library_search_fields(item)
                .into_iter()
                .flatten()
                .any(|value| normalized_search_text(value).contains(query))
        })
        .map(|(idx, _)| idx)
        .collect()
}

pub(crate) fn normalized_query(query: Option<&str>) -> Option<String> {
    query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalized_search_text)
}

pub(crate) fn normalized_search_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut prev_space = true;
    for ch in value.to_lowercase().nfc() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn library_search_fields(item: &LibraryItem) -> [Option<&str>; 5] {
    [
        Some(item.display_name.as_str()),
        Some(item.mime.as_str()),
        Some(item.file_id.as_str()),
        item.source_conversation_id.as_deref(),
        item.source_conversation_title.as_deref(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_conversation(id: &str, title: &str, preview: &str, archived: bool) -> ConversationSummary {
        ConversationSummary {
            id: id.to_string(),
            title: title.to_string(),
            created_at: None,
            updated_at: None,
            message_count: 2,
            attachment_count: 0,
            model: Some("gpt-4o".to_string()),
            archived,
            starred: false,
            kind: "regular".to_string(),
            project_id: None,
            gizmo_id: None,
            preview: preview.to_string(),
            last_role: Some("assistant".to_string()),
        }
    }

    fn sample_library_item(
        id: &str,
        file_id: &str,
        display_name: &str,
        source_state: &str,
    ) -> LibraryItem {
        LibraryItem {
            id: id.to_string(),
            file_id: file_id.to_string(),
            display_name: display_name.to_string(),
            filename: display_name.to_string(),
            original_name: None,
            mime: "image/png".to_string(),
            size_bytes: 1024,
            size_label: "1 KB".to_string(),
            width: Some(100),
            height: Some(100),
            created_at: None,
            status: "resolved".to_string(),
            file_ref: format!("file-service://{file_id}"),
            exists: true,
            source_conversation_id: Some("conv-1".to_string()),
            source_conversation_title: None,
            source_message_id: None,
            source_state: source_state.to_string(),
            in_chat: source_state == "linked",
            project_id: None,
        }
    }

    #[test]
    fn normalized_search_text_folds_case_whitespace_and_unicode_forms() {
        assert_eq!(normalized_search_text("  Hello\t\nWORLD  "), "hello world");
        let nfd_korean = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}";
        assert_eq!(normalized_search_text(nfd_korean), "한글");
    }

    #[test]
    fn filter_conversation_indices_applies_status_filter_and_search_fallback() {
        let items = vec![
            sample_conversation("c1", "Rust Ownership", "borrow checker notes", false),
            sample_conversation("c2", "Archived Chat", "old summary", true),
            sample_conversation("c3", "Design Spec", "modal layout", false),
        ];
        let search_list = vec![
            "rust ownership\nfull transcript body".to_string(),
            "archived chat".to_string(),
            String::new(),
        ];

        assert_eq!(
            filter_conversation_indices(&items, &search_list, None, Some("active")),
            vec![0, 2]
        );
        assert_eq!(
            filter_conversation_indices(&items, &search_list, None, Some("archived")),
            vec![1]
        );
        assert_eq!(
            filter_conversation_indices(&items, &search_list, Some("transcript"), Some("all")),
            vec![0]
        );
        assert_eq!(
            filter_conversation_indices(&items, &search_list, Some("  MODAL   layout "), Some("active")),
            vec![2]
        );
    }

    #[test]
    fn filter_library_indices_applies_source_state_and_lookup() {
        let items = vec![
            sample_library_item("img-1", "file-1", "Screen Shot.png", "linked"),
            sample_library_item("img-2", "file-2", "Banner.png", "library-only"),
        ];
        let (by_id, search_texts) = build_library_lookup(&items);
        assert_eq!(by_id.get("file-1"), Some(&0));
        assert_eq!(by_id.get("img-2"), Some(&1));

        assert_eq!(
            filter_library_indices(&items, &search_texts, None, Some("linked")),
            vec![0]
        );
        assert_eq!(
            filter_library_indices(&items, &search_texts, Some("banner"), Some("all")),
            vec![1]
        );
    }

    #[test]
    fn filter_conversation_indices_applies_scope_project_id_and_alias_search() {
        let mut p1 = sample_conversation("p1", "Quiz 1", "tcp vs udp", false);
        p1.kind = "project".to_string();
        p1.project_id = Some("g-p-alpha123".to_string());
        p1.gizmo_id = Some("g-p-alpha123".to_string());

        let mut p2 = sample_conversation("p2", "Quiz 2", "archived note", true);
        p2.kind = "project".to_string();
        p2.project_id = Some("g-p-beta999".to_string());
        p2.gizmo_id = Some("g-p-beta999".to_string());

        let reg = sample_conversation("r1", "General chat", "hello", false);
        let mut grp = sample_conversation("g1", "Dot group", "team chat", false);
        grp.kind = "group_chat".to_string();

        let items = vec![p1, p2, reg, grp];
        let search_list = vec![
            "quiz 1\ntcp vs udp".to_string(),
            "quiz 2\narchived note".to_string(),
            "general chat\nhello".to_string(),
            "dot group\nteam chat".to_string(),
        ];
        let mut aliases = BTreeMap::new();
        aliases.insert("g-p-alpha123".to_string(), "Server Quiz".to_string());

        assert_eq!(
            filter_conversation_indices_with_scope(
                &items,
                &search_list,
                None,
                Some("all"),
                Some("regular"),
                &[],
                &aliases,
            ),
            vec![2]
        );
        assert_eq!(
            filter_conversation_indices_with_scope(
                &items,
                &search_list,
                None,
                Some("all"),
                Some("project"),
                &[],
                &aliases,
            ),
            vec![0, 1]
        );
        assert_eq!(
            filter_conversation_indices_with_scope(
                &items,
                &search_list,
                None,
                Some("all"),
                Some("other"),
                &[],
                &aliases,
            ),
            vec![3]
        );
        assert_eq!(
            filter_conversation_indices_with_scope(
                &items,
                &search_list,
                None,
                Some("all"),
                Some("project"),
                &["g-p-beta999".to_string()],
                &aliases,
            ),
            vec![1]
        );
        assert_eq!(
            filter_conversation_indices_with_scope(
                &items,
                &search_list,
                None,
                Some("all"),
                Some("project"),
                &["g-p-alpha123".to_string(), "g-p-beta999".to_string()],
                &aliases,
            ),
            vec![0, 1]
        );
        assert_eq!(
            filter_conversation_indices_with_scope(
                &items,
                &search_list,
                Some("server quiz"),
                Some("all"),
                Some("all"),
                &[],
                &aliases,
            ),
            vec![0]
        );
    }
}
