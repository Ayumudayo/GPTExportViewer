use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

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

pub fn assert_safe_regular_file(
    base_path: &Path,
    file_path: &Path,
) -> AppResult<std::fs::Metadata> {
    let base = std::fs::canonicalize(base_path).map_err(|_| AppError::PathEscapesRoot)?;
    let target = std::fs::canonicalize(file_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::AssetNotFound
        } else {
            crate::errors::io_error(file_path, error)
        }
    })?;
    if !is_inside(&base, &target) {
        return Err(AppError::PathEscapesRoot);
    }

    let link_info = std::fs::symlink_metadata(file_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::AssetNotFound
        } else {
            crate::errors::io_error(file_path, error)
        }
    })?;
    if link_info.file_type().is_symlink()
        || is_reparse_point(&link_info)
        || has_multiple_links(file_path, &link_info)
    {
        return Err(AppError::AssetNotFound);
    }

    let info = std::fs::metadata(file_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::AssetNotFound
        } else {
            crate::errors::io_error(file_path, error)
        }
    })?;
    if !info.is_file() {
        return Err(AppError::AssetNotFound);
    }
    Ok(info)
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
    let mut output = String::new();
    let mut last_was_underscore = false;
    for ch in value.trim().nfc() {
        let next = if ch.is_control()
            || ch.is_whitespace()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            '_'
        } else {
            ch
        };

        if next == '_' {
            if !last_was_underscore && !output.is_empty() {
                output.push(next);
            }
            last_was_underscore = true;
        } else {
            output.push(next);
            last_was_underscore = false;
        }
        if output.chars().count() >= 180 {
            break;
        }
    }

    while output.ends_with('_') {
        output.pop();
    }
    if output.is_empty() {
        "untitled".to_string()
    } else {
        output
    }
}

pub fn is_windows_reserved_stem(stem: &str) -> bool {
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn safe_folder_segment(raw: &str, fallback: &str, max_chars: usize) -> String {
    let base = safe_cache_name(raw);
    let cleaned = if base == "untitled" || base.is_empty() {
        safe_cache_name(fallback)
    } else {
        base
    };
    let truncated: String = cleaned.chars().take(max_chars.max(1)).collect();
    let trimmed = truncated.trim_matches(|ch: char| ch == '_' || ch == '.' || ch == ' ');
    if trimmed.is_empty() || is_windows_reserved_stem(trimmed) {
        "export".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn iso_date_prefix(iso: Option<&str>) -> Option<&str> {
    let trimmed = iso?.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes[..10]
        .iter()
        .enumerate()
        .all(|(idx, byte)| idx == 4 || idx == 7 || byte.is_ascii_digit())
    {
        return None;
    }
    Some(&trimmed[..10])
}

pub fn session_folder_base(
    title: &str,
    fallback_id: &str,
    primary_iso: Option<&str>,
    secondary_iso: Option<&str>,
) -> String {
    let title_seg = safe_folder_segment(title, fallback_id, 48);
    match iso_date_prefix(primary_iso).or_else(|| iso_date_prefix(secondary_iso)) {
        Some(date) => format!("{date}_{title_seg}"),
        None => title_seg,
    }
}

pub fn resolve_project_label(project_id: &str, project_aliases: &BTreeMap<String, String>) -> String {
    if let Some(alias) = project_aliases
        .get(project_id)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return alias.to_string();
    }
    let trimmed = project_id.trim();
    let stripped = trimmed
        .strip_prefix("g-p-")
        .or_else(|| trimmed.strip_prefix("g-"))
        .unwrap_or(trimmed);
    let short: String = stripped.chars().take(6).collect();
    if short.is_empty() {
        "Project".to_string()
    } else {
        format!("Project {short}")
    }
}

pub fn build_project_folder_map(
    project_ids: &[String],
    project_aliases: &BTreeMap<String, String>,
) -> HashMap<String, String> {
    let unique: BTreeSet<&str> = project_ids
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect();
    let mut used_lower = HashSet::with_capacity(unique.len());
    let mut map = HashMap::with_capacity(unique.len());
    for pid in unique {
        let label = resolve_project_label(pid, project_aliases);
        let base = safe_folder_segment(&label, pid, 48);
        let mut attempt = 1usize;
        let chosen = loop {
            let candidate = if attempt == 1 {
                base.clone()
            } else {
                format!("{base} ({attempt})")
            };
            let lower = candidate.to_ascii_lowercase();
            if used_lower.insert(lower) {
                break candidate;
            }
            attempt += 1;
        };
        map.insert(pid.to_string(), chosen);
    }
    map
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn has_multiple_links(path: &Path, _metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_NORMAL,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut info = std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>();
        let ok = GetFileInformationByHandle(handle, &mut info);
        CloseHandle(handle);
        ok != 0 && info.nNumberOfLinks > 1
    }
}

#[cfg(unix)]
fn has_multiple_links(_path: &Path, metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() > 1
}

#[cfg(not(any(windows, unix)))]
fn has_multiple_links(_path: &Path, _metadata: &std::fs::Metadata) -> bool {
    false
}
