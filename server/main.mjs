import { createAppServer } from "./http/createServer.mjs";
import { parseArgs, usage } from "./config.mjs";
import { scanExports } from "./exports/scanExports.mjs";
import { indexExport } from "./cache/indexExport.mjs";

const config = parseArgs();

if (config.help) {
  console.log(usage());
  process.exit(0);
}

if (config.indexOnly) {
  const exports = await scanExports(config.root);
  let rebuilt = 0;
  for (const exportItem of exports) {
    const indexed = await indexExport(exportItem, { cacheDir: config.cacheDir });
    if (!indexed.cache.hit) rebuilt += 1;
  }
  console.log(`Indexed ${exports.length} exports (${rebuilt} rebuilt) into ${config.cacheDir}`);
  process.exit(0);
}

const server = await createAppServer({ root: config.root, cacheDir: config.cacheDir, allowedOrigins: config.allowedOrigins });
server.listen(config.port, config.host, () => {
  console.log(`GPTExportViewer API listening at http://${config.host}:${config.port}`);
  console.log(`Export root: ${config.root}`);
  console.log(`Cache: ${config.cacheDir}`);
});
