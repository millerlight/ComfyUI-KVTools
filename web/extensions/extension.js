// KVTools UI for KVGet: dropdown + preview + defaults + random + optional auto-run
// Served from /extensions/ComfyUI-KVTools/*

import { app } from "/scripts/app.js";

const EXT_NAME = "ComfyUI-KVTools.UI";

// ---------------- Registry cache ----------------
let REGISTRY = null;
async function loadRegistry() {
  const paths = [
    "/extensions/ComfyUI-KVTools/kv_registry.json",
    "/extensions/ComfyUI-KVTools/web/kv_registry.json",
    "/extensions/comfyui-kvtools/kv_registry.json",
    "/extensions/comfyui-kvtools/web/kv_registry.json",
  ];
  for (const p of paths) {
    try {
      const r = await fetch(p, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.files) { REGISTRY = j; return REGISTRY; }
      }
    } catch {}
  }
  REGISTRY = { files: {} };
  return REGISTRY;
}

// ---------------- Helpers ----------------
function W(node, name) { return (node.widgets || []).find(w => w.name === name); }
function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.widget_options = { hidden: true };
  w.draw = () => {};
  w.computeSize = () => [0, -4];
}
function moveWidgetToTop(node, w) {
  if (!node.widgets || !w) return;
  const i = node.widgets.indexOf(w);
  if (i > 0) { node.widgets.splice(i, 1); node.widgets.unshift(w); }
}
function setDropdownValues(combo, values) {
  combo.options = combo.options || {};
  combo.options.values = Array.isArray(values) ? values.slice() : [];
  if (!combo.options.values.includes(combo.value)) {
    combo.value = combo.options.values[0] ?? "";
  }
}
function ensureAsTypeDefault(node) {
  const w = W(node, "as_type");
  if (w && !["string", "int", "float", "bool"].includes(String(w.value))) {
    w.value = "string";
    const i = node.widgets.indexOf(w);
    if (i >= 0 && Array.isArray(node.widgets_values)) node.widgets_values[i] = "string";
  }
}
function upstreamNode(node) {
  const inp = (node.inputs || []).find(i => i && i.name === "store");
  if (!inp || inp.link == null) return null;
  const link = node.graph.links[inp.link];
  return link ? node.graph.getNodeById(link.origin_id) : null;
}

// ---- parse inline store (kv or json) ----
function parseStoreObject(text) {
  const s = String(text ?? "").trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {}
  const out = {};
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^\s*([^=:#]+)\s*[:=]\s*(.*)\s*$/);
    if (m) out[String(m[1]).trim()] = String(m[2]).trim();
  }
  return out;
}
function keysFromInline(up) {
  const dataW = W(up, "data");
  if (!dataW) return [];
  const obj = parseStoreObject(dataW.value ?? "");
  return Object.keys(obj).sort();
}

// ---- registry keys ----
function upstreamFileName(node) {
  const up = upstreamNode(node);
  if (!up) return null;
  const fnW = W(up, "file_name");
  if (fnW && fnW.value) return String(fnW.value).trim();
  const pathW = W(up, "path");
  if (pathW && pathW.value) {
    const p = String(pathW.value).trim();
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || null;
  }
  return null;
}
function keysFromRegistryByFile(fileName) {
  if (!fileName) return [];
  const entry = REGISTRY?.files?.[fileName];
  return Array.isArray(entry?.keys) ? entry.keys.slice() : [];
}

// ---- unified keys ----
function collectKeys(node) {
  const up = upstreamNode(node);
  if (!up) return [];
  if (up.comfyClass === "KVLoadInline") return keysFromInline(up);
  if (up.comfyClass === "KVLoadFromRegistry") {
    const fname = upstreamFileName(node);
    return keysFromRegistryByFile(fname);
  }
  return [];
}

// ---- default-aware pick ----
function pickNewKey(node, list) {
  if (!Array.isArray(list) || !list.length) return "";
  const dkW = W(node, "default_key");
  const dk = String(dkW?.value || "").trim();
  if (dk && list.includes(dk)) return dk;
  const ks = W(node, "key_select");
  if (ks && list.includes(String(ks.value))) return String(ks.value);
  return list[0];
}

// ---------------- Preview ----------------
function ensurePreviewWidget(node) {
  let w = W(node, "_kvtools_preview_value");
  if (!w) {
    w = node.addWidget("text", "_kvtools_preview_value", "", null);
    w.serialize = false;
  }
  try { if (w.inputEl) { w.inputEl.readOnly = true; w.inputEl.style.opacity = 0.9; } } catch {}
  return w;
}

// optional server endpoints
async function serverRefreshRegistry() { try { await fetch("/kvtools/refresh_registry", { method: "POST" }); } catch {} }
async function serverPeek(fileName, key) {
  if (!fileName || !key) return "";
  try {
    const r = await fetch("/kvtools/peek", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_name: fileName, key })
    });
    if (!r.ok) return "";
    const j = await r.json();
    return j && j.ok ? String(j.value ?? "") : "";
  } catch { return ""; }
}

