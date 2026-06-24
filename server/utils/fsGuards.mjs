import path from "node:path";

export function assertSafeFileId(fileId) {
  if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 256) {
    throw new Error("Invalid file id");
  }
  if (fileId.includes("/") || fileId.includes("\\") || fileId.includes("..")) {
    throw new Error("Invalid file id");
  }
  if (!/^[A-Za-z0-9._:@-]+$/.test(fileId)) {
    throw new Error("Invalid file id");
  }
  return fileId;
}

export function resolveInside(basePath, ...segments) {
  const base = path.resolve(basePath);
  const target = path.resolve(base, ...segments);
  if (!isInside(base, target)) {
    throw new Error("Resolved path escapes export root");
  }
  return target;
}

export function isInside(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function safeCacheName(value) {
  const normalized = String(value ?? "").normalize("NFC").trim();
  const safe = Array.from(normalized)
    .map((char) => (/[\u0000-\u001f\u007f<>:"/\\|?*\s]/u.test(char) ? "_" : char))
    .join("")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return Array.from(safe || "untitled").slice(0, 180).join("");
}
