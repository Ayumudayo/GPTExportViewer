/**
 * Helpers for distinguishing regular chats, ChatGPT Projects, Custom GPTs, Group Chats, and Codex tasks.
 */

export function normalizeConversationKind(item) {
  if (item?.kind) return item.kind;
  return item?.projectId ? "project" : "regular";
}

export function shortProjectCode(projectId) {
  if (!projectId) return "";
  const stripped = String(projectId)
    .trim()
    .replace(/^g-p-/, "")
    .replace(/^g-/, "");
  return stripped.slice(0, 6) || String(projectId).trim();
}

export function formatProjectLabel(projectId, projectAliases = {}) {
  const trimmedId = String(projectId || "").trim();
  const alias = trimmedId ? projectAliases?.[trimmedId]?.trim() : "";
  if (alias) return alias;
  const code = shortProjectCode(trimmedId);
  return code ? `Project ${code}` : "Project";
}

export function formatConversationKindLabel(kind) {
  switch (kind) {
    case "project":
      return "Project";
    case "custom_gpt":
      return "Custom GPT";
    case "group_chat":
      return "Group chat";
    case "codex":
      return "Codex";
    case "regular":
    default:
      return "General";
  }
}

export function formatConversationRowBadge(item, projectAliases = {}) {
  const kind = normalizeConversationKind(item);
  if (kind === "regular") return null;
  if (kind === "project") {
    return {
      variant: "project",
      label: formatProjectLabel(item?.projectId, projectAliases),
      title: item?.projectId ? `Project (${item.projectId})` : "Project"
    };
  }
  if (kind === "custom_gpt") {
    return {
      variant: "custom-gpt",
      label: "Custom GPT",
      title: item?.gizmoId ? `Custom GPT (${item.gizmoId})` : "Custom GPT"
    };
  }
  if (kind === "group_chat") {
    return {
      variant: "group-chat",
      label: "Group",
      title: "Group chat"
    };
  }
  if (kind === "codex") {
    return {
      variant: "codex",
      label: "Codex",
      title: "Codex task"
    };
  }
  return null;
}
