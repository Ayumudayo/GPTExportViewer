const COMMANDS = {
  fetchExports: "get_exports",
  fetchSettings: "get_settings",
  updateSettings: "update_settings",
  rescanExports: "rescan_exports",
  updatePreferences: "update_preferences",
  fetchStats: "get_stats",
  fetchConversations: "get_conversations",
  fetchConversation: "get_conversation",
  fetchLibrary: "get_library",
  refreshIndex: "refresh_index",
  saveSessions: "save_sessions",
  openSavedSessionsFolder: "open_saved_sessions_folder",
  saveOriginalImage: "save_original_image",
  exportOriginalImages: "export_original_images",
  openExportedImagesFolder: "open_exported_images_folder"
};

const SESSION_EXPORT_PROGRESS_EVENT = "session-export-progress";
const IMAGE_EXPORT_PROGRESS_EVENT = "image-export-progress";

async function runWithProgressEvent({ listenEvent, eventName, exportId, onProgress, invokeWork }) {
  let unlisten;
  let lastProgress;
  if (onProgress) {
    unlisten = await listenEvent(eventName, (event) => {
      const progress = event.payload;
      if (progress?.exportId !== exportId) {
        return;
      }
      lastProgress = progress;
      onProgress(progress);
    });
  }
  try {
    const result = await invokeWork();
    if (onProgress && !result?.canceled && result?.progress && !sameProgress(result.progress, lastProgress)) {
      lastProgress = result.progress;
      onProgress(result.progress);
    }
    return result;
  } finally {
    if (unlisten) {
      try {
        await unlisten();
      } catch {
        // Cleanup errors must not replace the invoke result or error.
      }
    }
  }
}

function attachProjectFilterArgs(args, projectId, projectIds) {
  const normalized = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(projectIds) ? projectIds : []), ...(projectId ? [projectId] : [])]) {
    const trimmed = String(raw || "").trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  if (normalized.length > 0) {
    args.projectIds = normalized;
    if (normalized.length === 1) {
      args.projectId = normalized[0];
    }
  } else if (projectId !== undefined && projectId !== "") {
    args.projectId = projectId;
  }
}

export function createTauriApiClient({ invoke = invokeCommand, openDialog = openFolderDialog, listenEvent = listenToEvent } = {}) {
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

    async rescanExports() {
      return invoke(COMMANDS.rescanExports);
    },

    async updatePreferences({ selectedExportId = undefined, windowSize = undefined, projectAliases = undefined } = {}) {
      const args = { selectedExportId, windowSize };
      if (projectAliases !== undefined) {
        args.projectAliases = projectAliases;
      }
      return invoke(COMMANDS.updatePreferences, args);
    },

    async fetchStats(exportId) {
      return invoke(COMMANDS.fetchStats, { exportId });
    },

    async fetchConversations({ exportId, query = "", filter = "all", scope = undefined, projectId = undefined, projectIds = undefined, cursor = 0, limit = 50 }) {
      const args = { exportId, query, filter, ...paginationArgs(cursor, limit) };
      if (scope && scope !== "all") {
        args.scope = scope;
      }
      attachProjectFilterArgs(args, projectId, projectIds);
      return normalizePagedResponse(await invoke(COMMANDS.fetchConversations, args));
    },

    async fetchConversation({ exportId, conversationId, start = 0, limit = 100 }) {
      return invoke(COMMANDS.fetchConversation, { exportId, conversationId, start: numericArg(start, 0), limit: numericArg(limit, 100) });
    },

    async fetchLibrary({ exportId, query = "", filter = "all", cursor = 0, limit = 80 }) {
      return normalizePagedResponse(await invoke(COMMANDS.fetchLibrary, { exportId, query, filter, ...paginationArgs(cursor, limit) }));
    },

    async refreshIndex({ exportId = undefined } = {}) {
      return invoke(COMMANDS.refreshIndex, { exportId });
    },

    async saveSessions({ exportId, conversationIds, onProgress }) {
      return runWithProgressEvent({
        listenEvent,
        eventName: SESSION_EXPORT_PROGRESS_EVENT,
        exportId,
        onProgress,
        invokeWork: () => invoke(COMMANDS.saveSessions, { exportId, conversationIds })
      });
    },

    async openSavedSessionsFolder({ exportId }) {
      return invoke(COMMANDS.openSavedSessionsFolder, { exportId });
    },

    async saveOriginalImage({ exportId, fileId }) {
      return invoke(COMMANDS.saveOriginalImage, { exportId, fileId });
    },

    async exportOriginalImages({ exportId, scope, conversationIds = undefined, projectId = undefined, projectIds = undefined, onProgress = undefined }) {
      const args = { exportId, scope };
      if (conversationIds !== undefined) {
        args.conversationIds = conversationIds;
      }
      attachProjectFilterArgs(args, projectId, projectIds);
      return runWithProgressEvent({
        listenEvent,
        eventName: IMAGE_EXPORT_PROGRESS_EVENT,
        exportId,
        onProgress,
        invokeWork: () => invoke(COMMANDS.exportOriginalImages, args)
      });
    },

    async openExportedImagesFolder({ path }) {
      return invoke(COMMANDS.openExportedImagesFolder, { path });
    },

    assetUrl,
    thumbUrl
  };
}

export async function fetchExports() {
  return defaultClient().fetchExports();
}

export async function fetchSettings() {
  return defaultClient().fetchSettings();
}

export async function pickSourceFolder(...args) {
  return defaultClient().pickSourceFolder(...args);
}

export async function updateSettings(...args) {
  return defaultClient().updateSettings(...args);
}

export async function rescanExports() {
  return defaultClient().rescanExports();
}

export async function updatePreferences(...args) {
  return defaultClient().updatePreferences(...args);
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

export async function saveSessions(...args) {
  return defaultClient().saveSessions(...args);
}

export async function openSavedSessionsFolder(...args) {
  return defaultClient().openSavedSessionsFolder(...args);
}

export async function saveOriginalImage(...args) {
  return defaultClient().saveOriginalImage(...args);
}

export async function exportOriginalImages(...args) {
  return defaultClient().exportOriginalImages(...args);
}

export async function openExportedImagesFolder(...args) {
  return defaultClient().openExportedImagesFolder(...args);
}

export function assetUrl(exportId, fileId) {
  return `http://gpt-export-asset.localhost/library/${encodeURIComponent(exportId)}/${encodeURIComponent(fileId)}`;
}

export function thumbUrl(exportId, fileId) {
  return `${assetUrl(exportId, fileId)}?thumb=1`;
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

function sameProgress(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

async function listenToEvent(eventName, handler) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(eventName, handler);
}
