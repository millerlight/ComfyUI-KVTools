// custom_nodes/ComfyUI-KVTools/web/js/extension.js
// KVTools Frontend Extension for ComfyUI
// - key_select combo at the top
// - inline text preview (_kvtools_preview_value) without run
// - image preview (_kvtools_img_preview) without run
// - buttons: refresh / random / default
// - autorun: debounced, single-flight/cooldown, robust prompt queueing
// - filters meta-keys (#workflow) out of the prompt
// - null sanitizing for text widgets, no widgets_values index hacks
// - NEW: direct hooks on KVLoadFromRegistry file_name/path changes → auto-sync keys & preview

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXT_NAME = "ComfyUI-KVTools.UI";
const KVTOOLS_AUTORUN = true;

// -----------------------------------------------------
// State / Anti-spam
// -----------------------------------------------------
let kvtoolsIsProcessing = false;
api.addEventListener("status", (e) => {
  kvtoolsIsProcessing = !!e?.detail?.processing;
});
const kvRunLock = { busy: false, last: 0, cooldownMs: 500 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------
// Widget / node helpers
// -----------------------------------------------------
function W(node, name) {
  return (node?.widgets || []).find((w) => w.name === name) || null;
}
function hideWidget(node, name) {
  const w = W(node, name);
  if (!w) return;
  w.hidden = true;
  w.draw = () => {};
  w.computeSize = () => [0, -4];
}
function moveWidgetToTop(node, widgetOrName) {
  const w = typeof widgetOrName === "string" ? W(node, widgetOrName) : widgetOrName;
  if (!node?.widgets || !w) return;
  const i = node.widgets.indexOf(w);
  if (i > 0) {
    node.widgets.splice(i, 1);
    node.widgets.unshift(w);
  }
}
function setDropdownValues(combo, values) {
  combo.options = combo.options || {};
  combo.options.values = Array.isArray(values) ? values.slice() : [];
  if (!combo.options.values.includes(combo.value)) {
    combo.value = combo.options.values[0] ?? "";
  }
}

// -----------------------------------------------------
// Store parsing
// -----------------------------------------------------
function parseStoreObject(s) {
  try { return JSON.parse(String(s || "")); } catch { return {}; }
}
function parseEnvFile(s) {
  const out = {};
  if (!s) return out;
  for (const raw of String(s).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^\s*([^=:#]+)\s*[:=]\s*(.*)\s*$/);
    if (m) out[String(m[1]).trim()] = String(m[2]).trim();
  }
  return out;
}

// -----------------------------------------------------
// Upstream detection & defaults
// -----------------------------------------------------
function ensureAsTypeDefault(node) {
  const w = W(node, "as_type");
  if (w && !["string", "int", "float", "bool"].includes(String(w.value))) {
    w.value = "string"; // do not touch node.widgets_values (index drift!)
  }
}
function upstreamNode(node) {
  const inp = (node.inputs || []).find((i) => i.name === "store");
  const link = inp?.link != null ? app.graph.links?.[inp.link] : null;
  const nodeId = link?.origin_id;
  return nodeId != null ? app.graph.getNodeById(nodeId) : null;
}
function upstreamFileName(node) {
  const up = upstreamNode(node);
  if (!up || up.comfyClass !== "KVLoadFromRegistry") return null;
  return W(up, "file_name")?.value || null;
}

// -----------------------------------------------------
// Registry cache & endpoints
// -----------------------------------------------------
let REGISTRY = null;

async function loadRegistry() {
  const candidates = [
    "/extensions/ComfyUI-KVTools/kv_registry.json",
    "/extensions/ComfyUI-KVTools/web/kv_registry.json",
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url + "?t=" + Date.now());
      if (r.ok) { REGISTRY = await r.json(); return; }
    } catch {}
  }
  REGISTRY = null;
}
async function serverRefreshRegistry() {
  try { await fetch("/kvtools/refresh_registry", { method: "POST" }); } catch {}
}
async function serverPeek(fileName, key) {
  if (!fileName || !key) return "";
  try {
    const r = await fetch("/kvtools/peek", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_name: fileName, key }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    return j?.ok ? String(j.value ?? "") : "";
  } catch { return ""; }
}

function keysFromInline(up) {
  const w = W(up, "data"); if (!w) return [];
  const text = String(w.value || "");
  const obj = text.trim().startsWith("{") ? parseStoreObject(text) : parseEnvFile(text);
  return Object.keys(obj).sort();
}
function keysFromRegistryByFile(fileName) {
  if (!REGISTRY || !fileName) return [];
  const entry = REGISTRY?.stores?.find?.((s) => s.file_name === fileName);
  if (entry && entry.value && typeof entry.value === "object") {
    try { return Object.keys(entry.value); } catch {}
  }
  const alt = REGISTRY?.files?.[fileName]?.keys;
  if (Array.isArray(alt)) return alt.slice();
  return [];
}
function collectKeys(node) {
  const up = upstreamNode(node);
  if (!up) return [];
  if (up.comfyClass === "KVLoadInline") return keysFromInline(up);
  if (up.comfyClass === "KVLoadFromRegistry") {
    const fn = W(up, "file_name")?.value || null;
    if (!fn) return [];
    return keysFromRegistryByFile(fn).sort();
  }
  return [];
}
function pickNewKey(keys, current) {
  if (!keys?.length) return "";
  if (keys.length === 1) return keys[0];
  let idx = Math.floor(Math.random() * keys.length);
  if (keys[idx] === current) idx = (idx + 1) % keys.length;
  return keys[idx];
}

// -----------------------------------------------------
// Text preview (no run)
// -----------------------------------------------------
function ensurePreviewWidget(node) {
  let pv = W(node, "_kvtools_preview_value");
  if (!pv) { pv = node.addWidget("text", "_kvtools_preview_value", "", null); pv.serialize = false; }
  return pv;
}
async function updateTextPreview(node) {
  const pv = ensurePreviewWidget(node);
  const up = upstreamNode(node);
  pv.value = "";
  if (!up) { node.setDirtyCanvas(true, true); return; }

  const key = String(W(node, "key_select")?.value || W(node, "key")?.value || "").trim();
  if (!key) { node.setDirtyCanvas(true, true); return; }

  if (up.comfyClass === "KVLoadInline") {
    const dataW = W(up, "data");
    const text = String(dataW?.value || "");
    const obj = text.trim().startsWith("{") ? parseStoreObject(text) : parseEnvFile(text);
    let v = obj[key]; if (v && typeof v === "object") { try { v = JSON.stringify(v); } catch {} }
    pv.value = v != null ? String(v) : "";
    node.setDirtyCanvas(true, true); return;
  }

  if (up.comfyClass === "KVLoadFromRegistry") {
    await serverRefreshRegistry().catch(() => {}); // harmless if already up to date
    await loadRegistry().catch(() => {});
    const fileName = upstreamFileName(node);
    pv.value = await serverPeek(fileName, key);
    node.setDirtyCanvas(true, true); return;
  }

  node.setDirtyCanvas(true, true);
}

// -----------------------------------------------------
// Image preview (no run) – custom draw widget
// -----------------------------------------------------
function ensureImagePreviewWidget(node) {
  let w = W(node, "_kvtools_img_preview");
  if (w) return w;
  w = node.addWidget("string", "_kvtools_img_preview", "", null);
  w.serialize = false; w.__img = null; w.__url = null;
  w.computeSize = function () {
    const width = Math.max(180, (node.size?.[0] || 320) - 20);
    const height = 140;
    return [width, height];
  };
  w.draw = function (ctx, n, left, top, width, height) {
    ctx.save();
    ctx.fillStyle = "#111";
    ctx.fillRect(left, top, width, height);
    ctx.strokeStyle = "#333";
    ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
    const img = this.__img;
    if (img && img.complete && img.naturalWidth > 0) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const arI = iw / ih, arB = width / height;
      let dw, dh, dx, dy;
      if (arI > arB) { dw = width - 10; dh = dw / arI; dx = left + 5; dy = top + (height - dh) / 2; }
      else { dh = height - 10; dw = dh * arI; dy = top + 5; dx = left + (width - dw) / 2; }
      ctx.drawImage(img, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#666";
      ctx.font = "12px monospace";
      ctx.fillText("no image", left + 10, top + height / 2);
    }
    ctx.restore();
  };
  return w;
}
function buildImageURL(node, key, ext) {
  const file = upstreamFileName(node);
  if (!file || !key) return "";
  const u = new URL(location.origin + "/kvtools/image");
  u.searchParams.set("file", file);
  u.searchParams.set("key", key);
  if (ext) u.searchParams.set("ext", ext);
  u.searchParams.set("t", Date.now());
  return u.toString();
}
function updateImagePreview(node, force = false) {
  const imgW = ensureImagePreviewWidget(node);
  const key = String(W(node, "key_select")?.value || W(node, "key")?.value || "").trim();
  const ip = (app.graph?._nodes || []).find((n) => n.comfyClass === "KVImagePathFromRegistry");
  const ext = String(ip?.widgets?.find((w) => w.name === "ext")?.value || "png");
  const url = buildImageURL(node, key, ext);
  if (!url) { imgW.__img = null; imgW.__url = null; node.setDirtyCanvas(true, true); return; }
  if (!force && url === imgW.__url) return;
  const img = new Image();
  img.onload = () => { imgW.__img = img; imgW.__url = url; node.setDirtyCanvas(true, true); };
  img.onerror = () => { imgW.__img = null; imgW.__url = url; node.setDirtyCanvas(true, true); };
  img.src = url;
}

// -----------------------------------------------------
// Prompt building / queueing (robust with fallbacks)
// -----------------------------------------------------
function sanitizeTextWidgets() {
  if (!app?.graph?._nodes) return;
  for (const n of app.graph._nodes) {
    for (const w of (n.widgets || [])) {
      if ((w.type === "text" || w.type === "string") && w.value == null) w.value = "";
    }
  }
}
async function buildPromptFiltered() {
  try {
    sanitizeTextWidgets();
    let r = null;
    if (typeof app.graphToPrompt === "function") r = await app.graphToPrompt();
    else if (typeof app.getPrompt === "function") r = await app.getPrompt();

    const raw = r?.prompt ?? r ?? null;
    if (!raw || typeof raw !== "object") return { prompt: null, workflow: r?.workflow };

    const clean = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === "string" && k.startsWith("#")) continue; // meta keys
      if (!v || typeof v !== "object") continue;
      if (!("class_type" in v)) continue; // only real nodes
      clean[k] = v;
    }
    if (!Object.keys(clean).length) return { prompt: null, workflow: r?.workflow };
    return { prompt: clean, workflow: r?.workflow };
  } catch (e) {
    console.warn("[KVTools] buildPromptFiltered error:", e);
    return { prompt: null, workflow: null };
  }
}
async function queueViaApi(prompt, workflow) {
  try {
    const body = {
      prompt,
      client_id: app?.clientId || api?.clientId || "kvtools",
      extra_data: { extra_pnginfo: { workflow } },
    };
    const res = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res?.ok) console.warn("[KVTools] /prompt failed:", res?.status, await res?.text?.());
    return !!res?.ok;
  } catch (e) {
    console.warn("[KVTools] /prompt api error:", e);
    return false;
  }
}
async function queueViaUI() {
  try {
    if (typeof app.queuePrompt === "function") {
      if (app.queuePrompt.length === 0) { await app.queuePrompt(); return true; }
      try { await app.queuePrompt(undefined); return true; } catch {}
    }
  } catch (e) {
    console.warn("[KVTools] queueViaUI error:", e);
  }
  try {
    const btn = [...document.querySelectorAll("button")]
      .find(b => /queue\s*prompt/i.test(b?.textContent || "") || /queue/i.test(b?.title || ""));
    if (btn) { btn.click(); return true; }
  } catch {}
  return false;
}
async function tryQueueRun(delay = 200) {
  if (!KVTOOLS_AUTORUN) return;
  if (!app?.graph) return;
  if (kvtoolsIsProcessing) return;

  const now = Date.now();
  if (kvRunLock.busy || (now - kvRunLock.last) < kvRunLock.cooldownMs) return;

  kvRunLock.busy = true;
  setTimeout(async () => {
    try {
      let { prompt, workflow } = await buildPromptFiltered();
      if (prompt) {
        const ok = await queueViaApi(prompt, workflow);
        if (ok) return;
      } else {
        await sleep(250);
        ({ prompt, workflow } = await buildPromptFiltered());
        if (prompt) {
          const ok2 = await queueViaApi(prompt, workflow);
          if (ok2) return;
        }
      }
      const viaUI = await queueViaUI();
      if (viaUI) return;
      if (typeof app.queueGraph === "function") { await app.queueGraph(true); return; }
      console.warn("[KVTools] tryQueueRun: prompt=null (not ready yet) – no fallback available");
    } catch (e) {
      console.error("[KVTools] autorun failed:", e);
    } finally {
      kvRunLock.last = Date.now();
      kvRunLock.busy = false;
    }
  }, delay);
}

