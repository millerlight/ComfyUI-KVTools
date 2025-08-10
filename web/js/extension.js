// Version: 1.0.0
// ComfyUI-KVTools — Frontend UI
// - No auto-run on UI changes
// - Real multi-line preview with scrollbar (custom widget "preview_value")
// - Global event routing in CAPTURE phase (pointer + wheel) to prevent canvas zoom over the preview
// - Inline image preview (spacer stack)
// - Random key via input/toggle (UI only) + random initialization
// - Inline edit mode for KVLoadInline (disables outputs while editing)
// - "as_type" is placed directly below the preview_value block

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXT_NAME = "ComfyUI-KVTools.UI";
const KVTOOLS_AUTORUN = false; // absolutely no auto-queue from UI events

// Inline image preview layout
const KV_PREVIEW_IMG_HEIGHT = 140;
const KV_IMG_UNIT = 20;
const KV_IMG_GAP = 6;

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function W(node, name) { return (node?.widgets || []).find((w) => w.name === name) || null; }
function hideWidget(node, name) { const w = W(node, name); if (!w) return; w.hidden = true; w.draw = () => {}; w.computeSize = () => [0,-4]; }

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
// Registry + store parsing
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
// Scrollable multi-line widget for preview_value (+ spacer stack)
// -----------------------------------------------------
function wrapLines(ctx, text, maxW) {
  const lines = [];
  const paras = String(text ?? "").split(/\r?\n/);
  for (const para of paras) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width <= maxW) line = t;
      else {
        if (line) lines.push(line);
        if (ctx.measureText(w).width > maxW) {
          let chunk = "";
          for (const ch of w) {
            const tmp = chunk + ch;
            if (ctx.measureText(tmp).width > maxW) {
              if (chunk) lines.push(chunk);
              chunk = ch;
            } else {
              chunk = tmp;
            }
          }
          if (chunk) lines.push(chunk);
          line = "";
        } else line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

function createScrollablePreviewWidget(node) {
  const addCW = (spec) => {
    if (typeof node.addCustomWidget === "function") return node.addCustomWidget(spec);
    const fw = node.addWidget("string", spec.name, "", null);
    Object.assign(fw, spec, { type: "custom" });
    return fw;
  };

  const pv = addCW({
    name: "preview_value",
    serialize: false,
    hidden: false,

    // layout/state
    __unit: 20,                            // base height per slot (aligned with image stack unit)
    __pad: 8,
    __lineH: 18,
    __font: "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    __visibleLines: 4,                     // visible lines (height provided by spacers)
    __scroll: 0,
    __contentH: 0,
    __rect: { x: 0, y: 0, w: 0, h: 0 },    // node-local rect
    __rect_canvas: null,                   // canvas-global rect (for hit-tests)
    __sb: null,                            // {x,y,w,h,trackX,trackY,trackH,trackW}
    __drag: false,
    __dragStartY: 0,
    __scrollStart: 0,
    value: "",

    computeSize(width) { return [width || 0, this.__unit]; }, // total height comes from spacers

    draw(ctx, nodeRef, widgetWidth, y, height) {
      const nodeW = (nodeRef.size && nodeRef.size[0]) || 320;
      const wIn   = Math.max(0, (widgetWidth ?? nodeW) - 20);
      const x     = 10;

      // total height = primary slot + N spacers
      const extraCount = Array.isArray(nodeRef.__kv_pv_spacers) ? nodeRef.__kv_pv_spacers.length : 0;
      const totalH = this.__unit * (1 + extraCount);

      // store rects (node-local + canvas-global)
      this.__rect = { x, y, w: wIn, h: totalH };
      const nx = (nodeRef.pos?.[0] || 0);
      const ny = (nodeRef.pos?.[1] || 0);
      this.__rect_canvas = { x: nx + x, y: ny + y, w: wIn, h: totalH };

      // box styling
      ctx.save();
      ctx.fillStyle = "#161616";
      ctx.fillRect(x, y, wIn, totalH);
      ctx.strokeStyle = "#2b2b2b";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, wIn - 1, totalH - 1);

      // inner viewport
      const left = x + this.__pad;
      const top  = y + this.__pad;
      const maxW = wIn - this.__pad * 2;
      const maxH = totalH - this.__pad * 2;

      ctx.font = this.__font;
      ctx.fillStyle = "#d7d7d7";
      ctx.textBaseline = "top";

      const lines = wrapLines(ctx, this.value ?? "", maxW);
      this.__contentH = Math.max(lines.length * this.__lineH, 0);

      // clamp scroll
      const maxScroll = Math.max(this.__contentH - maxH, 0);
      if (this.__scroll > maxScroll) this.__scroll = maxScroll;
      if (this.__scroll < 0) this.__scroll = 0;

      // clip + draw visible lines
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, maxW, maxH);
      ctx.clip();

      const firstLine = Math.floor(this.__scroll / this.__lineH);
      const offsetY   = -(this.__scroll % this.__lineH);

      for (let i = firstLine, yOff = offsetY; i < lines.length && (yOff < maxH); i++, yOff += this.__lineH) {
        ctx.fillText(lines[i], left, top + yOff);
      }
      ctx.restore();

      // scrollbar (store in CANVAS coordinates for hit-tests)
      if (this.__contentH > maxH) {
        const trackW = 10; // easier to grab
        const trackX = x + wIn - trackW - 4;
        const trackY = y + 2;
        const trackH = totalH - 4;

        ctx.fillStyle = "#202020";
        ctx.fillRect(trackX, trackY, trackW, trackH);

        const thumbH = Math.max((maxH / this.__contentH) * trackH, 20);
        const thumbY = trackY + (this.__scroll / Math.max(this.__contentH, 1)) * (trackH - thumbH);

        ctx.fillStyle = "#5a5a5a";
        ctx.fillRect(trackX, thumbY, trackW, thumbH);

        // store in CANVAS coords
        this.__sb = {
          x: nx + trackX, y: ny + thumbY, w: trackW, h: thumbH,
          trackX: nx + trackX, trackY: ny + trackY, trackH, trackW
        };
      } else {
        this.__sb = null;
      }

      ctx.restore();
    },

    // Interactions — pos is in CANVAS coordinates
    onMouseWheel(e, pos, nodeRef) {
      const r = this.__rect_canvas; if (!r) return false;
      const { x, y, w, h } = r; const [px, py] = pos;
      if (px < x || px > x + w || py < y || py > y + h) return false;

      const maxH  = h - this.__pad * 2;
      const step  = Math.max(this.__lineH, maxH * 0.15);
      const delta = e.deltaY || e.wheelDelta || 0;

      this.__scroll += (delta > 0 ? step : -step);

      const maxScroll = Math.max(this.__contentH - maxH, 0);
      if (this.__scroll > maxScroll) this.__scroll = maxScroll;
      if (this.__scroll < 0) this.__scroll = 0;

      nodeRef.setDirtyCanvas?.(true, true);
      return true; // handled -> router will block Comfy canvas zoom
    },

    onMouseDown(e, pos, nodeRef) {
      const sb = this.__sb;
      if (!sb) return false;
      const [px, py] = pos;

      // hit slop around thumb (6px left/right)
      const hx = sb.x - 6, hw = sb.w + 12;
      const thumbHit = (px >= hx && px <= hx + hw && py >= sb.y && py <= sb.y + sb.h);
      if (thumbHit) {
        this.__drag = true;
        this.__dragStartY = py;
        this.__scrollStart = this.__scroll;
        return true;
      }

      // clicking the track jumps thumb there and begins dragging
      const inTrack = (px >= sb.trackX - 6 && px <= sb.trackX + sb.trackW + 6 && py >= sb.trackY && py <= sb.trackY + sb.trackH);
      if (inTrack) {
        const maxH  = this.__rect_canvas.h - this.__pad * 2;
        const maxScroll = Math.max(this.__contentH - maxH, 0);
        const trackScrollable = Math.max(sb.trackH - sb.h, 1);
        const rel = Math.min(Math.max(py - sb.trackY - sb.h / 2, 0), trackScrollable);
        const ratio = rel / trackScrollable;

        this.__scroll = ratio * maxScroll;
        this.__drag = true;
        this.__dragStartY = py;
        this.__scrollStart = this.__scroll;

        nodeRef.setDirtyCanvas?.(true, true);
        return true;
      }

      return false;
    },

    onMouseMove(e, pos, nodeRef) {
      if (!this.__drag || !this.__rect_canvas || !this.__sb) return false;
      const maxH  = this.__rect_canvas.h - this.__pad * 2;
      const maxScroll = Math.max(this.__contentH - maxH, 0);
      if (maxScroll <= 0) return false;

      const trackScrollable = Math.max(this.__sb.trackH - this.__sb.h, 1);
      const dy = pos[1] - this.__dragStartY;
      const scrollDelta = (dy / trackScrollable) * maxScroll;

      this.__scroll = Math.min(Math.max(this.__scrollStart + scrollDelta, 0), maxScroll);
      nodeRef.setDirtyCanvas?.(true, true);
      return true;
    },

    onMouseUp() { this.__drag = false; return false; }
  });

  // place directly under key_select
  const ks = W(node, "key_select");
  if (ks) {
    const idxKS = node.widgets.indexOf(ks);
    const idxPV = node.widgets.indexOf(pv);
    const want  = Math.min(idxKS + 1, node.widgets.length);
    if (idxPV !== -1 && idxPV !== want) {
      node.widgets.splice(idxPV, 1);
      node.widgets.splice(want, 0, pv);
    }
  }

  pv.readonly = true;
  pv.disabled = true;
  pv.click = () => false;

  ensurePVSpacerStack(node, pv.__visibleLines);
  node.widgets_dirty = true;
  node.setDirtyCanvas?.(true, true);
  return pv;
}

