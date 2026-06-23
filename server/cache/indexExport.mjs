import path from "node:path";
import { buildConversationSummaryIndex } from "../conversations/conversationSummaryIndex.mjs";
import { buildLibraryIndex } from "../library/libraryIndex.mjs";
import { exportFingerprint, fingerprintsEqual, readJson, writeJsonAtomic } from "./jsonCache.mjs";

export async function indexExport(exportItem, { cacheDir, force = false } = {}) {
  const exportCacheDir = path.join(cacheDir, exportItem.id);
  const metaFile = path.join(exportCacheDir, "meta.json");
  const conversationsFile = path.join(exportCacheDir, "conversation-summaries.json");
  const libraryFile = path.join(exportCacheDir, "library-images.json");
  const fingerprint = await exportFingerprint(exportItem);
  const cachedMeta = await readJson(metaFile, null);
  if (!force && cachedMeta?.version === 1 && fingerprintsEqual(cachedMeta.fingerprint, fingerprint)) {
    const conversationIndex = await readJson(conversationsFile, null);
    const libraryIndex = await readJson(libraryFile, null);
    if (conversationIndex && libraryIndex) {
      return { export: exportItem, conversationIndex, libraryIndex, cache: { hit: true, dir: exportCacheDir } };
    }
  }

  const conversationIndex = await buildConversationSummaryIndex(exportItem);
  const conversationIds = new Set(conversationIndex.items.map((item) => item.id));
  const libraryIndex = await buildLibraryIndex(exportItem, conversationIds);
  await writeJsonAtomic(conversationsFile, conversationIndex);
  await writeJsonAtomic(libraryFile, libraryIndex);
  await writeJsonAtomic(metaFile, {
    version: 1,
    exportId: exportItem.id,
    exportPath: exportItem.path,
    generatedAt: new Date().toISOString(),
    fingerprint
  });
  return { export: exportItem, conversationIndex, libraryIndex, cache: { hit: false, dir: exportCacheDir } };
}
