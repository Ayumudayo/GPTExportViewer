import { stat } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../cache/jsonCache.mjs";

const SETTINGS_FILE = "settings.json";

export async function readRuntimeSettings(cacheDir) {
  return readJson(settingsPath(cacheDir), {});
}

export async function writeRuntimeSettings(cacheDir, settings) {
  await writeJsonAtomic(settingsPath(cacheDir), settings);
}

export async function resolveSourceRoot(sourceRoot) {
  if (typeof sourceRoot !== "string" || !sourceRoot.trim()) {
    throw new Error("Invalid source root");
  }
  const resolved = path.resolve(sourceRoot.trim());
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error("Invalid source root: directory not found");
  }
  if (!info.isDirectory()) {
    throw new Error("Invalid source root: not a directory");
  }
  return resolved;
}

export function publicSettings(state) {
  return {
    sourceRoot: state.root,
    cacheDir: state.cacheDir,
    exportCount: state.exports.length
  };
}

function settingsPath(cacheDir) {
  return path.join(cacheDir, SETTINGS_FILE);
}
