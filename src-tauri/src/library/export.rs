use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::errors::{io_error, AppError, AppResult};
use crate::fs_guards::{
    build_project_folder_map, is_windows_reserved_stem, resolve_project_label,
    safe_folder_segment, session_folder_base,
};
use crate::index_store::IndexedExport;
use crate::library::assets::resolve_asset_for_item;
use crate::library::mime::infer_mime_from_name;
use crate::models::{
    Conversation, ConversationSummary, ExportImagesProgress, ExportImagesResponse, ExportItem,
    LibraryItem, PublicExport,
};
use crate::search::collect_unique_project_ids;

const KNOWN_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "heic", "tiff",
];

type FolderDescriptor<'a> = (&'a [String], Option<&'a (String, String)>);
type SeenCandidateKey = (Vec<String>, Option<String>, String);

#[derive(Debug, Clone)]
pub struct ImageExportCandidate {
    pub file_id: String,
    pub display_name: Option<String>,
    pub mime_hint: Option<String>,
    pub parent_segments: Vec<String>,
    pub session_folder: Option<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ImageExportPlan {
    pub scope: String,
    pub scope_label: String,
    pub folder_name: String,
    pub candidates: Vec<ImageExportCandidate>,
    pub existing_count: usize,
    pub missing_count: usize,
}

pub(crate) fn plan_image_export(
    export: &ExportItem,
    indexed: &IndexedExport,
    project_aliases: &BTreeMap<String, String>,
    scope: &str,
    conversation_ids: Option<&[String]>,
    project_ids: &[String],
    mut load_conv: impl FnMut(&str) -> AppResult<Option<Conversation>>,
) -> AppResult<ImageExportPlan> {
    let mut candidates = Vec::new();
    let mut seen_keys: HashSet<SeenCandidateKey> = HashSet::new();

    let (normalized_scope, scope_label, folder_name) = match scope.trim() {
        "export" => {
            let conv_by_id: HashMap<&str, &ConversationSummary> = indexed
                .conversation_index
                .items
                .iter()
                .map(|summary| (summary.id.as_str(), summary))
                .collect();
            let all_project_ids: Vec<String> = indexed
                .conversation_index
                .items
                .iter()
                .filter_map(|summary| summary.project_id.clone())
                .chain(
                    indexed
                        .library_index
                        .items
                        .iter()
                        .filter_map(|item| item.project_id.clone()),
                )
                .collect();
            let project_folder_map = build_project_folder_map(&all_project_ids, project_aliases);

            for item in &indexed.library_index.items {
                if let Some(summary) = item
                    .source_conversation_id
                    .as_deref()
                    .and_then(|cid| conv_by_id.get(cid).copied())
                {
                    let parent_segments = match summary.kind.as_str() {
                        "project" => {
                            let proj_seg = summary
                                .project_id
                                .as_deref()
                                .and_then(|pid| project_folder_map.get(pid))
                                .cloned()
                                .unwrap_or_else(|| "_Unassigned".to_string());
                            vec!["Projects".to_string(), proj_seg]
                        }
                        "regular" => vec!["General".to_string()],
                        _ => vec!["Other".to_string()],
                    };
                    let sess_folder = summary_session_folder(summary);
                    push_candidate(
                        &mut candidates,
                        &mut seen_keys,
                        item.file_id.clone(),
                        Some(item.display_name.clone()),
                        Some(item.mime.clone()),
                        (&parent_segments, Some(&sess_folder)),
                    );
                } else if let Some(pid) = item
                    .project_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    let proj_seg = project_folder_map
                        .get(pid)
                        .cloned()
                        .unwrap_or_else(|| safe_folder_segment(&resolve_project_label(pid, project_aliases), pid, 48));
                    let parent_segments = vec![
                        "Projects".to_string(),
                        proj_seg,
                        "_Project Library".to_string(),
                    ];
                    push_candidate(
                        &mut candidates,
                        &mut seen_keys,
                        item.file_id.clone(),
                        Some(item.display_name.clone()),
                        Some(item.mime.clone()),
                        (&parent_segments, None),
                    );
                } else {
                    let parent_segments = vec!["_Library".to_string()];
                    push_candidate(
                        &mut candidates,
                        &mut seen_keys,
                        item.file_id.clone(),
                        Some(item.display_name.clone()),
                        Some(item.mime.clone()),
                        (&parent_segments, None),
                    );
                }
            }
            (
                "export".to_string(),
                export.name.clone(),
                format!("{}-images", safe_folder_segment(&export.name, "export", 64)),
            )
        }
        "project" | "projects" => {
            let pids = collect_unique_project_ids(None, Some(project_ids));
            if pids.is_empty() {
                return Err(AppError::InvalidSourceRoot(
                    "project id is required".to_string(),
                ));
            }
            let pid_set: HashSet<&str> = pids.iter().map(String::as_str).collect();
            let project_folder_map = build_project_folder_map(&pids, project_aliases);

            let project_summaries: Vec<&ConversationSummary> = indexed
                .conversation_index
                .items
                .iter()
                .filter(|summary| {
                    summary
                        .project_id
                        .as_deref()
                        .is_some_and(|pid| pid_set.contains(pid))
                })
                .collect();
            let conv_by_id: HashMap<&str, &ConversationSummary> = project_summaries
                .iter()
                .map(|summary| (summary.id.as_str(), *summary))
                .collect();

            for summary in &project_summaries {
                let pid = summary.project_id.as_deref().unwrap_or("");
                let parent_segments = if pids.len() == 1 {
                    Vec::new()
                } else {
                    vec![project_folder_map
                        .get(pid)
                        .cloned()
                        .unwrap_or_else(|| safe_folder_segment(&resolve_project_label(pid, project_aliases), pid, 48))]
                };
                let sess_folder = summary_session_folder(summary);
                if let Some(conv) = load_conv(&summary.id)? {
                    collect_images_from_conversation(
                        export,
                        indexed,
                        &conv,
                        (&parent_segments, Some(&sess_folder)),
                        &mut candidates,
                        &mut seen_keys,
                    );
                }
            }

            for item in &indexed.library_index.items {
                if let Some(summary) = item
                    .source_conversation_id
                    .as_deref()
                    .and_then(|cid| conv_by_id.get(cid).copied())
                {
                    let pid = summary.project_id.as_deref().unwrap_or("");
                    let parent_segments = if pids.len() == 1 {
                        Vec::new()
                    } else {
                        vec![project_folder_map
                            .get(pid)
                            .cloned()
                            .unwrap_or_else(|| safe_folder_segment(&resolve_project_label(pid, project_aliases), pid, 48))]
                    };
                    let sess_folder = summary_session_folder(summary);
                    push_candidate(
                        &mut candidates,
                        &mut seen_keys,
                        item.file_id.clone(),
                        Some(item.display_name.clone()),
                        Some(item.mime.clone()),
                        (&parent_segments, Some(&sess_folder)),
                    );
                } else if let Some(pid) = item
                    .project_id
                    .as_deref()
                    .filter(|pid| pid_set.contains(pid))
                {
                    let parent_segments = if pids.len() == 1 {
                        vec!["_Project Library".to_string()]
                    } else {
                        let proj_seg = project_folder_map
                            .get(pid)
                            .cloned()
                            .unwrap_or_else(|| safe_folder_segment(&resolve_project_label(pid, project_aliases), pid, 48));
                        vec![proj_seg, "_Project Library".to_string()]
                    };
                    push_candidate(
                        &mut candidates,
                        &mut seen_keys,
                        item.file_id.clone(),
                        Some(item.display_name.clone()),
                        Some(item.mime.clone()),
                        (&parent_segments, None),
                    );
                }
            }

            let (scope_label, folder_name) = if pids.len() == 1 {
                let label = resolve_project_label(&pids[0], project_aliases);
                let folder = format!("{}-images", safe_folder_segment(&label, &pids[0], 64));
                (label, folder)
            } else {
                let label = format!("{} projects", pids.len());
                let folder = format!("{}-projects-images", pids.len());
                (label, folder)
            };
            ("project".to_string(), scope_label, folder_name)
        }
        "conversations" | "conversation" => {
            let mut ids = Vec::new();
            let mut seen_conv_ids = HashSet::new();
            for raw_id in conversation_ids.unwrap_or(&[]) {
                let trimmed = raw_id.trim();
                if !trimmed.is_empty() && seen_conv_ids.insert(trimmed.to_string()) {
                    ids.push(trimmed.to_string());
                }
            }
            if ids.is_empty() {
                return Err(AppError::ConversationNotFound);
            }

            let mut summaries = Vec::with_capacity(ids.len());
            for cid in &ids {
                let Some(summary) = indexed
                    .conversation_index
                    .items
                    .iter()
                    .find(|summary| summary.id == *cid)
                else {
                    return Err(AppError::ConversationNotFound);
                };
                summaries.push(summary);
            }
            let conv_by_id: HashMap<&str, &ConversationSummary> = summaries
                .iter()
                .map(|summary| (summary.id.as_str(), *summary))
                .collect();
            let multi_sessions = summaries.len() > 1;

            for summary in &summaries {
                let sess_folder = multi_sessions.then(|| summary_session_folder(summary));
                if let Some(conv) = load_conv(&summary.id)? {
                    collect_images_from_conversation(
                        export,
                        indexed,
                        &conv,
                        (&[], sess_folder.as_ref()),
                        &mut candidates,
                        &mut seen_keys,
                    );
                }
            }

            for item in &indexed.library_index.items {
                if let Some(summary) = item
                    .source_conversation_id
                    .as_deref()
                    .and_then(|cid| conv_by_id.get(cid).copied())
                {
                    let sess_folder = multi_sessions.then(|| summary_session_folder(summary));
                    push_candidate(
                        &mut candidates,
                        &mut seen_keys,
                        item.file_id.clone(),
                        Some(item.display_name.clone()),
                        Some(item.mime.clone()),
                        (&[], sess_folder.as_ref()),
                    );
                }
            }

            let (scope_label, folder_name) = if !multi_sessions {
                let summary = summaries[0];
                let base = session_folder_base(
                    &summary.title,
                    &summary.id,
                    summary.updated_at.as_deref(),
                    summary.created_at.as_deref(),
                );
                let folder = format!("{}-images", safe_folder_segment(&base, &summary.id, 64));
                (summary.title.clone(), folder)
            } else {
                let label = format!("{} sessions", ids.len());
                let folder = format!("{}-sessions-images", ids.len());
                (label, folder)
            };
            ("conversations".to_string(), scope_label, folder_name)
        }
        other => {
            return Err(AppError::InvalidSourceRoot(format!(
                "unsupported image export scope: {other}"
            )));
        }
    };