// -----------------------------------------------------
// UI pieces on KVGet
// -----------------------------------------------------
function ensureKeySelectCombo(node) {
  let ks = W(node, "key_select");
  if (!ks) { ks = node.addWidget("combo", "key_select", "", null, { values: [] }); ks.serialize = false; }
  return ks;
}
function ensureRefreshButton(node) {
  if (node.__kvtools_refresh_btn) return node.__kvtools_refresh_btn;
  const btn = node.addWidget("button", "KVTools: refresh keys", null, async () => {
    await serverRefreshRegistry(); await loadRegistry(); await syncKeyList(node);
    ensureAsTypeDefault(node); await updateTextPreview(node); updateImagePreview(node, true);
    await tryQueueRun();
  });
  btn.serialize = false; node.__kvtools_refresh_btn = btn; return btn;
}
function ensureRandomButton(node) {
  if (node.__kvtools_random_btn) return node.__kvtools_random_btn;
  const btn = node.addWidget("button", "Random key", null, async () => {
    const ks = W(node, "key_select"); const keys = ks?.options?.values || []; if (!keys.length) return;
    const pick = pickNewKey(keys, ks.value); ks.value = pick;
    const keyW = W(node, "key"); if (keyW) keyW.value = pick;
    node.setDirtyCanvas(true, true);
    await updateTextPreview(node); updateImagePreview(node, true);
    await tryQueueRun();
  });
  btn.serialize = false; node.__kvtools_random_btn = btn; return btn;
}
function ensureDefaultKeyStorage(node) {
  let w = W(node, "default_key");
  if (!w) { w = node.addWidget("text", "default_key", "", null); w.serialize = true; w.hidden = true; }
  return w;
}
function ensureDefaultButtons(node) {
  if (!node.__kvtools_btn_set) {
    const btn = node.addWidget("button", "Set default (current key)", null, async () => {
      const ks = W(node, "key_select"); const def = ensureDefaultKeyStorage(node);
      def.value = String(ks?.value || ""); node.setDirtyCanvas(true, true);
    });
    btn.serialize = false; node.__kvtools_btn_set = btn;
  }
  if (!node.__kvtools_btn_load) {
    const btn = node.addWidget("button", "Load default", null, async () => {
      const def = ensureDefaultKeyStorage(node); const ks = W(node, "key_select"); const keyW = W(node, "key");
      if (def?.value) {
        ks.value = String(def.value); if (keyW) keyW.value = String(def.value);
        node.setDirtyCanvas(true, true);
        await updateTextPreview(node); updateImagePreview(node, true);
        await tryQueueRun();
      }
    });
    btn.serialize = false; node.__kvtools_btn_load = btn;
  }
}
function hideBuiltIns(node) {
  hideWidget(node, "value"); hideWidget(node, "key"); hideWidget(node, "keys_hint"); hideWidget(node, "default"); hideWidget(node, "default_key");
}

