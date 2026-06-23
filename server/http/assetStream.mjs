import { createReadStream } from "node:fs";

export function streamAsset(response, asset, extraHeaders = {}) {
  response.writeHead(200, {
    "content-type": asset.mimeType,
    "content-length": asset.size,
    "content-disposition": `inline; filename="${encodeHeaderValue(asset.fileName)}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600",
    ...extraHeaders
  });
  createReadStream(asset.filePath).pipe(response);
}

function encodeHeaderValue(value) {
  return String(value ?? "asset.dat").replace(/["\r\n]/g, "_");
}