    let mut existing_count = 0usize;
    let mut missing_count = 0usize;
    for candidate in &candidates {
        let lib_item = lookup_library_item(indexed, &candidate.file_id);
        match resolve_asset_for_item(export, &candidate.file_id, lib_item) {
            Ok(resolved) => {
                if resolved.mime_type.starts_with("image/") {
                    existing_count += 1;
                }
            }
            Err(AppError::AssetNotFound) => {
                missing_count += 1;
            }
            Err(_) => {}
        }
    }

    Ok(ImageExportPlan {
        scope: normalized_scope,
        scope_label,
        folder_name,
        candidates,
        existing_count,
        missing_count,
    })
}

pub(crate) fn execute_image_export(
    export: &ExportItem,
    indexed: &IndexedExport,
    plan: &ImageExportPlan,
    destination_root: &Path,
    mut on_progress: impl FnMut(ExportImagesProgress),
) -> AppResult<ExportImagesResponse> {
    if plan.existing_count == 0 {
        let progress = ExportImagesProgress {
            export_id: export.id.clone(),
            scope: plan.scope.clone(),
            total: 0,
            completed: 0,
            skipped_missing: plan.missing_count,
            current_file_name: None,
        };
        return Ok(ExportImagesResponse {
            export: PublicExport::from(export),
            scope: plan.scope.clone(),
            scope_label: plan.scope_label.clone(),
            destination_dir: None,
            total_candidates: plan.candidates.len(),
            exported_count: 0,
            skipped_missing: plan.missing_count,
            total_bytes: 0,
            canceled: false,
            progress,
        });
    }

    let destination_dir = destination_root.join(&plan.folder_name);
    let mut allocated_session_dirs: HashMap<(PathBuf, String), PathBuf> = HashMap::new();
    let mut used_child_dirs_by_parent: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut used_files_by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut exported_count = 0usize;
    let mut skipped_missing = 0usize;
    let mut total_bytes = 0_u64;
    let mut last_file_name = None;

    for candidate in &plan.candidates {
        let lib_item = lookup_library_item(indexed, &candidate.file_id);
        let resolved = match resolve_asset_for_item(export, &candidate.file_id, lib_item) {
            Ok(resolved) => resolved,
            Err(AppError::AssetNotFound) => {
                skipped_missing += 1;
                continue;
            }
            Err(AppError::InvalidFileId) => continue,
            Err(error) => return Err(error),
        };
        if !resolved.mime_type.starts_with("image/") {
            continue;
        }

        let target_dir = resolve_candidate_target_dir(
            &destination_dir,
            candidate,
            &mut allocated_session_dirs,
            &mut used_child_dirs_by_parent,
        );
        std::fs::create_dir_all(&target_dir).map_err(|error| io_error(&target_dir, error))?;

        let preferred = lib_item
            .map(|item| item.display_name.as_str())
            .filter(|name| !name.trim().is_empty())
            .or(candidate.display_name.as_deref())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(resolved.file_name.as_str());

        let used_lower = used_files_by_dir.entry(target_dir.clone()).or_default();
        let file_name = unique_image_filename(
            &target_dir,
            used_lower,
            preferred,
            &resolved.file_id,
            &resolved.mime_type,
        );
        let target_path = target_dir.join(&file_name);
        let bytes = std::fs::copy(&resolved.file_path, &target_path)
            .map_err(|error| io_error(&target_path, error))?;

        exported_count += 1;
        total_bytes += bytes;
        last_file_name = Some(file_name.clone());

        if plan.existing_count <= 60
            || exported_count == 1
            || exported_count == plan.existing_count
            || exported_count % 5 == 0
        {
            on_progress(ExportImagesProgress {
                export_id: export.id.clone(),
                scope: plan.scope.clone(),
                total: plan.existing_count,
                completed: exported_count,
                skipped_missing,
                current_file_name: Some(file_name),
            });
        }
    }

    let progress = ExportImagesProgress {
        export_id: export.id.clone(),
        scope: plan.scope.clone(),
        total: exported_count,
        completed: exported_count,
        skipped_missing,
        current_file_name: last_file_name,
    };

    Ok(ExportImagesResponse {
        export: PublicExport::from(export),
        scope: plan.scope.clone(),
        scope_label: plan.scope_label.clone(),
        destination_dir: (exported_count > 0).then_some(destination_dir),
        total_candidates: plan.candidates.len(),
        exported_count,
        skipped_missing,
        total_bytes,
        canceled: false,
        progress,
    })
}

