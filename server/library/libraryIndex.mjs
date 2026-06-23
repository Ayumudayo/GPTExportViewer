import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { formatBytes, toIsoTime } from "../utils/time.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);

export async function buildLibraryIndex(exportItem, conversationIds = new Set()) {
  if (!exportItem.hasLibraryFiles) {
    return emptyIndex();
  }
  const files = await readArray(exportItem.paths.libraryFiles);
  const nameMap = exportItem.hasAssetNames ? await readNameMap(exportItem.paths.assetNames) : {};
  const items = [];
  for (const file of files) {
    if (!isImageFile(file)) continue;
    const fileId = String(file.file_id ?? file.id ?? "");
    if (!fileId) continue;
    const storedName = `${fileId}.dat`;
    const storedPath = path.join(exportItem.path, storedName);
    const exists = await fileExists(storedPath);
    const sourceConversationId = file.origination_thread_id ?? file.conversation_id ?? file.thread_id ?? null;
    const linked = Boolean(sourceConversationId && conversationIds.has(String(sourceConversationId)));
    const displayName = nameMap[storedName] ?? file.file_name ?? file.name ?? storedName;
    const mime = file.mime_type ?? inferMimeFromName(displayName) ?? "application/octet-stream";
    const sizeBytes = Number(file.file_size_bytes ?? file.size_bytes ?? file.size ?? 0);
    const createdAt = toIsoTime(file.created_at ?? file.create_time ?? file.created_time);
    items.push({
      id: fileId,
      fileId,
      displayName,
      filename: displayName,
      originalName: file.file_name ?? null,
      mime,
      sizeBytes,
      sizeLabel: formatBytes(sizeBytes),
      createdAt,
      status: file.state ?? file.status ?? (exists ? "ready" : "missing"),
      fileRef: storedName,
      exists,
      sourceConversationId: sourceConversationId ? String(sourceConversationId) : null,
      sourceMessageId: file.origination_message_id ?? file.message_id ?? null,
      sourceState: linked ? "linked" : sourceConversationId ? "missing-source-chat" : "library-only",
      inChat: linked,
      raw: file
    });
  }
  items.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  return {
    items,
    stats: {
      totalImages: items.length,
      linkedImages: items.filter((item) => item.sourceState === "linked").length,
      libraryOnlyImages: items.filter((item) => item.sourceState === "library-only").length,
      missingSourceImages: items.filter((item) => item.sourceState === "missing-source-chat").length,
      missingFiles: items.filter((item) => !item.exists).length
    },
    generatedAt: new Date().toISOString()
  };
}

async function readArray(filePath) {
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.files)) return parsed.files;
  if (Array.isArray(parsed.library_files)) return parsed.library_files;
  return [];
}

async function readNameMap(filePath) {
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed)) {
    return Object.fromEntries(
      parsed
        .map((item) => [item.file_name ?? item.file ?? item.path, item.original_name ?? item.name])
        .filter(([key, value]) => key && value)
    );
  }
  return {};
}

function isImageFile(file) {
  const mime = file.mime_type ?? file.mimeType ?? "";
  if (mime.startsWith("image/")) return true;
  const category = String(file.library_file_category ?? file.category ?? "").toLowerCase();
  if (category === "image") return true;
  const name = file.file_name ?? file.name ?? "";
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function inferMimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".avif") return "image/avif";
  return null;
}

function emptyIndex() {
  return {
    items: [],
    stats: {
      totalImages: 0,
      linkedImages: 0,
      libraryOnlyImages: 0,
      missingSourceImages: 0,
      missingFiles: 0
    },
    generatedAt: new Date().toISOString()
  };
}
