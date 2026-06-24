import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { scanExports } from "../exports/scanExports.mjs";
import { pickNativeFolder } from "../settings/nativeFolderPicker.mjs";
import { readRuntimeSettings, resolveSourceRoot } from "../settings/runtimeSettings.mjs";
import { defaultAllowedOrigins } from "./cors.mjs";
import { ensureIndex, createRouter } from "./router.mjs";

export async function createAppServer({
  root,
  cacheDir = path.join(process.cwd(), ".cache"),
  autoIndex = false,
  allowedOrigins = defaultAllowedOrigins(),
  pickFolder = pickNativeFolder,
  openFolder = openFolderWithSystem
} = {}) {
  if (!root) throw new Error("root is required");
  const resolvedCacheDir = path.resolve(cacheDir);
  const savedSettings = await readRuntimeSettings(resolvedCacheDir);
  let resolvedRoot = await resolveSourceRoot(root);
  if (savedSettings.sourceRoot) {
    try {
      resolvedRoot = await resolveSourceRoot(savedSettings.sourceRoot);
    } catch {
      // Fall back to the launch root if a previously saved folder was removed.
    }
  }
  const exports = await scanExports(resolvedRoot);
  const state = {
    root: resolvedRoot,
    cacheDir: resolvedCacheDir,
    exports,
    indexes: new Map(),
    indexJobs: new Map(),
    pickFolder,
    openFolder,
    savedSessionsDir: path.join(resolvedCacheDir, "Saved Sessions"),
    allowedOrigins: new Set(allowedOrigins)
  };
  if (autoIndex) {
    for (const exportItem of exports) {
      await ensureIndex(state, exportItem.id);
    }
  }
  const server = http.createServer(createRouter(state));
  server.appState = state;
  return server;
}

async function openFolderWithSystem(folderPath) {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise((resolve, reject) => {
    const child = spawn(command, [folderPath], {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
