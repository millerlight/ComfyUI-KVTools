// web/extension.js
import { app } from "/scripts/app.js";

const WN = {
  PREVIEW: "_preview_value",
  RANDOM: "_kvtools_random_key",
  REFRESH: "_kvtools_refresh_keys",
  SETDEF: "_kvtools_set_default_key",
  LOADDEF: "_kvtools_load_default_key",
  KEY_SELECT: "key_select",     // sichtbares Dropdown (oben)
  DEFAULT: "default",
  DEFAULT_KEY: "default_key",
  KEY: "key",                   // intern, unsichtbar
  KEYS_HINT: "keys_hint",       // intern, unsichtbar
};
const REFRESH_LABEL = "KVTools: refresh keys";
const AS_TYPE_ALLOWED = ["string", "int", "float", "bool"];

// ---------- Helper ----------
function getInputNode(node, slotIndex = 0) {
  try { return node.getInputNode?.(slotIndex) ?? null; } catch { return null; }
}
function getWidget(node, name) {
  return node.widgets?.find?.(w => w.name === name);
}
function ensureWidget(node, type, name, value, cb, options) {
  let w = getWidget(node, name);
  if (w) return w;
  // addWidget(type, name, value, callback, options)
  return node.addWidget(type, name, value, cb, options);
}
function hideWidget(w) {
  if (!w) return;
  try { if (w.inputEl) w.inputEl.style.display = "none"; } catch {}
  w.hidden = true;
  w.draw = () => {};
  w.computeSize = () => [0, -4];
}
function moveWidgetToTop(node, w) {
  if (!node.widgets || !w) return;
  const i = node.widgets.indexOf(w);
  if (i > 0) {
    node.widgets.splice(i, 1);
    node.widgets.unshift(w);
  }
}
function setComboValues(combo, values) {
  combo.options = combo.options || {};
  combo.options.values = Array.isArray(values) ? values : [];
  if (!combo.options.values.includes(combo.value)) {
    combo.value = combo.options.values[0] ?? "";
  }
}
function parseInline(inlineNode) {
  const w = getWidget(inlineNode, "data");
  const txt = (w?.value ?? "").trim();
  if (!txt) return {};
  // JSON versuchen
  try {
    const obj = JSON.parse(txt);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {}
  // Fallback: einfache KV-Zeilen
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^\s*([^=:#]+)\s*[:=]\s*(.*)\s*$/);
    if (m) out[String(m[1]).trim()] = String(m[2]).trim();
  }
  return out;
}
async function tryFetchJson(url) {
  try { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}
async function loadRegistry() {
  const candidates = [
    "/extensions/ComfyUI-KVTools/kv_registry.json",
    "/extensions/comfyui-kvtools/kv_registry.json",
    "/extensions/ComfyUI-KVTools/web/kv_registry.json",
    "/extensions/comfyui-kvtools/web/kv_registry.json",
  ];
  for (const p of candidates) {
    const j = await tryFetchJson(p);
    if (j && j.files) return j;
  }
  return null;
}
function getRegFile(regNode) {
  return getWidget(regNode, "file_name")?.value || null;
}
async function peekServer(fileName, key) {
  if (!fileName || !key) return "";
  try {
    const res = await fetch("/kvtools/peek", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_name: fileName, key }),
    });
    if (!res.ok) return "";
    const j = await res.json();
    return j.ok ? (j.value ?? "") : "";
  } catch { return ""; }
}
function keysFromInline(node) { return Object.keys(parseInline(node)).sort(); }
async function keysFromRegistry(node, registry) {
  const fn = getRegFile(node);
  const entry = registry?.files?.[fn];
  return Array.isArray(entry?.keys) ? entry.keys : [];
}
async function getKeys(node, registry) {
  const up = getInputNode(node, 0);
  if (!up) return [];
  if (up.comfyClass === "KVLoadInline") return keysFromInline(up);
  if (up.comfyClass === "KVLoadFromRegistry") return await keysFromRegistry(up, registry);
  return [];
}
async function updatePreview(node, registry) {
  const prev = getWidget(node, WN.PREVIEW);
  const keyW = getWidget(node, WN.KEY);
  if (!prev || !keyW) return;
  const key = (keyW.value ?? "").trim();
  if (!key) { prev.value = ""; node.setDirtyCanvas(true, true); return; }

  const up = getInputNode(node, 0);
  if (!up) { prev.value = ""; node.setDirtyCanvas(true, true); return; }

  if (up.comfyClass === "KVLoadInline") {
    let v = parseInline(up)[key];
    if (typeof v === "object") v = JSON.stringify(v);
    prev.value = (v ?? "").toString();
  } else if (up.comfyClass === "KVLoadFromRegistry") {
    const v = await peekServer(getRegFile(up), key);
    prev.value = (v ?? "").toString();
  } else {
    prev.value = "";
  }
  node.setDirtyCanvas(true, true);
}
async function syncKeyList(node, registry) {
  const ks = getWidget(node, WN.KEY_SELECT);
  const keyW = getWidget(node, WN.KEY);
  if (!ks || !keyW) return;
  const list = await getKeys(node, registry);
  setComboValues(ks, list);

  if (keyW.value && list.includes(keyW.value)) {
    ks.value = keyW.value;
  } else if (!keyW.value && ks.value) {
    keyW.value = ks.value;
  }
  node.setDirtyCanvas(true, true);
}
function ensureAsTypeValid(node) {
  const w = getWidget(node, "as_type");
  if (!w) return;
  if (!AS_TYPE_ALLOWED.includes(w.value)) {
    w.value = "string";          // harter Fallback, falls leer/ungültig
    node.setDirtyCanvas(true, true);
  }
}

