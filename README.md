# ChatGPT Export Viewer

Dark-first local viewer for ChatGPT Data Export folders.

## Run

```powershell
npm install
npm run server -- --root "E:\OpenAI\Exports"
npm run dev
```

Open `http://127.0.0.1:5174`.

The API listens on `http://127.0.0.1:43117` by default. The frontend defaults to that API URL.
Only loopback frontend origins are allowed to read API responses by default. Add another local origin with `--allow-origin <origin>` if you run the UI on a different port.
Use the Settings button in the app to change the source folder without restarting the server. You can type a path or open the native Windows folder picker through the local app server. The selected source folder is persisted under `.cache/settings.json`.

## Index Only

```powershell
npm run index -- --root "E:\OpenAI\Exports"
```

The V1 cache is JSON-based and stored under `.cache`. Conversation summaries and library image metadata are cached, while full conversation messages and image bytes are loaded on demand. Long sessions and large image libraries auto-load as their scroll sentinels enter view, and offscreen rows are unmounted to keep browser memory bounded.

## Notes

- Image files are resolved as `${file_id}.dat` inside the selected export directory.
- The server only binds to `127.0.0.1` by default and rejects unexpected browser `Origin` headers.
- Asset requests reject path traversal and only stream files inside the selected export directory.
- `node_modules`, `dist`, `.cache`, and `.logs` are generated artifacts and are not needed in the source package.
