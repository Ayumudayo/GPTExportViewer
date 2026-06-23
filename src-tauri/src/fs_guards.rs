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
