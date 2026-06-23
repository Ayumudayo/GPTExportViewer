import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export async function fileFingerprint(filePath) {
  try {
    const info = await stat(filePath);
    return {
      path: filePath,
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: filePath, missing: true };
    }
    throw error;
  }
}

export async function exportFingerprint(exportItem) {
  const entries = await Promise.all(
    Object.entries(exportItem.paths)
      .filter(([key]) => key !== "root")
      .map(async ([key, filePath]) => [key, await fileFingerprint(filePath)])
  );
  return Object.fromEntries(entries);
}

export function fingerprintsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