function ensurePreviewWidgetPresent(node) {
  const idx = (node.widgets || []).findIndex(w => w.name === "preview_value");
  if (idx !== -1) node.widgets.splice(idx, 1);
  return createScrollablePreviewWidget(node);
}

function ensurePVSpacerStack(node, visibleLines = 4) {
  const pv = W(node, "preview_value");
  if (!pv) return;

  const target = pv.__pad * 2 + pv.__lineH * Math.max(1, visibleLines|0);
  const unit   = pv.__unit || 20;

  const needExtras = Math.max(0, Math.ceil(target / unit) - 1);
  const current = Array.isArray(node.__kv_pv_spacers) ? node.__kv_pv_spacers : (node.__kv_pv_spacers = []);

  while (current.length > needExtras) {
    const w = current.pop();
    const idx = node.widgets.indexOf(w);
    if (idx >= 0) node.widgets.splice(idx, 1);
  }

  const addCW = (spec)=>{
    if (typeof node.addCustomWidget === "function") return node.addCustomWidget(spec);
    const fw = node.addWidget("string", spec.name, "", null);
    Object.assign(fw, spec, { type:"custom", value:"" });
    return fw;
  };
  while (current.length < needExtras) {
    const idx = current.length + 1;
    const w = addCW({
      name: `_kvtools_pv_sp${idx}`,
      serialize: false,
      draw(ctx, nodeRef, widgetWidth, y, height) { /* spacer */ },
      computeSize(width){ return [width || 0, unit]; }
    });
    current.push(w);
  }

  // keep group (preview + spacers) directly after key_select
  const ks = W(node, "key_select");
  if (ks) {
    const idxKS = node.widgets.indexOf(ks);
    const wantPV  = Math.min(idxKS + 1, node.widgets.length);
    const idxPV = node.widgets.indexOf(pv);
    if (idxPV !== -1 && idxPV !== wantPV) {
      node.widgets.splice(idxPV, 1);
      node.widgets.splice(wantPV, 0, pv);
    }
    for (let i = 0; i < current.length; i++) {
      const w = current[i];
      const should = node.widgets.indexOf(pv) + 1 + i;
      const idxW = node.widgets.indexOf(w);
      if (idxW !== should) {
        if (idxW !== -1) node.widgets.splice(idxW, 1);
        node.widgets.splice(should, 0, w);
      }
    }
  }

  // ensure as_type is right below the preview block
  placeAsTypeBelowPreview(node);

  node.widgets_dirty = true;
  node.setDirtyCanvas?.(true, true);
}