// ---------- Extension ----------
app.registerExtension({
  name: "ComfyUI-KVTools.UI",
  async setup() {
    this._registry = await loadRegistry();
  },
  async nodeCreated(node) {
    if (node.comfyClass !== "KVGet") return;

    // (0) Sicherstellen, dass as_type gültig ist
    ensureAsTypeValid(node);

    // (A) Dropdown anlegen und GANZ NACH OBEN setzen
    const ks = ensureWidget(node, "combo", WN.KEY_SELECT, "", null, { values: [] });
    moveWidgetToTop(node, ks);

    // (B) key + keys_hint + default + default_key unsichtbar
    const keyW = getWidget(node, WN.KEY);
    const hintW = getWidget(node, WN.KEYS_HINT);
    hideWidget(keyW);
    hideWidget(hintW);
    hideWidget(getWidget(node, WN.DEFAULT));
    hideWidget(getWidget(node, WN.DEFAULT_KEY));
    // falls DOM spät kommt: noch einmal nach dem Rendern
    setTimeout(() => { hideWidget(getWidget(node, WN.KEY)); hideWidget(getWidget(node, WN.KEYS_HINT)); }, 0);

    // (C) Preview (read-only)
    const prev = ensureWidget(node, "text", WN.PREVIEW, "", null);
    if (prev?.inputEl) { prev.inputEl.readOnly = true; prev.inputEl.style.opacity = 0.9; }

    // (D) Buttons
    const randomBtn = ensureWidget(node, "button", WN.RANDOM, null, async () => {
      const list = await getKeys(node, this._registry);
      if (!list.length) return;
      const pick = list[Math.floor(Math.random() * list.length)];
      ks.value = pick;
      const kW = getWidget(node, WN.KEY);
      if (kW) kW.value = pick;
      node.setDirtyCanvas(true, true);
      await updatePreview(node, this._registry);
    });
    randomBtn.label = "🎲 Random key";

    const refreshBtn = ensureWidget(node, "button", WN.REFRESH, null, async () => {
      try { await fetch("/kvtools/refresh_registry", { method: "POST" }); } catch {}
      this._registry = await loadRegistry();
      await syncKeyList(node, this._registry);
      await updatePreview(node, this._registry);
      ensureAsTypeValid(node);   // sicherheitshalber erneut
    });
    refreshBtn.label = REFRESH_LABEL;

    const setDefBtn = ensureWidget(node, "button", WN.SETDEF, null, async () => {
      const dk = ensureWidget(node, "text", WN.DEFAULT_KEY, "", null);
      hideWidget(dk);
      dk.value = getWidget(node, WN.KEY)?.value || "";
      node.setDirtyCanvas(true, true);
    });
    setDefBtn.label = "Set as default key";

    const loadDefBtn = ensureWidget(node, "button", WN.LOADDEF, null, async () => {
      const dk = ensureWidget(node, "text", WN.DEFAULT_KEY, "", null);
      hideWidget(dk);
      const kW = getWidget(node, WN.KEY);
      if (dk?.value && kW) {
        kW.value = dk.value;
        ks.value = dk.value;
        node.setDirtyCanvas(true, true);
        await updatePreview(node, this._registry);
      }
    });
    loadDefBtn.label = "Load default key";

    // (E) Callbacks
    ks.callback = async () => {
      const kW = getWidget(node, WN.KEY);
      if (kW) kW.value = ks.value || "";
      node.setDirtyCanvas(true, true);
      await updatePreview(node, this._registry);
    };
    if (keyW) {
      const orig = keyW.callback;
      keyW.callback = async () => {
        if (orig) orig();
        if (ks.options?.values?.includes(keyW.value)) ks.value = keyW.value;
        node.setDirtyCanvas(true, true);
        await updatePreview(node, this._registry);
      };
    }

    // (F) Verbindungsänderungen
    const origConn = node.onConnectionsChange?.bind(node);
    node.onConnectionsChange = async (...args) => {
      if (origConn) origConn(...args);
      await syncKeyList(node, this._registry);
      await updatePreview(node, this._registry);
      ensureAsTypeValid(node);

      const up = getInputNode(node, 0);
      if (up?.comfyClass === "KVLoadFromRegistry") {
        const fnW = getWidget(up, "file_name");
        if (fnW && !fnW._kvtoolsHooked) {
          fnW._kvtoolsHooked = true;
          const orig = fnW.callback;
          fnW.callback = async () => {
            if (orig) orig();
            this._registry = await loadRegistry();
            await syncKeyList(node, this._registry);
            await updatePreview(node, this._registry);
            ensureAsTypeValid(node);
          };
        }
      }
    };

    // (G) Initial laden
    setTimeout(async () => {
      await syncKeyList(node, this._registry);
      const dk2 = getWidget(node, WN.DEFAULT_KEY);
      const kW2 = getWidget(node, WN.KEY);
      if (dk2?.value && kW2 && !kW2.value) {
        kW2.value = dk2.value;
        ks.value = dk2.value;
      }
      moveWidgetToTop(node, ks);
      ensureAsTypeValid(node);
      node.setDirtyCanvas(true, true);
      await updatePreview(node, this._registry);
    }, 0);
  }
});
