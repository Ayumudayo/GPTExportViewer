import { access, readdir, stat } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const SOURCE_FILES = {
  conversations: "conversations.json",
  libraryFiles: "library_files.json",
  assetNames: "conversation_asset_file_names.json"
};

export async function scanExports(rootPath) {
  const root = path.resolve(rootPath);
  const rootEntries = await readdir(root, { withFileTypes: true });
  const candidates = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));

  if (await pathExists(path.join(root, SOURCE_FILES.conversations))) {
    candidates.unshift(root);
  }

  const exports = [];
  for (const directory of candidates) {
    const exportItem = await describeExport(directory);
    if (exportItem.hasConversations || exportItem.hasLibraryFiles || exportItem.hasAssetNames) {
      exports.push(exportItem);
    }
  }

  exports.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || a.name.localeCompare(b.name));
  return exports;
}

async function describeExport(directory) {
  const info = await stat(directory);
  const paths = {
    root: directory,
    conversations: path.join(directory, SOURCE_FILES.conversations),
    libraryFiles: path.join(directory, SOURCE_FILES.libraryFiles),
    assetNames: path.join(directory, SOURCE_FILES.assetNames)
  };
  const hasConversations = await pathExists(paths.conversations);
  const hasLibraryFiles = await pathExists(paths.libraryFiles);
  const hasAssetNames = await pathExists(paths.assetNames);
  const warnings = [];
  if (!hasConversations) warnings.push(`missing ${SOURCE_FILES.conversations}`);
  if (!hasLibraryFiles) warnings.push(`missing ${SOURCE_FILES.libraryFiles}`);
  if (!hasAssetNames) warnings.push(`missing ${SOURCE_FILES.assetNames}`);

  return {
    id: stableId(directory),
    name: path.basename(directory),
    path: directory,
    paths,
    modifiedAt: info.mtime.toISOString(),
    modifiedAtMs: Math.trunc(info.mtimeMs),
    hasConversations,
    hasLibraryFiles,
    hasAssetNames,
    warnings
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stableId(value) {
  return crypto.createHash("sha1").update(path.resolve(value)).digest("hex").slice(0, 12);
}