// Place as_type directly under the preview_value block (after its spacers)
function placeAsTypeBelowPreview(node) {
  if (!node) return;
  const pv = W(node, "preview_value");
  const as = W(node, "as_type");
  if (!pv || !as) return;

  const widgets = node.widgets || [];
  const idxPV = widgets.indexOf(pv);
  if (idxPV < 0) return;

  // find the last spacer belonging to preview_value
  let lastIdx = idxPV;
  for (let i = idxPV + 1; i < widgets.length; i++) {
    const w = widgets[i];
    if (w && typeof w.name === "string" && /^_kvtools_pv_sp\d+$/.test(w.name)) {
      lastIdx = i;
    } else {
      break;
    }
  }

  // move as_type behind the preview block
  const idxAS = widgets.indexOf(as);
  if (idxAS < 0) return;
  const target = lastIdx + 1;

  if (idxAS !== target) {
    widgets.splice(idxAS, 1);
    const clamped = Math.min(target, widgets.length);
    widgets.splice(clamped, 0, as);
    node.widgets_dirty = true;
    node.setDirtyCanvas?.(true, true);
  }
}

// set text into preview (and cache)
async function updateTextPreview(node) {
  const up = upstreamNode(node);
  const pv = ensurePreviewWidgetPresent(node);
  ensurePVSpacerStack(node, 4);
  if (pv) { pv.hidden = false; pv.value = ""; }
  node.__kv_preview_text = "";

  if (!up) { node.setDirtyCanvas(true, true); return; }

  const key = String(
    (node?.widgets || []).find(w => w.name === "key_select")?.value ||
    (node?.widgets || []).find(w => w.name === "key")?.value ||
    ""
  ).trim();

  if (!key) { node.setDirtyCanvas(true, true); return; }

  if (up.comfyClass === "KVLoadInline") {
    if (up.__kv_edit === true) { if (pv) pv.value = ""; node.setDirtyCanvas(true, true); return; }
    const dataW = (up.widgets || []).find(w => w.name === "data");
    const raw   = String(dataW?.value || "");
    const obj   = raw.trim().startsWith("{") ? parseStoreObject(raw) : parseEnvFile(raw);
    let v       = obj[key];
    if (v && typeof v === "object") { try { v = JSON.stringify(v, null, 2); } catch {} }
    const s = v != null ? String(v) : "";
    node.__kv_preview_text = s;
    if (pv) pv.value = s;
    node.setDirtyCanvas(true, true);
    return;
  }

  if (up.comfyClass === "KVLoadFromRegistry") {
    await serverRefreshRegistry().catch(() => {});
    await loadRegistry().catch(() => {});
    const fileName = upstreamFileName(node);
    const s = await serverPeek(fileName, key);
    node.__kv_preview_text = s;
    if (pv) pv.value = s;
    node.setDirtyCanvas(true, true);
    return;
  }

  node.setDirtyCanvas(true, true);
}

