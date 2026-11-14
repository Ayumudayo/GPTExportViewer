use std::cmp::Ordering;

const MINIMUM_WEBVIEW2_VERSION: &str = "110.0.1531.0";

#[derive(Debug, thiserror::Error)]
pub enum WebView2Error {
    #[error("Microsoft Edge WebView2 Runtime {minimum} or newer is required.")]
    Missing { minimum: &'static str },
    #[error("Microsoft Edge WebView2 Runtime {minimum} or newer is required. Installed version: {installed}.")]
    TooOld {
        installed: String,
        minimum: &'static str,
    },
}

pub fn preflight_webview2_runtime() -> Result<(), WebView2Error> {
    match installed_webview2_version() {
        Some(version) if is_version_at_least(&version, MINIMUM_WEBVIEW2_VERSION) => Ok(()),
        Some(version) => Err(WebView2Error::TooOld {
            installed: version,
            minimum: MINIMUM_WEBVIEW2_VERSION,
        }),
        None => Err(WebView2Error::Missing {
            minimum: MINIMUM_WEBVIEW2_VERSION,
        }),
    }
}

pub fn is_version_at_least(installed: &str, minimum: &str) -> bool {
    compare_versions(installed, minimum) != Ordering::Less
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = parse_version(left);
    let right_parts = parse_version(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_part = *left_parts.get(index).unwrap_or(&0);
        let right_part = *right_parts.get(index).unwrap_or(&0);
        match left_part.cmp(&right_part) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

fn parse_version(value: &str) -> Vec<u64> {
    value
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

#[cfg(windows)]
fn installed_webview2_version() -> Option<String> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const SUBKEY_STANDARD: &str =
        r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const SUBKEY_WOW64: &str =
        r"Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    [
        (HKEY_CURRENT_USER, SUBKEY_STANDARD),
        (HKEY_LOCAL_MACHINE, SUBKEY_STANDARD),
        (HKEY_LOCAL_MACHINE, SUBKEY_WOW64),
    ]
    .into_iter()
    .find_map(|(root, subkey)| query_runtime_version(root, subkey))
}

#[cfg(windows)]
fn query_runtime_version(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    let subkey_wide = wide(subkey);
    let value_wide = wide("pv");
    let mut bytes_needed: u32 = 0;
    let status = unsafe {
        RegGetValueW(
            root,
            subkey_wide.as_ptr(),
            value_wide.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes_needed,
        )
    };
    if status != ERROR_SUCCESS || bytes_needed < 2 {
        return None;
    }

    let mut buffer = vec![0u16; (bytes_needed as usize).div_ceil(2)];
    let mut buffer_bytes = (buffer.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            subkey_wide.as_ptr(),
            value_wide.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut buffer_bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    let u16_len = (buffer_bytes as usize / 2).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..u16_len]);
    let trimmed = text.trim_end_matches('\0').trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(not(windows))]
fn installed_webview2_version() -> Option<String> {
    Some(MINIMUM_WEBVIEW2_VERSION.to_string())
}

#[cfg(test)]
mod tests {
    use super::is_version_at_least;

    #[test]
    fn webview2_version_rejects_older_runtime() {
        assert!(!is_version_at_least("109.0.1518.78", "110.0.1531.0"));
    }

    #[test]
    fn webview2_version_accepts_minimum_runtime() {
        assert!(is_version_at_least("110.0.1531.0", "110.0.1531.0"));
    }

    #[test]
    fn webview2_version_accepts_newer_runtime() {
        assert!(is_version_at_least("120.0.2210.77", "110.0.1531.0"));
    }
}