// -----------------------------------------------------
// Sync & hooks
// -----------------------------------------------------
async function syncKeyList(node) {
  const ks = ensureKeySelectCombo(node);
  const keyW = W(node, "key"); if (!ks || !keyW) return;

  const up = upstreamNode(node);
  let keys = [];
  if (up?.comfyClass === "KVLoadInline") {
    keys = keysFromInline(up);
  } else if (up?.comfyClass === "KVLoadFromRegistry") {
    await serverRefreshRegistry(); // mirrors manual "refresh keys" behavior
    await loadRegistry();
    keys = keysFromRegistryByFile(W(up, "file_name")?.value || "");
  }

  ks.options.values = Array.isArray(keys) ? keys : [];
  if (!ks.options.values.includes(ks.value)) ks.value = ks.options.values[0] ?? "";
  keyW.value = ks.value || keyW.value || "";
  node.setDirtyCanvas(true, true);
}

function hookUpstream(node) {
  const up = upstreamNode(node);
  if (!up || up.__kvtools_hooked) return;
  up.__kvtools_hooked = true;

  // Generic upstream hooks
  const onWidgetChangedOrig = up.onWidgetChanged;
  up.onWidgetChanged = async function (w, ...rest) {
    if (onWidgetChangedOrig) onWidgetChangedOrig.call(this, w, ...rest);
    if (w?.name === "data" || w?.name === "file_name" || w?.name === "path") {
      await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
      await updateTextPreview(node); updateImagePreview(node, true);
      await tryQueueRun();
    }
  };
  const onConnOrig = up.onConnectionsChange;
  up.onConnectionsChange = async function (...args) {
    if (onConnOrig) onConnOrig.apply(this, args);
    await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node, true);
    await tryQueueRun();
  };

  // NEW: direct widget callbacks for KVLoadFromRegistry (file_name / path)
  if (up.comfyClass === "KVLoadFromRegistry") {
    const fW = W(up, "file_name");
    if (fW && !fW.__kvtools_cb) {
      fW.__kvtools_cb = true;
      const orig = fW.callback;
      fW.callback = async (...args) => {
        if (orig) try { await orig(...args); } catch {}
        await serverRefreshRegistry(); // mirrors manual refresh button
        await loadRegistry();
        await syncKeyList(node);
        ensureAsTypeDefault(node);
        await updateTextPreview(node);
        updateImagePreview(node, true);
        await tryQueueRun();
      };
    }
    const pW = W(up, "path");
    if (pW && !pW.__kvtools_cb) {
      pW.__kvtools_cb = true;
      const orig = pW.callback;
      pW.callback = async (...args) => {
        if (orig) try { await orig(...args); } catch {}
        await serverRefreshRegistry();
        await loadRegistry();
        await syncKeyList(node);
        ensureAsTypeDefault(node);
        await updateTextPreview(node);
        updateImagePreview(node, true);
        await tryQueueRun();
      };
    }
  }

  // KVLoadInline: hook its "data" widget directly too (already handled above, but ensure direct callback)
  if (up.comfyClass === "KVLoadInline") {
    const dW = W(up, "data");
    if (dW && !dW.__kvtools_cb) {
      dW.__kvtools_cb = true;
      const orig = dW.callback;
      dW.callback = async (...args) => {
        if (orig) try { await orig(...args); } catch {}
        await syncKeyList(node);
        await updateTextPreview(node);
        updateImagePreview(node, true);
        await tryQueueRun();
      };
    }
  }
}