// -----------------------------------------------------
// Canvas event routing (CAPTURE) for preview_value
// -----------------------------------------------------
function setupCanvasPreviewEventRouting() {
  const c = app?.canvas?.canvas;
  if (!c || window.__kvtools_events_bound) return;
  window.__kvtools_events_bound = true;

  // improve pointer behavior on touch/precision devices
  try { c.style.touchAction = "none"; } catch {}

  function ds() { return app?.canvas?.ds || null; }

  function screenToCanvas(e) {
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const d = ds();
    if (!d) return [sx, sy];
    return [ sx / d.scale - d.offset[0], sy / d.scale - d.offset[1] ];
  }

  function hitPreviewWidgetCanvasXY(px, py) {
    const nodes = (app.graph?._nodes || []);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.comfyClass !== "KVGet") continue;
      const pv = W(n, "preview_value");
      const r = pv && pv.__rect_canvas;
      if (!r) continue;
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return { node: n, pv };
      }
    }
    return null;
  }

  function stopAll(e) { try{ e.preventDefault(); }catch{} try{ e.stopImmediatePropagation(); }catch{} try{ e.stopPropagation(); }catch{} }

  // Pointer events have priority in ComfyUI; we intercept in CAPTURE phase
  let activeDrag = null; // { node, pv }

  window.addEventListener("pointerdown", (e) => {
    if (!app?.canvas?.canvas) return;
    const [px, py] = screenToCanvas(e);
    const hit = hitPreviewWidgetCanvasXY(px, py);
    if (hit?.pv?.onMouseDown) {
      const handled = hit.pv.onMouseDown(e, [px, py], hit.node);
      if (handled) {
        activeDrag = hit;
        stopAll(e); // prevent node selection/drag & canvas zoom
        try { c.setPointerCapture?.(e.pointerId); } catch {}
      }
    }
  }, { passive: false, capture: true });

  window.addEventListener("pointermove", (e) => {
    if (!app?.canvas?.canvas) return;
    const [px, py] = screenToCanvas(e);

    // keep focus on preview while dragging
    const target = activeDrag || hitPreviewWidgetCanvasXY(px, py);
    if (target?.pv?.onMouseMove) {
      const handled = target.pv.onMouseMove(e, [px, py], target.node);
      if (handled) stopAll(e);
    }
  }, { passive: false, capture: true });

  window.addEventListener("pointerup", (e) => {
    if (!app?.canvas?.canvas) return;
    const [px, py] = screenToCanvas(e);

    let consumed = false;
    for (const n of (app.graph?._nodes || [])) {
      if (n.comfyClass !== "KVGet") continue;
      const pv = W(n, "preview_value");
      if (pv?.__drag && pv.onMouseUp) {
        pv.onMouseUp(e, [px, py], n);
        consumed = true;
      }
    }
    if (consumed) {
      stopAll(e);
      try { c.releasePointerCapture?.(e.pointerId); } catch {}
    }
    activeDrag = null;
  }, { passive: false, capture: true });

  // wheel -> scroll inside preview, not canvas zoom
  window.addEventListener("wheel", (e) => {
    if (!app?.canvas?.canvas) return;
    const [px, py] = screenToCanvas(e);
    const hit = hitPreviewWidgetCanvasXY(px, py);
    if (hit?.pv?.onMouseWheel) {
      const handled = hit.pv.onMouseWheel(e, [px, py], hit.node);
      if (handled) stopAll(e);
    }
  }, { passive: false, capture: true });
}

