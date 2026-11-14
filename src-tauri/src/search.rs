use std::collections::HashMap;

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

pub(crate) fn filter_conversation_indices(
    items: &[ConversationSummary],
    search_list: &[String],
    query: Option<&str>,
    filter: Option<&str>,
) -> Vec<usize> {
    let query = normalized_query(query);
    let filter = filter.unwrap_or("all");
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
            let Some(query) = query.as_deref() else {
                return true;
            };
            if let Some(search_text) = search_list.get(*idx).filter(|text| !text.is_empty()) {
                return search_text.contains(query);
            }
            [
                Some(item.title.as_str()),
                Some(item.preview.as_str()),
                item.model.as_deref(),
                Some(item.id.as_str()),
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

fn library_search_fields(item: &LibraryItem) -> [Option<&str>; 4] {
    [
        Some(item.display_name.as_str()),
        Some(item.mime.as_str()),
        Some(item.file_id.as_str()),
        item.source_conversation_id.as_deref(),
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
            source_message_id: None,
            source_state: source_state.to_string(),
            in_chat: source_state == "linked",
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
}