fn resolve_candidate_target_dir(
    root_dir: &Path,
    candidate: &ImageExportCandidate,
    allocated_session_dirs: &mut HashMap<(PathBuf, String), PathBuf>,
    used_child_dirs_by_parent: &mut HashMap<PathBuf, HashSet<String>>,
) -> PathBuf {
    let mut parent_dir = root_dir.to_path_buf();
    for seg in &candidate.parent_segments {
        parent_dir.push(seg);
    }
    let Some((conv_id, base_name)) = &candidate.session_folder else {
        return parent_dir;
    };
    let cache_key = (parent_dir.clone(), conv_id.clone());
    if let Some(existing) = allocated_session_dirs.get(&cache_key) {
        return existing.clone();
    }
    let used_lower = used_child_dirs_by_parent
        .entry(parent_dir.clone())
        .or_default();
    let mut attempt = 1usize;
    let chosen_path = loop {
        let folder_name = if attempt == 1 {
            base_name.clone()
        } else {
            format!("{base_name} ({attempt})")
        };
        let lower = folder_name.to_ascii_lowercase();
        let candidate_path = parent_dir.join(&folder_name);
        if !used_lower.contains(&lower) && !candidate_path.exists() {
            used_lower.insert(lower);
            break candidate_path;
        }
        attempt += 1;
    };
    allocated_session_dirs.insert(cache_key, chosen_path.clone());
    chosen_path
}

