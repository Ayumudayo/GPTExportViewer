import { createReadStream } from "node:fs";

export function streamAsset(response, asset, extraHeaders = {}) {
  response.writeHead(200, {
    "content-type": asset.mimeType,
    "content-length": asset.size,
    "content-disposition": contentDispositionHeader(asset.fileName),
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600",
    ...extraHeaders
  });
  createReadStream(asset.filePath).pipe(response);
}

export function contentDispositionHeader(value) {
  return `inline; filename="${encodeHeaderValue(value)}"; filename*=UTF-8''${encodeRfc5987Value(value)}`;
}

function encodeHeaderValue(value) {
  const fallback = String(value ?? "asset.dat")
    .normalize("NFC")
    .trim()
    .replace(/[^\x21-\x7e]|[<>:"/\\|?*;]/g, "_");
  return fallback || "asset.dat";
}

function encodeRfc5987Value(value) {
  const filename = String(value ?? "asset.dat").normalize("NFC").trim() || "asset.dat";
  return Array.from(Buffer.from(filename, "utf8"), (byte) =>
    isRfc5987AttrByte(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  ).join("");
}

function isRfc5987AttrByte(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    [0x21, 0x23, 0x24, 0x26, 0x2b, 0x2d, 0x2e, 0x5e, 0x5f, 0x60, 0x7c, 0x7e].includes(byte)
  );
}