async function updatePreview(node) {
  const pv = ensurePreviewWidget(node);
  const keyW = W(node, "key");
  const key = String(keyW?.value || "").trim();
  if (!key) { pv.value = ""; node.setDirtyCanvas(true, true); return; }

  const up = upstreamNode(node);
  if (!up) { pv.value = ""; node.setDirtyCanvas(true, true); return; }

  if (up.comfyClass === "KVLoadInline") {
    const dataW = W(up, "data");
    const obj = parseStoreObject(dataW?.value ?? "");
    let v = obj[key];
    if (v && typeof v === "object") { try { v = JSON.stringify(v); } catch {} }
    pv.value = String(v ?? "");
    node.setDirtyCanvas(true, true);
    return;
  }

  if (up.comfyClass === "KVLoadFromRegistry") {
    await serverRefreshRegistry().catch(() => {});
    await loadRegistry().catch(() => {});
    const fileName = upstreamFileName(node);
    const v = await serverPeek(fileName, key).catch(() => "");
    pv.value = String(v || "");
    node.setDirtyCanvas(true, true);
    return;
  }

  pv.value = "";
  node.setDirtyCanvas(true, true);
}

// ---------------- Auto-run ----------------
function ensureAutoRunToggle(node) {
  let w = W(node, "_kvtools_autorun");
  if (!w) {
    w = node.addWidget("checkbox", "_kvtools_autorun", false, null, { label: "Auto run on change" });
    w.serialize = true;
  }
  return w;
}
async function tryQueueRun() {
  if (app?.queuePrompt) {
    try { await app.queuePrompt(); } catch {}
  }
}

// ---------------- Defaults ----------------
function ensureDefaultKeyStorage(node) {
  let w = W(node, "default_key");
  if (!w) {
    w = node.addWidget("text", "default_key", "", null);
    w.serialize = true;
  }
  hideWidget(w);
  return w;
}
function ensureDefaultButtons(node) {
  if (!node.__kvtools_setdef_btn) {
    const b = node.addWidget("button", "Set default (current key)", null, () => {
      const ks = W(node, "key_select");
      const dk = ensureDefaultKeyStorage(node);
      if (ks && dk) {
        dk.value = String(ks.value || "");
        node.setDirtyCanvas(true, true);
      }
    });
    b.serialize = false;
    node.__kvtools_setdef_btn = b;
  }
  if (!node.__kvtools_loadd_btn) {
    const b2 = node.addWidget("button", "Load default", null, async () => {
      const dk = W(node, "default_key");
      const ks = W(node, "key_select");
      const keyW = W(node, "key");
      if (dk && ks && keyW) {
        const list = collectKeys(node);
        const val = String(dk.value || "").trim();
        if (val && list.includes(val)) {
          ks.value = val;
          keyW.value = val;
          node.setDirtyCanvas(true, true);
          await updatePreview(node);
          if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
        }
      }
    });
    b2.serialize = false;
    node.__kvtools_loadd_btn = b2;
  }
}

// ---------------- UI build / sync ----------------
function buildOrEnsureCombo(node) {
  if (node.__kvtools_combo && node.widgets.includes(node.__kvtools_combo)) {
    return node.__kvtools_combo;
  }
  const combo = node.addWidget("combo", "key_select", "", null, { values: [] });
  combo.serialize = false;
  node.__kvtools_combo = combo;
  moveWidgetToTop(node, combo);
  return combo;
}

async function syncKeyList(node) {
  const ks = buildOrEnsureCombo(node);
  const keyW = W(node, "key");
  if (!ks || !keyW) return;

  const list = collectKeys(node);
  setDropdownValues(ks, list);

  const cur = String(keyW.value || "").trim();
  if (list.includes(cur)) {
    ks.value = cur;
  } else {
    const pick = pickNewKey(node, list);
    ks.value = pick;
    keyW.value = pick;
  }
  node.setDirtyCanvas(true, true);
}

function hideBuiltIns(node) {
  hideWidget(W(node, "key"));
  hideWidget(W(node, "keys_hint"));
  hideWidget(W(node, "default"));
  hideWidget(W(node, "default_key"));
  setTimeout(() => {
    hideWidget(W(node, "key"));
    hideWidget(W(node, "keys_hint"));
    hideWidget(W(node, "default"));
    hideWidget(W(node, "default_key"));
  }, 0);
}

