# ComfyUI-KVTools

Utility nodes for key/value (KV) workflows in ComfyUI — with live previews, auto-updates, and a safe **Edit mode** for inline KV data.

## 🧩 Nodes

- **KV Load Inline** – type/paste KV data (JSON or `key=value` lines).

- **Edit mode** toggle: edit safely with node output disabled; lock the text when done.

- **KV Load From Registry** – pick a JSON file from a registry that’s built automatically from `<ComfyUI>/custom-kv-stores/*.json`.

- **KV Get** – central node: shows a **key dropdown** and **live value preview**; choose an output **type** (`string | int | float | bool`).  
  Extra UI: **Refresh keys**, **Random key**, **Set default**, **Load default**.

- **KV Image Path From Registry** (helper) – builds an image path from a selected registry key (e.g. `png`, `jpg`) to use with ComfyUI’s **Preview Image**.

### On-the-fly behavior (no manual Run needed for previews)

- As soon as a store is connected to **KV Get**, its **key dropdown** and **value preview** populate immediately.  
- Switching the **registry file** updates KV Get automatically (no manual “refresh” needed).  
- **Image preview updates automatically** when the selected key changes.

> The extension also **queues a run** in a debounced, robust way for downstream processing. While you’re editing inline data, runs are intentionally **suppressed** to keep things stable.

---

## 📁 Registry & file layout

- Place your JSON files here:
  ```
  <ComfyUI>/custom-kv-stores/<filename>.json
  ```
- Place optional images here:
  ```
  <ComfyUI>/custom-kv-stores/images/<filename>/<key>.png
  ```
  Give your images the same name as the corresponding key in the JSON file.
  Key and filename may contain numbers, letters, dots and underlines.

  Each must be **simple key-value JSON**:
  ```json
  {
    "speaker": "Tom",
    "greeting": "hello"
  }
  ```

- On ComfyUI startup, a registry is generated and served to the UI:
  - Written to: `custom_nodes/ComfyUI-KVTools/web/kv_registry.json`
  - Served at: `/extensions/ComfyUI-KVTools/kv_registry.json`

- Frontend endpoints used:
  - `POST /kvtools/refresh_registry` – rebuild/refresh registry cache
  - `POST /kvtools/peek` – read a single value `{file_name, key}`
  - `GET  /kvtools/image?file=...&key=...&ext=...` – build image URL for previews
---

## 🚀 Installation

### With ComfyUI-Manager
1. Open **Manager → Install via URL**.
2. Paste the repo URL (e.g. `https://github.com/millerlight/ComfyUI-KVTools`).  
3. Click **Install**, then **restart ComfyUI**.

### Manual
```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/millerlight/ComfyUI-KVTools.git
# or unzip the release into this folder
```
Restart ComfyUI afterwards.

> After updating the frontend (`web/js/extension.js`), **hard-reload** your browser (Ctrl/Cmd+Shift+R) to ensure the latest UI is loaded.


---

## 🩺 Troubleshooting

- **UI didn’t update after an install/update**
  - Hard-reload your browser (**Ctrl/Cmd+Shift+R**).
  - Verify assets are served:
    - `/extensions/ComfyUI-KVTools/extension.js`
    - `/extensions/ComfyUI-KVTools/kv_registry.json`

- **Registry file appears but KV Get has no keys**
  - Ensure your JSON is **flat key/value** (no arrays/objects unless you intend stringified values).
  - Click **KVTools: refresh keys** once (should rarely be needed with autosync).
  - Restart ComfyUI to rebuild the registry.

- **Inline editing shows empty previews**
  - That’s by design. While **Edit mode** is **ON**, downstream output & previews are blank and runs are paused.
  - Toggle **Edit mode OFF** to lock data and resume runs.

- **“Nothing runs automatically” after loading a large graph**
  - The extension debounces queueing to avoid spamming the server. Make one manual **Queue Prompt** if needed; subsequent changes are auto-queued.

---

## 🧱 Directory structure

```
ComfyUI/custom_nodes/ComfyUI-KVTools
├── info.json
├── __init__.py
├── kv_nodes.py
├── README.md
├── requirements.txt
└── web
    ├── js
    │   └── extension.js
    └── kv_registry.json
```

---

## 📄 License

MIT
