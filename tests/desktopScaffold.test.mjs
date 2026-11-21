import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const cargoToml = await readFile("src-tauri/Cargo.toml", "utf8");
const libRs = await readFile("src-tauri/src/lib.rs", "utf8");
const mainRs = await readFile("src-tauri/src/main.rs", "utf8");
const readme = await readFile("README.md", "utf8");
const readmeKo = await readFile("README.ko.md", "utf8");
const license = await readFile("LICENSE", "utf8");
const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");

const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
assert.ok(cargoVersionMatch, "Cargo.toml should declare a package version");
assert.equal(packageJson.version, tauriConfig.version, "package.json and tauri.conf.json versions should match");
assert.equal(packageJson.version, cargoVersionMatch[1], "package.json and Cargo.toml versions should match");
assert.equal(packageJson.license, "GPL-3.0-only", "package.json should declare GPL-3.0-only license");
assert.match(cargoToml, /license\s*=\s*"GPL-3\.0-only"/, "Cargo.toml should declare GPL-3.0-only license");
assert.match(license, /GNU GENERAL PUBLIC LICENSE/, "LICENSE file should contain GNU GPL");
assert.match(license, /Version 3, 29 June 2007/, "LICENSE file should be GPLv3");

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
assert.match(
  tauriConfig.app.security.csp,
  /http:\/\/gpt-export-asset\.localhost/,
  "CSP should allow the Windows custom-protocol bridge URL for images"
);

assert.match(cargoToml, /tauri-plugin-dialog/, "Rust scaffold should depend on tauri-plugin-dialog");
assert.match(mainRs, /windows_subsystem\s*=\s*"windows"/, "Release desktop exe should use the Windows GUI subsystem");
assert.match(mainRs, /not\(debug_assertions\)/, "Windows GUI subsystem should be scoped to release builds");
assert.match(libRs, /tauri_plugin_dialog::init\(\)/, "Rust scaffold should register the dialog plugin");
assert.match(libRs, /AppState::new\("GPTExportViewer",\s*None\)/, "First run should start without a hardcoded source folder so onboarding can run");
assert.equal(libRs.includes("E:\\OpenAI\\Exports"), false, "Desktop startup should not silently default to a developer-local export folder");
assert.match(libRs, /get_exports/, "Rust scaffold should register boot-safe commands");
assert.match(libRs, /get_library/, "Rust scaffold should register all boot-time commands");
assert.match(libRs, /rescan_exports/, "Rust scaffold should register source folder rescanning");
assert.match(libRs, /update_preferences/, "Rust scaffold should register selected export and window preference persistence");
assert.match(libRs, /save_original_image/, "Rust scaffold should register original image saving");
assert.match(libRs, /export_original_images/, "Rust scaffold should register batch original image exporting");
assert.match(libRs, /open_exported_images_folder/, "Rust scaffold should register opening exported image folders");

assert.match(readme, /Tauri\/Rust/, "Desktop docs should name Tauri/Rust as the primary target");
assert.equal(readme.includes("Node server"), false, "Desktop docs should not document the removed Node API server");
assert.match(readme, /110\.0\.1531\.0/, "Desktop docs should document the WebView2 minimum");
assert.match(readme, /user app data/i, "Desktop docs should say settings and cache live in user app data");
assert.match(
  readme,
  /src-tauri\/target\/release\/GPTExportViewer\.exe/,
  "Desktop docs should document the portable exe path"
);
assert.match(readme, /README\.ko\.md/, "English README should link to Korean README");
assert.match(readmeKo, /README\.md/, "Korean README should link back to English README");
assert.match(ciWorkflow, /npm test/, "CI workflow should run npm test");
assert.match(ciWorkflow, /cargo test/, "CI workflow should run cargo test");
assert.match(ciWorkflow, /desktop:build/, "CI workflow should verify desktop:build");
assert.match(releaseWorkflow, /Write-Sha256Sums\.ps1/, "Release workflow should generate SHA256SUMS.txt");
assert.match(releaseWorkflow, /desktop:build/, "Release workflow should build release binary");

for (const shot of ["sessions-dark.png", "library-dark.png", "sessions-light.png"]) {
  const shotPath = `assets/screenshots/${shot}`;
  const info = await stat(shotPath);
  assert.ok(info.size > 10000, `${shotPath} should be a non-empty rendered PNG screenshot`);
  const bytes = await readFile(shotPath);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${shotPath} should be a valid PNG file`);
}

console.log("desktop scaffold tests passed");
