// KVTools: KVGet-Dropdown (autoload, ES module)
// Files served at /extensions/ComfyUI-KVTools/*

import { app } from "/scripts/app.js";

const EXT = "KVTools.KVGetDropdown.autoload";
let REG = null;

async function loadRegistry() {
  if (REG) return REG;
  try {
    const r = await fetch("/extensions/ComfyUI-KVTools/kv_registry.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    REG = await r.json();
    console.log("[KVTools] registry OK");
  } catch (e) {
    console.warn("[KVTools] registry load failed:", e);
    REG = { base_dir: "", files: {} };
  }
  return REG;
}

function W(node, name){ return (node.widgets || []).find(w => w.name === name); }
function setVal(node, w, val){
  if (!w) return;
  const v = String(val ?? "").trim();
  w.value = v;
  const i = (node.widgets || []).indexOf(w);
  if (i >= 0 && Array.isArray(node.widgets_values)) node.widgets_values[i] = v;
}
function parseKV(text){
  const out = [];
  if(!text) return out;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^\s*([^=:#]+)\s*[:=]\s*(.*)\s*$/);
    if (m) out.push(m[1].trim());
  }
  return Array.from(new Set(out));
}
function parseMaybeJSON(text){
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o)) return Object.keys(o);
  } catch {}
  return null;
}
function keysFromInline(up){
  const dataW = W(up,"data");
  if (!dataW) return [];
  const data = dataW.value ?? "";
  const fmtW  = W(up,"format") || W(up,"file_format");
  const fmt   = String(fmtW?.value ?? "auto").toLowerCase();
  if (fmt === "json" || fmt === "auto") {
    const k = parseMaybeJSON(data);
    if (k?.length) return k.sort();
  }
  return parseKV(data).sort();
}
function upstreamFileName(node){
  const inp = (node.inputs||[]).find(i => i && i.name === "store");
  if (!inp || inp.link == null || !node.graph) return null;
  const link = node.graph.links[inp.link];
  if (!link) return null;
  const up = node.graph.getNodeById(link.origin_id);
  if (!up) return null;

  const fw = W(up,"file_name");
  if (fw) {
    const v = String(fw.value || "").trim();
    if (v) return v;
  }
  const pw = W(up,"path");
  if (pw) {
    const p = String(pw.value || "").trim();
    if (p) { try { return p.split(/[\\/]/).pop(); } catch {} }
  }
  return null;
}
function keysFromRegistryByFile(fileName){
  if (!fileName) return [];
  const files = REG?.files || {};
  const entry = files[fileName];
  return Array.isArray(entry?.keys) ? entry.keys.slice() : [];
}

function collectKeys(node){
  const f = upstreamFileName(node);
  if (f) {
    const kk = keysFromRegistryByFile(f);
    if (kk.length) return kk;
  }
  const inp = (node.inputs||[]).find(i => i && i.name === "store");
  if (inp && inp.link != null && node.graph) {
    const link = node.graph.links[inp.link];
    if (link) {
      const up = node.graph.getNodeById(link.origin_id);
      if (up) {
        const kk = keysFromInline(up);
        if (kk.length) return kk;
      }
    }
  }
  return ["(no keys)"];
}

function hideWidget(w){
  if (!w) return;
  w.hidden = true;
  w.widget_options = { hidden: true };
  w.computeSize = () => [0,0];
}

function ensureAsTypeDefault(node){
  const w = (node.widgets||[]).find(w => w.name === "as_type");
  if (w && !["string","int","float","bool"].includes(String(w.value))) {
    const i = node.widgets.indexOf(w);
    w.value = "string";
    if (i >= 0 && Array.isArray(node.widgets_values)) node.widgets_values[i] = "string";
  }
}

function buildCombo(node, keyW){
  if (node.__kvtools_combo) {
    const idx = node.widgets.indexOf(node.__kvtools_combo);
    if (idx >= 0) node.widgets.splice(idx, 1);
    node.__kvtools_combo = null;
  }

  const keys = collectKeys(node);
  const initial = keys.includes(String(keyW.value)) ? String(keyW.value) : keys[0];

  const combo = node.addWidget(
    "combo",
    "key_select",
    initial,
    (val) => {
      if (val && val !== "(no keys)") setVal(node, keyW, val);
      node.setDirtyCanvas(true,true);
    },
    { values: keys.slice() }
  );
  combo.serialize = false;
  combo.options = combo.options || {};
  combo.options.values = keys.slice();

  const wi = node.widgets.indexOf(combo);
  if (wi > 0) {
    node.widgets.splice(wi, 1);
    node.widgets.unshift(combo);
  }

  if (initial && initial !== "(no keys)") setVal(node, keyW, initial);

  hideWidget(keyW);
  hideWidget(W(node,"keys_hint"));

  node.widgets_changed = true;
  if (node.onResize) try { node.onResize(node.size); } catch {}
  node.setDirtyCanvas(true,true);
  node.__kvtools_combo = combo;

  console.log("[KVTools] combo built on node", node.id, "keys:", keys);
}

function isCandidateNode(node){
  const hasStoreInput = !!(node.inputs||[]).find(i => i && i.name === "store");
  const hasKeyWidget  = !!W(node, "key");
  return hasStoreInput && hasKeyWidget;
}

function attachNode(node){
  if (!node || node.__kvtools_dropdown_attached) return;
  if (!isCandidateNode(node)) return;

  loadRegistry().then(() => {
    const keyW = W(node,"key");
    if (!keyW) { console.warn("[KVTools] node has no 'key' widget", node.id); return; }

    buildCombo(node, keyW);
    ensureAsTypeDefault(node);

    const btn = node.addWidget("button","KVTools: refresh keys",null,()=>{
      buildCombo(node,keyW);
      ensureAsTypeDefault(node);
    });
    btn.serialize = false;

    const orig = node.onConnectionsChange?.bind(node);
    node.onConnectionsChange = function(type, index, connected, link_info){
      buildCombo(node, keyW);
      ensureAsTypeDefault(node);
      if (orig) orig(type, index, connected, link_info);
    };

    const t = setInterval(()=>{
      if (!node.graph || !node.widgets) { clearInterval(t); return; }
      buildCombo(node, keyW);
      ensureAsTypeDefault(node);
    }, 1200);

    node.__kvtools_dropdown_attached = true;
    console.log("[KVTools] attached to node", node.id, "title:", node.title, "class:", node.comfyClass);
  });
}

function attachAll(){
  if (!app.graph?._nodes?.length) return;
  for (const n of app.graph._nodes) attachNode(n);
  app.graph.on("nodeAdded", (n)=>attachNode(n));
}

app.registerExtension({
  name: EXT,
  setup(){
    console.log("[KVTools] extension registered, waiting for graph…");
    const wait = setInterval(()=>{
      if (app.graph) { clearInterval(wait); setTimeout(attachAll,200); }
    },200);
  }
});
