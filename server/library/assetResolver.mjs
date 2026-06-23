import { stat } from "node:fs/promises";
import path from "node:path";
import { assertSafeFileId, resolveInside } from "../utils/fsGuards.mjs";
import { sniffMime } from "./mimeSniff.mjs";

export async function resolveAsset(exportItem, fileId, libraryItems = []) {
  const safeFileId = assertSafeFileId(fileId);
  const item = libraryItems.find((candidate) => candidate.fileId === safeFileId || candidate.id === safeFileId);
  const fileRef = item?.fileRef ?? `${safeFileId}.dat`;
  const filePath = resolveInside(exportItem.path, fileRef);
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Asset file not found");
    }
    throw new Error("Asset file is unavailable");
  }
  if (!info.isFile()) {
    throw new Error("Asset is not a file");
  }
  const mimeType = item?.mime?.startsWith("image/") ? item.mime : await sniffMime(filePath, item?.mime);
  return {
    fileId: safeFileId,
    filePath,
    fileName: item?.displayName ?? path.basename(fileRef),
    mimeType: mimeType ?? "application/octet-stream",
    size: info.size
  };
}
