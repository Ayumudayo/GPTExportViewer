import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const apiClient = await readFile("src/data/apiClient.js", "utf8");
const tauriClient = await readFile("src/data/tauriApiClient.js", "utf8");

assert.equal(apiClient.includes("./tauriApiClient.js"), true, "Public API client should use the Tauri transport directly");
assert.equal(apiClient.includes("httpApiClient"), false, "Public API client should not import the removed HTTP transport");
assert.equal(apiClient.includes("saveSessions"), true, "Public API client should expose saveSessions");
assert.equal(apiClient.includes("openSavedSessionsFolder"), true, "Public API client should expose openSavedSessionsFolder");
assert.equal(apiClient.includes("saveOriginalImage"), true, "Public API client should expose original image saving");
assert.equal(apiClient.includes("rescanExports"), true, "Public API client should expose source folder rescanning");
assert.equal(apiClient.includes("updatePreferences"), true, "Public API client should expose lightweight app preference updates");

for (const command of [
  "get_exports",
  "get_settings",
  "update_settings",
  "rescan_exports",
  "update_preferences",
  "get_stats",
  "get_conversations",
  "get_conversation",
  "get_library",
  "refresh_index",
  "save_sessions",
  "open_saved_sessions_folder",
  "save_original_image"
]) {
  assert.equal(tauriClient.includes(command), true, `Tauri transport should invoke ${command}`);
}

assert.equal(tauriClient.includes("session-export-progress"), true, "Tauri transport should listen for session export progress");
assert.equal(tauriClient.includes("@tauri-apps/plugin-dialog"), true, "Tauri transport should use the native dialog plugin");
assert.equal(tauriClient.includes("http://gpt-export-asset.localhost/library/"), true, "Tauri asset URLs should use the Windows WebView2 protocol bridge");
assert.equal(tauriClient.includes("selectedPath"), true, "Tauri folder picker should return selectedPath");
assert.equal(tauriClient.includes("canceled: true"), true, "Tauri folder picker should normalize cancellation");
assert.equal(tauriClient.includes("displayName"), false, "Image saving should not depend on renderer-provided filenames");
assert.match(tauriClient, /page:\s*payload\.page/, "Tauri paged responses should preserve the page envelope");

const { createTauriApiClient } = await import("../src/data/tauriApiClient.js");
const calls = [];
const events = [];
const client = createTauriApiClient({
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "get_conversations" || command === "get_library") {
      return { export: { id: "exp" }, items: [], page: { cursor: 0, limit: args.limit, total: 0, nextCursor: null }, stats: {} };
    }
    if (command === "save_sessions") {
      return {
        export: { id: "exp" },
        destinationDir: "Saved Sessions",
        items: [],
        progress: { exportId: "exp", total: 1, completed: 1 }
      };
    }
    if (command === "save_original_image") {
      return { canceled: false, path: "E:\\Images\\image.png", fileName: "image.png" };
    }
    return {};
  },
  openDialog: async () => "E:\\OpenAI\\Exports",
  listenEvent: async (eventName, handler) => {
    events.push(eventName);
    handler({ payload: { exportId: "exp", total: 1, completed: 1 } });
    return () => events.push("unlisten");
  }
});

