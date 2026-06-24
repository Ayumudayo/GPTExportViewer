const API_BASE = (import.meta.env?.VITE_API_BASE ?? "http://127.0.0.1:43117").replace(/\/$/, "");

export async function fetchExports() {
  return request("/api/exports");
}

export async function fetchSettings() {
  return request("/api/settings");
}

export async function pickSourceFolder({ initialPath }) {
  return request("/api/pick-folder", {
    method: "POST",
    body: JSON.stringify({ initialPath })
  });
}

export async function updateSettings({ sourceRoot }) {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ sourceRoot })
  });
}

export async function fetchStats(exportId) {
  return request(`/api/stats?${queryString({ exportId })}`);
}

export async function fetchConversations({ exportId, query = "", filter = "all", cursor = 0, limit = 50 }) {
  return request(`/api/conversations?${queryString({ exportId, query, filter, cursor, limit })}`);
}

export async function fetchConversation({ exportId, conversationId, start = 0, limit = 100 }) {
  return request(`/api/conversations/${encodeURIComponent(conversationId)}?${queryString({ exportId, start, limit })}`);
}

export async function fetchLibrary({ exportId, query = "", filter = "all", cursor = 0, limit = 80 }) {
  return request(`/api/library?${queryString({ exportId, query, filter, cursor, limit })}`);
}

export async function saveSessions({ exportId, conversationIds = [], onProgress }) {
  if (onProgress) {
    onProgress({ exportId, total: conversationIds.length, completed: 0 });
  }
  const result = await request("/api/sessions/export", {
    method: "POST",
    body: JSON.stringify({ exportId, conversationIds })
  });
  if (onProgress) {
    onProgress(result.progress);
  }
  return result;
}

export async function openSavedSessionsFolder({ exportId }) {
  return request("/api/sessions/open-folder", {
    method: "POST",
    body: JSON.stringify({ exportId })
  });
}

export function assetUrl(exportId, fileId) {
  return `${API_BASE}/api/assets/${encodeURIComponent(fileId)}?${queryString({ exportId })}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(formatApiError(path, response.status, body?.error));
  }
  return body;
}

function formatApiError(path, status, message) {
  if (status === 404 && message === "Not found") {
    return `The local API server is running an older build and does not support ${path}. Restart the API server.`;
  }
  return message ?? `HTTP ${status}`;
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  return params.toString();
}
