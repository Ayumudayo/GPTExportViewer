use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::resolve_absolute;
use crate::models::WindowSize;

pub fn resolve_source_root(source_root: &Path) -> AppResult<PathBuf> {
    let resolved = resolve_absolute(source_root);
    let info = std::fs::metadata(&resolved)
        .map_err(|_| AppError::InvalidSourceRoot("directory not found".to_string()))?;
    if !info.is_dir() {
        return Err(AppError::InvalidSourceRoot("not a directory".to_string()));
    }
    Ok(resolved)
}

pub fn app_data_dir(app_name: &str) -> AppResult<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    Ok(base.join(app_name))
}

pub fn settings_file(app_name: &str) -> AppResult<PathBuf> {
    Ok(app_data_dir(app_name)?.join("settings.json"))
}

pub fn ensure_app_data_dir(app_name: &str) -> AppResult<PathBuf> {
    let dir = app_data_dir(app_name)?;
    std::fs::create_dir_all(&dir).map_err(|error| io_error(&dir, error))?;
    Ok(dir)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub source_root: Option<PathBuf>,
    pub selected_export_id: Option<String>,
    pub window_size: Option<WindowSize>,
    #[serde(default)]
    pub project_aliases: BTreeMap<String, String>,
}

pub fn read_runtime_settings(settings_path: &Path) -> AppResult<RuntimeSettings> {
    Ok(crate::cache::read_json(settings_path)?.unwrap_or_default())
}

pub fn write_runtime_settings(settings_path: &Path, settings: &RuntimeSettings) -> AppResult<()> {
    crate::cache::write_json_atomic(settings_path, settings)
}
