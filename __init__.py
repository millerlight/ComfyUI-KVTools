# __init__.py in custom_nodes/ComfyUI-KVTools

import os, json

from . import kv_nodes  # relativer Import!

NODE_CLASS_MAPPINGS = kv_nodes.NODE_CLASS_MAPPINGS
NODE_DISPLAY_NAME_MAPPINGS = kv_nodes.NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

def _root():
    return os.getcwd()

BASE_DIR = os.path.join(_root(), "custom_kv_stores")
REG_PATH = os.path.join(os.path.dirname(__file__), "web", "kv_registry.json")

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

try:
    _write(_scan())
    print("[ComfyUI-KVTools] registry written:", REG_PATH)
except Exception as e:
    print("[ComfyUI-KVTools] registry build failed:", e)
