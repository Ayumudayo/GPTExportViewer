# GPTExportViewer

Dark-first desktop viewer for ChatGPT Data Export folders.

The app targets Tauri/Rust on Windows 10/11. The React UI is built with Vite, while export discovery, indexing, settings, cache, session export, and image asset serving run inside the Rust desktop process.

## Desktop

```powershell
npm install
npm run desktop:dev
```

Build the portable executable:

```powershell
npm run desktop:build
```

The portable artifact is:

```text
src-tauri/target/release/GPTExportViewer.exe
```

The desktop runtime requires Microsoft Edge WebView2 `110.0.1531.0` or newer. Settings and cache live in user app data, for example `%LOCALAPPDATA%\GPTExportViewer`, with export indexes under the `cache` subfolder. The desktop app does not use the repo-local `.cache` directory.

## Development

Use `npm run desktop:dev` for interactive development so the UI talks to the real Tauri command layer. The standalone Vite dev server is only a frontend asset server for Tauri development.

## Notes

- Image files are resolved as `${file_id}.dat` inside the selected export directory.
- Desktop image URLs use the private `gpt-export-asset://library/<exportId>/<fileId>` protocol and do not expose absolute file paths.
- Asset requests reject path traversal and only stream files inside the selected export directory.
- Long sessions and large image libraries auto-load as their scroll sentinels enter view, and offscreen rows are unmounted to keep memory bounded.
- `node_modules`, `dist`, `.cache`, `.logs`, and `src-tauri/target` are generated artifacts and are not needed in the source package.