// -----------------------------------------------------
// Inline image preview (custom + spacer stack)
// -----------------------------------------------------
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
    __unit: KV_IMG_UNIT,
    __visible: true,

    computeSize(width) {
      if (!this.__visible) return [width || 0, KV_IMG_GAP];
      return [width || 0, this.__unit];
    },

    draw(ctx, nodeRef, widgetWidth, y, height) {
      const nodeW = (nodeRef.size && nodeRef.size[0]) || 320;
      const wIn = Math.max(0, (widgetWidth ?? nodeW) - 20);
      const x = 10;

      this.__unit = height || KV_IMG_UNIT;

      const extraCount = Array.isArray(nodeRef.__kv_img_spacers) ? nodeRef.__kv_img_spacers.length : 0;
      const totalH = this.__visible ? (this.__unit * (1 + extraCount)) : KV_IMG_GAP;

      ctx.save();
      ctx.fillStyle = "#111";
      ctx.fillRect(x, y, wIn, totalH);
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + 0.5, y + 0.5, wIn - 1, totalH - 1);

      if (this.__visible && nodeRef.__kv_img && nodeRef.__kv_img_visible) {
        const img = nodeRef.__kv_img;
        const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
        const arI = iw / ih, arB = wIn / totalH;
        let dw, dh, dx, dy;
        if (arI > arB) { dw = wIn - 10; dh = dw / arI; dx = x + 5; dy = y + (totalH - dh) / 2; }
        else { dh = totalH - 10; dw = dh * arI; dx = x + (wIn - dw) / 2; dy = y + 5; }
        ctx.drawImage(img, dx, dy, dw, dh);
      }

      ctx.restore();
    },
  });

  return w;
}

