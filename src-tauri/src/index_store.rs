use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::cache::{
    export_fingerprint, read_json, write_json_compact_atomic, ExportFingerprint,
};
use crate::conversations::summary_index::build_conversation_artifacts;
use crate::errors::AppResult;
use crate::library::index::build_library_index;
use crate::models::{CacheStatus, Conversation, ConversationIndex, ExportItem, LibraryIndex};
use crate::search::{build_conversation_search_list, build_library_lookup};

pub(crate) const CACHE_META_VERSION: u8 = 4;
pub(crate) const CONVERSATION_LRU_CAPACITY: usize = 16;

#[derive(Debug, Default)]
pub(crate) struct ConversationLru {
    entries: VecDeque<((String, String), Arc<Conversation>)>,
}

impl ConversationLru {
    pub(crate) fn get(&mut self, export_id: &str, conversation_id: &str) -> Option<Arc<Conversation>> {
        let pos = self
            .entries
            .iter()
            .position(|((exp, conv), _)| exp == export_id && conv == conversation_id)?;
        let entry = self.entries.remove(pos)?;
        let value = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(value)
    }

    pub(crate) fn insert(
        &mut self,
        export_id: String,
        conversation_id: String,
        value: Arc<Conversation>,
    ) {
        if let Some(pos) = self
            .entries
            .iter()
            .position(|((exp, conv), _)| exp == &export_id && conv == &conversation_id)
        {
            self.entries.remove(pos);
        } else if self.entries.len() >= CONVERSATION_LRU_CAPACITY {
            self.entries.pop_front();
        }
        self.entries
            .push_back(((export_id, conversation_id), value));
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn remove_export(&mut self, export_id: &str) {
        self.entries.retain(|((exp, _), _)| exp != export_id);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheMeta {
    pub(crate) version: u8,
    pub(crate) export_id: String,
    pub(crate) export_path: PathBuf,
    pub(crate) generated_at: String,
    pub(crate) fingerprint: ExportFingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationStore {
    pub(crate) offsets: HashMap<String, (u64, u64)>,
    pub(crate) search_texts: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub(crate) struct IndexedExport {
    pub(crate) conversation_index: ConversationIndex,
    pub(crate) library_index: LibraryIndex,
    pub(crate) cache: CacheStatus,
    pub(crate) conversation_offsets: HashMap<String, (u64, u64)>,
    pub(crate) conversation_jsonl_path: PathBuf,
    pub(crate) conversation_search_list: Vec<String>,
    pub(crate) library_by_file_id: HashMap<String, usize>,
    pub(crate) library_search_texts: Vec<String>,
}

pub(crate) fn index_export(
    export: &ExportItem,
    cache_dir: &Path,
    force: bool,
) -> AppResult<IndexedExport> {
    let export_cache_dir = cache_dir.join(&export.id);
    let meta_file = export_cache_dir.join("meta.json");
    let conversations_file = export_cache_dir.join("conversation-summaries.json");
    let library_file = export_cache_dir.join("library-images.json");
    let store_file = export_cache_dir.join("conversation-store.json");
    let jsonl_path = export_cache_dir.join("conversations-normalized.jsonl");
    let fingerprint = export_fingerprint(export)?;

    if !force && jsonl_path.is_file() {
        if let Some(meta) = read_json::<CacheMeta>(&meta_file)? {
            if meta.version == CACHE_META_VERSION
                && meta.export_id == export.id
                && meta.fingerprint == fingerprint
            {
                let conversation_index = read_json::<ConversationIndex>(&conversations_file)?;
                let library_index = read_json::<LibraryIndex>(&library_file)?;
                let store = read_json::<ConversationStore>(&store_file)?;
                if let (Some(conversation_index), Some(library_index), Some(store)) =
                    (conversation_index, library_index, store)
                {
                    let (library_by_file_id, library_search_texts) =
                        build_library_lookup(&library_index.items);
                    let conversation_search_list = build_conversation_search_list(
                        &conversation_index.items,
                        &store.search_texts,
                    );
                    return Ok(IndexedExport {
                        conversation_index,
                        library_index,
                        cache: CacheStatus {
                            hit: true,
                            dir: export_cache_dir,
                        },
                        conversation_offsets: store.offsets,
                        conversation_jsonl_path: jsonl_path,
                        conversation_search_list,
                        library_by_file_id,
                        library_search_texts,
                    });
                }
            }
        }
    }

    let artifacts = build_conversation_artifacts(export, &jsonl_path)?;
    let conversation_ids: HashSet<_> = artifacts
        .index
        .items
        .iter()
        .map(|item| item.id.clone())
        .collect();
    let library_index = build_library_index(export, &conversation_ids)?;
    let (library_by_file_id, library_search_texts) = build_library_lookup(&library_index.items);
    let conversation_search_list =
        build_conversation_search_list(&artifacts.index.items, &artifacts.search_texts);

    write_json_compact_atomic(&conversations_file, &artifacts.index)?;
    write_json_compact_atomic(&library_file, &library_index)?;
    write_json_compact_atomic(
        &store_file,
        &ConversationStore {
            offsets: artifacts.offsets.clone(),
            search_texts: artifacts.search_texts,
        },
    )?;
    write_json_compact_atomic(
        &meta_file,
        &CacheMeta {
            version: CACHE_META_VERSION,
            export_id: export.id.clone(),
            export_path: export.path.clone(),
            generated_at: crate::time::generated_at(),
            fingerprint,
        },
    )?;

    Ok(IndexedExport {
        conversation_index: artifacts.index,
        library_index,
        cache: CacheStatus {
            hit: false,
            dir: export_cache_dir,
        },
        conversation_offsets: artifacts.offsets,
        conversation_jsonl_path: jsonl_path,
        conversation_search_list,
        library_by_file_id,
        library_search_texts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_conversation(id: &str) -> Arc<Conversation> {
        Arc::new(Conversation {
            id: id.to_string(),
            title: format!("Conversation {id}"),
            created_at: None,
            updated_at: None,
            model: None,
            archived: false,
            starred: false,
            total_messages: 0,
            messages: Vec::new(),
            range: None,
        })
    }

    #[test]
    fn conversation_lru_promotes_on_get_and_evicts_least_recent() {
        let mut lru = ConversationLru::default();
        for i in 0..CONVERSATION_LRU_CAPACITY {
            let conv_id = format!("conv-{i}");
            lru.insert("exp-1".to_string(), conv_id.clone(), sample_conversation(&conv_id));
        }
        assert_eq!(
            lru.get("exp-1", "conv-0").map(|conv| conv.id.clone()),
            Some("conv-0".to_string())
        );

        lru.insert(
            "exp-1".to_string(),
            "conv-new".to_string(),
            sample_conversation("conv-new"),
        );

        assert!(lru.get("exp-1", "conv-1").is_none());
        assert!(lru.get("exp-1", "conv-0").is_some());
        assert!(lru.get("exp-1", "conv-new").is_some());
    }

    #[test]
    fn conversation_lru_replaces_existing_and_scopes_clear() {
        let mut lru = ConversationLru::default();
        lru.insert("exp-1".to_string(), "c1".to_string(), sample_conversation("v1"));
        lru.insert("exp-1".to_string(), "c1".to_string(), sample_conversation("v2"));
        lru.insert("exp-2".to_string(), "c2".to_string(), sample_conversation("c2"));

        assert_eq!(lru.entries.len(), 2);
        assert_eq!(
            lru.get("exp-1", "c1").map(|conv| conv.id.clone()),
            Some("v2".to_string())
        );

        lru.remove_export("exp-1");
        assert!(lru.get("exp-1", "c1").is_none());
        assert!(lru.get("exp-2", "c2").is_some());

        lru.clear();
        assert!(lru.get("exp-2", "c2").is_none());
    }
}
