const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:4174",
  "http://localhost:4174"
];

export function defaultAllowedOrigins() {
  return [...DEFAULT_ALLOWED_ORIGINS];
}

export function getCorsResult(request, state) {
  const origin = request.headers.origin;
  if (!origin) {
    return { allowed: true, headers: {} };
  }
  const sameOrigin = origin === `http://${request.headers.host}`;
  const allowedOrigins = state.allowedOrigins ?? new Set(DEFAULT_ALLOWED_ORIGINS);
  if (sameOrigin || allowedOrigins.has(origin)) {
    return {
      allowed: true,
      headers: {
        "access-control-allow-origin": origin,
        "vary": "Origin"
      }
    };
  }
  return { allowed: false, headers: {} };
}

export function corsPreflightHeaders(corsHeaders) {
  return {
    ...corsHeaders,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}
