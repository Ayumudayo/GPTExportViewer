# GPTExportViewer

Dark-first local viewer for ChatGPT Data Export folders.

The primary desktop target is Tauri/Rust on Windows 10/11. The React UI is still built with Vite, but export discovery, indexing, settings, cache, and image asset serving run inside the Rust desktop process rather than a local Node API server.

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

## Web Development

The Node server is kept for web-development compatibility and browser-only debugging.

```powershell
npm run server -- --root "E:\OpenAI\Exports"
npm run dev
```

Open `http://127.0.0.1:5174`.

The compatibility API listens on `http://127.0.0.1:43117` by default. Only loopback frontend origins are allowed to read API responses unless another local origin is passed with `--allow-origin`.

## Index Only

```powershell
npm run index -- --root "E:\OpenAI\Exports"
```

The Node compatibility cache is JSON-based and stored under `.cache`. The desktop cache is also JSON-based but is stored in user app data.

## Notes

- Image files are resolved as `${file_id}.dat` inside the selected export directory.
- Desktop image URLs use the private `gpt-export-asset://library/<exportId>/<fileId>` protocol and do not expose absolute file paths.
- Asset requests reject path traversal and only stream files inside the selected export directory.
- Long sessions and large image libraries auto-load as their scroll sentinels enter view, and offscreen rows are unmounted to keep memory bounded.
- `node_modules`, `dist`, `.cache`, `.logs`, and `src-tauri/target` are generated artifacts and are not needed in the source package.