function ensureSpacerStack(node, visible=true) {
  const sp0 = ensureImagePreviewPrimary(node);

  const unit = sp0.__unit || KV_IMG_UNIT;
  const target = visible ? KV_PREVIEW_IMG_HEIGHT : KV_IMG_GAP;
  const needExtras = visible ? Math.max(0, Math.ceil(target / unit) - 1) : 0;

  const current = Array.isArray(node.__kv_img_spacers) ? node.__kv_img_spacers : (node.__kv_img_spacers = []);

  while (current.length > needExtras) {
    const w = current.pop();
    const idx = node.widgets.indexOf(w);
    if (idx >= 0) node.widgets.splice(idx, 1);
  }

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
      draw(ctx, nodeRef, widgetWidth, y, height) { /* spacer */ },
    });
    current.push(w);
  }

  sp0.__visible = !!visible;

  // keep image spacers at the very end (visually below others)
  const imgNames = new Set((node.widgets || []).map(w => w.name).filter(n => /^_kvtools_img_sp\d*$/.test(n)));
  if (imgNames.size) {
    const imgs = [];
    node.widgets = node.widgets.filter(w => { if (imgNames.has(w.name)) { imgs.push(w); return false; } return true; });
    for (const s of imgs) node.widgets.push(s);
  }

  node.widgets_dirty = true;
  node.setDirtyCanvas?.(true, true);
}

function buildImageURL(node, key, ext) {
  const file = upstreamFileName(node); if (!file || !key) return "";
  const u = new URL(location.origin + "/kvtools/image");
  u.searchParams.set("file", file);
  u.searchParams.set("key", key);
  if (ext) u.searchParams.set("ext", ext);
  u.searchParams.set("t", Date.now());
  return u.toString();
}

function updateImagePreview(node, force=false) {
  const up = upstreamNode(node);

  if (up?.comfyClass === "KVLoadInline" && up.__kv_edit === true) {
    ensureSpacerStack(node, false);
    node.__kv_img = null; node.__kv_img_visible = false;
    node.setDirtyCanvas(true,true);
    return;
  }

  const key = String(W(node,"key_select")?.value || W(node,"key")?.value || "").trim();
  const visible = !!key;

  ensureSpacerStack(node, visible);
  node.setDirtyCanvas(true,true);

  if (!visible) { node.__kv_img = null; node.__kv_img_visible = false; return; }

  const ip  = (app.graph?._nodes || []).find((n)=>n.comfyClass==="KVImagePathFromRegistry");
  const ext = String(ip?.widgets?.find((w)=>w.name==="ext")?.value || "png");
  const url = buildImageURL(node, key, ext);
  if (!url) { node.__kv_img = null; node.__kv_img_visible = false; return; }
  if (!force && url === node.__kv_img_url && node.__kv_img && node.__kv_img_visible) return;

  const img = new Image();
  img.crossOrigin = "anonymous"; try{ img.decoding="async"; }catch{}
  img.onload = ()=>{ node.__kv_img = img; node.__kv_img_url = url; node.__kv_img_visible = true; node.setDirtyCanvas(true,true); };
  img.onerror = ()=>{ node.__kv_img = null; node.__kv_img_url = url; node.__kv_img_visible = false; node.setDirtyCanvas(true,true); try{ console.warn("[KVTools] inline image failed:",url);}catch{} };
  img.src = url;
}

// -----------------------------------------------------
// Random helpers (UI only; run remains manual)
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

