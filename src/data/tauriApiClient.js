const COMMANDS = {
  fetchExports: "get_exports",
  fetchSettings: "get_settings",
  updateSettings: "update_settings",
  fetchStats: "get_stats",
  fetchConversations: "get_conversations",
  fetchConversation: "get_conversation",
  fetchLibrary: "get_library",
  refreshIndex: "refresh_index"
};

export function createTauriApiClient({ invoke = invokeCommand, openDialog = openFolderDialog } = {}) {
  return {
    async fetchExports() {
      return invoke(COMMANDS.fetchExports);
    },

    async fetchSettings() {
      return invoke(COMMANDS.fetchSettings);
    },

    async pickSourceFolder({ initialPath }) {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: initialPath || undefined
      });
      if (!selected) return { folder: { canceled: true } };
      return { folder: { selectedPath: Array.isArray(selected) ? selected[0] : selected } };
    },

    async updateSettings({ sourceRoot }) {
      return invoke(COMMANDS.updateSettings, { sourceRoot });
    },

    async fetchStats(exportId) {
      return invoke(COMMANDS.fetchStats, { exportId });
    },

    async fetchConversations({ exportId, query = "", filter = "all", cursor = 0, limit = 50 }) {
      return normalizePagedResponse(await invoke(COMMANDS.fetchConversations, { exportId, query, filter, ...paginationArgs(cursor, limit) }));
    },

    async fetchConversation({ exportId, conversationId, start = 0, limit = 100 }) {
      return invoke(COMMANDS.fetchConversation, { exportId, conversationId, start: numericArg(start, 0), limit: numericArg(limit, 100) });
    },

    async fetchLibrary({ exportId, query = "", filter = "all", cursor = 0, limit = 80 }) {
      return normalizePagedResponse(await invoke(COMMANDS.fetchLibrary, { exportId, query, filter, ...paginationArgs(cursor, limit) }));
    },

    async refreshIndex({ exportId } = {}) {
      return invoke(COMMANDS.refreshIndex, { exportId });
    },

    assetUrl
  };
}

export async function fetchExports(...args) {
  return defaultClient().fetchExports(...args);
}

export async function fetchSettings(...args) {
  return defaultClient().fetchSettings(...args);
}

export async function pickSourceFolder(...args) {
  return defaultClient().pickSourceFolder(...args);
}

export async function updateSettings(...args) {
  return defaultClient().updateSettings(...args);
}

export async function fetchStats(...args) {
  return defaultClient().fetchStats(...args);
}

export async function fetchConversations(...args) {
  return defaultClient().fetchConversations(...args);
}

export async function fetchConversation(...args) {
  return defaultClient().fetchConversation(...args);
}

export async function fetchLibrary(...args) {
  return defaultClient().fetchLibrary(...args);
}

export function assetUrl(exportId, fileId) {
  return `gpt-export-asset://library/${encodeURIComponent(exportId)}/${encodeURIComponent(fileId)}`;
}

function normalizePagedResponse(payload) {
  return {
    ...payload,
    items: payload.items ?? [],
    page: payload.page ?? { cursor: 0, limit: 0, total: payload.items?.length ?? 0, nextCursor: null },
    stats: payload.stats ?? {}
  };
}

function paginationArgs(cursor, limit) {
  return {
    cursor: numericArg(cursor, 0),
    limit: numericArg(limit, 50)
  };
}

function numericArg(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function defaultClient() {
  return createTauriApiClient();
}

async function invokeCommand(command, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

async function openFolderDialog(options) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open(options);
}
