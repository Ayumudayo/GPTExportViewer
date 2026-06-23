import { toIsoTime } from "../utils/time.mjs";

export function normalizeConversation(conversation) {
  const orderedNodes = getOrderedNodes(conversation);
  const messages = orderedNodes
    .map((node, index) => normalizeNode(node, index))
    .filter(Boolean);

  return {
    id: getConversationId(conversation),
    title: conversation.title || "Untitled conversation",
    createdAt: toIsoTime(conversation.create_time ?? conversation.created_at),
    updatedAt: toIsoTime(conversation.update_time ?? conversation.updated_at),
    model: conversation.default_model_slug ?? conversation.model_slug ?? null,
    archived: Boolean(conversation.is_archived),
    starred: Boolean(conversation.is_starred),
    totalMessages: messages.length,
    messages
  };
}

export function getConversationId(conversation, fallback = "") {
  return String(conversation.id ?? conversation.conversation_id ?? conversation.uuid ?? fallback);
}

export function extractMessageText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content.parts)) {
    return content.parts.map(partToText).filter(Boolean).join("\n").trim();
  }
  if (typeof content.text === "string") return content.text.trim();
  if (typeof content.result === "string") return content.result.trim();
  if (typeof content.summary === "string") return content.summary.trim();
  return "";
}

export function extractAssetRefs(value) {
  const refs = [];
  const seen = new Set();
  scan(value);
  return refs;

  function add(ref) {
    const fileId = normalizeFileId(ref.file_id ?? ref.fileId ?? ref.id ?? ref.asset_pointer ?? ref.assetPointer);
    if (!fileId) return;
    const key = `${fileId}:${ref.name ?? ref.file_name ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      fileId,
      name: ref.name ?? ref.file_name ?? ref.filename ?? null,
      mimeType: ref.mime_type ?? ref.mimeType ?? null
    });
  }

  function scan(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(scan);
      return;
    }
    if (node.file_id || node.fileId || node.asset_pointer || node.assetPointer) {
      add(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "text" || key === "prompt" || key === "title") continue;
      scan(child);
    }
  }
}

function normalizeNode(node, index) {
  const message = node.message;
  if (!message) return null;
  const role = message.author?.role ?? message.author?.name ?? "unknown";
  const text = extractMessageText(message.content);
  return {
    id: String(message.id ?? node.id ?? index),
    nodeId: String(node.id ?? index),
    ordinal: index + 1,
    role,
    author: message.author?.name ?? role,
    createdAt: toIsoTime(message.create_time ?? message.created_at),
    contentType: message.content?.content_type ?? null,
    text,
    assetRefs: extractAssetRefs({ content: message.content, metadata: message.metadata })
  };
}

function getOrderedNodes(conversation) {
  const mapping = conversation.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  const byId = new Map(Object.entries(mapping).map(([id, node]) => [id, { id, ...node }]));
  const current = conversation.current_node && byId.get(conversation.current_node);
  if (current) {
    const chain = [];
    const seen = new Set();
    let node = current;
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      chain.push(node);
      node = node.parent ? byId.get(node.parent) : null;
    }
    const ordered = chain.reverse().filter((item) => item.message);
    if (ordered.length > 0) return ordered;
  }

  const roots = [...byId.values()].filter((node) => !node.parent || !byId.has(node.parent));
  const derivedChildren = deriveChildrenByParent(byId);
  const visited = new Set();
  const ordered = [];
  for (const root of roots.length ? roots : byId.values()) {
    walk(root);
  }
  return ordered.length ? ordered : [...byId.values()].filter((node) => node.message).sort(compareNodes);

  function walk(node) {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    if (node.message) ordered.push(node);
    for (const childId of childIdsFor(node, derivedChildren)) {
      walk(byId.get(childId));
    }
  }
}

function deriveChildrenByParent(byId) {
  const children = new Map();
  for (const node of byId.values()) {
    if (!node.parent || !byId.has(node.parent)) continue;
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node.id);
    children.set(node.parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((leftId, rightId) => compareNodes(byId.get(leftId), byId.get(rightId)));
  }
  return children;
}

function childIdsFor(node, derivedChildren) {
  const merged = [];
  const seen = new Set();
  for (const childId of node.children ?? []) {
    if (!seen.has(childId)) {
      merged.push(childId);
      seen.add(childId);
    }
  }
  for (const childId of derivedChildren.get(node.id) ?? []) {
    if (!seen.has(childId)) {
      merged.push(childId);
      seen.add(childId);
    }
  }
  return merged;
}

function compareNodes(a, b) {
  return (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0);
}

function partToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.transcript === "string") return part.transcript;
  if (typeof part.caption === "string") return part.caption;
  return "";
}

function normalizeFileId(value) {
  if (typeof value !== "string") return null;
  const pointerMatch = value.match(/file[-_][A-Za-z0-9_-]+/);
  return pointerMatch?.[0] ?? value;
}
