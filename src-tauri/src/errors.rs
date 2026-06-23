use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Invalid source root: {0}")]
    InvalidSourceRoot(String),
    #[error("Export not found")]
    ExportNotFound,
    #[error("Invalid file id")]
    InvalidFileId,
    #[error("Asset file not found")]
    AssetNotFound,
    #[error("Conversation not found")]
    ConversationNotFound,
    #[error("Resolved path escapes export root")]
    PathEscapesRoot,
    #[error("Parse failed: {0}")]
    ParseFailed(String),
    #[error("Cache unavailable: {0}")]
    CacheUnavailable(String),
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidSourceRoot(_) => "invalid_source_root",
            Self::ExportNotFound => "export_not_found",
            Self::InvalidFileId => "invalid_file_id",
            Self::AssetNotFound => "asset_not_found",
            Self::ConversationNotFound => "conversation_not_found",
            Self::PathEscapesRoot => "path_escapes_root",
            Self::ParseFailed(_) => "parse_failed",
            Self::CacheUnavailable(_) => "cache_unavailable",
            Self::Io { .. } => "io_error",
        }
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;

        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.public_message())?;
        map.end()
    }
}

impl AppError {
    fn public_message(&self) -> String {
        match self {
            Self::InvalidSourceRoot(reason) => format!("Invalid source root: {reason}"),
            Self::ExportNotFound => "Export not found".to_string(),
            Self::InvalidFileId => "Invalid file id".to_string(),
            Self::AssetNotFound => "Asset file not found".to_string(),
            Self::ConversationNotFound => "Conversation not found".to_string(),
            Self::PathEscapesRoot => "Resolved path escapes export root".to_string(),
            Self::ParseFailed(_) => "Parse failed".to_string(),
            Self::CacheUnavailable(_) => "Cache unavailable".to_string(),
            Self::Io { .. } => "I/O error".to_string(),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn io_error(path: impl Into<PathBuf>, source: std::io::Error) -> AppError {
    AppError::Io {
        path: path.into(),
        source,
    }
}