fn summary_session_folder(summary: &ConversationSummary) -> (String, String) {
    (
        summary.id.clone(),
        session_folder_base(
            &summary.title,
            &summary.id,
            summary.updated_at.as_deref(),
            summary.created_at.as_deref(),
        ),
    )
}

fn collect_images_from_conversation(
    export: &ExportItem,
    indexed: &IndexedExport,
    conversation: &Conversation,
    folder: FolderDescriptor<'_>,
    candidates: &mut Vec<ImageExportCandidate>,
    seen_keys: &mut HashSet<SeenCandidateKey>,
) {
    for message in &conversation.messages {
        for part in &message.parts {
            if part.part_type != "image" {
                continue;
            }
            let Some(file_id) = part
                .file_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            push_candidate(
                candidates,
                seen_keys,
                file_id.to_string(),
                part.name.clone(),
                part.mime_type.clone(),
                folder,
            );
        }

        for asset in &message.asset_refs {
            let file_id = asset.file_id.trim();
            if file_id.is_empty() {
                continue;
            }
            let candidate_key = (
                folder.0.to_vec(),
                folder.1.map(|(cid, _)| cid.clone()),
                file_id.to_string(),
            );
            if seen_keys.contains(&candidate_key) {
                continue;
            }
            let is_known_image = lookup_library_item(indexed, file_id).is_some()
                || asset
                    .mime_type
                    .as_deref()
                    .is_some_and(|mime| mime.starts_with("image/"))
                || asset
                    .name
                    .as_deref()
                    .and_then(infer_mime_from_name)
                    .is_some();
            if is_known_image {
                push_candidate(
                    candidates,
                    seen_keys,
                    file_id.to_string(),
                    asset.name.clone(),
                    asset.mime_type.clone(),
                    folder,
                );
                continue;
            }
            if let Ok(resolved) = resolve_asset_for_item(export, file_id, None) {
                if resolved.mime_type.starts_with("image/") {
                    push_candidate(
                        candidates,
                        seen_keys,
                        file_id.to_string(),
                        asset.name.clone(),
                        Some(resolved.mime_type),
                        folder,
                    );
                }
            }
        }
    }
}

