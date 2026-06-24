import path from "node:path";
import { mkdir } from "node:fs/promises";
import { writeJsonAtomic } from "../cache/jsonCache.mjs";
import { readConversationArray } from "./conversationSummaryIndex.mjs";
import { getConversationId } from "./normalizeConversation.mjs";

export async function saveSessions({ exportItem, destinationDir, conversationIds, onProgress = () => {} }) {
  const conversations = await readConversationArray(exportItem.paths.conversations);
  const byId = new Map(conversations.map((conversation, index) => [getConversationId(conversation, String(index)), conversation]));
  const missingId = conversationIds.find((conversationId) => !byId.has(conversationId));
  if (missingId) {
    const error = new Error("Conversation not found");
    error.status = 404;
    throw error;
  }

  await mkdir(destinationDir, { recursive: true });
  const items = [];
  let progress = {
    exportId: exportItem.id,
    total: conversationIds.length,
    completed: 0,
    currentConversationId: null,
    currentTitle: null
  };
  for (const [index, conversationId] of conversationIds.entries()) {
    const conversation = byId.get(conversationId);
    const title = conversation.title || "Untitled conversation";
    const filePath = path.join(destinationDir, sessionFilename(conversation, title, conversationId));
    await writeJsonAtomic(filePath, conversation);
    items.push({ conversationId, title, path: filePath, format: "original" });
    progress = {
      exportId: exportItem.id,
      total: conversationIds.length,
      completed: index + 1,
      currentConversationId: conversationId,
      currentTitle: title
    };
    onProgress(progress);
  }
  return { destinationDir, items, progress };
}

function sessionFilename(conversation, title, conversationId) {
  const rawDate = conversation.update_time ?? conversation.updated_at ?? conversation.create_time ?? conversation.created_at ?? "unknown-date";
  const date = safeFileSegment(dateSegment(rawDate));
  return `${date}-${safeFileSegment(title)}-${safeFileSegment(conversationId)}.json`;
}

function dateSegment(value) {
  return toIsoLike(value).replace(/[:TZ]/g, "-");
}

function toIsoLike(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return "unknown-date";
}

function safeFileSegment(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}
