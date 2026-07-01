import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const cargoToml = await readFile("src-tauri/Cargo.toml", "utf8");
const libRs = await readFile("src-tauri/src/lib.rs", "utf8");
const mainRs = await readFile("src-tauri/src/main.rs", "utf8");
const readme = await readFile("README.md", "utf8");

assert.equal(packageJson.scripts["desktop:dev"], "tauri dev");
assert.equal(packageJson.scripts["desktop:build"], "tauri build --no-bundle");
assert.ok(packageJson.dependencies["@tauri-apps/api"], "@tauri-apps/api should be a runtime dependency");
assert.ok(packageJson.dependencies["@tauri-apps/plugin-dialog"], "@tauri-apps/plugin-dialog should be a runtime dependency");
assert.ok(packageJson.devDependencies["@tauri-apps/cli"], "@tauri-apps/cli should be a dev dependency");

assert.equal(tauriConfig.productName, "GPTExportViewer");
assert.equal(tauriConfig.identifier, "local.gpt-export-viewer");
assert.equal(tauriConfig.build.beforeDevCommand, "npm run dev");
assert.equal(tauriConfig.build.devUrl, "http://127.0.0.1:5174");
assert.equal(tauriConfig.build.beforeBuildCommand, "npm run build");
assert.equal(tauriConfig.build.frontendDist, "../dist");
assert.equal(tauriConfig.bundle.windows.webviewInstallMode.type, "skip");
assert.equal(tauriConfig.bundle.windows.minimumWebview2Version, "110.0.1531.0");
assert.notEqual(tauriConfig.app.security.csp, null, "Desktop build should not disable CSP");
assert.match(tauriConfig.app.security.csp, /connect-src ipc: http:\/\/ipc\.localhost/, "CSP should allow Tauri IPC");
assert.match(tauriConfig.app.security.csp, /gpt-export-asset:/, "CSP should allow the private asset protocol");

assert.match(cargoToml, /tauri-plugin-dialog/, "Rust scaffold should depend on tauri-plugin-dialog");
assert.match(mainRs, /windows_subsystem\s*=\s*"windows"/, "Release desktop exe should use the Windows GUI subsystem");
assert.match(mainRs, /not\(debug_assertions\)/, "Windows GUI subsystem should be scoped to release builds");
assert.match(libRs, /tauri_plugin_dialog::init\(\)/, "Rust scaffold should register the dialog plugin");
assert.match(libRs, /get_exports/, "Rust scaffold should register boot-safe commands");
assert.match(libRs, /get_library/, "Rust scaffold should register all boot-time commands");

assert.match(readme, /Tauri\/Rust/, "Desktop docs should name Tauri/Rust as the primary target");
assert.equal(readme.includes("Node server"), false, "Desktop docs should not document the removed Node API server");
assert.match(readme, /110\.0\.1531\.0/, "Desktop docs should document the WebView2 minimum");
assert.match(readme, /user app data/i, "Desktop docs should say settings and cache live in user app data");
assert.match(
  readme,
  /src-tauri\/target\/release\/GPTExportViewer\.exe/,
  "Desktop docs should document the portable exe path"
);

console.log("desktop scaffold tests passed");