fn push_candidate(
    candidates: &mut Vec<ImageExportCandidate>,
    seen_keys: &mut HashSet<SeenCandidateKey>,
    file_id: String,
    display_name: Option<String>,
    mime_hint: Option<String>,
    folder: FolderDescriptor<'_>,
) {
    if file_id.is_empty() {
        return;
    }
    let key: SeenCandidateKey = (
        folder.0.to_vec(),
        folder.1.map(|(cid, _)| cid.clone()),
        file_id.clone(),
    );
    if !seen_keys.insert(key) {
        return;
    }
    candidates.push(ImageExportCandidate {
        file_id,
        display_name,
        mime_hint,
        parent_segments: folder.0.to_vec(),
        session_folder: folder.1.cloned(),
    });
}

fn lookup_library_item<'a>(indexed: &'a IndexedExport, file_id: &str) -> Option<&'a LibraryItem> {
    indexed
        .library_by_file_id
        .get(file_id)
        .and_then(|&idx| indexed.library_index.items.get(idx))
}

pub fn sanitize_image_filename(preferred_name: &str, file_id: &str, mime_type: &str) -> String {
    let fallback_ext = mime_to_extension(mime_type);
    let sanitized_raw = sanitize_filename_component(preferred_name);

    let (raw_stem, chosen_ext) = if sanitized_raw.is_empty() {
        (sanitize_filename_component(file_id), fallback_ext.to_string())
    } else if let Some((head, tail)) = sanitized_raw.rsplit_once('.') {
        let lower_ext = tail.to_ascii_lowercase();
        if lower_ext == "dat" {
            let base = if head.trim().is_empty() {
                sanitize_filename_component(file_id)
            } else {
                head.trim().to_string()
            };
            (base, fallback_ext.to_string())
        } else if KNOWN_IMAGE_EXTENSIONS.contains(&lower_ext.as_str()) {
            let base = if head.trim().is_empty() {
                sanitize_filename_component(file_id)
            } else {
                head.trim().to_string()
            };
            (base, lower_ext)
        } else {
            (sanitized_raw, fallback_ext.to_string())
        }
    } else {
        (sanitized_raw, fallback_ext.to_string())
    };

    let mut stem = raw_stem
        .trim_matches(|ch: char| ch == ' ' || ch == '.')
        .chars()
        .take(120)
        .collect::<String>()
        .trim_end_matches(|ch: char| ch == ' ' || ch == '.')
        .to_string();
    if stem.is_empty() || is_windows_reserved_stem(&stem) {
        let fid_fallback = sanitize_filename_component(file_id);
        stem = if fid_fallback.is_empty() || is_windows_reserved_stem(&fid_fallback) {
            "image".to_string()
        } else {
            fid_fallback.chars().take(120).collect()
        };
    }

    format!("{stem}.{chosen_ext}")
}

pub fn unique_image_filename(
    destination_dir: &Path,
    used_lower: &mut HashSet<String>,
    preferred_name: &str,
    file_id: &str,
    mime_type: &str,
) -> String {
    let base_name = sanitize_image_filename(preferred_name, file_id, mime_type);
    let (stem, ext) = base_name
        .rsplit_once('.')
        .unwrap_or((base_name.as_str(), "png"));

    let mut attempt = 1usize;
    loop {
        let candidate = if attempt == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({attempt}).{ext}")
        };
        let lower = candidate.to_ascii_lowercase();
        if !used_lower.contains(&lower) && !destination_dir.join(&candidate).exists() {
            used_lower.insert(lower);
            return candidate;
        }
        attempt += 1;
    }
}

fn sanitize_filename_component(value: &str) -> String {
    let trimmed = value.trim();
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed).trim();
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim_matches(|ch: char| ch == ' ' || ch == '.').to_string()
}

pub fn mime_to_extension(mime_type: &str) -> &'static str {
    let normalized = mime_type.trim().to_ascii_lowercase();
    let base = normalized.split(';').next().unwrap_or("").trim();
    match base {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}
