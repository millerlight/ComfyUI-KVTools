# ComfyUI-KVTools: Key/Value Utilities + sicherer Image-Preview-Loader
# Robuste Version: gibt NIE None als IMAGE zurück (immer Placeholder).
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
# Sicherer Image-Preview (nur unter custom_kv_stores/images)
# Struktur: <ComfyUI>/custom_kv_stores/images/<json-basisname>/<key>.png
# Immer gültiges IMAGE zurückgeben (Platzhalter bei Missing/Error).
# ---------------------------------------------------------------------

def _images_root():
    return os.path.join(os.getcwd(), "custom_kv_stores", "images")

def _sanitize_name(s: str) -> str:
    s = os.path.basename(str(s or "").strip())
    return re.sub(r"[^A-Za-z0-9._ \-]+", "_", s)

# Platzhalter vorab bauen (1x1 schwarz), damit wir nie None zurückgeben
try:
    import torch as _torch
    _KVTOOLS_PLACEHOLDER = _torch.zeros((1, 1, 1, 3), dtype=_torch.float32)  # [B=1,H=1,W=1,C=3]
except Exception:
    _KVTOOLS_PLACEHOLDER = None  # Sollte in ComfyUI nicht passieren; als Fallback unten nochmal abgefangen.

def _placeholder_image():
    global _KVTOOLS_PLACEHOLDER
    if _KVTOOLS_PLACEHOLDER is None:
        # letztes Sicherheitsnetz, falls torch import fehlschlug
        try:
            import torch
            _KVTOOLS_PLACEHOLDER = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
        except Exception:
            # letzte Instanz: gib irgendwas zurück, was kein None ist (riskant, aber verhindert None)
            _KVTOOLS_PLACEHOLDER = 0
    return _KVTOOLS_PLACEHOLDER

try:
    os.makedirs(_images_root(), exist_ok=True)
except Exception:
    pass

class KVPreviewImageFromRegistry:
    """
    Sucht Bild unter:
      <ComfyUI>/custom_kv_stores/images/<json-basisname>/<key>.png
    Gibt bei fehlender Datei KEINEN Fehler aus, sondern einen 1x1-Platzhalter als IMAGE
    sowie einen leeren Pfad (""). Bei Erfolg: echtes Bild + voller Pfad.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "key": ("STRING", {"forceInput": True, "multiline": False}),
                "registry_path": ("STRING", {"forceInput": True, "multiline": False}),
                "ext": (["png"], {"default": "png"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "path")
    FUNCTION = "load"
    CATEGORY = "Utils/KV"

    def load(self, key, registry_path, ext):
        # Standard-Outputs vorbereiten
        img_out = _placeholder_image()
        path_out = ""

        try:
            key = str(key or "").strip()
            registry_path = str(registry_path or "").strip()

            if not key or not registry_path:
                return (img_out, path_out)

            base = _images_root()
            json_base = os.path.splitext(os.path.basename(registry_path))[0]
            folder = _sanitize_name(json_base)
            fname = f"{_sanitize_name(key)}.{ext}"
            full_path = os.path.join(base, folder, fname)

            if not os.path.isfile(full_path):
                return (img_out, path_out)  # Platzhalter + leerer Pfad

            # Bild laden
            from PIL import Image
            import numpy as np
            import torch
            img = Image.open(full_path).convert("RGB")
            arr = (np.asarray(img).astype("float32") / 255.0)  # H,W,3
            t = torch.from_numpy(arr)[None, ...]               # 1,H,W,3
            return (t, full_path)

        except Exception:
            # Niemals None als IMAGE zurückgeben
            return (img_out, path_out)

class KVImagePathFromRegistry:
    """
    Baut nur den Pfad (STRING), ohne zu laden:
      <ComfyUI>/custom_kv_stores/images/<json-basisname>/<key>.png
    Falls die Datei fehlt, wird trotzdem ein String-Pfad zurückgegeben.
    """
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
        base = _images_root()
        json_base = os.path.splitext(os.path.basename(registry_path))[0]
        folder = _sanitize_name(json_base)
        fname = f"{_sanitize_name(key)}.{ext}"
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
