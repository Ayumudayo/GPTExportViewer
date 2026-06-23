import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const apiClient = await readFile("src/data/apiClient.js", "utf8");
const httpClient = await readFile("src/data/httpApiClient.js", "utf8");
const tauriClient = await readFile("src/data/tauriApiClient.js", "utf8");

assert.equal(apiClient.includes("selectClient"), true, "Public API client should select the active transport");
assert.equal(apiClient.includes("isTauriRuntime"), true, "Public API client should detect the Tauri runtime");
assert.equal(httpClient.includes("/api/pick-folder"), true, "HTTP transport should retain the existing native picker endpoint");
assert.equal(httpClient.includes("local API server is running an older build"), true, "HTTP transport should keep restart guidance");

for (const command of [
  "get_exports",
  "get_settings",
  "update_settings",
  "get_stats",
  "get_conversations",
  "get_conversation",
  "get_library",
  "refresh_index"
]) {
  assert.equal(tauriClient.includes(command), true, `Tauri transport should invoke ${command}`);
}

assert.equal(tauriClient.includes("@tauri-apps/plugin-dialog"), true, "Tauri transport should use the native dialog plugin");
assert.equal(tauriClient.includes("gpt-export-asset://library/"), true, "Tauri asset URLs should use the custom protocol");
assert.equal(tauriClient.includes("selectedPath"), true, "Tauri folder picker should return selectedPath");
assert.equal(tauriClient.includes("canceled: true"), true, "Tauri folder picker should normalize cancellation");
assert.match(tauriClient, /page:\s*payload\.page/, "Tauri paged responses should preserve the page envelope");

const { createTauriApiClient } = await import("../src/data/tauriApiClient.js");
const calls = [];
const client = createTauriApiClient({
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "get_conversations" || command === "get_library") {
      return { export: { id: "exp" }, items: [], page: { cursor: 0, limit: args.limit, total: 0, nextCursor: null }, stats: {} };
    }
    return {};
  },
  openDialog: async () => "E:\\OpenAI\\Exports"
});

assert.equal(client.assetUrl("export id", "file/id"), "gpt-export-asset://library/export%20id/file%2Fid");
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

console.log("api client contract tests passed");
