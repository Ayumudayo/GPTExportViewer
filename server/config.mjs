import path from "node:path";
import { defaultAllowedOrigins } from "./http/cors.mjs";

const DEFAULT_EXPORT_ROOT = process.platform === "win32" ? "E:\\OpenAI\\Exports" : path.resolve("exports");

export function parseArgs(argv = process.argv.slice(2)) {
  const config = {
    root: DEFAULT_EXPORT_ROOT,
    cacheDir: path.join(process.cwd(), ".cache"),
    host: "127.0.0.1",
    port: 43117,
    allowedOrigins: defaultAllowedOrigins(),
    indexOnly: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") config.root = argv[++index];
    else if (arg === "--cache") config.cacheDir = argv[++index];
    else if (arg === "--host") config.host = argv[++index];
    else if (arg === "--port") config.port = Number.parseInt(argv[++index], 10);
    else if (arg === "--allow-origin") config.allowedOrigins.push(argv[++index]);
    else if (arg === "--index-only") config.indexOnly = true;
    else if (arg === "--help" || arg === "-h") config.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return config;
}

export function usage() {
  return [
    "ChatGPT Export Viewer",
    "",
    "Options:",
    "  --root <path>       Export root directory",
    "  --cache <path>      JSON cache directory",
    "  --host <host>       Bind host, defaults to 127.0.0.1",
    "  --port <port>       API port, defaults to 43117",
    "  --allow-origin <o>  Additional allowed browser Origin",
    "  --index-only        Build caches and exit"
  ].join("\n");
}
