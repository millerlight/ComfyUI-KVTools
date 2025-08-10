# Version: 1.0.0
# __init__.py in custom_nodes/ComfyUI-KVTools
# - Registry scan for the frontend dropdown
# - Safe web endpoints:
#     GET  /kvtools/image?file=<jsonNameOrPath>&key=<key>&ext=png
#     POST /kvtools/refresh_registry
#     POST /kvtools/peek   {file_name|path, key}  -> {"ok":true,"value":...}

import os, json, re

# --- CORE: node implementation
from . import kv_nodes  # relative import!

NODE_CLASS_MAPPINGS = kv_nodes.NODE_CLASS_MAPPINGS
NODE_DISPLAY_NAME_MAPPINGS = kv_nodes.NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

def _root():
    return os.getcwd()

BASE_DIR = os.path.join(_root(), "custom_kv_stores")
REG_PATH = os.path.join(os.path.dirname(__file__), "web", "kv_registry.json")
IMAGES_ROOT = os.path.join(BASE_DIR, "images")

def _scan():
    os.makedirs(BASE_DIR, exist_ok=True)
    files = {}
    for name in sorted(os.listdir(BASE_DIR)):
        if not name.lower().endswith(".json"):
            continue
        f = os.path.join(BASE_DIR, name)
        try:
            with open(f, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                files[name] = {"keys": sorted([str(k) for k in data.keys()])}
        except Exception:
            pass
    return {"base_dir": BASE_DIR, "files": files}

def _write(reg):
    web_dir = os.path.join(os.path.dirname(__file__), "web")
    os.makedirs(web_dir, exist_ok=True)
    with open(REG_PATH, "w", encoding="utf-8") as fh:
        json.dump(reg, fh, ensure_ascii=False, indent=2)

def _sanitize_name(s: str) -> str:
    s = os.path.basename(str(s or "").strip())
    return re.sub(r"[^A-Za-z0-9._ \-]+", "_", s)

def _json_basename_from_param(file_or_path: str) -> str:
    """
    Accepts either "foo.json" or a full path and returns "foo".
    """
    if not file_or_path:
        return ""
    base = os.path.basename(str(file_or_path).strip())
    base, _ = os.path.splitext(base)
    return _sanitize_name(base)

# --- Build registry at startup
try:
    _write(_scan())
    print("[ComfyUI-KVTools] registry written:", REG_PATH)
except Exception as e:
    print("[ComfyUI-KVTools] registry build failed:", e)

# --- Web endpoints (only when running inside ComfyUI)
try:
    from aiohttp import web
    from server import PromptServer  # ComfyUI-internal

    # POST /kvtools/refresh_registry  -> {"ok":true, "written": ".../kv_registry.json"}
    @PromptServer.instance.routes.post("/kvtools/refresh_registry")
    async def kvtools_refresh_registry(request):
        try:
            reg = _scan()
            _write(reg)
            return web.json_response({"ok": True, "written": REG_PATH})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    # POST /kvtools/peek  {file_name|path, key} -> {"ok":true,"value": "..."}
    # reads a value from a JSON in BASE_DIR, no paths outside allowed.
    @PromptServer.instance.routes.post("/kvtools/peek")
    async def kvtools_peek(request):
        try:
            data = await request.json()
        except:
            data = {}
        file_name = data.get("file_name") or data.get("path") or ""
        key = data.get("key") or ""
        if not file_name or not key:
            return web.json_response({"ok": False, "error": "missing file_name or key"}, status=400)

        json_name = os.path.basename(str(file_name).strip())
        json_path = os.path.join(BASE_DIR, json_name)
        if not (json_path.startswith(BASE_DIR) and os.path.isfile(json_path)):
            return web.json_response({"ok": False, "error": "invalid file"}, status=400)

        try:
            with open(json_path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            val = doc.get(key, "")
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            return web.json_response({"ok": True, "value": str(val)})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    # GET /kvtools/image?file=<jsonNameOrPath>&key=<key>&ext=png
    # Serves ONLY images from <ComfyUI>/custom_kv_stores/images/<json-base>/<key>.<ext>
    @PromptServer.instance.routes.get("/kvtools/image")
    async def kvtools_image(request):
        params = request.rel_url.query
        file_or_path = params.get("file") or params.get("registry") or params.get("path") or ""
        key = params.get("key") or ""
        ext = params.get("ext") or "png"
        ext = "png" if ext.lower() != "png" else "png"  # fixed to png

        json_base = _json_basename_from_param(file_or_path)
        if not json_base or not key:
            raise web.HTTPNotFound()

        folder = os.path.join(IMAGES_ROOT, json_base)
        fname  = f"{_sanitize_name(key)}.{ext}"
        full   = os.path.join(folder, fname)

        # Whitelist check: must stay under IMAGES_ROOT
        if not os.path.abspath(full).startswith(os.path.abspath(IMAGES_ROOT)):
            raise web.HTTPForbidden()

        if not os.path.isfile(full):
            raise web.HTTPNotFound()

        return web.FileResponse(full)

    print("[ComfyUI-KVTools] web endpoints ready (/kvtools/*)")

except Exception as e:
    # Outside of ComfyUI (pure Python env) we ignore the endpoints.
    print("[ComfyUI-KVTools] web endpoints not active:", e)
