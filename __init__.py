# __init__.py in custom_nodes/ComfyUI-KVTools

import os
import json

from . import kv_nodes  # relativer Import!

# ---- ComfyUI Node-Mappings ----
NODE_CLASS_MAPPINGS = kv_nodes.NODE_CLASS_MAPPINGS
NODE_DISPLAY_NAME_MAPPINGS = kv_nodes.NODE_DISPLAY_NAME_MAPPINGS

# ---- Web-Assets ----
WEB_DIRECTORY = "./web"

# ---- Basisverzeichnisse / Registry-Pfad ----
def _root():
    # ComfyUI-Base (CWD)
    return os.getcwd()

# Optional: Override per ENV
_BASE_DIR_ENV = os.environ.get("KVTOOLS_BASE_DIR", "").strip()
BASE_DIR = os.path.abspath(_BASE_DIR_ENV) if _BASE_DIR_ENV else os.path.join(_root(), "custom_kv_stores")
REG_PATH = os.path.join(os.path.dirname(__file__), "web", "kv_registry.json")


# ---- Registry-Scan & Write ----
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
            # fehlerhafte Dateien stillschweigend überspringen
            pass
    return {"base_dir": BASE_DIR, "files": files}


def _write(reg):
    web_dir = os.path.join(os.path.dirname(__file__), "web")
    os.makedirs(web_dir, exist_ok=True)
    with open(REG_PATH, "w", encoding="utf-8") as fh:
        json.dump(reg, fh, ensure_ascii=False, indent=2)


# Beim Laden Registry erzeugen
try:
    _write(_scan())
    print("[ComfyUI-KVTools] registry written:", REG_PATH)
except Exception as e:
    print("[ComfyUI-KVTools] registry build failed:", e)


# ---- Sichere Datei-Checks & Helfer ----
def _is_safe(path: str) -> bool:
    """
    Erlaubt nur Zugriffe innerhalb von BASE_DIR (Whitelist-Root).
    """
    try:
        base = os.path.realpath(BASE_DIR)
        rp = os.path.realpath(path)
        return rp == base or rp.startswith(base + os.sep)
    except Exception:
        return False


def _safe_json_read(filename: str):
    """
    Liest JSON-Objekt (dict) nur aus sicherem BASE_DIR, mit reiner Dateinamen-Whitelist.
    """
    safe_name = os.path.basename(filename or "")
    if not safe_name or not safe_name.lower().endswith(".json"):
        raise FileNotFoundError("Invalid or empty file_name")

    path = os.path.join(BASE_DIR, safe_name)
    if not _is_safe(path) or not os.path.isfile(path):
        raise FileNotFoundError(f"File not found or out of base_dir: {safe_name}")

    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("JSON content is not an object (dict)")
    return data


# ---- API-Endpunkte (PromptServer/aiohttp) ----
# Wichtig: aiohttp.web.Response zurückgeben!
try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/kvtools/peek")
    async def kvtools_peek(request):
        """
        Body: { "file_name": "example.json", "key": "lang" }
        Antwort (JSON): { ok: bool, value?: str, error?: str }
        """
        try:
            payload = await request.json()
            file_name = (payload.get("file_name") or "").strip()
            key = (payload.get("key") or "").strip()
            if not file_name or not key:
                return web.json_response({"ok": False, "error": "missing file_name or key"})

            obj = _safe_json_read(file_name)
            val = obj.get(key, "")

            # Immer als String zurückgeben (Frontend zeigt read-only Text)
            if isinstance(val, (dict, list)):
                val = json.dumps(val, ensure_ascii=False)
            elif val is None:
                val = ""

            return web.json_response({"ok": True, "value": str(val)})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    @PromptServer.instance.routes.post("/kvtools/refresh_registry")
    async def kvtools_refresh_registry(request):
        """
        Erzwingt ein Re-Scan von BASE_DIR und schreibt kv_registry.json neu.
        Antwort: { ok: bool, error?: str }
        """
        try:
            reg = _scan()
            _write(reg)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)})

    print("[ComfyUI-KVTools] API routes registered: /kvtools/peek, /kvtools/refresh_registry")

except Exception as e:
    # Falls server/aiohttp in der Laufzeit nicht verfügbar ist,
    # sollen die Nodes dennoch benutzbar bleiben.
    print("[ComfyUI-KVTools] API routes not registered:", e)