async function applyRandomIfEnabled(node){
  if(!hasRandomEnabled(node)) return false;
  const ks = W(node,"key_select"); const keyW = W(node,"key"); if(!ks||!keyW) return false;
  const keys = ks.options?.values?.length ? ks.options.values : collectKeys(node); if(!keys?.length) return false;

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
// Pre-run safety (only on manual run)
// -----------------------------------------------------
function sanitizeTextWidgetsGlobal(){
  if(!app?.graph?._nodes) return;
  for(const n of app.graph._nodes){
    for(const w of (n.widgets || [])){
      const t = String(w.type || w.widget_type || "").toLowerCase();
      const name = String(w.name || "");
      const isTextish = (t === "text" || t === "string" || /prompt|text|negative|string|json|key|default|preview_value/i.test(name));
      if (isTextish && (w.value == null)) w.value = "";
    }
    if (n.comfyClass === "KVGet") ensureAsTypeDefault(n);
  }
}
function syncKVGetInputsFromUI(node){
  if(!node || node.comfyClass !== "KVGet") return;
  const ks = W(node, "key_select");
  const kW = W(node, "key");
  const keys = (ks && ks.options && Array.isArray(ks.options.values)) ? ks.options.values : [];
  let chosen = String(ks?.value ?? kW?.value ?? "").trim();
  if(!chosen && keys.length) chosen = String(keys[0]);
  if (kW) kW.value = chosen || "";
  if (ks && chosen && ks.value !== chosen) ks.value = chosen;
  node.setDirtyCanvas?.(true, true);
}
async function preRunSafetyAndSync(){
  sanitizeTextWidgetsGlobal();
  for (const n of (app.graph?._nodes || [])) {
    if (n.comfyClass === "KVGet") {
      try {
        const changed = await applyRandomIfEnabled(n);
        syncKVGetInputsFromUI(n);
        if (changed) { await updateTextPreview(n); updateImagePreview(n, true); }
      } catch {}
    }
  }
}
(function wrapQueueBoth(){
  const origQP = app.queuePrompt;
  if(origQP && !app.__kvtools_wrapped_queuePrompt){
    app.__kvtools_wrapped_queuePrompt = true;
    app.queuePrompt = async function(...args){
      try{ await preRunSafetyAndSync(); }catch(e){ console.warn("[KVTools] preRun (queuePrompt) failed:", e); }
      return await origQP.apply(this, args);
    };
  }
  const origQG = app.queueGraph;
  if(origQG && !app.__kvtools_wrapped_queueGraph){
    app.__kvtools_wrapped_queueGraph = true;
    app.queueGraph = async function(...args){
      try{ await preRunSafetyAndSync(); }catch(e){ console.warn("[KVTools] preRun (queueGraph) failed:", e); }
      return await origQG.apply(this, args);
    };
  }
})();

// -----------------------------------------------------
// UI wiring for KVGet + inline edit
// -----------------------------------------------------
function ensureKeySelectCombo(node){ let ks=W(node,"key_select"); if(!ks){ ks=node.addWidget("combo","key_select","",null,{values:[]}); ks.serialize=false; } return ks; }
function ensureRefreshButton(node){
  if(node.__kvtools_refresh_btn) return node.__kvtools_refresh_btn;
  const btn=node.addWidget("button","KVTools: refresh keys",null,async()=>{
    await serverRefreshRegistry(); await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node,true);
  });
  btn.serialize=false; node.__kvtools_refresh_btn=btn; return btn;
}
function ensureRandomButton(node){
  if(node.__kvtools_random_btn) return node.__kvtools_random_btn;
  const btn=node.addWidget("button","Random key",null,async()=>{
    const ks=W(node,"key_select"); const keys=ks?.options?.values||[]; if(!keys.length) return;
    const pick=pickNewKey(keys, ks.value); ks.value=pick; const keyW=W(node,"key"); if(keyW) keyW.value=pick;
    node.setDirtyCanvas(true,true); await updateTextPreview(node); updateImagePreview(node,true);
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
        node.setDirtyCanvas(true,true); await updateTextPreview(node); updateImagePreview(node,true); }
    });
    b.serialize=false; node.__kvtools_btn_load=b;
  }
}
function hideBuiltIns(node){
  hideWidget(node,"value");     // backend output
  hideWidget(node,"key");       // mirrored from key_select
  hideWidget(node,"keys_hint");
  hideWidget(node,"default");
  hideWidget(node,"default_key");
  hideWidget(node,"random");    // random via input port
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

  if(!ks.options.values.includes(ks.value)) ks.value = ks.options.values[0] ?? "";
  keyW.value = ks.value || keyW.value || "";

  node.setDirtyCanvas(true,true);
}

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
            n.__kv_preview_text = "";
            ensurePreviewWidgetPresent(n);
            ensurePVSpacerStack(n, 4);
            ensureSpacerStack(n,false);
            n.__kv_img=null; n.__kv_img_visible=false;
            n.setDirtyCanvas(true,true);
          }else{
            await syncKeyList(n); await updateTextPreview(n); updateImagePreview(n,true);
          }
        }
      }
    }catch{}
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
            n.__kv_preview_text = "";
            ensurePreviewWidgetPresent(n);
            ensurePVSpacerStack(n, 4);
            ensureSpacerStack(n,false);
            n.__kv_img=null; n.__kv_img_visible=false;
            n.setDirtyCanvas(true,true);
          }
        }
        return;
      }
      // not editing: previews will be refreshed by upstream hooks when applicable
    };
  }
}

