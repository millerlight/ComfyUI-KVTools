
# ComfyUI-KVTools: Key/Value Utilities (stabil, ohne Format-/Encoding-UI)

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
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "store": ("KV",),
                "key": ("STRING", {"default": "", "placeholder": "set via Dropdown"}),
                "default": ("STRING", {"default": ""}),
                "as_type": (["string", "int", "float", "bool"], {"default": "string"}),
            },
            "optional": {
                "keys_hint": ("STRING", {"multiline": True, "default": ""}),
            }
        }
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("value", "keys")
    FUNCTION = "get"
    CATEGORY = "Utils/KV"

    def get(self, store, key, default, as_type, keys_hint=""):
        if not isinstance(store, dict):
            raise ValueError("KVGet: 'store' is no Dict (KV).")
        if as_type not in ("string", "int", "float", "bool"):
            as_type = "string"

        keys_list = sorted([str(k) for k in store.keys()])
        keys_str = "\n".join(keys_list)
        value = store.get((key or "").strip(), default)
        try:
            value = _cast(value, as_type)
        except Exception:
            value = _cast(default, as_type)
        return (str(value), keys_str)

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
        store = _parse_data(text, "utf-8")
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
