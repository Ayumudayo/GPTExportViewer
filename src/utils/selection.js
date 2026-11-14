/**
 * Pick the preferred export ID if it exists in the discovered export list, otherwise the first export.
 */
export function pickExportId(exports, preferredExportId = "") {
  if (preferredExportId && exports.some((item) => item.id === preferredExportId)) {
    return preferredExportId;
  }
  return exports[0]?.id || "";
}

/**
 * Toggle an ID inside a multi-selection array without mutating the source array.
 */
export function toggleSelection(current, id) {
  return current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id];
}

/**
 * Select an inclusive contiguous range of conversation IDs between anchorId and targetId.
 */
export function selectConversationRange(conversations, anchorId, targetId) {
  const targetIndex = conversations.findIndex((item) => item.id === targetId);
  const anchorIndex = conversations.findIndex((item) => item.id === anchorId);
  if (targetIndex < 0) return [];
  if (anchorIndex < 0) return [targetId];
  const startIndex = Math.min(anchorIndex, targetIndex);
  const endIndex = Math.max(anchorIndex, targetIndex);
  return conversations.slice(startIndex, endIndex + 1).map((item) => item.id);
}

/**
 * Prune stale selected conversation IDs and anchor ID that are no longer in the visible conversation list.
 */
export function reconcileConversationSelection(conversations, selectedConversationIds, lastSelectedConversationId) {
  const availableIds = new Set(conversations.map((item) => item.id));
  return {
    selectedConversationIds: selectedConversationIds.filter((id) => availableIds.has(id)),
    lastSelectedConversationId: availableIds.has(lastSelectedConversationId) ? lastSelectedConversationId : ""
  };
}

/**
 * Merge paginated records onto an existing list while deduplicating by `key`.
 */
export function mergeByKey(current, next, key) {
  const merged = [...current];
  const seen = new Set(current.map((item) => item[key]));
  for (const item of next) {
    const value = item[key];
    if (seen.has(value)) continue;
    seen.add(value);
    merged.push(item);
  }
  return merged;
}
