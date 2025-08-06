# ComfyUI-KVTools: Key/Value Utilities (stabil)

import json
import re
import os

print("[KVTools] loaded from", __file__)

def _parse_data(data: str, fmt: str):
    data = (data or "").strip()
    if fmt == "auto":
        if (data.startswith("{") and data.endswith("}")) or (data.startswith("[") and data.endswith("]")):
            fmt = "json"
        else:
            fmt = "kv"
    if fmt == "json":
        try:
            obj = json.loads(data) if data else {}
            if isinstance(obj, dict):
                return obj
            raise ValueError("JSON is not an object (dict).")
        except Exception as e:
            raise ValueError(f"JSON-Error: {e}")
    elif fmt == "kv":
        out = {}
        for line in data.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^\s*([^=:#]+)\s*[:=]\s*(.*)\s*$", line)
            if not m:
                raise ValueError(f"not a valid KV-line: {line}")
            k, v = m.group(1).strip(), m.group(2).strip()
            out[k] = v
        return out
    else:
        raise ValueError(f"Unknown Format: {fmt}")

def _dump_data(obj: dict, fmt: str, pretty: bool = True) -> str:
    if fmt == "json":
        return json.dumps(obj, ensure_ascii=False, indent=(2 if pretty else None))
    elif fmt == "kv":
        lines = []
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"{k}={v}")
        return "\n".join(lines)
    else:
        raise ValueError(f"Unknown Format to write: {fmt}")

def _cast(value, as_type: str):
    if as_type == "string":
        return "" if value is None else str(value)
    if as_type == "int":
        return int(value)
    if as_type == "float":
        return float(value)
    if as_type == "bool":
        s = str(value).strip().lower()
        return s in ("1", "true", "yes", "y", "on")
    return value

class KVLoadInline:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "data": ("STRING", {"multiline": True, "placeholder":
                    "{\n  \"speaker\":\"Tom\",\n  \"lang\":\"de\"\n}\n"
                    "# oder:\n# speaker=Tom\n# lang=de"}),
            }
        }
    RETURN_TYPES = ("KV",)
    RETURN_NAMES = ("store",)
    FUNCTION = "create"
    CATEGORY = "Utils/KV"

    def create(self, data):
        store = _parse_data(data, "auto")
        return (store,)

class KVGet:
    """Read one value from a key/value store"""

    CATEGORY = "KVTools"
    FUNCTION = "kv_get"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "store": ("KV",),
                "key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "forceInput": False,
                }),
                "default": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                # WICHTIG: '' als Option zulassen für alte Workflows
                "as_type": (["string", "int", "float", "bool", ""], {
                    "default": "string",
                }),
            },
            "optional": {
                "default_key": ("STRING", { "default": "", "visible": False, "multiline": False }),
                "keys_hint": ("STRING", {
                    "default": "(dropdown enabled)",
                    "multiline": False,
                    "visible": False,
                }),
            }
        }

    # value, key (bestehend) + json + kv (neu)
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES  = ("value",  "key",   "json",   "kv")
    OUTPUT_NODE = True

    def __init__(self):
        self.default = ""

    def kv_get(self, store, key, default, as_type, **kwargs):
        if default is None:
            default = ""

        # Fallback: leere/ungültige Auswahl wie 'string' behandeln
        if as_type not in ("string", "int", "float", "bool"):
            as_type = "string"

        # 1) Wert holen
        raw_value = store.get(key, default)

        # 2) in gewählten Typ casten (für 'value')
        if as_type == "int":
            try:
                value = str(int(raw_value))
            except:
                value = default
        elif as_type == "float":
            try:
                value = str(float(raw_value))
            except:
                value = default
        elif as_type == "bool":
            if str(raw_value).strip().lower() in ("1", "true", "yes"):
                value = "true"
            else:
                value = "false"
        else:
            value = "" if raw_value is None else str(raw_value)

        # 3) JSON-Snippet {"key":"value"}
        json_snippet = json.dumps({str(key): ("" if raw_value is None else str(raw_value))}, ensure_ascii=False)

        # 4) KV-Zeile key=value
        if isinstance(raw_value, (dict, list)):
            kv_value = json.dumps(raw_value, ensure_ascii=False)
        else:
            kv_value = "" if raw_value is None else str(raw_value)
        kv_line = f"{key}={kv_value}"

        return (value, key, json_snippet, kv_line)

class KVLoadFromRegistry:
    _BASE = os.path.join(os.getcwd(), "custom_kv_stores")
    try:
        os.makedirs(_BASE, exist_ok=True)
        _FILES = sorted([n for n in os.listdir(_BASE) if n.lower().endswith(".json")]) or ["(none)"]
    except Exception:
        _FILES = ["(none)"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file_name": (cls._FILES, {"default": cls._FILES[0]}),
            }
        }

    RETURN_TYPES = ("KV", "STRING")
    RETURN_NAMES = ("store", "path")
    FUNCTION = "load"
    CATEGORY = "Utils/KV"

    def load(self, file_name):
        if not file_name or file_name == "(none)":
            return ({}, "")
        path = os.path.join(self._BASE, file_name)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"KVLoadFromRegistry: File not found: {path}")
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        store = _parse_data(text, "auto")
        return (store, path)

NODE_CLASS_MAPPINGS = {
    "KVLoadInline": KVLoadInline,
    "KVLoadFromRegistry": KVLoadFromRegistry,
    "KVGet": KVGet,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "KVLoadInline": "KV Load Inline",
    "KVLoadFromRegistry": "KV Load from Registry",
    "KVGet": "KV Get Value",
}


# --- KVTools: Build an image path from key + base_dir + extension ---
import re, os
from PIL import Image
import numpy as np
import torch

class KVBuildImagePath:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"forceInput": True, "multiline": False}),
                "base_dir": ("STRING", {"default": "", "multiline": False}),
                "ext": (["png", "jpg", "jpeg", "webp"], {"default": "png"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    FUNCTION = "build"
    CATEGORY = "Utils/KV"

    def build(self, key, base_dir, ext):
        # Key in einen sicheren Dateinamen überführen (keine Pfad-Tricks)
        name = os.path.basename(str(key).strip())
        safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", name)
        filename = f"{safe}.{ext}"
        path = os.path.join(str(base_dir).strip(), filename)
        return (path,)


class KVLoadImageFromPath:
    """
    Minimaler Loader: lädt ein Bild von 'path' und gibt ein ComfyUI-IMAGE zurück.
    Form: Tensor [1, H, W, 3], float32, 0..1
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": ("STRING", {"forceInput": True, "multiline": False}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "load"
    CATEGORY = "Utils/KV"

    def load(self, path):
        p = str(path or "").strip()
        if not p or not os.path.isfile(p):
            raise FileNotFoundError(f"KVLoadImageFromPath: file not found: {p}")
        img = Image.open(p).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0  # H, W, 3
        t = torch.from_numpy(arr)[None, ...]            # 1, H, W, 3
        return (t,)


# ---- Node-Mapping ergänzen (am bestehenden Mapping unten dranhängen) ----
NODE_CLASS_MAPPINGS.update({
    "KVBuildImagePath": KVBuildImagePath,
    "KVLoadImageFromPath": KVLoadImageFromPath,
})
NODE_DISPLAY_NAME_MAPPINGS.update({
    "KVBuildImagePath": "KV Build Image Path",
    "KVLoadImageFromPath": "KV Load Image From Path",
})
