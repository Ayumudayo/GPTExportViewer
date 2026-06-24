import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { makeFixtureExportRoot } from "./fixtures.mjs";
import { createAppServer } from "../server/http/createServer.mjs";
import { resolveAsset } from "../server/library/assetResolver.mjs";
import { buildLibraryIndex } from "../server/library/libraryIndex.mjs";
import { normalizeConversation } from "../server/conversations/normalizeConversation.mjs";
import { buildConversationSummaryIndex } from "../server/conversations/conversationSummaryIndex.mjs";
import { readJson, writeJsonAtomic } from "../server/cache/jsonCache.mjs";
import { scanExports } from "../server/exports/scanExports.mjs";
import { createWindowsFolderDialogInvocation } from "../server/settings/nativeFolderPicker.mjs";

const fixture = await makeFixtureExportRoot();

try {
  const exports = await scanExports(fixture.root);
  assert.equal(exports.length, 2);
  const goodExport = exports.find((item) => item.name === "chatgpt-export-good");
  const partialExport = exports.find((item) => item.name === "chatgpt-export-partial");
  assert.ok(goodExport.id);
  assert.equal(goodExport.hasConversations, true);
  assert.equal(goodExport.hasLibraryFiles, true);
  assert.equal(partialExport.hasLibraryFiles, false);
  assert.ok(partialExport.warnings.some((warning) => warning.includes("library_files.json")));

  const cacheFile = path.join(fixture.cacheDir, "sample.json");
  await writeJsonAtomic(cacheFile, { ok: true });
  assert.deepEqual(await readJson(cacheFile), { ok: true });
  assert.equal((await stat(cacheFile)).isFile(), true);

  const conversations = JSON.parse(await readFile(path.join(fixture.good, "conversations.json"), "utf8"));
  const normalized = normalizeConversation(conversations[0]);
  assert.equal(normalized.id, "conv-1");
  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[0].text, "Please make an image");
  assert.equal(normalized.messages[1].text, "Here is image\nDone");
  assert.ok(normalized.messages[1].assetRefs.some((asset) => asset.fileId === "file-img-1"));
  const parentOnly = normalizeConversation(conversations.find((item) => item.id === "conv-parent-only"));
  assert.deepEqual(parentOnly.messages.map((message) => message.text), ["Root message", "Child message", "Grandchild message"]);

  const summaries = await buildConversationSummaryIndex(goodExport);
  assert.equal(summaries.items.length, 3);
  assert.equal(summaries.items[0].title, "Parent only chain");
  assert.equal(summaries.items.find((item) => item.id === "conv-1").messageCount, 2);
  assert.equal(summaries.stats.totalMessages, 6);

  const library = await buildLibraryIndex(goodExport, new Set(["conv-1"]));
  assert.equal(library.items.length, 2);
  const linkedImage = library.items.find((item) => item.fileId === "file-img-1");
  const missingImage = library.items.find((item) => item.fileId === "file-img-missing");
  assert.equal(linkedImage.displayName, "renamed library.png");
  assert.equal(linkedImage.sourceState, "linked");
  assert.equal(missingImage.exists, false);

  const asset = await resolveAsset(goodExport, "file-img-1", library.items);
  assert.equal(asset.mimeType, "image/png");
  assert.equal(asset.filePath, path.join(fixture.good, "file-img-1.dat"));
  await assert.rejects(resolveAsset(goodExport, "..\\escape", library.items), /Invalid file id/);

  const pickerInvocation = createWindowsFolderDialogInvocation(fixture.root);
  assert.equal(pickerInvocation.command, "powershell.exe");
  assert.equal(pickerInvocation.args.includes(fixture.root), false);
  assert.equal(pickerInvocation.args.filter((item) => item === "-EncodedCommand").length, 1);
  assert.equal(pickerInvocation.args.at(-2), "-EncodedCommand");
  assert.equal(pickerInvocation.options.env.CHATGPT_EXPORT_PICKER_INITIAL_PATH, fixture.root);
  const pickerScript = Buffer.from(pickerInvocation.args.at(-1), "base64").toString("utf16le");
  assert.equal(pickerScript.includes("CHATGPT_EXPORT_PICKER_INITIAL_PATH"), true);

  const pickerCalls = [];
  const openFolderCalls = [];
  const server = await createAppServer({
    root: fixture.root,
    cacheDir: fixture.cacheDir,
    autoIndex: true,
    openFolder: async (folderPath) => {
      openFolderCalls.push(folderPath);
    },
    pickFolder: async ({ initialPath, fallbackPath }) => {
      pickerCalls.push({ initialPath, fallbackPath });
      if (initialPath === "cancel") return { canceled: true };
      return { selectedPath: fixture.good };
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const exportResponse = await fetch(`${baseUrl}/api/exports`);
    assert.equal(exportResponse.status, 200);
    const exportPayload = await exportResponse.json();
    const exportedItem = exportPayload.exports.find((item) => item.name === "chatgpt-export-good");
    const exportId = exportedItem.id;
    assert.ok(exportedItem.id);
    assert.equal(exportedItem.name, "chatgpt-export-good");
    assert.ok(exportedItem.modifiedAt);
    assert.equal(exportedItem.hasConversations, true);
    assert.equal(exportedItem.path, undefined);
    assert.equal(exportedItem.paths, undefined);
    assert.equal(exportedItem.modifiedAtMs, undefined);

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.status, 200);
    const settingsPayload = await settingsResponse.json();
    assert.equal(settingsPayload.settings.sourceRoot, path.resolve(fixture.root));
    assert.equal(settingsPayload.settings.cacheDir, path.resolve(fixture.cacheDir));
    assert.equal(settingsPayload.settings.exportCount, 2);

    const pickFolderResponse = await fetch(`${baseUrl}/api/pick-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialPath: fixture.root })
    });
    assert.equal(pickFolderResponse.status, 200);
    const pickFolderPayload = await pickFolderResponse.json();
    assert.equal(pickFolderPayload.folder.selectedPath, path.resolve(fixture.good));
    assert.deepEqual(pickerCalls.at(-1), { initialPath: fixture.root, fallbackPath: path.resolve(fixture.root) });

    const cancelFolderResponse = await fetch(`${baseUrl}/api/pick-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialPath: "cancel" })
    });
    assert.equal(cancelFolderResponse.status, 200);
    const cancelFolderPayload = await cancelFolderResponse.json();
    assert.equal(cancelFolderPayload.folder.canceled, true);

    const hostileResponse = await fetch(`${baseUrl}/api/exports`, { headers: { Origin: "https://evil.example" } });
    assert.equal(hostileResponse.status, 403);
    assert.equal(hostileResponse.headers.get("access-control-allow-origin"), null);

    const allowedResponse = await fetch(`${baseUrl}/api/exports`, { headers: { Origin: "http://127.0.0.1:5174" } });
    assert.equal(allowedResponse.status, 200);
    assert.equal(allowedResponse.headers.get("access-control-allow-origin"), "http://127.0.0.1:5174");

    const conversationResponse = await fetch(`${baseUrl}/api/conversations?exportId=${encodeURIComponent(exportId)}&limit=1`);
    const conversationPayload = await conversationResponse.json();
    assert.equal(conversationPayload.items.length, 1);
    assert.equal(conversationPayload.items[0].title, "Parent only chain");
    assert.equal(conversationPayload.page.nextCursor, "1");

    const conversationNextResponse = await fetch(`${baseUrl}/api/conversations?exportId=${encodeURIComponent(exportId)}&cursor=${conversationPayload.page.nextCursor}&limit=2`);
    const conversationNextPayload = await conversationNextResponse.json();
    assert.equal(conversationNextPayload.items.length, 2);

    const archivedResponse = await fetch(`${baseUrl}/api/conversations?exportId=${encodeURIComponent(exportId)}&filter=archived&limit=10`);
    assert.equal(archivedResponse.status, 200);
    const archivedPayload = await archivedResponse.json();
    assert.deepEqual(archivedPayload.items.map((item) => item.title), ["Beta notes"]);

    const activeResponse = await fetch(`${baseUrl}/api/conversations?exportId=${encodeURIComponent(exportId)}&filter=active&limit=10`);
    assert.equal(activeResponse.status, 200);
    const activePayload = await activeResponse.json();
    assert.equal(activePayload.items.some((item) => item.archived), false);
    assert.equal(activePayload.items.length, 2);

    const threadResponse = await fetch(`${baseUrl}/api/conversations/conv-1?exportId=${encodeURIComponent(exportId)}&limit=10`);
    const threadPayload = await threadResponse.json();
    assert.equal(threadPayload.messages.length, 2);
    assert.equal(threadPayload.messages[1].text, "Here is image\nDone");

    const expectedSavedSessionsDir = path.join(server.appState.savedSessionsDir, exportId);
    const missingSessionResponse = await fetch(`${baseUrl}/api/sessions/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exportId, conversationIds: ["missing"] })
    });
    assert.equal(missingSessionResponse.status, 404);
    await assert.rejects(stat(expectedSavedSessionsDir), { code: "ENOENT" });

    const sessionExportResponse = await fetch(`${baseUrl}/api/sessions/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exportId, conversationIds: ["conv-1", "conv-2"] })
    });
    assert.equal(sessionExportResponse.status, 200);
    const sessionExportPayload = await sessionExportResponse.json();
    assert.equal(sessionExportPayload.items.length, 2);
    assert.equal(sessionExportPayload.export.id, exportId);
    assert.equal(sessionExportPayload.export.path, undefined);
    assert.equal(sessionExportPayload.export.paths, undefined);
    assert.equal(sessionExportPayload.destinationDir, expectedSavedSessionsDir);
    for (const item of sessionExportPayload.items) {
      assert.equal(path.dirname(item.path), expectedSavedSessionsDir);
      assert.equal((await stat(item.path)).isFile(), true);
    }
    assert.equal(path.basename(sessionExportPayload.items[0].path), "2024-03-09-16-10-00.000--Alpha_image_work-conv-1.json");
    const savedSession = JSON.parse(await readFile(sessionExportPayload.items[0].path, "utf8"));
    assert.ok(savedSession.mapping);
    assert.equal(Object.hasOwn(savedSession, "messages"), false);

    const openSessionFolderResponse = await fetch(`${baseUrl}/api/sessions/open-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exportId })
    });
    assert.equal(openSessionFolderResponse.status, 200);
    const openSessionFolderPayload = await openSessionFolderResponse.json();
    assert.equal(openSessionFolderPayload.path, expectedSavedSessionsDir);
    assert.deepEqual(openFolderCalls, [expectedSavedSessionsDir]);

    const parentThreadResponse = await fetch(`${baseUrl}/api/conversations/conv-parent-only?exportId=${encodeURIComponent(exportId)}&limit=2`);
    const parentThreadPayload = await parentThreadResponse.json();
    assert.deepEqual(parentThreadPayload.messages.map((message) => message.text), ["Root message", "Child message"]);
    assert.equal(parentThreadPayload.range.nextStart, 2);

    const libraryResponse = await fetch(`${baseUrl}/api/library?exportId=${encodeURIComponent(exportId)}&filter=all&limit=1`);
    const libraryPayload = await libraryResponse.json();
    assert.equal(libraryPayload.items.length, 1);
    assert.equal(libraryPayload.page.nextCursor, "1");
    assert.equal(Boolean(libraryPayload.items[0].assetUrl), true);

    const assetResponse = await fetch(`${baseUrl}/api/assets/file-img-1?exportId=${encodeURIComponent(exportId)}`);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get("content-type"), "image/png");
    const assetBytes = new Uint8Array(await assetResponse.arrayBuffer());
    assert.equal(assetBytes[0], 0x89);
    assert.equal(assetBytes[1], 0x50);

    const missingAssetResponse = await fetch(`${baseUrl}/api/assets/file-img-missing?exportId=${encodeURIComponent(exportId)}`);
    assert.equal(missingAssetResponse.status, 404);
    const missingAssetPayload = await missingAssetResponse.json();
    assert.equal(missingAssetPayload.error, "Asset file not found");
    assert.equal(JSON.stringify(missingAssetPayload).includes(fixture.good), false);

    const invalidSettingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRoot: path.join(fixture.root, "missing") })
    });
    assert.equal(invalidSettingsResponse.status, 400);
    assert.equal((await fetch(`${baseUrl}/api/exports`).then((response) => response.json())).exports.length, 2);

    const patchSettingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRoot: fixture.partial })
    });
    assert.equal(patchSettingsResponse.status, 200);
    const patchSettingsPayload = await patchSettingsResponse.json();
    assert.equal(patchSettingsPayload.settings.sourceRoot, path.resolve(fixture.partial));
    assert.equal(patchSettingsPayload.settings.exportCount, 1);
    assert.equal(patchSettingsPayload.exports.length, 1);
    assert.equal(patchSettingsPayload.exports[0].name, "chatgpt-export-partial");
    assert.ok(patchSettingsPayload.exports[0].id);
    assert.ok(patchSettingsPayload.exports[0].modifiedAt);
    assert.equal(patchSettingsPayload.exports[0].hasConversations, true);
    assert.equal(patchSettingsPayload.exports[0].path, undefined);
    assert.equal(patchSettingsPayload.exports[0].paths, undefined);
    assert.equal(patchSettingsPayload.exports[0].modifiedAtMs, undefined);

    const nextExportsPayload = await fetch(`${baseUrl}/api/exports`).then((response) => response.json());
    assert.equal(nextExportsPayload.exports.length, 1);
    const nextExportId = nextExportsPayload.exports[0].id;
    assert.notEqual(nextExportId, exportId);

    const oldExportResponse = await fetch(`${baseUrl}/api/stats?exportId=${encodeURIComponent(exportId)}`);
    assert.equal(oldExportResponse.status, 404);

    const [nextStatsResponse, nextConversationsResponse, nextLibraryResponse] = await Promise.all([
      fetch(`${baseUrl}/api/stats?exportId=${encodeURIComponent(nextExportId)}`),
      fetch(`${baseUrl}/api/conversations?exportId=${encodeURIComponent(nextExportId)}&limit=1`),
      fetch(`${baseUrl}/api/library?exportId=${encodeURIComponent(nextExportId)}&limit=1`)
    ]);
    assert.equal(nextStatsResponse.status, 200);
    assert.equal(nextConversationsResponse.status, 200);
    assert.equal(nextLibraryResponse.status, 200);
    const nextStatsPayload = await nextStatsResponse.json();
    assert.equal(nextStatsPayload.conversations.totalConversations, 0);

    const settingsFile = await readJson(path.join(fixture.cacheDir, "settings.json"));
    assert.equal(settingsFile.sourceRoot, path.resolve(fixture.partial));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const restartedServer = await createAppServer({ root: fixture.root, cacheDir: fixture.cacheDir });
  assert.equal(restartedServer.appState.root, path.resolve(fixture.partial));
  assert.equal(restartedServer.appState.exports.length, 1);

  console.log("server tests passed");
} finally {
  await rm(fixture.root, { recursive: true, force: true });
}