function ensureRefreshButton(node) {
  if (node.__kvtools_refresh_btn) return node.__kvtools_refresh_btn;
  const btn = node.addWidget("button", "KVTools: refresh keys", null, async () => {
    await loadRegistry();
    await syncKeyList(node);
    ensureAsTypeDefault(node);
    await updatePreview(node);
    if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
  });
  btn.serialize = false;
  node.__kvtools_refresh_btn = btn;
  return btn;
}

function ensureRandomButton(node) {
  if (node.__kvtools_random_btn) return node.__kvtools_random_btn;
  const btn = node.addWidget("button", "Random key", null, async () => {
    const ks = W(node, "key_select");
    const keyW = W(node, "key");
    const list = collectKeys(node);
    if (!list.length || !ks || !keyW) return;
    const pick = list[Math.floor(Math.random() * list.length)];
    ks.value = pick;
    keyW.value = pick;
    node.setDirtyCanvas(true, true);
    await updatePreview(node);
    if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
  });
  btn.serialize = false;
  node.__kvtools_random_btn = btn;
  return btn;
}

// Upstream changes
function hookUpstream(node) {
  const up = upstreamNode(node);
  if (!up) return;

  if (up.comfyClass === "KVLoadInline") {
    const dataW = W(up, "data");
    if (dataW && !dataW._kvtoolsHooked) {
      dataW._kvtoolsHooked = true;
      const orig = dataW.callback;
      dataW.callback = async () => {
        if (orig) orig();
        await syncKeyList(node);
        await updatePreview(node);
        if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
      };
    }
  }

  if (up.comfyClass === "KVLoadFromRegistry") {
    const fnW = W(up, "file_name");
    if (fnW && !fnW._kvtoolsHooked) {
      fnW._kvtoolsHooked = true;
      const orig = fnW.callback;
      fnW.callback = async () => {
        if (orig) orig();
        await loadRegistry();
        await syncKeyList(node);
        await updatePreview(node);
        if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
      };
    }
  }
}

// ---------------- Attach ----------------
function isKVGet(node) { return node?.comfyClass === "KVGet"; }

function attachToKVGet(node) {
  if (!isKVGet(node)) return;
  if (node.__kvtools_attached) return;
  node.__kvtools_attached = true;

  hideBuiltIns(node);
  ensureAsTypeDefault(node);
  buildOrEnsureCombo(node);
  ensurePreviewWidget(node);
  ensureRefreshButton(node);
  ensureRandomButton(node);
  ensureDefaultKeyStorage(node);
  ensureDefaultButtons(node);
  ensureAutoRunToggle(node);

  const ks = W(node, "key_select");
  if (ks && !ks.__kvtools_cb) {
    ks.__kvtools_cb = true;
    ks.callback = async () => {
      const keyW = W(node, "key");
      if (keyW) keyW.value = String(ks.value || "");
      node.setDirtyCanvas(true, true);
      await updatePreview(node);
      if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
    };
  }

  const keyW = W(node, "key");
  if (keyW && !keyW.__kvtools_cb) {
    keyW.__kvtools_cb = true;
    const orig = keyW.callback;
    keyW.callback = async () => {
      if (orig) orig();
      const ks2 = W(node, "key_select");
      if (ks2 && ks2.options?.values?.includes(keyW.value)) ks2.value = keyW.value;
      node.setDirtyCanvas(true, true);
      await updatePreview(node);
      if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
    };
  }

  const origConn = node.onConnectionsChange?.bind(node);
  node.onConnectionsChange = async (...args) => {
    if (origConn) origConn(...args);
    hookUpstream(node);
    await loadRegistry();
    await syncKeyList(node);
    ensureAsTypeDefault(node);
    await updatePreview(node);
    if (W(node, "_kvtools_autorun")?.value) await tryQueueRun();
  };

  const wait = setInterval(async () => {
    const up = upstreamNode(node);
    if (up) {
      clearInterval(wait);
      hookUpstream(node);
      await loadRegistry();
      await syncKeyList(node);
      await updatePreview(node);
    }
  }, 200);
}

// ---------------- Register ----------------
app.registerExtension({
  name: EXT_NAME,
  setup() {
    const ready = setInterval(() => {
      if (app.graph && Array.isArray(app.graph._nodes)) {
        clearInterval(ready);
        for (const n of app.graph._nodes) attachToKVGet(n);
        const origAdd = app.graph.add;
        app.graph.add = function(node) {
          const res = origAdd.call(this, node);
          attachToKVGet(node);
          return res;
        };
      }
    }, 200);
  },
});