// -----------------------------------------------------
// Attach to KVGet
// -----------------------------------------------------
function isKVGet(node) { return node?.comfyClass === "KVGet"; }
function ensureTopOrder(node) {
  moveWidgetToTop(node, "_kvtools_preview_value");
  moveWidgetToTop(node, "_kvtools_img_preview");
  moveWidgetToTop(node, "key_select");
}
function attachToKVGet(node) {
  if (!isKVGet(node) || node.__kvtools_attached) return;
  node.__kvtools_attached = true;

  hideBuiltIns(node);
  ensureAsTypeDefault(node);

  // Build widgets
  ensurePreviewWidget(node);
  ensureImagePreviewWidget(node);
  const ks = ensureKeySelectCombo(node);
  ensureRefreshButton(node);
  ensureRandomButton(node);
  ensureDefaultKeyStorage(node);
  ensureDefaultButtons(node);
  ensureTopOrder(node);

  // key_select callback → keep "key" in sync, update previews, autorun
  if (!ks.__kvtools_cb) {
    ks.__kvtools_cb = true;
    ks.callback = async () => {
      const keyW = W(node, "key");
      if (keyW) keyW.value = String(ks.value || "");
      node.setDirtyCanvas(true, true);
      await updateTextPreview(node);
      updateImagePreview(node, true);
      await tryQueueRun();
    };
  }

  // allow changing the internal "key" to reflect in combo too (e.g., after load)
  const keyW = W(node, "key");
  if (keyW && !keyW.__kvtools_cb) {
    keyW.__kvtools_cb = true;
    const orig = keyW.callback;
    keyW.callback = async () => {
      if (orig) orig();
      if (ks && ks.options?.values?.includes(keyW.value)) ks.value = keyW.value;
      node.setDirtyCanvas(true, true);
      await updateTextPreview(node);
      updateImagePreview(node, true);
      await tryQueueRun();
    };
  }

  // react to connections / upstream changes
  const onConnOrig = node.onConnectionsChange?.bind(node);
  node.onConnectionsChange = async (...args) => {
    if (onConnOrig) onConnOrig(...args);
    hookUpstream(node);
    await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node, true);
    await tryQueueRun();
  };

  // initial: wait until store is connected → one sync + autorun kick
  const wait = setInterval(async () => {
    const up = upstreamNode(node);
    if (up) {
      clearInterval(wait);
      hookUpstream(node);
      await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
      await updateTextPreview(node); updateImagePreview(node, true);
      await tryQueueRun(150);
    }
  }, 150);
}

// -----------------------------------------------------
// Extension registration
// -----------------------------------------------------
app.registerExtension({
  name: EXT_NAME,
  setup() {
    const ready = setInterval(() => {
      if (app.graph && Array.isArray(app.graph._nodes)) {
        clearInterval(ready);
        for (const n of app.graph._nodes) attachToKVGet(n);
        const addOrig = app.graph.add;
        app.graph.add = function (node) {
          const res = addOrig.call(this, node);
          attachToKVGet(node);
          return res;
        };
      }
    }, 200);
  },
  loadedGraphNode(node) { try { attachToKVGet(node); } catch (e) { console.warn(e); } },
  nodeCreated(node)     { try { attachToKVGet(node); } catch (e) { console.warn(e); } },
});
