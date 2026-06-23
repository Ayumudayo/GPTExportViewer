use std::path::{Path, PathBuf};

use crate::errors::{AppError, AppResult};

pub fn assert_safe_file_id(file_id: &str) -> AppResult<&str> {
    if file_id.is_empty() || file_id.len() > 256 {
        return Err(AppError::InvalidFileId);
    }
    if file_id.contains('/') || file_id.contains('\\') || file_id.contains("..") {
        return Err(AppError::InvalidFileId);
    }
    if !file_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '@' | '-'))
    {
        return Err(AppError::InvalidFileId);
    }
    Ok(file_id)
}

pub fn resolve_inside(base_path: &Path, segment: impl AsRef<Path>) -> AppResult<PathBuf> {
    let base = resolve_absolute(base_path);
    let target = resolve_absolute(&base.join(segment));
    if is_inside(&base, &target) {
        Ok(target)
    } else {
        Err(AppError::PathEscapesRoot)
    }
}

pub fn is_inside(base_path: &Path, target_path: &Path) -> bool {
    let base = resolve_absolute(base_path);
    let target = resolve_absolute(target_path);
    target == base || target.starts_with(base)
}

pub fn resolve_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub fn safe_cache_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .take(180)
        .collect()
}
