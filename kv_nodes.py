# ComfyUI-KVTools: Key/Value Utilities + sicherer Image-Preview-Loader
# Robuste Version: behandelt Keys mit eingebauter Endung (.png/.jpg/.jpeg/.webp)
# UI/Dropdown/Defaults/Auto-Run ist in web/extension.js.

import json
import re
import os

print("[KVTools] loaded from", __file__)

# ---------------------------------------------------------------------
# Parsing/Dumping Helpers
# ---------------------------------------------------------------------

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

# ---------------------------------------------------------------------
# Nodes: KV
# ---------------------------------------------------------------------

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
                "as_type": (["string", "int", "float", "bool"], {
                    "default": "string",
                }),
            },
            "optional": {
                "keys_hint": ("STRING", {
                    "default": "(dropdown enabled)",
                    "multiline": False,
                    "visible": False,
                }),
                "default_key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "visible": False,
                }),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("value", "key")
    OUTPUT_NODE = True

    def __init__(self):
        self.default = ""

    def kv_get(self, store, key, default, as_type, **kwargs):
        if default is None:
            default = ""
        value = store.get(key, default)

        if as_type == "int":
            try:
                value = str(int(value))
            except:
                value = default
        elif as_type == "float":
            try:
                value = str(float(value))
            except:
                value = default
        elif as_type == "bool":
            if str(value).strip().lower() in ("1", "true", "yes"):
                value = "true"
            else:
                value = "false"
        else:
            value = str(value)

        return (value, key)

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

# ---------------------------------------------------------------------
# Sicherer Image-Preview
# Struktur: <ComfyUI>/custom_kv_stores/images/<json-basisname>/<key>[.ext]
# Falls key bereits .png/.jpg/.jpeg/.webp enthält, wird diese Endung genutzt.
# ---------------------------------------------------------------------

def _images_root():
    return os.path.join(os.getcwd(), "custom_kv_stores", "images")

def _sanitize_name(s: str) -> str:
    s = os.path.basename(str(s or "").strip())
    # Erlaubt: Buchstaben, Ziffern, Punkt, Unterstrich, Minus, Leerzeichen
    return re.sub(r"[^A-Za-z0-9._ \-]+", "_", s)

def _split_key_and_ext(key: str):
    m = re.match(r"^(.*)\.(png|jpg|jpeg|webp)$", str(key or "").strip(), re.IGNORECASE)
    if m:
        return m.group(1), m.group(2).lower()
    return key, None

# Platzhalter (1x1 schwarz), damit nie None ausgegeben wird
try:
    import torch as _torch
    _KVTOOLS_PLACEHOLDER = _torch.zeros((1, 1, 1, 3), dtype=_torch.float32)
except Exception:
    _KVTOOLS_PLACEHOLDER = None

def _placeholder_image():
    global _KVTOOLS_PLACEHOLDER
    if _KVTOOLS_PLACEHOLDER is None:
        try:
            import torch
            _KVTOOLS_PLACEHOLDER = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
        except Exception:
            _KVTOOLS_PLACEHOLDER = 0
    return _KVTOOLS_PLACEHOLDER

try:
    os.makedirs(_images_root(), exist_ok=True)
except Exception:
    pass

class KVPreviewImageFromRegistry:
    """
    Liefert IMMER den berechneten Pfad (zweiter Output).
    Nutzt die Endung aus dem Key, wenn vorhanden.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"forceInput": True, "multiline": False}),
                "registry_path": ("STRING", {"forceInput": True, "multiline": False}),
                "ext": (["png"], {"default": "png"}),  # Fallback-Endung
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "path")
    FUNCTION = "load"
    CATEGORY = "Utils/KV"

    def load(self, key, registry_path, ext):
        img_out = _placeholder_image()

        key = str(key or "").strip()
        registry_path = str(registry_path or "").strip()
        if not key or not registry_path:
            return (img_out, "")

        base = _images_root()
        json_base = os.path.splitext(os.path.basename(registry_path))[0]

        # Endung aus Key respektieren
        key_name, key_ext = _split_key_and_ext(key)
        used_ext = (key_ext or ext or "png").lower()

        folder = _sanitize_name(json_base)
        fname = f"{_sanitize_name(key_name)}.{used_ext}"
        full_path = os.path.join(base, folder, fname)

        # Pfad IMMER herausgeben
        if not os.path.isfile(full_path):
            return (img_out, full_path)

        try:
            from PIL import Image
            import numpy as np
            import torch
            img = Image.open(full_path).convert("RGB")
            arr = (np.asarray(img).astype("float32") / 255.0)  # H,W,3
            t = torch.from_numpy(arr)[None, ...]               # 1,H,W,3
            return (t, full_path)
        except Exception:
            return (img_out, full_path)

class KVImagePathFromRegistry:
    """Nur Pfad bauen – respektiert Endung im Key, wenn vorhanden."""
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"forceInput": True, "multiline": False}),
                "registry_path": ("STRING", {"forceInput": True, "multiline": False}),
                "ext": (["png"], {"default": "png"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    FUNCTION = "build"
    CATEGORY = "Utils/KV"

    def build(self, key, registry_path, ext):
        key = str(key or "").strip()
        registry_path = str(registry_path or "").strip()
        if not key or not registry_path:
            return ("",)

        key_name, key_ext = _split_key_and_ext(key)
        used_ext = (key_ext or ext or "png").lower()

        base = _images_root()
        json_base = os.path.splitext(os.path.basename(registry_path))[0]
        folder = _sanitize_name(json_base)
        fname = f"{_sanitize_name(key_name)}.{used_ext}"
        path = os.path.join(base, folder, fname)
        return (path,)

# ---------------------------------------------------------------------
# Node Mappings
# ---------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "KVLoadInline": KVLoadInline,
    "KVLoadFromRegistry": KVLoadFromRegistry,
    "KVGet": KVGet,
    "KVPreviewImageFromRegistry": KVPreviewImageFromRegistry,
    "KVImagePathFromRegistry": KVImagePathFromRegistry,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KVLoadInline": "KV Load Inline",
    "KVLoadFromRegistry": "KV Load from Registry",
    "KVGet": "KV Get Value",
    "KVPreviewImageFromRegistry": "KV Preview Image (Registry Key)",
    "KVImagePathFromRegistry": "KV Image Path (Registry Key)",
}
