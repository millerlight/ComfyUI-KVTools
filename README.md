# ComfyUI-KVTools

Utility nodes for key/value (KV) workflows in ComfyUI — with live previews, auto-updates, and a safe **Edit mode** for inline KV data.

## ✨ What’s inside

- **KV Load Inline** – type/paste KV data (JSON or `key=value` lines).
  ✅ **Edit mode** toggle: edit safely with node output disabled; lock the text when done.

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
