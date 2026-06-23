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
    const CLIENT: &str = r"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let keys = [
        format!(r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{CLIENT}"),
        format!(r"HKLM\Software\Microsoft\EdgeUpdate\Clients\{CLIENT}"),
        format!(r"HKLM\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{CLIENT}"),
    ];
    keys.iter().find_map(|key| query_runtime_version(key))
}

#[cfg(windows)]
fn query_runtime_version(key: &str) -> Option<String> {
    let output = std::process::Command::new("reg")
        .args(["query", key, "/v", "pv"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next()? == "pv").then(|| parts.last().map(str::to_string))?
    })
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