assert.equal(client.assetUrl("export id", "file/id"), "http://gpt-export-asset.localhost/library/export%20id/file%2Fid");
assert.deepEqual(await client.pickSourceFolder({ initialPath: "E:\\OpenAI" }), { folder: { selectedPath: "E:\\OpenAI\\Exports" } });
assert.deepEqual(
  await createTauriApiClient({ invoke: async () => ({}), openDialog: async () => null }).pickSourceFolder({ initialPath: "E:\\OpenAI" }),
  { folder: { canceled: true } }
);
assert.deepEqual(await client.fetchConversations({ exportId: "exp", limit: 10 }), {
  export: { id: "exp" },
  items: [],
  page: { cursor: 0, limit: 10, total: 0, nextCursor: null },
  stats: {}
});
assert.equal(calls.some((call) => call.command === "get_conversations"), true);
await client.fetchLibrary({ exportId: "exp", cursor: "12", limit: "10" });
const libraryCall = calls.findLast((call) => call.command === "get_library");
assert.equal(libraryCall.args.cursor, 12);
assert.equal(libraryCall.args.limit, 10);
const progressPayloads = [];
assert.deepEqual(
  await client.saveSessions({ exportId: "exp", conversationIds: ["c1"], onProgress: (progress) => progressPayloads.push(progress) }),
  {
    export: { id: "exp" },
    destinationDir: "Saved Sessions",
    items: [],
    progress: { exportId: "exp", total: 1, completed: 1 }
  }
);
assert.equal(calls.some((call) => call.command === "save_sessions"), true);
assert.deepEqual(events, ["session-export-progress", "unlisten"]);
assert.deepEqual(progressPayloads, [{ exportId: "exp", total: 1, completed: 1 }]);
await client.openSavedSessionsFolder({ exportId: "exp" });
assert.equal(calls.some((call) => call.command === "open_saved_sessions_folder"), true);
assert.deepEqual(await client.saveOriginalImage({ exportId: "exp", fileId: "file-img-1" }), {
  canceled: false,
  path: "E:\\Images\\image.png",
  fileName: "image.png"
});
const imageSaveCall = calls.findLast((call) => call.command === "save_original_image");
assert.equal(imageSaveCall.args.exportId, "exp");
assert.equal(imageSaveCall.args.fileId, "file-img-1");
await client.rescanExports();
assert.equal(calls.some((call) => call.command === "rescan_exports"), true);
await client.updatePreferences({ selectedExportId: "exp", windowSize: { width: 1280, height: 840 } });
const preferenceCall = calls.findLast((call) => call.command === "update_preferences");
assert.deepEqual(preferenceCall.args, { selectedExportId: "exp", windowSize: { width: 1280, height: 840 } });

const fallbackProgress = [];
const fallbackClient = createTauriApiClient({
  invoke: async () => ({ progress: { exportId: "exp", total: 1, completed: 1 } }),
  listenEvent: async () => () => {}
});
assert.deepEqual(await fallbackClient.saveSessions({ exportId: "exp", conversationIds: ["c1"], onProgress: (progress) => fallbackProgress.push(progress) }), {
  progress: { exportId: "exp", total: 1, completed: 1 }
});
assert.deepEqual(fallbackProgress, [{ exportId: "exp", total: 1, completed: 1 }]);

const filteredProgress = [];
const filteredClient = createTauriApiClient({
  invoke: async () => ({ progress: { exportId: "exp", total: 2, completed: 2 } }),
  listenEvent: async (_eventName, handler) => {
    handler({ payload: { exportId: "other", total: 2, completed: 1 } });
    handler({ payload: { exportId: "exp", total: 2, completed: 2 } });
    return () => {};
  }
});
await filteredClient.saveSessions({ exportId: "exp", conversationIds: ["c1", "c2"], onProgress: (progress) => filteredProgress.push(progress) });
assert.deepEqual(filteredProgress, [{ exportId: "exp", total: 2, completed: 2 }]);

const cleanupResult = { progress: { exportId: "exp", total: 1, completed: 1 } };
const cleanupSuccessClient = createTauriApiClient({
  invoke: async () => cleanupResult,
  listenEvent: async () => async () => {
    throw new Error("cleanup failed");
  }
});
assert.equal(await cleanupSuccessClient.saveSessions({ exportId: "exp", conversationIds: ["c1"], onProgress: () => {} }), cleanupResult);

const invokeError = new Error("invoke failed");
const cleanupFailureClient = createTauriApiClient({
  invoke: async () => {
    throw invokeError;
  },
  listenEvent: async () => async () => {
    throw new Error("cleanup failed");
  }
});
await assert.rejects(
  cleanupFailureClient.saveSessions({ exportId: "exp", conversationIds: ["c1"], onProgress: () => {} }),
  (error) => {
    assert.equal(error, invokeError);
    return true;
  }
);

console.log("api client contract tests passed");
