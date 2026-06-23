import { readFile } from "node:fs/promises";
import { compareIsoDesc } from "../utils/time.mjs";
import { extractAssetRefs, extractMessageText, getConversationId } from "./normalizeConversation.mjs";

export async function buildConversationSummaryIndex(exportItem) {
  if (!exportItem.hasConversations) {
    return emptyIndex();
  }
  const conversations = await readConversationArray(exportItem.paths.conversations);
  const items = conversations.map((conversation, index) => summarizeConversation(conversation, index));
  items.sort((a, b) => compareIsoDesc(a.updatedAt ?? a.createdAt, b.updatedAt ?? b.createdAt));
  return {
    items,
    stats: {
      totalConversations: items.length,
      totalMessages: items.reduce((sum, item) => sum + item.messageCount, 0),
      totalAttachments: items.reduce((sum, item) => sum + item.attachmentCount, 0),
      archived: items.filter((item) => item.archived).length,
      starred: items.filter((item) => item.starred).length,
      maxMessages: items.reduce((max, item) => Math.max(max, item.messageCount), 0)
    },
    generatedAt: new Date().toISOString()
  };
}

export async function readConversationArray(filePath) {
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.conversations)) return parsed.conversations;
  return [];
}

function summarizeConversation(conversation, index) {
  const mapping = conversation.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {};
  const nodes = Object.values(mapping).filter((node) => node?.message);
  const firstText = nodes.map((node) => extractMessageText(node.message.content)).find(Boolean) ?? "";
  const assetRefs = nodes.flatMap((node) => extractAssetRefs({ content: node.message.content, metadata: node.message.metadata }));
  const createdAt = toIso(conversation.create_time ?? conversation.created_at);
  const updatedAt = toIso(conversation.update_time ?? conversation.updated_at) ?? createdAt;
  return {
    id: getConversationId(conversation, String(index)),
    title: conversation.title || "Untitled conversation",
    createdAt,
    updatedAt,
    messageCount: nodes.length,
    attachmentCount: assetRefs.length,
    model: conversation.default_model_slug ?? conversation.model_slug ?? null,
    archived: Boolean(conversation.is_archived),
    starred: Boolean(conversation.is_starred),
    preview: firstText.slice(0, 240),
    lastRole: nodes.at(-1)?.message?.author?.role ?? null
  };
}

function emptyIndex() {
  return {
    items: [],
    stats: {
      totalConversations: 0,
      totalMessages: 0,
      totalAttachments: 0,
      archived: 0,
      starred: 0,
      maxMessages: 0
    },
    generatedAt: new Date().toISOString()
  };
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}
