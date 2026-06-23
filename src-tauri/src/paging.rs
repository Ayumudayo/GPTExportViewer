use crate::models::{Page, PagedItems};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pagination {
    pub cursor: usize,
    pub limit: usize,
}

pub fn parse_pagination(cursor: Option<usize>, limit: Option<usize>, default_limit: usize, max_limit: usize) -> Pagination {
    let safe_limit = limit.unwrap_or(default_limit).clamp(1, max_limit);
    Pagination {
        cursor: cursor.unwrap_or(0),
        limit: safe_limit,
    }
}

pub fn page_items<T: Clone>(items: &[T], cursor: usize, limit: usize, max_limit: usize) -> PagedItems<T> {
    let pagination = parse_pagination(Some(cursor), Some(limit), limit, max_limit);
    let end = pagination.cursor.saturating_add(pagination.limit);
    let sliced = items
        .iter()
        .skip(pagination.cursor)
        .take(pagination.limit)
        .cloned()
        .collect();
    PagedItems {
        items: sliced,
        page: Page {
            cursor: pagination.cursor,
            limit: pagination.limit,
            total: items.len(),
            next_cursor: (end < items.len()).then(|| end.to_string()),
        },
    }
}