function attachToKVGet(node){
  if(!node || node.comfyClass!=="KVGet" || node.__kvtools_attached) return;
  node.__kvtools_attached = true;

  hideBuiltIns(node); ensureAsTypeDefault(node);

  ensurePreviewWidgetPresent(node);
  ensurePVSpacerStack(node, 4);
  ensureSpacerStack(node, true);

  const ks=ensureKeySelectCombo(node);
  const keyW=W(node,"key");
  ensureRefreshButton(node); ensureRandomButton(node); ensureDefaultKeyStorage(node); ensureDefaultButtons(node);

  if(!ks.__kvtools_cb){
    ks.__kvtools_cb=true;
    ks.callback = async ()=>{
      if(keyW) keyW.value = String(ks.value||"");
      node.setDirtyCanvas(true,true);
      await updateTextPreview(node); updateImagePreview(node,true);
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
    };
  }

  const onConnOrig=node.onConnectionsChange?.bind(node);
  node.onConnectionsChange = async (...args)=>{
    if(onConnOrig) onConnOrig(...args);
    hookUpstream(node);
    await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node,true);
  };

  // initial attach after upstream is present
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

      // randomize selection at UI start
      setTimeout(()=>{ startRandomizeAllKVGets(); },40);
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
    }
  };
  const onConnOrig=up.onConnectionsChange;
  up.onConnectionsChange = async function (...args){
    if(onConnOrig) onConnOrig.apply(this,args);
    await loadRegistry(); await syncKeyList(node); ensureAsTypeDefault(node);
    await updateTextPreview(node); updateImagePreview(node,true);
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
        };
      }
    }
  }
}

// -----------------------------------------------------
// Register extension
// -----------------------------------------------------
app.registerExtension({
  name: EXT_NAME,
  setup(){
    const ready=setInterval(()=>{
      if(app.graph && Array.isArray(app.graph._nodes) && app.canvas?.canvas){
        clearInterval(ready);

        setupCanvasPreviewEventRouting(); // capture router for preview_value

        for(const n of app.graph._nodes) attachToKVGet(n);
        for(const n of app.graph._nodes) if(n.comfyClass==="KVLoadInline") ensureInlineEditToggle(n);

        setTimeout(()=>{ startRandomizeAllKVGets(); },40);

        const addOrig=app.graph.add;
        app.graph.add=function(node){
          const res=addOrig.call(this,node);
          attachToKVGet(node);
          if(node.comfyClass==="KVLoadInline") ensureInlineEditToggle(node);
          setupCanvasPreviewEventRouting(); // in case canvas was rebound
          return res;
        };
      }
    },200);
  },
  loadedGraphNode(node){ try{ attachToKVGet(node); if(node.comfyClass==="KVLoadInline") ensureInlineEditToggle(node);}catch(e){ console.warn(e);} },
  nodeCreated(node){ try{ attachToKVGet(node); if(node.comfyClass==="KVLoadInline") ensureInlineEditToggle(node);}catch(e){ console.warn(e);} },
});
