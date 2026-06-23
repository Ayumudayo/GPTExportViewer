import { indexExport } from "../cache/indexExport.mjs";
import { loadConversation } from "../conversations/loadConversation.mjs";
import { scanExports } from "../exports/scanExports.mjs";
import { resolveAsset } from "../library/assetResolver.mjs";
import { publicSettings, resolveSourceRoot, writeRuntimeSettings } from "../settings/runtimeSettings.mjs";
import { pageItems, parsePagination } from "../utils/pagination.mjs";
import { streamAsset } from "./assetStream.mjs";
import { corsPreflightHeaders, getCorsResult } from "./cors.mjs";
import { sendError, sendJson, sendOptions } from "./responses.mjs";

export function createRouter(state) {
  return async function route(request, response) {
    const cors = getCorsResult(request, state);
    if (request.method === "OPTIONS") {
      if (!cors.allowed) return sendError(response, 403, "Origin not allowed");
      return sendOptions(response, corsPreflightHeaders(cors.headers));
    }
    if (!cors.allowed) return sendError(response, 403, "Origin not allowed");
    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true }, cors.headers);
      }
      if (request.method === "GET" && url.pathname === "/api/exports") {
        return sendJson(response, 200, { exports: state.exports }, cors.headers);
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return sendJson(response, 200, { settings: publicSettings(state) }, cors.headers);
      }
      if (request.method === "PATCH" && url.pathname === "/api/settings") {
        const body = await readJsonBody(request);
        const sourceRoot = await resolveSourceRoot(body.sourceRoot);
        const exports = await scanExports(sourceRoot);
        state.root = sourceRoot;
        state.exports = exports;
        state.indexes.clear();
        state.indexJobs.clear();
        await writeRuntimeSettings(state.cacheDir, { sourceRoot });
        return sendJson(response, 200, { settings: publicSettings(state), exports: state.exports }, cors.headers);
      }
      if (request.method === "POST" && url.pathname === "/api/pick-folder") {
        const body = await readJsonBody(request);
        const picked = await state.pickFolder({
          initialPath: body.initialPath || state.root,
          fallbackPath: state.root
        });
        if (picked?.canceled) return sendJson(response, 200, { folder: { canceled: true } }, cors.headers);
        const selectedPath = await resolveSourceRoot(picked?.selectedPath);
        return sendJson(response, 200, { folder: { selectedPath } }, cors.headers);
      }
      if (request.method === "POST" && url.pathname === "/api/index") {
        const exportId = url.searchParams.get("exportId");
        const targets = exportId ? [findExport(state, exportId)] : state.exports;
        const results = [];
        for (const exportItem of targets) {
          const indexed = await ensureIndex(state, exportItem.id, { force: true });
          results.push({ exportId: exportItem.id, cacheHit: indexed.cache.hit });
        }
        return sendJson(response, 200, { indexed: results }, cors.headers);
      }
      if (request.method === "GET" && url.pathname === "/api/conversations") {
        const exportItem = getRequestedExport(state, url);
        const indexed = await ensureIndex(state, exportItem.id);
        const filtered = filterConversations(indexed.conversationIndex.items, url.searchParams);
        const { cursor, limit } = parsePagination(url.searchParams, { defaultLimit: 30, maxLimit: 100 });
        const page = pageItems(filtered, cursor, limit);
        return sendJson(response, 200, {
          export: publicExport(exportItem),
          ...page,
          stats: indexed.conversationIndex.stats
        }, cors.headers);
      }
      const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (request.method === "GET" && conversationMatch) {
        const exportItem = getRequestedExport(state, url);
        const start = Number.parseInt(url.searchParams.get("start") ?? "0", 10);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        const conversation = await loadConversation(exportItem, decodeURIComponent(conversationMatch[1]), {
          cacheDir: state.cacheDir,
          start,
          limit
        });
        if (!conversation) return sendError(response, 404, "Conversation not found", undefined, cors.headers);
        return sendJson(response, 200, conversation, cors.headers);
      }
      if (request.method === "GET" && url.pathname === "/api/library") {
        const exportItem = getRequestedExport(state, url);
        const indexed = await ensureIndex(state, exportItem.id);
        const filtered = filterLibrary(indexed.libraryIndex.items, url.searchParams);
        const { cursor, limit } = parsePagination(url.searchParams, { defaultLimit: 60, maxLimit: 120 });
        const page = pageItems(filtered.map((item) => withAssetUrl(item, exportItem.id)), cursor, limit);
        return sendJson(response, 200, {
          export: publicExport(exportItem),
          ...page,
          stats: indexed.libraryIndex.stats
        }, cors.headers);
      }
      const libraryMatch = url.pathname.match(/^\/api\/library\/([^/]+)$/);
      if (request.method === "GET" && libraryMatch) {
        const exportItem = getRequestedExport(state, url);
        const indexed = await ensureIndex(state, exportItem.id);
        const fileId = decodeURIComponent(libraryMatch[1]);
        const item = indexed.libraryIndex.items.find((candidate) => candidate.fileId === fileId);
        if (!item) return sendError(response, 404, "Library item not found", undefined, cors.headers);
        return sendJson(response, 200, { item: withAssetUrl(item, exportItem.id) }, cors.headers);
      }
      const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
      if (request.method === "GET" && assetMatch) {
        const exportItem = getRequestedExport(state, url);
        const indexed = await ensureIndex(state, exportItem.id);
        const asset = await resolveAsset(exportItem, decodeURIComponent(assetMatch[1]), indexed.libraryIndex.items);
        return streamAsset(response, asset, cors.headers);
      }
      if (request.method === "GET" && url.pathname === "/api/stats") {
        const exportItem = getRequestedExport(state, url);
        const indexed = await ensureIndex(state, exportItem.id);
        return sendJson(response, 200, {
          export: publicExport(exportItem),
          conversations: indexed.conversationIndex.stats,
          library: indexed.libraryIndex.stats,
          cache: indexed.cache
        }, cors.headers);
      }
      return sendError(response, 404, "Not found", undefined, cors.headers);
    } catch (error) {
      const message = error?.message ?? "Internal server error";
      const statusCode = message.includes("Invalid") || message.includes("required") ? 400 : message.includes("not found") ? 404 : 500;
      return sendError(response, statusCode, message, undefined, cors.headers);
    }
  };
}

