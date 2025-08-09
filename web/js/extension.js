// ComfyUI-KVTools — Frontend
// Version: x-0
// - Dropdown (key_select) + Text-Preview + Bild-Preview
// - Buttons: refresh / random / default set & load
// - Inline edit for KVLoadInline (pause outputs while editing)
// - Autorun + Queue-Prompt-Fallback
// - Random autorun: when random=true, do NOT default to the first key; pick randomly earlier
// - Registry-Helpers (peek/image)

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXT_NAME = "ComfyUI-KVTools.UI";
const KVTOOLS_AUTORUN = true;

// --- Preview target height & layout ---
const KV_PREVIEW_HEIGHT = 140;     // desired preview height
const KV_PREVIEW_GAP = 6;          // when hidden: small gap
const KV_UNIT_FALLBACK = 20;       // expected default per-widget height (your build: 20)
const KV_DEBUG_LAYOUT = false;     // set true for layout logs

let kvtoolsIsProcessing = false;
api.addEventListener("status", (e) => { kvtoolsIsProcessing = !!e?.detail?.processing; });

const kvRunLock = { busy: false, last: 0, cooldownMs: 500 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dlog(...a){ if(KV_DEBUG_LAYOUT) try{ console.debug("[KVTools][layout]",...a);}catch{} }

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------
function W(node, name) { return (node?.widgets || []).find((w) => w.name === name) || null; }
function hideWidget(node, name) { const w = W(node, name); if (!w) return; w.hidden = true; w.draw = () => {}; w.computeSize = () => [0,-4]; }
function moveWidgetToTop(node, widgetOrName) {
  const w = typeof widgetOrName === "string" ? W(node, widgetOrName) : widgetOrName;
  if (!node?.widgets || !w) return;
  const i = node.widgets.indexOf(w);
  if (i > 0) { node.widgets.splice(i,1); node.widgets.unshift(w); }
}
function ensureAsTypeDefault(node) {
  const w = W(node, "as_type");
  if (w && !["string","int","float","bool"].includes(String(w.value))) w.value = "string";
}
function upstreamNode(node) {
  const inp = (node.inputs || []).find((i) => i.name === "store");
  const link = inp?.link != null ? app.graph.links?.[inp.link] : null;
  const nodeId = link?.origin_id; return nodeId != null ? app.graph.getNodeById(nodeId) : null;
}
function upstreamFileName(node) {
  const up = upstreamNode(node);
  if (!up || up.comfyClass !== "KVLoadFromRegistry") return null;
  return W(up, "file_name")?.value || null;
}

// -----------------------------------------------------
// Registry + Store Parsing
// -----------------------------------------------------
let REGISTRY = null;
async function loadRegistry() {
  const candidates = [
    "/extensions/ComfyUI-KVTools/kv_registry.json",
    "/extensions/ComfyUI-KVTools/web/kv_registry.json",
  ];
  for (const url of candidates) {
    try { const r = await fetch(url + "?t=" + Date.now()); if (r.ok) { REGISTRY = await r.json(); return; } } catch {}
  }
  REGISTRY = null;
}
async function serverRefreshRegistry(){ try{ await fetch("/kvtools/refresh_registry",{method:"POST"});}catch{} }
async function serverPeek(fileName, key) {
  if (!fileName || !key) return "";
  try {
    const r = await fetch("/kvtools/peek", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ file_name:fileName, key }) });
    if (!r.ok) return "";
    const j = await r.json();
    return j?.ok ? String(j.value ?? "") : "";
  } catch { return ""; }
}
function parseStoreObject(s){ try{ return JSON.parse(String(s||"")); }catch{ return {}; } }
function parseEnvFile(s){
  const out={}; if(!s) return out;
  for (const raw of String(s).split(/\r?\n/)) {
    const line = raw.trim(); if(!line || line.startsWith("#")) continue;
    const m = line.match(/^\s*([^=:#]+)\s*[:=]\s*(.*)\s*$/);
    if (m) out[String(m[1]).trim()] = String(m[2]).trim();
  }
  return out;
}
function keysFromInline(up) {
  const w = W(up,"data"); if(!w) return [];
  const text = String(w.value||"");
  const obj = text.trim().startsWith("{") ? parseStoreObject(text) : parseEnvFile(text);
  return Object.keys(obj).sort();
}
function keysFromRegistryByFile(fileName) {
  if (!REGISTRY || !fileName) return [];
  const files = REGISTRY?.files || {};
  const entry = files[fileName];
  if (entry && Array.isArray(entry.keys)) return entry.keys.slice();
  return [];
}

// -----------------------------------------------------
// Text preview (without Run)
// -----------------------------------------------------
function ensurePreviewWidget(node) {
  let pv = W(node, "_kvtools_preview_value");
  if (!pv) { pv = node.addWidget("text","_kvtools_preview_value","",null); pv.serialize=false; }
  return pv;
}
async function updateTextPreview(node) {
  const pv = ensurePreviewWidget(node);
  const up = upstreamNode(node);
  pv.value = "";
  if (!up) { node.setDirtyCanvas(true,true); return; }

  const key = String(W(node,"key_select")?.value || W(node,"key")?.value || "").trim();
  if (!key) { node.setDirtyCanvas(true,true); return; }

  if (up.comfyClass === "KVLoadInline") {
    if (up.__kv_edit === true) { pv.value=""; node.setDirtyCanvas(true,true); return; }
    const dataW = W(up,"data"); const text = String(dataW?.value||"");
    const obj = text.trim().startsWith("{") ? parseStoreObject(text) : parseEnvFile(text);
    let v = obj[key]; if (v && typeof v==="object"){ try{ v=JSON.stringify(v);}catch{} }
    pv.value = v != null ? String(v) : ""; node.setDirtyCanvas(true,true); return;
  }
  if (up.comfyClass === "KVLoadFromRegistry") {
    await serverRefreshRegistry().catch(()=>{}); await loadRegistry().catch(()=>{});
    const fileName = upstreamFileName(node); pv.value = await serverPeek(fileName,key); node.setDirtyCanvas(true,true); return;
  }
  node.setDirtyCanvas(true,true);
}

// -----------------------------------------------------
// Image preview: primary spacer draws image; extra spacers reserve height
// -----------------------------------------------------

// Primary spacer (draws the image and defines rect/height)
function ensureImagePreviewPrimary(node){
  let w = W(node, "_kvtools_img_sp0");
  if (w) return w;

  const addCW = (spec)=>{
    if (typeof node.addCustomWidget === "function") return node.addCustomWidget(spec);
    const fw = node.addWidget("string", spec.name, "", null);
    Object.assign(fw, spec, { type:"custom", value:"" });
    return fw;
  };

  w = addCW({
    name: "_kvtools_img_sp0",
    serialize: false,
    __unit: KV_UNIT_FALLBACK,
    __visible: true,   // only 'large' when there is actually an image

    // We return the height; the framework passes 'width' into draw()
    computeSize(width) {
      if (!this.__visible) return [width || 0, KV_PREVIEW_GAP]; // If no image is present → keep a single-line gap
      return [width || 0, this.__unit];
    },

    // Draw inside the widget area (with left/right padding)
    draw(ctx, nodeRef, widgetWidth, y, height) {
      const nodeW = (nodeRef.size && nodeRef.size[0]) || 320;
      const wIn = Math.max(0, (widgetWidth ?? nodeW) - 20);
      const x = 10;

      // read actual unit height (most builds ~20)
      this.__unit = height || KV_UNIT_FALLBACK;

      // total reserved height = unit * (1 + extra spacers)
      const extraCount = Array.isArray(nodeRef.__kv_img_spacers) ? nodeRef.__kv_img_spacers.length : 0;
      const totalH = this.__visible ? (this.__unit * (1 + extraCount)) : KV_PREVIEW_GAP;

      nodeRef.__kv_img_rect = { x, y, w: wIn, h: totalH };

      // background & border
      ctx.save();
      ctx.fillStyle = "#111";
      ctx.fillRect(x, y, wIn, totalH);
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + 0.5, y + 0.5, wIn - 1, totalH - 1);

      // draw image if available
      if (this.__visible && nodeRef.__kv_img && nodeRef.__kv_img_visible) {
        const img = nodeRef.__kv_img;
        const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
        const arI = iw / ih, arB = wIn / totalH;
        let dw, dh, dx, dy;
        if (arI > arB) {                   // wider than the area → fit to width
          dw = wIn - 10; dh = dw / arI; dx = x + 5; dy = y + (totalH - dh) / 2;
        } else {                           // taller than area → fit to height
          dh = totalH - 10; dw = dh * arI; dx = x + (wIn - dw) / 2; dy = y + 5;
        }
        ctx.drawImage(img, dx, dy, dw, dh);
      }

      ctx.restore();
    },
  });

  return w;
}

// Create/adjust spacer stack to reach ~KV_PREVIEW_HEIGHT
function ensureSpacerStack(node, visible=true) {
  const sp0 = ensureImagePreviewPrimary(node);

  // if unit not known yet, use fallback
  const unit = sp0.__unit || KV_UNIT_FALLBACK;

  // target height
  const target = visible ? KV_PREVIEW_HEIGHT : KV_PREVIEW_GAP;

  // number of extra spacers (primary already contributes one unit)
  const needExtras = visible ? Math.max(0, Math.ceil(target / unit) - 1) : 0;

  // current extras
  const current = Array.isArray(node.__kv_img_spacers) ? node.__kv_img_spacers : (node.__kv_img_spacers = []);

  // remove surplus
  while (current.length > needExtras) {
    const w = current.pop();
    const idx = node.widgets.indexOf(w);
    if (idx >= 0) node.widgets.splice(idx, 1);
  }

  // add missing extras
  const addCW = (spec)=>{
    if (typeof node.addCustomWidget === "function") return node.addCustomWidget(spec);
    const fw = node.addWidget("string", spec.name, "", null);
    Object.assign(fw, spec, { type:"custom", value:"" });
    return fw;
  };
  while (current.length < needExtras) {
    const idx = current.length + 1;
    const w = addCW({
      name: `_kvtools_img_sp${idx}`,
      serialize: false,
      draw(ctx, nodeRef, widgetWidth, y, height) { /* placeholder only */ },
    });
    current.push(w);
  }

  // visibility of the primary spacer controls reserved area & image drawing
  sp0.__visible = !!visible;

  // keep stack together and on top: extras first (reverse), primary last
  for (let i = current.length - 1; i >= 0; i--) moveWidgetToTop(node, current[i].name);
  moveWidgetToTop(node, sp0.name);
}

// enforce re-layout (+ optional logging)
function kvRelayout(node, reason="") {
  try {
    node.widgets_dirty = true;
    if (typeof node.computeSize === "function") {
      const s = node.computeSize();
      if (Array.isArray(s) && s.length >= 2) {
        if (typeof node.setSize === "function") node.setSize(s);
        else node.size = s;
      }
    }
    node.setDirtyCanvas(true,true);
    if (KV_DEBUG_LAYOUT) {
      const sizes = (node.widgets||[]).map((w,i)=>{
        let h=0; try{ h= (typeof w.computeSize==="function") ? (w.computeSize(node.size?.[0])||[0,0])[1] : (w.height||0);}catch{}
        return {i,name:w.name,type:w.type,height:h};
      });
      dlog(reason||"relayout",{node:node.id,nodeSize:node.size,sizes});
    }
  } catch(e){ console.warn("[KVTools] relayout error",e); }
}

// URL build unchanged
function buildImageURL(node, key, ext) {
  const file = upstreamFileName(node); if (!file || !key) return "";
  const u = new URL(location.origin + "/kvtools/image");
  u.searchParams.set("file", file);
  u.searchParams.set("key", key);
  if (ext) u.searchParams.set("ext", ext);
  u.searchParams.set("t", Date.now());
  return u.toString();
}

// Main update: stack + image load
function updateImagePreview(node, force=false) {
  const up = upstreamNode(node);

  // no preview while inline edit is active
  if (up?.comfyClass === "KVLoadInline" && up.__kv_edit === true) {
    ensureSpacerStack(node, false);
    node.__kv_img = null; node.__kv_img_visible = false;
    kvRelayout(node,"inline-edit");
    return;
  }

  const key = String(W(node,"key_select")?.value || W(node,"key")?.value || "").trim();
  const visible = !!key;

  ensureSpacerStack(node, visible);
  kvRelayout(node, visible ? "preview-visible" : "preview-hidden");

  if (!visible) { node.__kv_img = null; node.__kv_img_visible = false; return; }

  const ip  = (app.graph?._nodes || []).find((n)=>n.comfyClass==="KVImagePathFromRegistry");
  const ext = String(ip?.widgets?.find((w)=>w.name==="ext")?.value || "png");
  const url = buildImageURL(node, key, ext);
  if (!url) { node.__kv_img = null; node.__kv_img_visible = false; return; }
  if (!force && url === node.__kv_img_url && node.__kv_img && node.__kv_img_visible) return;

  const img = new Image();
  img.crossOrigin = "anonymous"; try{ img.decoding="async"; }catch{}
  img.onload = ()=>{ node.__kv_img = img; node.__kv_img_url = url; node.__kv_img_visible = true; kvRelayout(node,"img-onload"); };
  img.onerror = ()=>{ node.__kv_img = null; node.__kv_img_url = url; node.__kv_img_visible = false; kvRelayout(node,"img-onerror"); try{ console.warn("[KVTools] inline image failed:",url);}catch{} };
  img.src = url;
}

// -----------------------------------------------------
// Random (UI) + autorun orchestration
// -----------------------------------------------------
function hasRandomEnabled(node) {
  const rw = W(node,"random");
  if (rw && (rw.value===true || String(rw.value).toLowerCase()==="true")) return true;
  const inp = (node.inputs||[]).find((i)=>i.name==="random");
  if (inp?.link != null) return true;
  return false;
}
function collectKeys(node){
  const up = upstreamNode(node); if(!up) return [];
  if (up.comfyClass === "KVLoadInline") return keysFromInline(up);
  if (up.comfyClass === "KVLoadFromRegistry") {
    const fn = W(up,"file_name")?.value || null; if(!fn) return [];
    return keysFromRegistryByFile(fn).sort();
  }
  return [];
}
function pickNewKey(keys,current){ if(!keys?.length) return ""; if(keys.length===1) return keys[0]; let i=Math.floor(Math.random()*keys.length); if(keys[i]===current) i=(i+1)%keys.length; return keys[i]; }

async function applyRandomIfEnabled(node, force=false){
  if(!hasRandomEnabled(node)) return false;
  const ks = W(node,"key_select"); const keyW = W(node,"key"); if(!ks||!keyW) return false;
  const keys = ks.options?.values?.length ? ks.options.values : collectKeys(node); if(!keys?.length) return false;

  const now = Date.now();
  if(!force && node.__kv_last_rand && (now - node.__kv_last_rand) < 120) return false;
  node.__kv_last_rand = now;

  const pick = pickNewKey(keys, ks.value);
  ks.value = pick; keyW.value = pick;
  node.setDirtyCanvas(true,true);
  await updateTextPreview(node); updateImagePreview(node, true);
  return true;
}

async function startRandomizeKVGet(node){
  try{
    if(!node || node.comfyClass!=="KVGet" || node.__kvtools_random_bootstrapped) return;
    node.__kvtools_random_bootstrapped = true;
    const ks = W(node,"key_select"); const keyW = W(node,"key"); if(!ks||!keyW) return;

    // wait until keys are available
    for(let i=0;i<12;i++){
      let keys = (ks.options && Array.isArray(ks.options.values)) ? ks.options.values : [];
      if(!keys||!keys.length){ try{ keys = collectKeys(node)||[]; }catch{} }
      if(keys && keys.length){
        const pick = keys[Math.floor(Math.random()*keys.length)];
        ks.options.values = keys.slice();
        ks.value = pick; keyW.value = pick;
        await updateTextPreview(node); updateImagePreview(node, true);
        node.setDirtyCanvas?.(true,true);
        break;
      }
      await sleep(120);
    }
  }catch(err){ console.warn("[KVTools] startRandomizeKVGet error:",err); }
}
async function startRandomizeAllKVGets(){ try{ const nodes=(app.graph?._nodes||[]).filter(n=>n.comfyClass==="KVGet"); for(const n of nodes) await startRandomizeKVGet(n);}catch(e){ console.warn("[KVTools] startRandomizeAllKVGets error:",e);} }

// -----------------------------------------------------
// Prompt/Queue
// -----------------------------------------------------
function sanitizeTextWidgets(){
  if(!app?.graph?._nodes) return;
  for(const n of app.graph._nodes){
    for(const w of (n.widgets||[])){
      if((w.type==="text"||w.type==="string") && w.value==null) w.value = "";
    }
  }
}
async function buildPromptFiltered(){
  try{
    sanitizeTextWidgets();
    let r=null;
    if(typeof app.graphToPrompt==="function") r=await app.graphToPrompt();
    else if(typeof app.getPrompt==="function") r=await app.getPrompt();
    const raw = r?.prompt ?? r ?? null;
    if(!raw || typeof raw!=="object") return {prompt:null, workflow:r?.workflow};

    const clean={};
    for(const [k,v] of Object.entries(raw)){
      if(typeof k==="string" && k.startsWith("#")) continue;
      if(!v || typeof v!=="object") continue;
      if(!("class_type" in v)) continue;
      clean[k]=v;
    }

    for(const n of (app.graph?._nodes||[])){
      if(n?.comfyClass!=="KVGet") continue;
      const item = clean?.[String(n.id)];
      if(!item || item.class_type!=="KVGet" || !item.inputs) continue;

      const uiPick = String(W(n,"key_select")?.value || W(n,"key")?.value || "");
      if(uiPick) item.inputs.key = uiPick;

      const wAT = W(n,"as_type");
      if(wAT && !["string","int","float","bool"].includes(String(wAT.value))) wAT.value = "string";
    }

    if(!Object.keys(clean).length) return {prompt:null, workflow:r?.workflow};
    return {prompt:clean, workflow:r?.workflow};
  }catch(e){ console.warn("[KVTools] buildPromptFiltered error:",e); return {prompt:null, workflow:null}; }
}
async function queueViaApi(prompt, workflow){
  try{
    const body = { prompt, client_id: app?.clientId || api?.clientId || "kvtools", extra_data:{ extra_pnginfo:{ workflow } } };
    const res = await api.fetchApi("/prompt",{ method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    return !!res?.ok;
  }catch{ return false; }
}
async function queueViaUI(){
  try{ if(typeof app.queuePrompt==="function"){ await app.queuePrompt(); return true; } }catch{}
  try{
    const btn = [...document.querySelectorAll("button")].find(b=>/queue\s*prompt/i.test(b?.textContent||"")||/queue/i.test(b?.title||""));
    if(btn){ btn.click(); return true; }
  }catch{}
  return false;
}
async function preRunRandomAll(){
  try{
    for(const n of (app.graph?._nodes||[])){
      if(n.comfyClass==="KVGet"){
        const changed = await applyRandomIfEnabled(n,true);
        if(changed){ await updateTextPreview(n); updateImagePreview(n,true); }
      }
    }
  }catch{}
}
async function tryQueueRun(delay=200){
  if(!KVTOOLS_AUTORUN || !app?.graph || kvtoolsIsProcessing) return;

  await preRunRandomAll(); // Random (if externally connected) before the run

  const now=Date.now();
  if(kvRunLock.busy || (now-kvRunLock.last)<kvRunLock.cooldownMs) return;
  kvRunLock.busy=true;

  setTimeout(async ()=>{
    try{
      let {prompt, workflow} = await buildPromptFiltered();
      if(prompt && await queueViaApi(prompt, workflow)) return;
      await sleep(200);
      ({prompt, workflow} = await buildPromptFiltered());
      if(prompt && await queueViaApi(prompt, workflow)) return;
      if(await queueViaUI()) return;
      if(typeof app.queueGraph==="function"){ await app.queueGraph(true); return; }
      console.warn("[KVTools] tryQueueRun: prompt=null (not ready yet)");
    }catch(e){
      console.error("[KVTools] autorun failed:",e);
    }finally{
      kvRunLock.last = Date.now();
      kvRunLock.busy = false;
    }
  }, delay);
}

// hook manual queue: random first
(function wrapQueuePrompt(){
  const orig = app.queuePrompt;
  if(!orig || app.__kvtools_wrapped_queue) return;
  app.__kvtools_wrapped_queue = true;
  app.queuePrompt = async function(...args){ await preRunRandomAll(); return await orig.apply(this,args); };
})();

// -----------------------------------------------------
// UI for KVGet + inline edit
// -----------------------------------------------------
function ensureKeySelectCombo(node){ let ks=W(node,"key_select"); if(!ks){ ks=node.addWidget("combo","key_select","",null,{values:[]}); ks.serialize=false; } return ks; }
function ensureRefreshButton(node){
  if(node.__kvtools_refresh_btn) return node.__kvtools_refresh_btn;
  const btn=node.addWidget("button","KVTools: refresh keys",null,async()=>{
    await serverRefreshRegistry(); await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node,true); await tryQueueRun();
  });
  btn.serialize=false; node.__kvtools_refresh_btn=btn; return btn;
}
function ensureRandomButton(node){
  if(node.__kvtools_random_btn) return node.__kvtools_random_btn;
  const btn=node.addWidget("button","Random key",null,async()=>{
    const ks=W(node,"key_select"); const keys=ks?.options?.values||[]; if(!keys.length) return;
    const pick=pickNewKey(keys, ks.value); ks.value=pick; const keyW=W(node,"key"); if(keyW) keyW.value=pick;
    node.setDirtyCanvas(true,true); await updateTextPreview(node); updateImagePreview(node,true); await tryQueueRun();
  });
  btn.serialize=false; node.__kvtools_random_btn=btn; return btn;
}
function ensureDefaultKeyStorage(node){ let w=W(node,"default_key"); if(!w){ w=node.addWidget("text","default_key","",null); w.serialize=true; w.hidden=true; } return w; }
function ensureDefaultButtons(node){
  if(!node.__kvtools_btn_set){
    const b=node.addWidget("button","Set default (current key)",null,async()=>{
      const ks=W(node,"key_select"); const def=ensureDefaultKeyStorage(node);
      def.value=String(ks?.value||""); node.setDirtyCanvas(true,true);
    });
    b.serialize=false; node.__kvtools_btn_set=b;
  }
  if(!node.__kvtools_btn_load){
    const b=node.addWidget("button","Load default",null,async()=>{
      const def=ensureDefaultKeyStorage(node); const ks=W(node,"key_select"); const keyW=W(node,"key");
      if(def?.value){ ks.value=String(def.value); if(keyW) keyW.value=String(def.value);
        node.setDirtyCanvas(true,true); await updateTextPreview(node); updateImagePreview(node,true); await tryQueueRun(); }
    });
    b.serialize=false; node.__kvtools_btn_load=b;
  }
}
function hideBuiltIns(node){
  hideWidget(node,"value");
  hideWidget(node,"key");
  hideWidget(node,"keys_hint");
  hideWidget(node,"default");
  hideWidget(node,"default_key");
  hideWidget(node,"random"); // random hidden in UI; port still works
}

async function syncKeyList(node){
  const ks=ensureKeySelectCombo(node); const keyW=W(node,"key"); if(!ks||!keyW) return;

  const up=upstreamNode(node);
  let keys=[];
  if(up?.comfyClass==="KVLoadInline"){
    keys = up.__kv_edit===true ? [] : keysFromInline(up);
  }else if(up?.comfyClass==="KVLoadFromRegistry"){
    await serverRefreshRegistry(); await loadRegistry();
    keys = keysFromRegistryByFile(W(up,"file_name")?.value || "");
  }
  ks.options.values = Array.isArray(keys) ? keys : [];

  // do not overwrite; only align if valid
  if(!ks.options.values.includes(ks.value)) ks.value = ks.options.values[0] ?? "";
  keyW.value = ks.value || keyW.value || "";

  node.setDirtyCanvas(true,true);
}

// Inline edit (KVLoadInline)
function setTextEditable(widget, editable){
  if(!widget) return;
  try{
    widget.readonly=!editable; widget.disabled=!editable;
    widget.options = widget.options || {}; widget.options.readOnly=!editable; widget.options.disabled=!editable;
    if(widget.inputEl){ widget.inputEl.readOnly=!editable; widget.inputEl.disabled=!editable; widget.inputEl.style.opacity=editable?1:0.85; }
  }catch{}
}
function applyInlineEditState(inlineNode, editing){
  inlineNode.__kv_edit = !!editing;
  const dataW=W(inlineNode,"data"); setTextEditable(dataW,!!editing);
  inlineNode.setDirtyCanvas?.(true,true);
}
function ensureInlineEditToggle(inlineNode){
  if(!inlineNode || inlineNode.__kvtools_edit_attached) return;
  inlineNode.__kvtools_edit_attached = true;

  let t=(inlineNode.widgets||[]).find(w=>w.name==="KVTools: Edit mode");
  if(!t){ t = inlineNode.addWidget("toggle","KVTools: Edit mode",false,null); t.serialize=true; }
  applyInlineEditState(inlineNode, !!t.value);

  const orig=t.callback;
  t.callback = async (...args)=>{
    if(orig){ try{ await orig(...args);}catch{} }
    const editing=!!t.value; applyInlineEditState(inlineNode,editing);

    try{
      for(const n of (app.graph?._nodes||[])){
        if(n.comfyClass!=="KVGet") continue;
        const inp=(n.inputs||[]).find(i=>i.name==="store");
        const link=inp?.link!=null ? app.graph.links?.[inp.link] : null;
        if(link?.origin_id===inlineNode.id){
          if(editing){
            const pv=ensurePreviewWidget(n); pv.value="";
            ensureSpacerStack(n,false);
            n.__kv_img=null; n.__kv_img_visible=false;
            n.setDirtyCanvas(true,true);
          }else{
            await syncKeyList(n); await updateTextPreview(n); updateImagePreview(n,true);
          }
        }
      }
    }catch{}
    if(!editing) await tryQueueRun(150);
  };

  const dataW=W(inlineNode,"data");
  if(dataW && !dataW.__kvtools_cb){
    dataW.__kvtools_cb=true;
    const origData=dataW.callback;
    dataW.callback = async (...args)=>{
      if(origData) try{ await origData(...args);}catch{}
      if(inlineNode.__kv_edit===true){
        for(const n of (app.graph?._nodes||[])){
          if(n.comfyClass!=="KVGet") continue;
          const inp=(n.inputs||[]).find(i=>i.name==="store");
          const link=inp?.link!=null ? app.graph.links?.[inp.link] : null;
          if(link?.origin_id===inlineNode.id){
            const pv=ensurePreviewWidget(n); pv.value="";
            ensureSpacerStack(n,false);
            n.__kv_img=null; n.__kv_img_visible=false;
            n.setDirtyCanvas(true,true);
          }
        }
        return;
      }
      await tryQueueRun(150);
    };
  }
}

// -----------------------------------------------------
// Hooks + registration
// -----------------------------------------------------
function isKVGet(node){ return node?.comfyClass==="KVGet"; }
function ensureTopOrder(node){
  // Order: key_select → _kvtools_preview_value → _kvtools_img_preview
  moveWidgetToTop(node, "_kvtools_img_preview");     // bring to top first …
  moveWidgetToTop(node, "_kvtools_preview_value");   // … then above it
  moveWidgetToTop(node, "key_select");               // … and the dropdown at the very top
}

function attachToKVGet(node){
  if(!isKVGet(node) || node.__kvtools_attached) return;
  node.__kvtools_attached = true;

  hideBuiltIns(node); ensureAsTypeDefault(node);

  ensurePreviewWidget(node);
  ensureSpacerStack(node, true); // ensure stack exists
  const ks=ensureKeySelectCombo(node);
  const keyW=W(node,"key");
  ensureRefreshButton(node); ensureRandomButton(node); ensureDefaultKeyStorage(node); ensureDefaultButtons(node);
  ensureTopOrder(node);

  if(!ks.__kvtools_cb){
    ks.__kvtools_cb=true;
    ks.callback = async ()=>{
      if(keyW) keyW.value = String(ks.value||"");
      node.setDirtyCanvas(true,true);
      await updateTextPreview(node); updateImagePreview(node,true);
      await tryQueueRun();
    };
  }
  if(keyW && !keyW.__kvtools_cb){
    keyW.__kvtools_cb=true;
    const orig=keyW.callback;
    keyW.callback = async ()=>{
      if(orig) orig();
      if(ks && ks.options?.values?.includes(keyW.value)) ks.value = keyW.value;
      node.setDirtyCanvas(true,true);
      await updateTextPreview(node); updateImagePreview(node,true);
      await tryQueueRun();
    };
  }

  const onConnOrig=node.onConnectionsChange?.bind(node);
  node.onConnectionsChange = async (...args)=>{
    if(onConnOrig) onConnOrig(...args);
    hookUpstream(node);
    await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node,true);
    await tryQueueRun();
  };

  // Initial attach → early random initialization & first run
  const wait=setInterval(async ()=>{
    const up=upstreamNode(node);
    if(up){
      clearInterval(wait);
      hookUpstream(node);
      if(up.comfyClass==="KVLoadInline") ensureInlineEditToggle(up);

      await loadRegistry();
      await syncKeyList(node); ensureAsTypeDefault(node);
      await updateTextPreview(node);
      updateImagePreview(node,true);

      // Kick early: first randomize all KVGet, then run
      setTimeout(()=>{ startRandomizeAllKVGets(); },40);
      setTimeout(()=>{ preRunRandomAll(); },80);
      setTimeout(()=>{ tryQueueRun(140); },140);
    }
  },150);
}

function hookUpstream(node){
  const up=upstreamNode(node);
  if(!up || up.__kvtools_hooked) return;
  up.__kvtools_hooked = true;

  if(up.comfyClass==="KVLoadInline") ensureInlineEditToggle(up);

  const onWidgetChangedOrig=up.onWidgetChanged;
  up.onWidgetChanged = async function (w,...rest){
    if(onWidgetChangedOrig) onWidgetChangedOrig.call(this,w,...rest);
    if(w?.name==="data" || w?.name==="file_name" || w?.name==="path"){
      await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
      await updateTextPreview(node); updateImagePreview(node,true);
      await tryQueueRun();
    }
  };
  const onConnOrig=up.onConnectionsChange;
  up.onConnectionsChange = async function (...args){
    if(onConnOrig) onConnOrig.apply(this,args);
    await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node,true);
    await tryQueueRun();
  };

  if(up.comfyClass==="KVLoadFromRegistry"){
    for(const n of ["file_name","path"]){
      const w=W(up,n);
      if(w && !w.__kvtools_cb){
        w.__kvtools_cb=true;
        const orig=w.callback;
        w.callback = async (...args)=>{
          if(orig) try{ await orig(...args);}catch{}
          await serverRefreshRegistry(); await loadRegistry(); await syncKeyList(node);
          ensureAsTypeDefault(node);
          await updateTextPreview(node); updateImagePreview(node,true);
          await tryQueueRun();
        };
      }
    }
  }
}

// registration
app.registerExtension({
  name: EXT_NAME,
  setup(){
    const ready=setInterval(()=>{
      if(app.graph && Array.isArray(app.graph._nodes)){
        clearInterval(ready);

        for(const n of app.graph._nodes) attachToKVGet(n);
        for(const n of app.graph._nodes) if(n.comfyClass==="KVLoadInline") ensureInlineEditToggle(n);

        // 1) First randomize ALL KVGet keys (fill dropdown + preview) – always, independent of the random flag
        setTimeout(()=>{ startRandomizeAllKVGets(); },40);
        // 2) Then as before your two async blocks: first random/sync, then autorun
        setTimeout(()=>{ try{ preRunRandomAll(); }catch{} },80);
        setTimeout(()=>{ try{ tryQueueRun(140); }catch{} },140);

        const addOrig=app.graph.add;
        app.graph.add=function(node){
          const res=addOrig.call(this,node);
          attachToKVGet(node);
          if(node.comfyClass==="KVLoadInline") ensureInlineEditToggle(node);
          return res;
        };
      }
    },200);
  },
  loadedGraphNode(node){ try{ attachToKVGet(node); if(node.comfyClass==="KVLoadInline") ensureInlineEditToggle(node);}catch(e){ console.warn(e);} },
  nodeCreated(node){ try{ attachToKVGet(node); if(node.comfyClass==="KVLoadInline") ensureInlineEditToggle(node);}catch(e){ console.warn(e);} },
});
