import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readConversationArray } from "./conversationSummaryIndex.mjs";
import { getConversationId, normalizeConversation } from "./normalizeConversation.mjs";
import { safeCacheName } from "../utils/fsGuards.mjs";
import { readJson, writeJsonAtomic } from "../cache/jsonCache.mjs";

export async function loadConversation(exportItem, conversationId, { cacheDir, start = 0, limit = 100 } = {}) {
  const cacheFile = conversationCachePath(cacheDir, exportItem.id, conversationId);
  let normalized = await readJson(cacheFile, null);
  if (!normalized) {
    const conversations = await readConversationArray(exportItem.paths.conversations);
    const found = conversations.find((conversation, index) => getConversationId(conversation, String(index)) === conversationId);
    if (!found) return null;
    normalized = normalizeConversation(found);
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeJsonAtomic(cacheFile, normalized);
  }
  const safeStart = Math.max(Number.isFinite(start) ? start : 0, 0);
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 200);
  return {
    ...normalized,
    messages: normalized.messages.slice(safeStart, safeStart + safeLimit),
    range: {
      start: safeStart,
      limit: safeLimit,
      total: normalized.totalMessages,
      nextStart: safeStart + safeLimit < normalized.totalMessages ? safeStart + safeLimit : null
    }
  };
}

function conversationCachePath(cacheDir, exportId, conversationId) {
  const digest = createHash("sha1").update(conversationId).digest("hex").slice(0, 16);
  return path.join(cacheDir, exportId, "conversations", `${safeCacheName(conversationId)}-${digest}.json`);
}