export async function ensureIndex(state, exportId, { force = false } = {}) {
  if (!force && state.indexes.has(exportId)) return state.indexes.get(exportId);
  if (!state.indexJobs) state.indexJobs = new Map();
  if (state.indexJobs.has(exportId)) return state.indexJobs.get(exportId);
  const exportItem = findExport(state, exportId);
  if (force) state.indexes.delete(exportId);
  const job = indexExport(exportItem, { cacheDir: state.cacheDir, force }).then((indexed) => {
    state.indexes.set(exportId, indexed);
    return indexed;
  });
  state.indexJobs.set(exportId, job);
  try {
    return await job;
  } finally {
    if (state.indexJobs.get(exportId) === job) state.indexJobs.delete(exportId);
  }
}

function getRequestedExport(state, url) {
  const exportId = url.searchParams.get("exportId") ?? state.exports[0]?.id;
  if (!exportId) throw new Error("exportId is required");
  return findExport(state, exportId);
}

function findExport(state, exportId) {
  const exportItem = state.exports.find((item) => item.id === exportId);
  if (!exportItem) throw new Error("Export not found");
  return exportItem;
}

function filterConversations(items, searchParams) {
  const query = searchParams.get("query")?.toLowerCase();
  const filter = searchParams.get("filter") ?? "all";
  return items.filter((item) => {
    if (filter === "archived" && !item.archived) return false;
    if (filter === "active" && item.archived) return false;
    if (!query) return true;
    return [item.title, item.preview, item.model, item.id].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

function filterLibrary(items, searchParams) {
  const query = searchParams.get("query")?.toLowerCase();
  const filter = searchParams.get("filter") ?? "all";
  return items.filter((item) => {
    if (filter !== "all" && item.sourceState !== filter) return false;
    if (!query) return true;
    return [item.displayName, item.mime, item.fileId, item.sourceConversationId].some((value) =>
      String(value ?? "").toLowerCase().includes(query)
    );
  });
}

function withAssetUrl(item, exportId) {
  return {
    ...item,
    assetUrl: `/api/assets/${encodeURIComponent(item.fileId)}?exportId=${encodeURIComponent(exportId)}`
  };
}

function publicExport(exportItem) {
  const { paths, modifiedAtMs, ...rest } = exportItem;
  return rest;
}

async function readJsonBody(request) {
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of request) {
    totalSize += chunk.length;
    if (totalSize > 64 * 1024) throw new Error("Invalid request body");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body");
  }
}
