export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(body);
}

export function sendError(response, statusCode, message, details = undefined, extraHeaders = {}) {
  sendJson(response, statusCode, { error: message, details }, extraHeaders);
}

export function sendOptions(response, extraHeaders = {}) {
  response.writeHead(204, {
    ...extraHeaders
  });
  response.end();
}
