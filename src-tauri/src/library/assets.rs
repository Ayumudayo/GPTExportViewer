use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::{assert_safe_file_id, resolve_inside};
use crate::library::mime::sniff_mime;
use crate::models::{ExportItem, LibraryItem, ResolvedAsset};

pub fn resolve_asset(
    export_item: &ExportItem,
    file_id: &str,
    library_items: &[LibraryItem],
) -> AppResult<ResolvedAsset> {
    let safe_file_id = assert_safe_file_id(file_id)?.to_string();
    let item = library_items
        .iter()
        .find(|candidate| candidate.file_id == safe_file_id || candidate.id == safe_file_id);
    let fallback_file_ref;
    let file_ref = if let Some(item) = item {
        item.file_ref.as_str()
    } else {
        fallback_file_ref = format!("{safe_file_id}.dat");
        fallback_file_ref.as_str()
    };
    let file_path = resolve_inside(&export_item.path, file_ref)?;
    let info = std::fs::metadata(&file_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::AssetNotFound
        } else {
            io_error(&file_path, error)
        }
    })?;
    if !info.is_file() {
        return Err(AppError::AssetNotFound);
    }

    let fallback_mime = item.and_then(|item| (!item.mime.is_empty()).then_some(item.mime.as_str()));
    let mime_type = if fallback_mime.is_some_and(|mime| mime.starts_with("image/")) {
        fallback_mime.unwrap().to_string()
    } else {
        sniff_mime(&file_path, fallback_mime)?
    };

    Ok(ResolvedAsset {
        file_id: safe_file_id,
        file_path,
        file_name: item
            .map(|item| item.display_name.clone())
            .unwrap_or_else(|| {
                file_ref
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or("asset.dat")
                    .to_string()
            }),
        mime_type,
        size: info.len(),
    })
}
