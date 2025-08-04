# ComfyUI-KVTools

Small utility nodes for key/value workflows in ComfyUI.
Custom JSON key-value pairs from multiple external files. 

## Nodes
- **KV Load Inline** – type/paste JSON or `key=value` lines; emits a KV store.
- **KV Load From File** – load a JSON file from `base_path + file_name` (UTF-8, auto-detected JSON/KV).
- **KV Load From Registry** – dropdown of JSON files found in `./custom_stores` (UTF-8).
- **KV Get** – pick a key (dropdown) and output its value (optionally cast to string/int/float/bool). Also outputs all keys as text.
- **KV Inspect** – debug helper to print keys.

## Installation
### With ComfyUI-Manager
1. In ComfyUI, open **Manager → Install via URL**.
2. Paste the repository URL (e.g., `https://github.com/millerlight/ComfyUI-KVTools`) and install.
3. **Restart ComfyUI**.

### Manual
```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/millerlight/ComfyUI-KVTools.git
# or unzip the archive into this folder
```
Restart ComfyUI afterwards.

## Usage
- For **KV Load From Registry**, put your JSON files into:
  ```
  <ComfyUI>/custom_stores/*.json
  ```
  On startup, a registry file is written to:  
  `custom_nodes/ComfyUI-KVTools/web/kv_registry.json` (served at `/extensions/ComfyUI-KVTools/kv_registry.json`).

- The **KV Get** node shows a **dropdown** of keys without pressing Run. It prefers keys from an upstream file loader (via registry); otherwise it reads keys directly from an inline loader connected to its `store` input.

- All reading is **UTF‑8**, and format is **auto-detected** (`json` or `key=value` per line).

## Troubleshooting
- After updating, **clear the browser cache** or do a **hard reload (Ctrl+F5)** to ensure the frontend JS is reloaded.
- If the dropdown doesn’t appear, confirm the web assets are served:
  - `http://127.0.0.1:8188/extensions/ComfyUI-KVTools/extension.js`
  - `http://127.0.0.1:8188/extensions/ComfyUI-KVTools/kv_registry.json`
- If an old workflow loads with a blank `as_type`, the node defaults to **string** automatically.

## License
MIT
