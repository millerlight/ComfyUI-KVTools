# ComfyUI-KVTools

Utility nodes for key/value (KV) workflows in ComfyUI — with live previews, auto-updates, and a safe **Edit mode** for inline KV data.

## ✨ What’s inside

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

- Place your files here:
  ```
  <ComfyUI>/custom-kv-stores/*.json
  ```
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

## 🧩 Nodes

### KV Load Inline
- **Input**: none  
- **Output**: KV store
- **Data formats**:
  - **JSON** object of key/value pairs, or
  - **`.env` style** lines: `key=value` (one per line)
- **Edit mode** (toggle in the node):
  - **ON**: text field is editable; node output is disabled; previews downstream are blank; autoruns are paused.
  - **OFF**: text field is locked; node output is enabled; connected **KV Get** updates previews; one run is queued.

### KV Load From Registry
- **Input**: none  
- **Outputs**:
  - **store** (KV object derived from the selected JSON file)
  - **path** (base path for optional images)
- **UI**:
  - Dropdown for **file_name** (populated from the registry)
  - Changing the file triggers **automatic** key/preview updates on connected **KV Get**.

### KV Get
- **Input**: `store` (from **KV Load Inline** or **KV Load From Registry**)
- **Outputs**:
  - **value** (cast to selected type)
  - **key** (currently selected key)
- **UI**:
  - **key_select** (dropdown, auto-filled from upstream)
  - **as_type**: output type (`string | int | float | bool`)
  - **_kvtools_preview_value** (read-only value preview)
  - Buttons:
    - **KVTools: refresh keys** – rebuild list (normally not needed thanks to autosync)
    - **Random key**
    - **Set default (current key)** / **Load default**

### KV Image Path From Registry (helper)
- **Input**: registry **path**, selected **key**, optional **ext** (`png` default)
- **Output**: constructed image path/URL → connect to ComfyUI’s **Preview Image** to show it.

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

## 🧭 Usage patterns

### A) Inline store, safe editing
1. Add **KV Load Inline** and **KV Get**; connect `store → KV Get`.
2. Toggle **Edit mode ON** on **KV Load Inline**, paste or type your KV.
3. Toggle **Edit mode OFF**:
   - Inline text locks
   - **KV Get** previews update
   - A run is queued for downstream

### B) Registry store + image preview
1. Put `*.json` files in `<ComfyUI>/custom-kv-stores/`.
2. Add **KV Load From Registry** and **KV Get**; connect `store`.
3. Pick a **file_name** – **KV Get** updates automatically.
4. To show images:
   - Add **KV Image Path From Registry**, connect **path** (from registry loader) and **key** (from KV Get).
   - Connect to **Preview Image**. The preview refreshes as you change the key.

---

## ⚙️ Casting & types

**KV Get → as_type** controls the output value type:
- `string` (default)
- `int`
- `float`
- `bool`

If an old workflow loads with a blank type, it defaults to **string**.

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
