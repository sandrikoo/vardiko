const $ = (id) => document.getElementById(id);
const APP_VERSION = '2.0.6';
console.log('[Vardiko] version', APP_VERSION);

// ─── Status / messaging ─────────────────────────────────────────────────
const topMsg = $('topMsg');
function msg(text, type) {
  console.log('[Vardiko]', text);
  topMsg.textContent = text;
  topMsg.className = 'top-msg' + (type === 'err' ? ' err' : (type === 'ok' ? ' ok' : ''));
}

window.addEventListener('load', () => {
  const versionEl = $('appVersion');
  if (versionEl) versionEl.textContent = 'v' + APP_VERSION;
  setTimeout(() => {
    if (typeof agPsd !== 'undefined' && agPsd.readPsd) msg('Ready', 'ok');
    else msg('PSD support unavailable', 'err');
  }, 300);
});

// ─── Core state ─────────────────────────────────────────────────────────
const canvas = $('mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const stage = $('stage');
const stageInner = $('stageInner');
const emptyState = $('emptyState');
const handlesOverlay = $('handlesOverlay');

const state = {
  isDrawing: false,
  dragLayerIndex: -1,
  dragOffsetX: 0,
  dragOffsetY: 0,
  move: { rafId: null, pendingPoint: null },
  pointerMetrics: null,
  renderRafId: null,
  didChange: false,
  hasContent: false,
  history: [],
  historyIndex: -1,
  maxHistory: 20,
  adjust: { brightness: 100, contrast: 100, saturation: 100, blur: 0 },
  transform: { dir: null, startPointer: null, startBounds: null, sourceCanvas: null, constrain: true },
  gesture: { active: false, rafId: null, pending: null, startMid: null, startDistance: 1, startBounds: null, sourceCanvas: null },
  // Editing-transaction state — when the user starts moving or resizing a layer
  // we capture a snapshot here and show floating Done/Cancel buttons. Until
  // the user presses one of those, no other layer can be selected and no
  // history is pushed.
  edit: {
    active: false,
    layerIndex: -1,
    snapshot: null   // { canvas (HTMLCanvasElement clone), left, top } captured at edit start
  }
};

const layers = { list: [], tree: [], selected: -1, docW: 0, docH: 0 };

// Custom font registry — fonts the user uploaded, applied to text layers
const customFonts = {};  // { 'My Brand Font': FontFace }
let activeCustomFont = 'BPG Paata Caps'; // brand font baked into HTML

const BLEND_MAP = {
  'normal': 'source-over', 'multiply': 'multiply', 'screen': 'screen',
  'overlay': 'overlay', 'darken': 'darken', 'lighten': 'lighten',
  'color dodge': 'color-dodge', 'color burn': 'color-burn',
  'hard light': 'hard-light', 'soft light': 'soft-light',
  'difference': 'difference', 'exclusion': 'exclusion',
  'hue': 'hue', 'saturation': 'saturation',
  'color': 'color', 'luminosity': 'luminosity'
};

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
// clamp, isProtectedLayerName, normalizeOpacity, escapeHtml → core.js

// ─── Group tree helpers ─────────────────────────────────────────────────
// Tree node shape:
//   layer node: { kind: 'layer', layerIndex }   (points into layers.list)
//   group node: { kind: 'group', name, expanded, visible, opacity, locked, children: [...] }
//
// We keep layers.list as a FLAT array of leaves so the existing rendering,
// hit-testing, and history code keep working unchanged. The tree is purely
// for the layers panel UI and "is this group visible?" computations.

// findLeafContext, collectDisplayedLeaves, findPathToLayer → core.js
// (walkTreeLeaves was unused and removed.)

// Compute effective visibility / opacity for a leaf, factoring in ancestor groups.
function effectiveVis(layerIndex) {
  const L = layers.list[layerIndex];
  if (!L) return { visible: false, opacity: 0 };
  let visible = !!L.visible, opacity = L.opacity;
  // Find ancestor groups
  const path = findPathToLayer(layers.tree, layerIndex);
  if (path) {
    for (const node of path) {
      if (node.kind === 'group') {
        if (!node.visible) visible = false;
        opacity *= (node.opacity ?? 1);
      }
    }
  }
  return { visible, opacity };
}

// Move a layer up (+1) or down (-1) within its current group in the tree.
// Direction is in "stacking" terms: +1 = higher stack (above in display).
function moveLayerInTree(layerIndex, direction) {
  const ctx = findLeafContext(layers.tree, layerIndex);
  if (!ctx) return;
  const { parentArray, indexInParent } = ctx;
  const newIdx = indexInParent + direction;
  if (newIdx < 0 || newIdx >= parentArray.length) {
    msg(direction > 0 ? 'Already at the top' : 'Already at the bottom');
    return;
  }
  // Skip over a group sibling (don't dive into it from up/down buttons)
  [parentArray[indexInParent], parentArray[newIdx]] = [parentArray[newIdx], parentArray[indexInParent]];
  renderAll(); updateLayersUI(); pushHistory();
}

// Rebuild a flat tree (no groups) from layers.list — used when there's no PSD-derived tree.
function buildFlatTree() {
  layers.tree = layers.list.map((_, i) => ({ kind: 'layer', layerIndex: i }));
}

// Insert a leaf at the top of the tree (root level)
function insertLeafAtTop(layerIndex) {
  layers.tree.unshift({ kind: 'layer', layerIndex });
  reindexAfterInsertion(layerIndex);
}

// After splicing layers.list at position i, all leaf.layerIndex >= i must be incremented.
function reindexAfterInsertion(insertedAt) {
  const fix = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'layer' && n.layerIndex >= insertedAt) n.layerIndex++;
      else if (n.kind === 'group') fix(n.children);
    }
  };
  fix(layers.tree);
  // Then mark our just-inserted leaf as exact (it was incremented but shouldn't be)
  // Actually, the simpler invariant: caller passes the already-correct index.
  // We just bump everyone whose index >= insertedAt + 1 in cases where we
  // inserted *before* an existing leaf. But we always push to end, so this
  // is rarely needed. Keep this function for completeness.
}

// ─── Text layer helpers ─────────────────────────────────────────────────
// A "text layer" is a regular layer with a `text` object attached:
//   layer.text = { value, fontFamily, fontSize, color, bold, italic, align, lineHeight }
// The `canvas` is the rasterised version, regenerated whenever text changes.

function rasterizeText(textData, maxWidth) {
  const {
    value, fontFamily, fontSize, color,
    bold, italic, align, lineHeight
  } = textData;
  const text = value || ' ';
  const lines = text.split('\n');
  const style = (italic ? 'italic ' : '') + (bold ? 'bold ' : '');
  const fontStr = `${style}${fontSize}px "${fontFamily}", sans-serif`;
  // Measure
  const measure = makeCanvas(2, 2).getContext('2d');
  measure.font = fontStr;
  let maxLineW = 0;
  for (const line of lines) {
    const m = measure.measureText(line || ' ');
    if (m.width > maxLineW) maxLineW = m.width;
  }
  const lh = fontSize * (lineHeight || 1.2);
  const w = Math.max(2, Math.ceil(maxLineW) + Math.ceil(fontSize * 0.4));
  const h = Math.max(2, Math.ceil(lh * lines.length) + Math.ceil(fontSize * 0.4));
  const out = makeCanvas(w, h);
  const c = out.getContext('2d');
  c.font = fontStr;
  c.fillStyle = color || '#000000';
  c.textBaseline = 'top';
  c.textAlign = align || 'left';
  const padX = Math.ceil(fontSize * 0.2);
  const padY = Math.ceil(fontSize * 0.2);
  let x = padX;
  if (align === 'center') x = w / 2;
  else if (align === 'right') x = w - padX;
  for (let i = 0; i < lines.length; i++) {
    c.fillText(lines[i], x, padY + i * lh);
  }
  return out;
}

// Re-rasterise a text layer (in-place updates layer.canvas).
// Keeps the layer's CENTER point fixed so that changing font size doesn't
// shift the text — the new bitmap grows or shrinks around its center.
function refreshTextLayer(layer) {
  if (!layer.text) return;
  // Remember the center point of the existing layer
  const oldW = layer.canvas.width, oldH = layer.canvas.height;
  const oldCenterX = (layer.left || 0) + oldW / 2;
  const oldCenterY = (layer.top || 0) + oldH / 2;

  // Re-rasterise
  const fresh = rasterizeText(layer.text);
  layer.canvas = fresh;

  // Re-anchor so the new canvas is centered on the same point
  layer.left = Math.round(oldCenterX - fresh.width / 2);
  layer.top  = Math.round(oldCenterY - fresh.height / 2);
}

// ─── Custom font upload ─────────────────────────────────────────────────
async function loadCustomFontFile(file) {
  try {
    const buf = await file.arrayBuffer();
    // Derive a clean font family name from the filename
    const baseName = (file.name || 'Custom Font').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const family = baseName.trim() || 'Custom Font';
    const fontFace = new FontFace(family, buf);
    await fontFace.load();
    document.fonts.add(fontFace);
    customFonts[family] = fontFace;
    activeCustomFont = family;
    msg('Font loaded: ' + family, 'ok');
    // Re-rasterise only text layers that were already referencing THIS family
    // by name — before the upload they fell back to sans-serif, now they can
    // render with the real glyphs. Layers using built-in fonts are left alone.
    for (const L of layers.list) {
      if (L.text && L.text.fontFamily === family) {
        refreshTextLayer(L);
      }
    }
    renderAll(); updateLayersUI();
  } catch (err) {
    console.error(err); msg('Font load failed: ' + err.message, 'err');
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────
function scheduleRender() {
  if (state.renderRafId) return;
  state.renderRafId = requestAnimationFrame(() => {
    state.renderRafId = null;
    renderAll();
  });
}

function flushRender() {
  if (!state.renderRafId) return;
  cancelAnimationFrame(state.renderRafId);
  state.renderRafId = null;
  renderAll();
}

function renderAll() {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  // Walk the tree in tree order (root[0] paints first → root[last] paints on top).
  // Groups don't paint themselves; they just contribute visibility/opacity to their children.
  function paint(nodes, parentVisible, parentOpacity) {
    for (const n of nodes) {
      if (n.kind === 'group') {
        const gv = parentVisible && n.visible;
        const go = parentOpacity * (n.opacity ?? 1);
        paint(n.children, gv, go);
      } else if (n.kind === 'layer') {
        const L = layers.list[n.layerIndex];
        if (!L) continue;
        const visible = parentVisible && L.visible;
        if (!visible) continue;
        const opacity = parentOpacity * L.opacity;
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = BLEND_MAP[L.blendMode] || 'source-over';
        // If a live resize preview is active for this layer, draw the source
        // bitmap at the preview size/position — much faster than resampling
        // the bitmap itself every frame.
        if (L._preview) {
          ctx.drawImage(L._preview.source, L._preview.left, L._preview.top, L._preview.width, L._preview.height);
        } else {
          ctx.drawImage(L.canvas, L.left || 0, L.top || 0);
        }
        ctx.restore();
      }
    }
  }
  // If we somehow have layers but no tree, fall back to flat list order
  if (layers.tree && layers.tree.length) {
    paint(layers.tree, true, 1);
  } else {
    for (let i = 0; i < layers.list.length; i++) {
      const L = layers.list[i];
      if (!L.visible) continue;
      ctx.save();
      ctx.globalAlpha = L.opacity;
      ctx.globalCompositeOperation = BLEND_MAP[L.blendMode] || 'source-over';
      if (L._preview) {
        ctx.drawImage(L._preview.source, L._preview.left, L._preview.top, L._preview.width, L._preview.height);
      } else {
        ctx.drawImage(L.canvas, L.left || 0, L.top || 0);
      }
      ctx.restore();
    }
  }
  ctx.restore();

  updateHandles();
}

// Fit canvas inside the stage area
function fitStage() {
  if (!state.hasContent) return;
  const stageW = window.innerWidth;
  const stageH = window.innerHeight - 70 - 70; // top + bottom dock approx
  const s = Math.min(stageW / layers.docW, stageH / layers.docH, 1);
  canvas.style.width = (layers.docW * s) + 'px';
  canvas.style.height = (layers.docH * s) + 'px';
  updateHandles();
}
window.addEventListener('resize', fitStage);

// ─── Layer helpers ──────────────────────────────────────────────────────
function getLayerBounds(L) {
  // During a live resize, prefer the preview bounds — these reflect what
  // the user is currently seeing on screen, not the (still un-resampled) bitmap.
  if (L && L._preview) {
    return {
      left: L._preview.left,
      top:  L._preview.top,
      right: L._preview.left + L._preview.width,
      bottom: L._preview.top + L._preview.height,
    };
  }
  return { left: L.left||0, top: L.top||0, right: (L.left||0)+L.canvas.width, bottom: (L.top||0)+L.canvas.height };
}
function isPointInLayer(L, x, y, layerIdx) {
  if (!L) return false;
  // If we know the layer's index, factor in group visibility
  if (typeof layerIdx === 'number') {
    const eff = effectiveVis(layerIdx);
    if (!eff.visible) return false;
  } else if (!L.visible) return false;
  const b = getLayerBounds(L);
  if (x < b.left || x > b.right || y < b.top || y > b.bottom) return false;
  const lx = Math.floor(x - b.left), ly = Math.floor(y - b.top);
  if (lx < 0 || ly < 0 || lx >= L.canvas.width || ly >= L.canvas.height) return false;
  const a = L.canvas.getContext('2d', { willReadFrequently: true }).getImageData(lx, ly, 1, 1).data[3];
  return a > 10;
}
// Hit test for the move tool — prioritises SMALL layers over big ones.
//
// In a PSD with a big frame/background layer (e.g. "Layer 10") covering most
// of the canvas plus small text/logo layers floating on top, paint-order
// hit-testing picks the frame because its pixels are opaque under the tap.
// What the user actually means is the small element they can see clearly,
// not the giant background covering it.
//
// Strategy: find every layer whose bounding box contains the tap, then pick
// the one with the smallest bounding box. Within that, prefer layers with
// actual visible pixels at/near the tap (so we don't grab an oversized text
// canvas with mostly empty space if there's a smaller real glyph beside it).
function getTopLayerByBounds(x, y) {
  const leaves = [];
  function gather(nodes, vis) {
    for (const n of nodes) {
      if (n.kind === 'group') gather(n.children, vis && n.visible);
      else if (n.kind === 'layer') leaves.push({ idx: n.layerIndex, visible: vis });
    }
  }
  if (layers.tree && layers.tree.length) gather(layers.tree, true);
  else for (let i = 0; i < layers.list.length; i++) leaves.push({ idx: i, visible: true });

  // Document area — anything covering 70%+ of the doc is a "frame" layer
  // and should NEVER win against smaller candidates that also contain the tap.
  const docArea = Math.max(1, layers.docW * layers.docH);

  // First gather candidates whose bounds contain the tap
  const candidates = [];
  for (const { idx, visible } of leaves) {
    if (!visible) continue;
    const L = layers.list[idx];
    if (!L || L.locked) continue;
    const b = getLayerBounds(L);
    if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue;
    const area = L.canvas.width * L.canvas.height;
    candidates.push({ idx, L, area, isFrame: area > docArea * 0.7 });
  }
  if (candidates.length === 0) return -1;

  // Filter out frame layers as long as a non-frame candidate exists
  const nonFrames = candidates.filter(c => !c.isFrame);
  const pool = nonFrames.length > 0 ? nonFrames : candidates;

  // Within the pool, prefer the candidate with actual opaque pixels at the tap
  const FAT_FINGER = 8;
  const opaqueHits = pool.filter(c => isAlphaNearby(c.L, x, y, FAT_FINGER));
  const finalPool = opaqueHits.length > 0 ? opaqueHits : pool;

  // Smallest bounding box wins (most specific layer)
  finalPool.sort((a, b) => a.area - b.area);
  return finalPool[0].idx;
}

// Check whether any pixel within `radius` of (x,y) in canvas coords is opaque
// in the given layer. We sample a few points around the click for speed.
function isAlphaNearby(L, x, y, radius) {
  if (!L) return false;
  const b = getLayerBounds(L);
  if (x < b.left - radius || x > b.right + radius || y < b.top - radius || y > b.bottom + radius) return false;
  const lctx = L.canvas.getContext('2d', { willReadFrequently: true });
  const offsets = [[0,0],[radius,0],[-radius,0],[0,radius],[0,-radius],
                   [radius,radius],[-radius,radius],[radius,-radius],[-radius,-radius]];
  for (const [dx, dy] of offsets) {
    const lx = Math.floor(x - b.left + dx);
    const ly = Math.floor(y - b.top + dy);
    if (lx < 0 || ly < 0 || lx >= L.canvas.width || ly >= L.canvas.height) continue;
    const a = lctx.getImageData(lx, ly, 1, 1).data[3];
    if (a > 10) return true;
  }
  return false;
}

function getTopLayerAtPoint(x, y) {
  // Walk the tree in REVERSE paint order (last-painted = topmost).
  // Collect leaves in paint order, then iterate from end.
  const leaves = [];
  function gather(nodes, vis, op) {
    for (const n of nodes) {
      if (n.kind === 'group') {
        gather(n.children, vis && n.visible, op * (n.opacity ?? 1));
      } else if (n.kind === 'layer') {
        leaves.push({ idx: n.layerIndex, visible: vis });
      }
    }
  }
  if (layers.tree && layers.tree.length) {
    gather(layers.tree, true, 1);
  } else {
    for (let i = 0; i < layers.list.length; i++) leaves.push({ idx: i, visible: true });
  }

  // First pass — strict alpha hit-test on every layer (top-down).
  for (let i = leaves.length - 1; i >= 0; i--) {
    const { idx, visible } = leaves[i];
    if (!visible) continue;
    if (isPointInLayer(layers.list[idx], x, y, idx)) return idx;
  }

  // Second pass — bounding-box hit-test for TEXT layers only, top-down.
  // Text glyphs have lots of transparent space; this lets the user tap near
  // a number/letter and grab the text layer instead of falling through to
  // background layers.
  for (let i = leaves.length - 1; i >= 0; i--) {
    const { idx, visible } = leaves[i];
    if (!visible) continue;
    const L = layers.list[idx];
    if (!L || !L.text) continue;
    const b = getLayerBounds(L);
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return idx;
  }

  return -1;
}
function canEdit(L) { return Boolean(L) && !L.locked; }
function findNearestUnlocked(i) {
  if (i < 0 || i >= layers.list.length) return -1;
  if (!layers.list[i]?.locked) return i;
  for (let k = i - 1; k >= 0; k--) if (!layers.list[k]?.locked) return k;
  for (let k = i + 1; k < layers.list.length; k++) if (!layers.list[k]?.locked) return k;
  return -1;
}
function selectLayer(i, opt = {}) {
  if (i < 0 || i >= layers.list.length) { layers.selected = -1; updateLayersUI(); renderAll(); return -1; }
  const r = findNearestUnlocked(i);
  if (r === -1) { layers.selected = -1; updateLayersUI(); renderAll(); if (!opt.quiet) msg('No editable layers', 'err'); return -1; }
  layers.selected = r;
  updateLayersUI(); renderAll();
  return r;
}

// ─── Transform handles ──────────────────────────────────────────────────
// ─── Editing transaction (Done/Cancel for layer move & resize) ──────────
const editActionsEl = $('editActions');

// Begin an edit — snapshot the current layer state so cancel can restore it.
// Idempotent: if already editing the same layer, do nothing.
function beginEdit(layerIndex) {
  if (state.edit.active && state.edit.layerIndex === layerIndex) return;
  if (state.edit.active && state.edit.layerIndex !== layerIndex) {
    // Auto-commit the previous edit before starting a new one
    commitEdit({ silent: true });
  }
  const L = layers.list[layerIndex];
  if (!L) return;
  // Deep copy the canvas so cancel can perfectly restore the bitmap
  const snap = makeCanvas(L.canvas.width, L.canvas.height);
  snap.getContext('2d').drawImage(L.canvas, 0, 0);
  state.edit.active = true;
  state.edit.layerIndex = layerIndex;
  state.edit.snapshot = { canvas: snap, left: L.left || 0, top: L.top || 0 };
  updateEditActionsPosition();
  editActionsEl.classList.add('visible');
}

// Commit the current edit — push history, clear snapshot, hide buttons
function commitEdit({ silent = false } = {}) {
  if (!state.edit.active) return;
  const L = layers.list[state.edit.layerIndex];
  // Bake any live preview into the actual bitmap before pushing history
  if (L && L._preview) {
    finalizeResize(L);
    renderAll();
    updateLayersUI();
  }
  state.edit.active = false;
  state.edit.layerIndex = -1;
  state.edit.snapshot = null;
  editActionsEl.classList.remove('visible');
  pushHistory();
  if (!silent) msg('Saved', 'ok');
}

// Cancel the current edit — restore the snapshotted state, hide buttons
function cancelEdit() {
  if (!state.edit.active) return;
  const L = layers.list[state.edit.layerIndex];
  const snap = state.edit.snapshot;
  if (L) {
    // Throw away any unfinalised live preview
    if (L._preview) delete L._preview;
    if (snap) {
      L.canvas = snap.canvas;
      L.left = snap.left;
      L.top = snap.top;
    }
    renderAll();
    updateLayersUI();
  }
  state.edit.active = false;
  state.edit.layerIndex = -1;
  state.edit.snapshot = null;
  editActionsEl.classList.remove('visible');
  msg('Cancelled', 'ok');
}

// Position the Done/Cancel buttons OUTSIDE the layer's bounding box.
// Preferred placement: centered horizontally below the layer, with a margin.
// If there's no room below (layer near canvas bottom), flip above the layer.
// Always clamped to stay inside the visible canvas area.
function updateEditActionsPosition() {
  if (!state.edit.active) return;
  const L = layers.list[state.edit.layerIndex];
  if (!L) return;
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width / canvas.width;
  const sy = rect.height / canvas.height;
  // Use effective bounds (preview-aware) so buttons follow live resizes
  const b = getLayerBounds(L);
  const layerLeft   = b.left * sx;
  const layerTop    = b.top  * sy;
  const layerRight  = b.right * sx;
  const layerBottom = b.bottom * sy;
  const layerCenterX = (layerLeft + layerRight) / 2;

  // Row dimensions: 2 buttons × 36px + 14px gap = 86px
  const ROW_W = 86, ROW_H = 36, MARGIN = 14;

  // Center horizontally on the layer
  let leftPos = layerCenterX - ROW_W / 2;

  // Prefer below the layer
  let topPos = layerBottom + MARGIN;
  // If below would push outside the canvas, try above
  if (topPos + ROW_H + 4 > rect.height) {
    topPos = layerTop - ROW_H - MARGIN;
  }
  // If above also doesn't fit, fall back to inside the canvas at the bottom edge
  if (topPos < 4) {
    topPos = Math.max(4, rect.height - ROW_H - 4);
  }

  // Clamp horizontally to keep buttons fully on screen
  leftPos = Math.max(4, Math.min(leftPos, rect.width - ROW_W - 4));

  editActionsEl.style.left = leftPos + 'px';
  editActionsEl.style.top  = topPos + 'px';
}

// Wire the buttons
$('editDoneBtn').addEventListener('click', (e) => { e.stopPropagation(); commitEdit(); });
$('editCancelBtn').addEventListener('click', (e) => { e.stopPropagation(); cancelEdit(); });
// Also handle touch explicitly so the press feels instant
$('editDoneBtn').addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); commitEdit(); }, { passive: false });
$('editCancelBtn').addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); cancelEdit(); }, { passive: false });

function updateHandles() {
  // Show handles whenever a layer is selected and editable — regardless of tool.
  // (Drawing tools still let you draw; tap-to-select on the canvas brings them up.)
  if (layers.selected < 0) {
    handlesOverlay.classList.add('hidden-el');
    return;
  }
  const sel = layers.list[layers.selected];
  if (!sel || !sel.visible || sel.locked) { handlesOverlay.classList.add('hidden-el'); return; }
  handlesOverlay.classList.remove('hidden-el');

  const rect = canvas.getBoundingClientRect();
  const sx = rect.width / canvas.width;
  const sy = rect.height / canvas.height;
  // Read effective bounds (preview-aware) so handles follow live resizes
  const b = getLayerBounds(sel);
  const rawLeft = b.left * sx;
  const rawTop  = b.top  * sy;
  const rawW    = (b.right - b.left) * sx;
  const rawH    = (b.bottom - b.top) * sy;

  // Clamp visible bounds to the canvas — even if the layer extends off-screen,
  // we want grabbable handles inside the visible area.
  const left = Math.max(0, rawLeft);
  const top  = Math.max(0, rawTop);
  const right = Math.min(rect.width, rawLeft + rawW);
  const bottom = Math.min(rect.height, rawTop + rawH);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  const cx = left + w / 2, cy = top + h / 2;

  // Adaptive size: never larger than min(w,h)/3, min 12px, max 22px
  const minDim = Math.max(8, Math.min(w, h));
  const corner = Math.max(12, Math.min(22, Math.floor(minDim / 3)));
  handlesOverlay.style.setProperty('--hsize', corner + 'px');
  const showEdges = minDim > 60;

  const positions = {
    nw: [left, top], n: [cx, top], ne: [right, top],
    e:  [right, cy], se: [right, bottom],
    s:  [cx, bottom], sw: [left, bottom], w: [left, cy]
  };
  handlesOverlay.querySelectorAll('.handle').forEach(el => {
    const dir = el.dataset.dir;
    const isEdge = ['n','s','e','w'].includes(dir);
    if (isEdge && !showEdges) { el.style.display = 'none'; return; }
    el.style.display = '';
    const [hx, hy] = positions[dir];
    el.style.left = hx + 'px';
    el.style.top  = hy + 'px';
  });

  // Also keep the editing-transaction buttons aligned
  if (state.edit.active) updateEditActionsPosition();
}

function resampleCanvas(source, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const out = makeCanvas(w, h);
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
  o.drawImage(source, 0, 0, source.width, source.height, 0, 0, w, h);
  return out;
}

// computeResizeBounds → core.js

function cachePointerMetrics() {
  const r = canvas.getBoundingClientRect();
  state.pointerMetrics = {
    left: r.left,
    top: r.top,
    sx: canvas.width / r.width,
    sy: canvas.height / r.height,
  };
}

function clearPointerMetrics() {
  state.pointerMetrics = null;
}

function getTouchPoint(t) {
  if (!state.pointerMetrics) cachePointerMetrics();
  const m = state.pointerMetrics;
  return { x: (t.clientX - m.left) * m.sx, y: (t.clientY - m.top) * m.sy };
}

function getGestureInfo(e) {
  const a = getTouchPoint(e.touches[0]);
  const b = getTouchPoint(e.touches[1]);
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
  };
}

// canvas-coord conversion — works for both touch and mouse
function getEvtPoint(e) {
  if (!state.pointerMetrics) cachePointerMetrics();
  const m = state.pointerMetrics;
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
  return { x: (t.clientX - m.left) * m.sx, y: (t.clientY - m.top) * m.sy };
}

// Handle touch+mouse on the resize handles
handlesOverlay.querySelectorAll('.handle').forEach(h => {
  const startTransform = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (layers.selected < 0) return;
    const sel = layers.list[layers.selected];
    if (!sel || sel.locked) return;
    cachePointerMetrics();
    h.classList.add('grabbing');
    // Open an edit transaction (idempotent — same layer = no-op)
    beginEdit(layers.selected);
    // If a previous resize left a live preview attached, bake it into the
    // bitmap now so this new resize starts from what the user sees on screen.
    if (sel._preview) finalizeResize(sel);
    state.transform.dir = h.dataset.dir;
    state.transform.startPointer = getEvtPoint(e);
    state.transform.startBounds = { left: sel.left||0, top: sel.top||0, width: sel.canvas.width, height: sel.canvas.height };
    state.transform.sourceCanvas = makeCanvas(sel.canvas.width, sel.canvas.height);
    state.transform.sourceCanvas.getContext('2d').drawImage(sel.canvas, 0, 0);
    state.transform.constrain = true;
    state.transform.rafId = null;
    state.transform.pendingPoint = state.transform.startPointer;
    state.didChange = false;
    window.addEventListener('mousemove', onTransformMove, { passive: false });
    window.addEventListener('mouseup', onTransformEnd);
    window.addEventListener('touchmove', onTransformMove, { passive: false });
    window.addEventListener('touchend', onTransformEnd);
    window.addEventListener('touchcancel', onTransformEnd);
  };
  h.addEventListener('mousedown', startTransform);
  h.addEventListener('touchstart', startTransform, { passive: false });
});

function onTransformMove(e) {
  if (!state.transform.dir) return;
  e.preventDefault();
  // Cache pointer; do the actual work on the next frame to coalesce events
  state.transform.pendingPoint = getEvtPoint(e);
  if (state.transform.rafId) return;
  state.transform.rafId = requestAnimationFrame(applyTransformFrame);
}

function applyTransformFrame() {
  state.transform.rafId = null;
  const sel = layers.list[layers.selected];
  if (!sel || !state.transform.dir) return;
  const p = state.transform.pendingPoint;
  const isCorner = ['nw','ne','se','sw'].includes(state.transform.dir);
  const b = computeResizeBounds(state.transform.dir, state.transform.startBounds, state.transform.startPointer, p, isCorner);
  // FAST PATH: don't resample the bitmap during drag — just stash the
  // preview transform on the layer. renderAll uses ctx.drawImage with
  // explicit width/height which scales on the GPU. The expensive
  // resample only happens once on Done, in finalizeResize().
  sel._preview = {
    source: state.transform.sourceCanvas,
    left: Math.round(b.left),
    top:  Math.round(b.top),
    width:  Math.max(2, Math.round(b.width)),
    height: Math.max(2, Math.round(b.height)),
  };
  state.didChange = true;
  scheduleRender();
}

// Convert any pending live preview into a real resampled bitmap.
// Called when a resize ends (and is being committed).
function finalizeResize(L) {
  if (!L || !L._preview) return;
  const p = L._preview;
  L.canvas = resampleCanvas(p.source, p.width, p.height);
  L.left = p.left;
  L.top  = p.top;
  delete L._preview;
}
function onTransformEnd() {
  if (!state.transform.dir) return;
  if (state.transform.rafId) {
    cancelAnimationFrame(state.transform.rafId);
    applyTransformFrame();
  }
  // Remove grabbing class from any handle
  handlesOverlay.querySelectorAll('.handle.grabbing').forEach(h => h.classList.remove('grabbing'));
  state.transform.dir = null; state.transform.sourceCanvas = null;
  window.removeEventListener('mousemove', onTransformMove);
  window.removeEventListener('mouseup', onTransformEnd);
  window.removeEventListener('touchmove', onTransformMove);
  window.removeEventListener('touchend', onTransformEnd);
  window.removeEventListener('touchcancel', onTransformEnd);
  clearPointerMetrics();
  // While an edit transaction is open, the user must press Done/Cancel to
  // commit. Otherwise (defensive — shouldn't happen), push history.
  if (state.didChange && !state.edit.active) { pushHistory(); updateLayersUI(); msg('Resized', 'ok'); }
  state.didChange = false;
}

// ─── File I/O ───────────────────────────────────────────────────────────
$('emptyOpenBtn').addEventListener('click', () => $('fileInput').click());
$('addImageBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) {
    if (replaceMode) {
      replaceMode = false;
      const n = (f.name || '').toLowerCase();
      const isPsd = n.endsWith('.psd') || f.type === 'image/vnd.adobe.photoshop';
      if (isPsd) { msg('Cannot replace with a PSD — pick an image', 'err'); }
      else { replaceImageInSelectedLayer(f); closeAllSheets(); }
    } else {
      handleFile(f);
    }
  }
  e.target.value = '';
});
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

// Paste image from clipboard.
// Default behaviour: paste as a new layer.
// If the layers sheet is open and a layer is selected, paste replaces that layer.
document.addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (!file) return;
  e.preventDefault();
  const layersSheetOpen = $('sheet-layers').classList.contains('open');
  if (layersSheetOpen && layers.selected >= 0 && state.hasContent) {
    replaceImageInSelectedLayer(file);
  } else {
    importImageIntoCurrentDocument(file);
  }
});

function handleFile(file) {
  const n = (file.name || '').toLowerCase();
  const isPsd = n.endsWith('.psd') || file.type === 'image/vnd.adobe.photoshop';
  if (!isPsd && state.hasContent) { importImageIntoCurrentDocument(file); return; }
  msg('Loading…');
  if (isPsd) loadPsdFile(file); else loadImageFile(file);
  closeAllSheets();
}

function loadImageElement(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (ev) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('decode')); img.src = ev.target.result; };
    r.onerror = () => rej(new Error('read'));
    r.readAsDataURL(file);
  });
}
async function importImageIntoCurrentDocument(file) {
  try {
    const img = await loadImageElement(file);
    const baseName = (file.name || 'image').replace(/\.[^.]+$/, '');
    if (!state.hasContent) {
      initDocument(img.width, img.height);
      const c = makeCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
      layers.list = [{ name: baseName, canvas: c, left: 0, top: 0, opacity: 1, visible: true, blendMode: 'normal', locked: false }];
      layers.tree = [{ kind: 'layer', layerIndex: 0 }];
      layers.selected = 0;
      renderAll(); updateLayersUI(); pushHistory(); fitStage();
      msg('Image loaded', 'ok'); return;
    }
    // Add as new layer, centered
    const lc = makeCanvas(img.width, img.height); lc.getContext('2d').drawImage(img, 0, 0);
    const newIdx = layers.list.length;
    layers.list.push({ name: baseName, canvas: lc, left: Math.round((layers.docW - img.width)/2), top: Math.round((layers.docH - img.height)/2), opacity: 1, visible: true, blendMode: 'normal', locked: false });
    // Insert into tree at root level, on top
    layers.tree.push({ kind: 'layer', layerIndex: newIdx });
    layers.selected = newIdx;
    renderAll(); updateLayersUI(); pushHistory();
    msg('Added as new layer', 'ok');
  } catch (err) { console.error(err); msg('Failed to load image', 'err'); }
}
function loadImageFile(file) { importImageIntoCurrentDocument(file); }

function loadPsdFile(file) {
  if (typeof agPsd === 'undefined' || !agPsd.readPsd) { msg('PSD library not loaded', 'err'); return; }
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const psd = agPsd.readPsd(ev.target.result, { skipLayerImageData: false, skipCompositeImageData: false, skipThumbnail: true });
      if (!psd.width || !psd.height) { msg('Invalid PSD', 'err'); return; }
      initDocument(psd.width, psd.height);
      layers.list = []; layers.tree = [];

      // Walk PSD tree, building both the flat layers.list AND the layers.tree (groups preserved)
      function walkPsd(psdNodes, ancestorNames = []) {
        const treeNodes = [];
        if (!psdNodes) return treeNodes;
        for (const n of psdNodes) {
          if (n.children && n.children.length) {
            // Group
            const gName = n.name || 'Group';
            const group = {
              kind: 'group',
              name: gName,
              expanded: false,  // collapsed by default — like the screenshot the user showed
              visible: !n.hidden,
              opacity: normalizeOpacity(n.opacity),
              locked: false,
              children: walkPsd(n.children, [...ancestorNames, gName])
            };
            treeNodes.push(group);
          } else if (n.canvas || n.text) {
            // Leaf layer — locked if its own name OR any ancestor group's name
            // matches the protected-name pattern (shadow / light / bg / texture etc.)
            const lockedByOwn = isProtectedLayerName(n.name || '');
            const lockedByAncestor = ancestorNames.some(a => isProtectedLayerName(a));
            const layerObj = {
              name: n.name || 'Layer',
              canvas: n.canvas || makeCanvas(2, 2),
              left: n.left || 0,
              top: n.top || 0,
              opacity: normalizeOpacity(n.opacity),
              visible: !n.hidden,
              blendMode: n.blendMode || 'normal',
              locked: lockedByOwn || lockedByAncestor
            };

            // Detect editable text layer
            if (n.text && typeof n.text.text === 'string') {
              const t = n.text;
              // Default sizing: numbers (scorelines etc.) are huge, everything else is 23.
              // "Numeric" = string is just digits, possibly with a decimal point or whitespace.
              const isNumeric = /^[\s\d.,:-]+$/.test(t.text.trim()) && /\d/.test(t.text);
              let fontFamily = 'BPG Paata Caps';
              let fontSize = isNumeric ? 346.41 : 23;
              let color = '#ffffff';
              let bold = false, italic = false, align = 'left';
              try {
                const run = t.style || (t.styleRuns && t.styleRuns[0] && t.styleRuns[0].style);
                if (run) {
                  if (run.fillColor) {
                    const fc = run.fillColor;
                    if (fc.r !== undefined) {
                      const r = Math.round(fc.r), g = Math.round(fc.g), b = Math.round(fc.b);
                      color = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
                    }
                  }
                }
                if (t.paragraphStyle && t.paragraphStyle.justification) {
                  const j = t.paragraphStyle.justification;
                  if (j === 'center') align = 'center';
                  else if (j === 'right') align = 'right';
                }
              } catch (_) {}
              layerObj.text = {
                value: t.text,
                fontFamily, fontSize, color,
                bold, italic, align,
                lineHeight: 1.2
              };
              // Keep the PSD's pre-rendered canvas as initial display so it
              // looks exactly like the original until the user edits.
              if (!n.canvas) {
                layerObj.canvas = rasterizeText(layerObj.text);
              }
            }

            const idx = layers.list.length;
            layers.list.push(layerObj);
            treeNodes.push({ kind: 'layer', layerIndex: idx });
          }
        }
        return treeNodes;
      }

      layers.tree = walkPsd(psd.children);

      if (layers.list.length === 0 && psd.canvas) {
        const full = makeCanvas(psd.width, psd.height); full.getContext('2d').drawImage(psd.canvas, 0, 0);
        const idx = layers.list.length;
        layers.list.push({ name: 'Composite', canvas: full, left: 0, top: 0, opacity: 1, visible: true, blendMode: 'normal', locked: false });
        layers.tree.push({ kind: 'layer', layerIndex: idx });
        msg('PSD loaded (flat)', 'ok');
      } else {
        // coverage check
        const t = makeCanvas(psd.width, psd.height); const tc = t.getContext('2d');
        for (let i = 0; i < layers.list.length; i++) {
          const eff = effectiveVis(i); if (!eff.visible) continue;
          const L = layers.list[i];
          tc.save(); tc.globalAlpha = eff.opacity; tc.globalCompositeOperation = BLEND_MAP[L.blendMode]||'source-over';
          tc.drawImage(L.canvas, L.left||0, L.top||0); tc.restore();
        }
        const d = tc.getImageData(0, 0, psd.width, psd.height).data;
        let op = 0; const step = 4 * 50; const total = Math.floor(d.length / step);
        for (let i = 3; i < d.length; i += step) if (d[i] > 10) op++;
        const cov = op / total;
        if (cov < 0.3 && psd.canvas) {
          const full = makeCanvas(psd.width, psd.height); full.getContext('2d').drawImage(psd.canvas, 0, 0);
          const idx = layers.list.length;
          layers.list.push({ name: '⚠ Composite — hide to edit layers', canvas: full, left: 0, top: 0, opacity: 1, visible: true, blendMode: 'normal', locked: false });
          layers.tree.push({ kind: 'layer', layerIndex: idx });
          msg('Complex PSD — hide composite to edit', 'ok');
        } else msg('PSD loaded — ' + layers.list.length + ' layer(s)', 'ok');
      }
      layers.selected = layers.list.length - 1;
      renderAll(); updateLayersUI(); pushHistory(); fitStage();
    } catch (err) { console.error(err); msg('PSD error: ' + err.message, 'err'); }
  };
  r.onerror = () => msg('Failed to read', 'err');
  r.readAsArrayBuffer(file);
}

function initDocument(w, h) {
  canvas.width = w; canvas.height = h;
  layers.docW = w; layers.docH = h; layers.selected = -1;
  state.hasContent = true; state.isDrawing = false;
  emptyState.classList.add('hidden-el'); stageInner.classList.remove('hidden-el');
  state.history = []; state.historyIndex = -1;
  resetAdjustments();
}

// Inverse of initDocument — tear the current document down and return to the
// empty/home screen. Invoked by the brand/logo button (goHome).
function closeDocument() {
  // Abandon any in-progress text edit or move/resize transaction (same cleanup
  // restoreHistory does) so nothing writes back to a torn-down layer.
  if (editingTextLayer) {
    editingTextLayer = null; textEditBackup = null;
    const teSheet = $('sheet-textedit');
    if (teSheet && teSheet.classList.contains('open')) closeAllSheets();
  }
  if (state.edit.active) {
    state.edit.active = false; state.edit.layerIndex = -1; state.edit.snapshot = null;
    editActionsEl.classList.remove('visible');
  }
  layers.list = []; layers.tree = []; layers.selected = -1;
  layers.docW = 0; layers.docH = 0;
  state.hasContent = false; state.isDrawing = false;
  state.history = []; state.historyIndex = -1;
  state.dragLayerIndex = -1; state.move.pendingPoint = null;
  handlesOverlay.classList.add('hidden-el');
  stageInner.classList.add('hidden-el');
  emptyState.classList.remove('hidden-el');
  closeAllSheets();
  resetAdjustments();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  msg('Ready', 'ok');
}

// Brand/logo → home. With no persistence yet, returning home discards the
// current image, so confirm first when a document is open.
function goHome() {
  if (state.hasContent && !confirm('Return to the home screen? Your current image will be cleared.')) return;
  closeDocument();
}
$('brandHome').addEventListener('click', goHome);

// ─── Drawing on canvas ──────────────────────────────────────────────────
// The move tool is the only tool — brush/eraser/shape/text/pick were removed.
// activeLayerCtx() is kept because the Adjust-sheet filters still use it.
function activeLayerCtx() {
  if (layers.selected < 0) { msg('Select a layer first', 'err'); return null; }
  const L = layers.list[layers.selected];
  if (!L.visible) { msg('Layer is hidden', 'err'); return null; }
  if (!canEdit(L)) { msg('Layer is locked', 'err'); return null; }
  return { layer: L, ctx: L.canvas.getContext('2d') };
}

canvas.addEventListener('mousedown', onCanvasStart);
canvas.addEventListener('mousemove', onCanvasMove);
canvas.addEventListener('mouseup', onCanvasEnd);
canvas.addEventListener('mouseleave', onCanvasEnd);
canvas.addEventListener('touchstart', onCanvasStart, { passive: false });
canvas.addEventListener('touchmove', onCanvasMove, { passive: false });
canvas.addEventListener('touchend', onCanvasEnd);
canvas.addEventListener('touchcancel', onCanvasEnd);

function startTouchGesture(e) {
  if (!state.hasContent || !e.touches || e.touches.length < 2) return false;
  e.preventDefault();
  cachePointerMetrics();
  const info = getGestureInfo(e);
  let layerIndex = layers.selected;
  let L = layers.list[layerIndex];
  if (!L || !effectiveVis(layerIndex).visible || L.locked || !canEdit(L)) {
    layerIndex = getTopLayerByBounds(info.mid.x, info.mid.y);
    if (layerIndex >= 0) layerIndex = selectLayer(layerIndex, { quiet: true });
    L = layers.list[layerIndex];
  }
  if (layerIndex < 0 || !L || !effectiveVis(layerIndex).visible || !canEdit(L)) {
    clearPointerMetrics();
    return false;
  }
  if (L._preview) finalizeResize(L);
  beginEdit(layerIndex);
  if (state.move.rafId) {
    cancelAnimationFrame(state.move.rafId);
    applyMoveFrame();
  }
  state.move.pendingPoint = null;
  state.isDrawing = false;
  state.dragLayerIndex = -1;
  state.gesture.active = true;
  state.gesture.pending = info;
  state.gesture.startMid = info.mid;
  state.gesture.startDistance = info.distance;
  state.gesture.startBounds = { left: L.left || 0, top: L.top || 0, width: L.canvas.width, height: L.canvas.height };
  state.gesture.sourceCanvas = makeCanvas(L.canvas.width, L.canvas.height);
  state.gesture.sourceCanvas.getContext('2d').drawImage(L.canvas, 0, 0);
  state.didChange = false;
  msg('Pinch / pan: ' + L.name);
  return true;
}

function updateTouchGesture(e) {
  if (!state.gesture.active) return false;
  if (!e.touches || e.touches.length < 2) {
    endTouchGesture();
    return false;
  }
  e.preventDefault();
  state.gesture.pending = getGestureInfo(e);
  if (!state.gesture.rafId) state.gesture.rafId = requestAnimationFrame(applyGestureFrame);
  return true;
}

function applyGestureFrame() {
  state.gesture.rafId = null;
  if (!state.gesture.active || !state.gesture.pending) return;
  const L = layers.list[layers.selected];
  if (!L) return;
  const pending = state.gesture.pending;
  const sb = state.gesture.startBounds;
  const scale = clamp(pending.distance / state.gesture.startDistance, 0.05, 20);
  const width = Math.max(2, Math.round(sb.width * scale));
  const height = Math.max(2, Math.round(sb.height * scale));
  const startCenter = { x: sb.left + sb.width / 2, y: sb.top + sb.height / 2 };
  const center = {
    x: startCenter.x + pending.mid.x - state.gesture.startMid.x,
    y: startCenter.y + pending.mid.y - state.gesture.startMid.y,
  };
  L._preview = {
    source: state.gesture.sourceCanvas,
    left: Math.round(center.x - width / 2),
    top: Math.round(center.y - height / 2),
    width,
    height,
  };
  state.didChange = true;
  scheduleRender();
}

function endTouchGesture() {
  if (!state.gesture.active) return false;
  if (state.gesture.rafId) {
    cancelAnimationFrame(state.gesture.rafId);
    applyGestureFrame();
  }
  flushRender();
  state.gesture.active = false;
  state.gesture.pending = null;
  state.gesture.startMid = null;
  state.gesture.startBounds = null;
  state.gesture.sourceCanvas = null;
  clearPointerMetrics();
  return true;
}

function onCanvasStart(e) {
  if (!state.hasContent) return;
  if (e.touches && e.touches.length > 1) {
    startTouchGesture(e);
    return;
  }
  e.preventDefault();
  cachePointerMetrics();
  const p = getEvtPoint(e);
  state.didChange = false;

  // If a layer is already selected and the touch lands inside ITS bounding box,
  // keep dragging that layer — no re-selection, no UI rebuild.
  let stickyHit = -1;
  if (layers.selected >= 0) {
    const sel = layers.list[layers.selected];
    const eff = effectiveVis(layers.selected);
    if (sel && eff.visible && !sel.locked) {
      const b = getLayerBounds(sel);
      if (p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom) {
        stickyHit = layers.selected;
      }
    }
  }

  if (stickyHit >= 0) {
    // Just start the drag — keep current selection
    const L = layers.list[stickyHit];
    // If a previous resize left a live preview attached, bake it now so
    // L.left/L.canvas.width reflect what the user sees on screen.
    if (L._preview) finalizeResize(L);
    state.isDrawing = true;
    state.dragLayerIndex = stickyHit;
    state.dragOffsetX = p.x - (L.left||0);
    state.dragOffsetY = p.y - (L.top||0);
    state.move.pendingPoint = p;
    beginEdit(stickyHit);
    msg('Moving: ' + L.name);
    return;
  }

  // No sticky match — bounds-based hit-test (predictable for text layers).
  const hit = getTopLayerByBounds(p.x, p.y);
  if (hit >= 0) {
    const r = selectLayer(hit, { quiet: true });
    const L = layers.list[r];
    if (r < 0 || !L || !canEdit(L)) return;
    if (L._preview) finalizeResize(L);
    state.isDrawing = true;
    state.dragLayerIndex = r;
    state.dragOffsetX = p.x - (L.left||0);
    state.dragOffsetY = p.y - (L.top||0);
    state.move.pendingPoint = p;
    beginEdit(r);
    msg('Selected: ' + L.name, 'ok');
  } else if (!state.edit.active) {
    // Don't deselect while an edit transaction is open — user must press
    // Done or Cancel to leave editing mode
    selectLayer(-1, { quiet: true });
  }
  clearPointerMetrics();
}

function onCanvasMove(e) {
  if (state.gesture.active) {
    updateTouchGesture(e);
    return;
  }
  if (e.touches && e.touches.length > 1) {
    startTouchGesture(e);
    return;
  }
  if (!state.isDrawing) return;
  e.preventDefault();
  const p = getEvtPoint(e);
  state.move.pendingPoint = p;
  if (!state.move.rafId) state.move.rafId = requestAnimationFrame(applyMoveFrame);
}

function applyMoveFrame() {
  state.move.rafId = null;
  const L = layers.list[state.dragLayerIndex];
  const p = state.move.pendingPoint;
  if (!L || !p) return;
  const nextLeft = clamp(Math.round(p.x - state.dragOffsetX), -L.canvas.width+1, layers.docW-1);
  const nextTop = clamp(Math.round(p.y - state.dragOffsetY), -L.canvas.height+1, layers.docH-1);
  if (nextLeft === (L.left || 0) && nextTop === (L.top || 0)) return;
  L.left = nextLeft;
  L.top = nextTop;
  state.didChange = true;
  scheduleRender();
}

function onCanvasEnd() {
  if (state.gesture.active) {
    endTouchGesture();
    return;
  }
  if (!state.isDrawing) return;
  if (state.move.rafId) {
    cancelAnimationFrame(state.move.rafId);
    applyMoveFrame();
  }
  flushRender();
  state.isDrawing = false; state.dragLayerIndex = -1;
  state.move.pendingPoint = null;
  // While an edit transaction is open, the user must press Done/Cancel to
  // commit; a finished move pushes history only when nothing is mid-edit.
  if (state.didChange && !state.edit.active) pushHistory();
  state.didChange = false;
  clearPointerMetrics();
}

// Quick-tap layer selection.
// • Tap any layer → selected, handles visible, ready to drag/resize.
// • Double-tap a TEXT layer → also opens the text editor.
let lastTapInfo = { time: 0, layerIndex: -1 };
canvas.addEventListener('click', (e) => {
  if (!state.hasContent) return;

  const p = getEvtPoint(e);
  const hit = getTopLayerAtPoint(p.x, p.y);
  if (hit < 0) return;

  // Detect double-tap on the same layer → open the editor for text layers.
  const now = Date.now();
  const isDouble = (now - lastTapInfo.time < 350) && lastTapInfo.layerIndex === hit;
  lastTapInfo = { time: now, layerIndex: hit };

  if (isDouble) {
    const L = layers.list[hit];
    if (L && L.text && !L.locked) openTextEditor();
  }
});

// ─── Adjust ─────────────────────────────────────────────────────────────
['brightness','contrast','saturation','blur'].forEach(id => {
  $(id).oninput = (e) => { state.adjust[id] = +e.target.value; $(id+'Val').textContent = e.target.value; updateFilter(); };
});
function updateFilter() {
  const a = state.adjust;
  canvas.style.filter = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%) blur(${a.blur}px)`;
}
function resetAdjustments() {
  state.adjust = { brightness: 100, contrast: 100, saturation: 100, blur: 0 };
  ['brightness','contrast','saturation','blur'].forEach(id => {
    const v = id === 'blur' ? 0 : 100; $(id).value = v; $(id+'Val').textContent = v;
  });
  canvas.style.filter = 'none';
}
$('resetAdjust').onclick = resetAdjustments;
$('applyAdjust').onclick = () => {
  if (!state.hasContent) return;
  const a = state.adjust;
  if (a.brightness===100 && a.contrast===100 && a.saturation===100 && a.blur===0) return;
  for (const L of layers.list) {
    if (!L.visible) continue;
    const t = makeCanvas(L.canvas.width, L.canvas.height); const tc = t.getContext('2d');
    tc.filter = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%) blur(${a.blur}px)`;
    tc.drawImage(L.canvas, 0, 0);
    const lc = L.canvas.getContext('2d'); lc.clearRect(0,0,L.canvas.width,L.canvas.height); lc.drawImage(t, 0, 0);
    touchLayerPixels(L);
  }
  resetAdjustments(); renderAll(); updateLayersUI(); pushHistory();
  msg('Adjustments applied', 'ok');
};

// ─── Filters ────────────────────────────────────────────────────────────
document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.onclick = () => {
    const a = activeLayerCtx(); if (!a) return;
    const img = a.ctx.getImageData(0, 0, a.layer.canvas.width, a.layer.canvas.height);
    const d = img.data;
    switch (btn.dataset.filter) {
      case 'grayscale': for (let i=0;i<d.length;i+=4){const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];d[i]=d[i+1]=d[i+2]=g;} break;
      case 'sepia': for (let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2];d[i]=Math.min(255,r*0.393+g*0.769+b*0.189);d[i+1]=Math.min(255,r*0.349+g*0.686+b*0.168);d[i+2]=Math.min(255,r*0.272+g*0.534+b*0.131);} break;
      case 'invert': for (let i=0;i<d.length;i+=4){d[i]=255-d[i];d[i+1]=255-d[i+1];d[i+2]=255-d[i+2];} break;
      case 'vintage': for (let i=0;i<d.length;i+=4){d[i]=Math.min(255,d[i]*0.9+30);d[i+1]=Math.min(255,d[i+1]*0.85+20);d[i+2]=Math.min(255,d[i+2]*0.7+10);} break;
    }
    a.ctx.putImageData(img, 0, 0);
    touchLayerPixels(a.layer);
    renderAll(); updateLayersUI(); pushHistory();
    msg('Filter: ' + btn.dataset.filter, 'ok');
  };
});

// ─── Transform: rotate / flip / resize doc ─────────────────────────────
function rotateAll(deg) {
  if (!state.hasContent) return;
  const nw = Math.abs(deg)===90 ? layers.docH : layers.docW;
  const nh = Math.abs(deg)===90 ? layers.docW : layers.docH;
  for (const L of layers.list) {
    const t = makeCanvas(nw, nh); const tc = t.getContext('2d');
    tc.translate(nw/2, nh/2); tc.rotate(deg*Math.PI/180);
    tc.drawImage(L.canvas, -L.canvas.width/2, -L.canvas.height/2);
    L.canvas = t;
  }
  layers.docW = nw; layers.docH = nh; canvas.width = nw; canvas.height = nh;
  renderAll(); updateLayersUI(); pushHistory(); fitStage();
}
function flipAll(dir) {
  if (!state.hasContent) return;
  for (const L of layers.list) {
    const t = makeCanvas(L.canvas.width, L.canvas.height); const tc = t.getContext('2d');
    if (dir === 'h') { tc.translate(L.canvas.width, 0); tc.scale(-1, 1); }
    else { tc.translate(0, L.canvas.height); tc.scale(1, -1); }
    tc.drawImage(L.canvas, 0, 0);
    const lc = L.canvas.getContext('2d'); lc.clearRect(0,0,L.canvas.width,L.canvas.height); lc.drawImage(t, 0, 0);
    touchLayerPixels(L);
  }
  renderAll(); updateLayersUI(); pushHistory();
}
$('rotateBtn').onclick = () => { rotateAll(90); msg('Rotated', 'ok'); };
$('flipBtn').onclick = () => {
  // Toggle direction each tap
  if (!state.hasContent) return;
  flipAll('h'); msg('Flipped horizontally', 'ok');
};

function resizeDocument(newW, newH) {
  if (!state.hasContent) return;
  newW = Math.max(1, Math.round(newW)); newH = Math.max(1, Math.round(newH));
  const sx = newW / layers.docW, sy = newH / layers.docH;
  for (const L of layers.list) {
    L.canvas = resampleCanvas(L.canvas, Math.max(1, Math.round(L.canvas.width*sx)), Math.max(1, Math.round(L.canvas.height*sy)));
    L.left = Math.round((L.left||0)*sx); L.top = Math.round((L.top||0)*sy);
  }
  layers.docW = newW; layers.docH = newH; canvas.width = newW; canvas.height = newH;
  renderAll(); updateLayersUI(); pushHistory(); fitStage();
  msg('Canvas: ' + newW + '×' + newH, 'ok');
}
$('resizeDocBtn').onclick = () => {
  if (!state.hasContent) { msg('Open a file first', 'err'); return; }
  openResizeModal(layers.docW, layers.docH, (w, h) => resizeDocument(w, h));
};

function openResizeModal(initW, initH, onCommit) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal-card">
      <h3>Resize <em>canvas</em></h3>
      <label>Width (px)</label>
      <input type="number" class="num-input" id="mW" value="${initW}" min="1">
      <label>Height (px)</label>
      <input type="number" class="num-input" id="mH" value="${initH}" min="1">
      <label class="toggle-row" style="margin-top:8px;padding:0;">
        <span>Lock aspect ratio</span>
        <input type="checkbox" id="mKeep" checked style="width:20px;height:20px;accent-color:var(--accent);">
      </label>
      <div class="grid-2" style="margin-top:18px;">
        <button class="pill" id="mCancel">Cancel</button>
        <button class="pill primary" id="mOk">Apply</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  const mW = wrap.querySelector('#mW'), mH = wrap.querySelector('#mH'), mKeep = wrap.querySelector('#mKeep');
  const ratio = initW / initH;
  mW.addEventListener('input', () => { if (mKeep.checked) mH.value = Math.max(1, Math.round(Number(mW.value)/ratio)); });
  mH.addEventListener('input', () => { if (mKeep.checked) mW.value = Math.max(1, Math.round(Number(mH.value)*ratio)); });
  const close = () => document.body.removeChild(wrap);
  wrap.querySelector('#mCancel').onclick = close;
  wrap.querySelector('#mOk').onclick = () => {
    const w = Number(mW.value)||initW, h = Number(mH.value)||initH;
    close(); onCommit(w, h);
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
}

// ─── Layers UI ──────────────────────────────────────────────────────────
function updateLayersUI() {
  const list = $('layersList');
  list.innerHTML = '';
  if (layers.list.length === 0) {
    list.innerHTML = '<div class="layer-empty">Open a file to see layers</div>';
    $('selectedBlockHost').innerHTML = '';
    return;
  }

  // If somehow we have layers but no tree, build a flat one
  if (!layers.tree || layers.tree.length === 0) buildFlatTree();

  // Render the tree. Walk it in REVERSE so top-of-stack appears first.
  // Each tree level renders its children in reverse for the same reason.
  function renderNodes(nodes, depth) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '6px';
    // Reverse so painting order (last = top) becomes display order (first = top)
    for (let k = nodes.length - 1; k >= 0; k--) {
      const node = nodes[k];
      if (node.kind === 'group') {
        wrap.appendChild(renderGroup(node, depth));
      } else {
        const L = layers.list[node.layerIndex];
        if (!L) continue;
        wrap.appendChild(renderLayerRow(L, node.layerIndex));
      }
    }
    return wrap;
  }

  function renderGroup(group, depth) {
    const groupWrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'group-row';

    const chev = document.createElement('div');
    chev.className = 'chev' + (group.expanded ? ' expanded' : '');
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

    const eye = document.createElement('div');
    eye.className = 'layer-eye' + (group.visible ? '' : ' off');
    eye.innerHTML = group.visible
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><path d="M1 1l22 22"/></svg>';

    const ic = document.createElement('div');
    ic.className = 'gicon';
    ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';

    const nm = document.createElement('div');
    nm.className = 'gname';
    nm.textContent = group.name;

    head.appendChild(chev);
    head.appendChild(eye);
    head.appendChild(ic);
    head.appendChild(nm);

    eye.onclick = (e) => { e.stopPropagation(); group.visible = !group.visible; renderAll(); updateLayersUI(); pushHistory(); };
    head.addEventListener('click', () => {
      group.expanded = !group.expanded;
      updateLayersUI();
    });

    groupWrap.appendChild(head);

    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'group-children' + (group.expanded ? '' : ' collapsed');
    if (group.expanded) {
      childrenWrap.appendChild(renderNodes(group.children, depth + 1));
    }
    groupWrap.appendChild(childrenWrap);
    return groupWrap;
  }

  function renderLayerRow(L, i) {
    const row = document.createElement('div');
    row.className = 'layer-item' + (i === layers.selected ? ' active' : '');
    row.dataset.layerIndex = i;

    const eye = document.createElement('div');
    const eff = effectiveVis(i);
    eye.className = 'layer-eye' + (L.visible ? '' : ' off');
    eye.innerHTML = L.visible
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><path d="M1 1l22 22"/></svg>';
    eye.onclick = (e) => {
      e.stopPropagation();
      if (L.locked) { msg('Locked layer', 'err'); return; }
      L.visible = !L.visible; renderAll(); updateLayersUI(); pushHistory();
    };

    const thumb = document.createElement('canvas');
    thumb.className = 'layer-thumb';
    thumb.width = 44; thumb.height = 44;
    const tctx = thumb.getContext('2d');
    if (L.canvas.width > 0 && L.canvas.height > 0) {
      const s = Math.min(44/L.canvas.width, 44/L.canvas.height);
      const w = L.canvas.width*s, h = L.canvas.height*s;
      tctx.drawImage(L.canvas, (44-w)/2, (44-h)/2, w, h);
    }

    const name = document.createElement('div');
    name.className = 'layer-name';
    let prefix = '';
    if (L.locked) prefix += '🔒 ';
    if (L.text) prefix += 'T  ';
    name.textContent = prefix + L.name;

    const grip = document.createElement('div');
    grip.className = 'layer-grip';
    grip.textContent = '⋮⋮';

    row.appendChild(eye);
    row.appendChild(thumb);
    row.appendChild(name);
    row.appendChild(grip);

    row.addEventListener('click', () => selectLayer(i));
    attachLongPressDrag(row, grip, i);
    return row;
  }

  list.appendChild(renderNodes(layers.tree, 0));

  // Selected layer detail panel
  const host = $('selectedBlockHost');
  host.innerHTML = '';
  if (layers.selected >= 0 && layers.selected < layers.list.length) {
    const sel = layers.list[layers.selected];
    const dis = sel.locked ? 'disabled' : '';
    const lockedNote = sel.locked
      ? '<div style="font-size:11px;color:var(--accent-warm);margin-bottom:10px;">Locked (looks like a shadow/light effect).</div>'
      : '';
    const isText = !!sel.text;
    const textBlock = isText
      ? `<button class="pill primary" id="selEditText" style="width:100%;margin-bottom:14px;padding:14px;">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-3px;"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
           Edit text
         </button>`
      : '';
    const block = document.createElement('div');
    block.className = 'selected-block';
    block.innerHTML = `
      <div class="hdr">${escapeHtml(sel.name)}${isText ? ' · TEXT' : ''}</div>
      ${lockedNote}
      ${textBlock}
      <div class="num-row">
        <div class="num-input-wrap"><label>Width</label><input type="number" class="num-input" id="selW" value="${sel.canvas.width}" min="1" ${dis}></div>
        <div class="num-input-wrap"><label>Height</label><input type="number" class="num-input" id="selH" value="${sel.canvas.height}" min="1" ${dis}></div>
      </div>
      <label class="toggle-row" style="padding:4px 0;"><span>Lock aspect</span><input type="checkbox" id="selKeep" checked style="width:20px;height:20px;accent-color:var(--accent);" ${dis}></label>
      <button class="pill primary" id="selApply" style="width:100%;margin-bottom:14px;" ${dis}>Apply Size</button>

      <button class="pill" id="selReplace" style="width:100%;margin-bottom:14px;" ${dis}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
        Replace image in this layer
      </button>

      <div class="row-label" style="margin-bottom:6px;"><div class="name">Opacity</div><div class="val" id="selOpVal">${Math.round(sel.opacity*100)}</div></div>
      <input type="range" id="selOp" min="0" max="100" value="${Math.round(sel.opacity*100)}" ${dis}>

      <label style="display:block;margin:14px 0 4px;font-size:11px;color:var(--ink-faint);letter-spacing:0.1em;text-transform:uppercase;">Blend</label>
      <select id="selBlend" ${dis}></select>

      <div class="grid-3" style="margin-top:12px;">
        <button class="pill" id="layerUp" ${dis}>▲ Up</button>
        <button class="pill" id="layerDown" ${dis}>▼ Down</button>
        <button class="pill danger" id="layerDel" ${dis}>Delete</button>
      </div>
    `;
    host.appendChild(block);

    const bs = $('selBlend');
    Object.keys(BLEND_MAP).forEach(m => {
      const o = document.createElement('option'); o.value = m; o.textContent = m;
      if (m === sel.blendMode) o.selected = true; bs.appendChild(o);
    });
    bs.onchange = (e) => { sel.blendMode = e.target.value; renderAll(); pushHistory(); };

    const selW = $('selW'), selH = $('selH'), selKeep = $('selKeep');
    if (selW && selH && !sel.locked) {
      const ratio = sel.canvas.width / sel.canvas.height;
      selW.addEventListener('input', () => { if (selKeep.checked) selH.value = Math.max(1, Math.round(Number(selW.value)/ratio)); });
      selH.addEventListener('input', () => { if (selKeep.checked) selW.value = Math.max(1, Math.round(Number(selH.value)*ratio)); });
      $('selApply').onclick = () => {
        const w = Number(selW.value)||sel.canvas.width, h = Number(selH.value)||sel.canvas.height;
        sel.canvas = resampleCanvas(sel.canvas, w, h);
        renderAll(); updateLayersUI(); pushHistory();
        msg('Resized', 'ok');
      };
    }

    const op = $('selOp');
    op.oninput = (e) => { sel.opacity = +e.target.value/100; $('selOpVal').textContent = e.target.value; renderAll(); };
    op.onchange = () => pushHistory();

    $('layerUp').onclick = () => {
      moveLayerInTree(layers.selected, +1);
    };
    $('layerDown').onclick = () => {
      moveLayerInTree(layers.selected, -1);
    };
    $('layerDel').onclick = () => {
      if (!confirm('Delete "' + sel.name + '"?')) return;
      layers.list.splice(layers.selected, 1);
      // Also remove from tree
      removeLayerFromTree(layers.selected);
      // Bump down all leaf indices > the removed one
      reindexAfterDeletion(layers.selected);
      layers.selected = Math.min(layers.selected, layers.list.length-1);
      renderAll(); updateLayersUI(); pushHistory();
    };

    const selReplace = $('selReplace');
    if (selReplace && !sel.locked) {
      selReplace.onclick = () => { replaceMode = true; $('fileInput').click(); };
    }
    const editBtn = $('selEditText');
    if (editBtn) editBtn.onclick = () => openTextEditor();
  }
}

// Helpers for tree maintenance after layer deletion
function removeLayerFromTree(layerIndex) {
  const remove = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === 'layer' && n.layerIndex === layerIndex) { nodes.splice(i, 1); return true; }
      if (n.kind === 'group' && remove(n.children)) return true;
    }
    return false;
  };
  remove(layers.tree);
}
function reindexAfterDeletion(removedAt) {
  const fix = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'layer' && n.layerIndex > removedAt) n.layerIndex--;
      else if (n.kind === 'group') fix(n.children);
    }
  };
  fix(layers.tree);
}

// ─── Text editor ────────────────────────────────────────────────────────
// When true, the next image picked from the file input replaces the selected
// layer's bitmap (fitted into its current bounds) instead of being added.
let replaceMode = false;

let editingTextLayer = null;
let textEditBackup = null;  // Backup of original text data

function openTextEditor() {
  const sel = layers.list[layers.selected];
  if (!sel) { msg('No layer selected', 'err'); return; }
  // If layer has no text data, treat as adding text to a non-text layer (rare)
  if (!sel.text) {
    sel.text = {
      value: 'New text',
      fontFamily: activeCustomFont || 'BPG Paata Caps',
      fontSize: 32,
      color: '#000000',
      bold: false, italic: false, align: 'left', lineHeight: 1.2
    };
  }
  editingTextLayer = sel;

  // Create a backup of the original text data
  textEditBackup = {
    value: sel.text.value,
    fontFamily: sel.text.fontFamily,
    fontSize: sel.text.fontSize,
    color: sel.text.color,
    bold: sel.text.bold,
    italic: sel.text.italic,
    align: sel.text.align,
    lineHeight: sel.text.lineHeight
  };

  // Populate sheet inputs
  $('teValue').value = sel.text.value;
  $('teSize').value = sel.text.fontSize;
  $('teSizeVal').textContent = sel.text.fontSize;
  $('teColor').value = sel.text.color;
  $('teColorHex').textContent = sel.text.color.toUpperCase();
  $('teColorDisplay').style.background = sel.text.color;
  $('teBold').classList.toggle('active', !!sel.text.bold);
  $('teItalic').classList.toggle('active', !!sel.text.italic);
  $('teAlignL').classList.toggle('active', sel.text.align === 'left');
  $('teAlignC').classList.toggle('active', sel.text.align === 'center');
  $('teAlignR').classList.toggle('active', sel.text.align === 'right');
  refreshFontList();

  openSheet('textedit');
}

function refreshFontList() {
  const list = $('teFontList');
  list.innerHTML = '';
  const families = ['BPG Paata Caps', 'Fraunces', ...Object.keys(customFonts)];
  // Dedupe while preserving order
  const seen = new Set(); const uniqueFamilies = [];
  for (const f of families) { if (!seen.has(f)) { seen.add(f); uniqueFamilies.push(f); } }
  for (const fam of uniqueFamilies) {
    const b = document.createElement('div');
    b.className = 'font-pill' + (editingTextLayer && editingTextLayer.text.fontFamily === fam ? ' active' : '');
    b.style.fontFamily = `"${fam}", sans-serif`;
    b.textContent = fam;
    b.onclick = () => {
      if (!editingTextLayer) return;
      editingTextLayer.text.fontFamily = fam;
      refreshFontList();
    };
    list.appendChild(b);
  }
}

// Wire text editor controls
$('teValue').addEventListener('input', (e) => {
  if (editingTextLayer) editingTextLayer.text.value = e.target.value;
});
$('teSize').addEventListener('input', (e) => {
  $('teSizeVal').textContent = e.target.value;
  if (editingTextLayer) editingTextLayer.text.fontSize = +e.target.value;
});
$('teColor').addEventListener('input', (e) => {
  const hex = e.target.value;
  $('teColorHex').textContent = hex.toUpperCase();
  $('teColorDisplay').style.background = hex;
  if (editingTextLayer) editingTextLayer.text.color = hex;
});
$('teBold').onclick = () => { if (!editingTextLayer) return; editingTextLayer.text.bold = !editingTextLayer.text.bold; $('teBold').classList.toggle('active'); };
$('teItalic').onclick = () => { if (!editingTextLayer) return; editingTextLayer.text.italic = !editingTextLayer.text.italic; $('teItalic').classList.toggle('active'); };
function setAlign(a) {
  if (!editingTextLayer) return;
  editingTextLayer.text.align = a;
  $('teAlignL').classList.toggle('active', a === 'left');
  $('teAlignC').classList.toggle('active', a === 'center');
  $('teAlignR').classList.toggle('active', a === 'right');
}
$('teAlignL').onclick = () => setAlign('left');
$('teAlignC').onclick = () => setAlign('center');
$('teAlignR').onclick = () => setAlign('right');

$('teSave').onclick = () => {
  if (!editingTextLayer) { closeAllSheets(); return; }
  // Re-rasterise. Preserve layer's top-left position by anchoring the new
  // canvas at the same `left, top`. (Width/height auto-fit the text.)
  refreshTextLayer(editingTextLayer);
  renderAll(); updateLayersUI(); pushHistory();
  msg('Text saved', 'ok');
  editingTextLayer = null;
  textEditBackup = null;
  closeAllSheets();
};

$('teCancel').onclick = () => {
  if (!editingTextLayer || !textEditBackup) { closeAllSheets(); return; }
  // Restore from backup — user pressed cancel so changes are thrown away
  editingTextLayer.text.value = textEditBackup.value;
  editingTextLayer.text.fontFamily = textEditBackup.fontFamily;
  editingTextLayer.text.fontSize = textEditBackup.fontSize;
  editingTextLayer.text.color = textEditBackup.color;
  editingTextLayer.text.bold = textEditBackup.bold;
  editingTextLayer.text.italic = textEditBackup.italic;
  editingTextLayer.text.align = textEditBackup.align;
  editingTextLayer.text.lineHeight = textEditBackup.lineHeight;

  msg('Changes cancelled', 'ok');
  editingTextLayer = null;
  textEditBackup = null;
  closeAllSheets();
};

// Font upload
$('teUploadFont').onclick = () => $('fontInput').click();
$('fontInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) {
    await loadCustomFontFile(f);
    refreshFontList();
  }
  e.target.value = '';
});

async function replaceImageInSelectedLayer(file) {
  const sel = layers.list[layers.selected];
  if (!sel || sel.locked) { msg('No editable layer to replace', 'err'); return; }
  try {
    const img = await loadImageElement(file);

    // Contain-fit to the full canvas: scale the image so it touches one edge
    // (whichever runs out first), preserving aspect ratio. No cropping, no
    // forced margins.
    const s = Math.min(layers.docW / img.width, layers.docH / img.height);
    const dispW = Math.max(2, Math.round(img.width  * s));
    const dispH = Math.max(2, Math.round(img.height * s));

    // Build the new bitmap at the chosen size
    const fresh = makeCanvas(dispW, dispH);
    const fc = fresh.getContext('2d');
    fc.imageSmoothingEnabled = true; fc.imageSmoothingQuality = 'high';
    fc.drawImage(img, 0, 0, dispW, dispH);
    sel.canvas = fresh;

    // Center on the CANVAS, not on the old layer's center — old layers may
    // have been tiny frames in odd positions, which led to off-screen drops.
    sel.left = Math.round((layers.docW - dispW) / 2);
    sel.top  = Math.round((layers.docH - dispH) / 2);

    // Discard any stale resize preview pointing at the old bitmap
    if (sel._preview) delete sel._preview;

    renderAll(); updateLayersUI(); pushHistory();
    msg('Image replaced — resize as needed', 'ok');
  } catch (err) {
    console.error(err); msg('Replace failed: ' + err.message, 'err');
  }
}

// ─── Long-press drag reorder for layers (touch + mouse) ─────────────────
// Clean rewrite with:
//   • Long-press to begin (350ms) — prevents accidental reorders
//   • A bright accent line shows exactly where the layer will land
//   • Auto-scroll when the finger nears the top/bottom of the sheet body
//   • Clear displayed-index ↔ stack-index conversion
function attachLongPressDrag(row, gripEl, layerStackIndex) {
  let pressTimer = null;
  let dragging = false;
  let placeholder = null;
  let listEl = $('layersList');
  let scrollHost = listEl.closest('.sheet-body') || listEl.parentElement;
  let pointerOffsetY = 0;   // where in the row the finger started (for natural feel)
  let autoScrollRAF = null;
  let lastClientY = 0;
  let dropDisplayIdx = -1;  // computed insertion index in displayed order

  const begin = (clientY) => {
    if (layers.list[layerStackIndex]?.locked) return;
    dragging = true;
    const rect = row.getBoundingClientRect();
    pointerOffsetY = clientY - rect.top;

    // Build placeholder where the row currently is
    placeholder = document.createElement('div');
    placeholder.className = 'layer-placeholder';
    placeholder.style.height = rect.height + 'px';
    placeholder.style.borderRadius = '12px';
    placeholder.style.background = 'rgba(212,255,58,0.08)';
    placeholder.style.border = '2px dashed var(--accent)';
    placeholder.style.boxSizing = 'border-box';
    row.parentNode.insertBefore(placeholder, row);

    // Lift the row to a fixed position so it follows the finger
    row.classList.add('dragging');
    row.style.position = 'fixed';
    row.style.left = rect.left + 'px';
    row.style.top  = (clientY - pointerOffsetY) + 'px';
    row.style.width = rect.width + 'px';
    row.style.zIndex = '60';
    row.style.pointerEvents = 'none';

    if (navigator.vibrate) navigator.vibrate(15);
    msg('Move layer…');
  };

  const updateDropTarget = (clientY) => {
    // All layer-item rows (excluding the dragged one), in displayed order
    const items = Array.from(listEl.querySelectorAll('.layer-item')).filter(r => r !== row);
    let inserted = false;
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const rect = r.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        listEl.insertBefore(placeholder, r);
        dropDisplayIdx = i;
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      listEl.appendChild(placeholder);
      dropDisplayIdx = items.length;
    }
  };

  const handleAutoScroll = (clientY) => {
    if (!scrollHost) return;
    const hostRect = scrollHost.getBoundingClientRect();
    const EDGE = 60; // px from edge to start scrolling
    const MAX_SPEED = 14;
    let speed = 0;
    if (clientY < hostRect.top + EDGE) {
      speed = -MAX_SPEED * ((hostRect.top + EDGE - clientY) / EDGE);
    } else if (clientY > hostRect.bottom - EDGE) {
      speed = MAX_SPEED * ((clientY - (hostRect.bottom - EDGE)) / EDGE);
    }
    if (speed !== 0) {
      scrollHost.scrollTop += speed;
    }
  };

  const move = (clientY) => {
    if (!dragging) return;
    lastClientY = clientY;
    row.style.top = (clientY - pointerOffsetY) + 'px';
    updateDropTarget(clientY);
    handleAutoScroll(clientY);
    // Keep auto-scrolling on RAF while finger is held near edge (even without movement)
    if (!autoScrollRAF) {
      const tick = () => {
        if (!dragging) { autoScrollRAF = null; return; }
        handleAutoScroll(lastClientY);
        updateDropTarget(lastClientY);
        autoScrollRAF = requestAnimationFrame(tick);
      };
      autoScrollRAF = requestAnimationFrame(tick);
    }
  };

  const finish = (commit) => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
    if (!dragging) return;
    dragging = false;

    // Reset row styling
    row.style.position = ''; row.style.left = ''; row.style.top = '';
    row.style.width = ''; row.style.zIndex = ''; row.style.pointerEvents = '';
    row.classList.remove('dragging');

    if (commit && placeholder && placeholder.parentNode && dropDisplayIdx >= 0) {
      // Tree-aware reorder.
      // The displayed list (top-of-stack first) is built by walking the tree
      // in reverse. Drop-display-idx tells us where among the *currently
      // displayed leaves* the placeholder sits.
      // We rebuild the tree from scratch: take the leaf out, then insert it
      // at the new position. Only top-level reordering is supported via drag
      // — moving a layer between groups would require a different gesture.

      // Find the moving leaf node and its current parent in the tree
      const treeInfo = findLeafContext(layers.tree, layerStackIndex);
      if (treeInfo) {
        const { parentArray, indexInParent } = treeInfo;
        const movingNode = parentArray[indexInParent];

        // Compute the *flat* sequence of displayed leaves so we know where
        // the placeholder lands. This walks the same way renderNodes() does.
        const displayedLeaves = collectDisplayedLeaves(layers.tree);
        // displayedLeaves[i] = { layerIndex, parentArray, indexInParent }
        // The placeholder sits at dropDisplayIdx among these (with the moving
        // leaf already excluded from the layout DOM).
        const filtered = displayedLeaves.filter(d => d.layerIndex !== layerStackIndex);

        // Remove from its current parent
        parentArray.splice(indexInParent, 1);

        // Determine target parent + insertion index.
        // Place at root level (sibling of whatever leaf the placeholder is next to)
        let targetParent = layers.tree;
        let targetIdx = 0; // root array, insert position

        if (filtered.length > 0) {
          // The displayed list is reversed relative to tree order.
          // dropDisplayIdx === 0 → top of display → end of root array (highest stack).
          // dropDisplayIdx === filtered.length → bottom of display → start of root.
          const neighbor = filtered[Math.max(0, Math.min(dropDisplayIdx, filtered.length - 1))];
          targetParent = neighbor.parentArray;
          // Find where neighbor currently sits in its parent (may have shifted after removal)
          const neighborIdx = neighbor.parentArray.indexOf(
            neighbor.parentArray.find(n => n.kind === 'layer' && n.layerIndex === neighbor.layerIndex)
          );
          // If we drop ABOVE the neighbor in display (smaller dropDisplayIdx), we
          // want HIGHER stack position → AFTER neighbor in tree array.
          if (dropDisplayIdx <= filtered.indexOf(neighbor)) {
            targetIdx = neighborIdx + 1;
          } else {
            targetIdx = neighborIdx;
          }
          // Safety clamp
          targetIdx = Math.max(0, Math.min(targetIdx, targetParent.length));
        } else {
          targetParent = layers.tree;
          targetIdx = layers.tree.length;
        }

        targetParent.splice(targetIdx, 0, movingNode);
        layers.selected = layerStackIndex; // index in layers.list didn't change
        pushHistory();
        msg('Layer moved', 'ok');
      }
    }

    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    placeholder = null;
    dropDisplayIdx = -1;
    renderAll();
    updateLayersUI();
  };

  // Touch path
  row.addEventListener('touchstart', (e) => {
    if (layers.list[layerStackIndex]?.locked) return;
    if (e.touches.length > 1) return;
    const touch = e.touches[0];
    const startY = touch.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      begin(startY);
    }, 350);
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    // Cancel long-press if user starts scrolling before threshold
    if (pressTimer && !dragging) {
      clearTimeout(pressTimer); pressTimer = null;
      return;
    }
    if (!dragging) return;
    e.preventDefault();
    move(e.touches[0].clientY);
  }, { passive: false });

  row.addEventListener('touchend', () => finish(true));
  row.addEventListener('touchcancel', () => finish(false));

  // Mouse path: only via grip (so click on row body still selects)
  gripEl.addEventListener('mousedown', (e) => {
    if (layers.list[layerStackIndex]?.locked) return;
    e.preventDefault();
    e.stopPropagation();
    begin(e.clientY);
    const onMM = (ev) => move(ev.clientY);
    const onMU = () => {
      window.removeEventListener('mousemove', onMM);
      window.removeEventListener('mouseup', onMU);
      finish(true);
    };
    window.addEventListener('mousemove', onMM);
    window.addEventListener('mouseup', onMU);
  });
}

// ─── History ────────────────────────────────────────────────────────────
// Snapshots are heavy — a full-resolution canvas clone per layer — so we avoid
// re-cloning bitmaps that didn't change between steps. Each snapshot record
// keeps a WeakRef to the LIVE canvas it copied plus a pixel revision; the next
// push reuses the existing (immutable) clone whenever the live layer still
// points at that same canvas with the same revision. A metadata-only edit
// (move, opacity, visibility, reorder…) therefore clones nothing.
//
// Invariant: a layer's pixels change  ⟺  EITHER L.canvas is reassigned to a new
// canvas object (auto-detected here) OR touchLayerPixels(L) is called for an
// in-place draw. Drawing into an EXISTING layer canvas without calling
// touchLayerPixels will make undo/redo show stale pixels.
function touchLayerPixels(L) { if (L) L._rev = (L._rev || 0) + 1; }

// Cap on retained snapshot pixels (shared clones counted once). Protects
// low-memory phones from OOM when editing large multi-layer documents.
const HISTORY_PIXEL_BUDGET_BYTES = 192 * 1024 * 1024;

function snapshotLayers(prevEntry) {
  // Reuse map: live-canvas object → its record in the step we're branching from.
  const reuse = new Map();
  if (prevEntry) for (const r of prevEntry.layers) {
    const src = r.srcRef && r.srcRef.deref();
    if (src) reuse.set(src, r);
  }
  return layers.list.map(L => {
    const rev = L._rev || 0;
    const prev = reuse.get(L.canvas);
    let clone;
    if (prev && prev.rev === rev) {
      clone = prev.canvas;            // bitmap unchanged since last step — share the clone
    } else {
      clone = makeCanvas(L.canvas.width, L.canvas.height);
      clone.getContext('2d').drawImage(L.canvas, 0, 0);
    }
    const out = {
      name: L.name, canvas: clone, srcRef: new WeakRef(L.canvas), rev,
      left: L.left, top: L.top, opacity: L.opacity, visible: L.visible,
      blendMode: L.blendMode, locked: !!L.locked
    };
    if (L.text) out.text = JSON.parse(JSON.stringify(L.text));
    return out;
  });
}
// Deep clone of layers.tree (no canvas refs in tree, so JSON works)
function cloneTree(nodes) {
  return nodes.map(n => {
    if (n.kind === 'group') {
      return { ...n, children: cloneTree(n.children) };
    }
    return { ...n };
  });
}
function historyPixelBytes() {
  // Shared clones (unchanged bitmaps across steps) are counted once.
  const seen = new Set(); let bytes = 0;
  for (const e of state.history) for (const r of e.layers) {
    if (seen.has(r.canvas)) continue;
    seen.add(r.canvas);
    bytes += r.canvas.width * r.canvas.height * 4;
  }
  return bytes;
}
function trimHistory() {
  while (state.history.length > state.maxHistory) state.history.shift();
  // Always keep at least one step so the current state stays restorable.
  while (state.history.length > 1 && historyPixelBytes() > HISTORY_PIXEL_BUDGET_BYTES) {
    state.history.shift();
  }
}
function pushHistory() {
  if (!state.hasContent) return;
  const prevEntry = state.history[state.historyIndex];   // step we're branching from (may be undefined)
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push({ layers: snapshotLayers(prevEntry), tree: cloneTree(layers.tree), selected: layers.selected, docW: layers.docW, docH: layers.docH });
  trimHistory();
  state.historyIndex = state.history.length - 1;
}
function undo() {
  if (state.historyIndex <= 0) { msg('Nothing to undo'); return; }
  state.historyIndex--; restoreHistory(); msg('Undone', 'ok');
}
function redo() {
  if (state.historyIndex >= state.history.length - 1) { msg('Nothing to redo'); return; }
  state.historyIndex++; restoreHistory(); msg('Redone', 'ok');
}
function restoreHistory() {
  const e = state.history[state.historyIndex]; if (!e) return;
  // An in-progress text edit / move-resize transaction points at layer objects
  // we're about to replace below. Abandon it so a later Save doesn't write to a
  // detached layer and stale Done/Cancel buttons don't linger.
  if (editingTextLayer) {
    editingTextLayer = null; textEditBackup = null;
    const teSheet = $('sheet-textedit');
    if (teSheet && teSheet.classList.contains('open')) closeAllSheets();
  }
  if (state.edit.active) {
    state.edit.active = false; state.edit.layerIndex = -1; state.edit.snapshot = null;
    editActionsEl.classList.remove('visible');
  }
  layers.list = e.layers.map(r => {
    const c = makeCanvas(r.canvas.width, r.canvas.height); c.getContext('2d').drawImage(r.canvas, 0, 0);
    // Build a fresh live layer — don't spread the record (it carries srcRef/rev
    // and a shared text object that live edits must not mutate).
    const L = {
      name: r.name, canvas: c, left: r.left, top: r.top, opacity: r.opacity,
      visible: r.visible, blendMode: r.blendMode, locked: !!r.locked, _rev: r.rev || 0
    };
    if (r.text) L.text = JSON.parse(JSON.stringify(r.text));
    return L;
  });
  layers.tree = e.tree ? cloneTree(e.tree) : (buildFlatTree(), layers.tree);
  layers.selected = e.selected;
  if (e.docW && e.docH) {
    layers.docW = e.docW; layers.docH = e.docH;
    canvas.width = e.docW; canvas.height = e.docH;
  }
  renderAll(); updateLayersUI(); fitStage();
}
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;

// ─── Robust mobile-friendly file save ───────────────────────────────────
// On mobile (especially iOS Safari), <a download> with a data URL often
// silently fails. Use Blob + URL.createObjectURL + Web Share API where
// available, fall back to opening in a new tab so the user can long-press.
async function saveBlob(blob, filename) {
  // Try Web Share API with files (iOS 15+, Android Chrome)
  if (navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (err) {
      // User cancelled, or share failed — fall through
      if (err && err.name === 'AbortError') return 'cancelled';
      console.warn('Share failed, falling back:', err);
    }
  }
  // Try the standard <a download> path
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Some iOS versions need the link in the DOM
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Cleanup after a moment
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}

function canvasToBlob(c, type, quality) {
  return new Promise((resolve, reject) => {
    if (c.toBlob) {
      c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), type || 'image/png', quality);
    } else {
      // Fallback: data URL → Blob
      try {
        const url = c.toDataURL(type || 'image/png', quality);
        const bin = atob(url.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: type || 'image/png' }));
      } catch (err) { reject(err); }
    }
  });
}
$('flattenBtn').onclick = () => {
  if (layers.list.length <= 1) { msg('Nothing to flatten'); return; }
  if (!confirm('Flatten all visible layers into one?')) return;
  // Use the same canvas the user sees — render everything in tree order
  // with effective visibility and opacity, into a fresh canvas.
  const flat = makeCanvas(layers.docW, layers.docH);
  const fc = flat.getContext('2d');
  function paint(nodes, parentVisible, parentOpacity) {
    for (const n of nodes) {
      if (n.kind === 'group') {
        paint(n.children, parentVisible && n.visible, parentOpacity * (n.opacity ?? 1));
      } else if (n.kind === 'layer') {
        const L = layers.list[n.layerIndex]; if (!L) continue;
        if (!(parentVisible && L.visible)) continue;
        fc.save();
        fc.globalAlpha = parentOpacity * L.opacity;
        fc.globalCompositeOperation = BLEND_MAP[L.blendMode] || 'source-over';
        fc.drawImage(L.canvas, L.left || 0, L.top || 0);
        fc.restore();
      }
    }
  }
  if (layers.tree && layers.tree.length) paint(layers.tree, true, 1);
  else for (const L of layers.list) {
    if (!L.visible) continue;
    fc.save(); fc.globalAlpha = L.opacity; fc.globalCompositeOperation = BLEND_MAP[L.blendMode]||'source-over';
    fc.drawImage(L.canvas, L.left||0, L.top||0); fc.restore();
  }
  layers.list = [{ name: 'Flattened', canvas: flat, left: 0, top: 0, opacity: 1, visible: true, blendMode: 'normal', locked: false }];
  layers.tree = [{ kind: 'layer', layerIndex: 0 }];
  layers.selected = 0;
  renderAll(); updateLayersUI(); pushHistory(); msg('Flattened', 'ok');
};

$('saveBtn').onclick = () => {
  if (!state.hasContent) { msg('Nothing to save', 'err'); return; }
  openSheet('save');
};
// Render a CLEAN composite of all visible layers into a fresh canvas — no
// selection outline, no resize handles, no editing UI. Used by export paths
// so the saved file matches exactly what the user sees minus the editing chrome.
function buildCleanComposite() {
  const clean = makeCanvas(layers.docW, layers.docH);
  const cctx = clean.getContext('2d');
  function paint(nodes, parentVisible, parentOpacity) {
    for (const n of nodes) {
      if (n.kind === 'group') {
        paint(n.children, parentVisible && n.visible, parentOpacity * (n.opacity ?? 1));
      } else if (n.kind === 'layer') {
        const L = layers.list[n.layerIndex]; if (!L) continue;
        if (!(parentVisible && L.visible)) continue;
        cctx.save();
        cctx.globalAlpha = parentOpacity * L.opacity;
        cctx.globalCompositeOperation = BLEND_MAP[L.blendMode] || 'source-over';
        if (L._preview) {
          cctx.drawImage(L._preview.source, L._preview.left, L._preview.top, L._preview.width, L._preview.height);
        } else {
          cctx.drawImage(L.canvas, L.left || 0, L.top || 0);
        }
        cctx.restore();
      }
    }
  }
  if (layers.tree && layers.tree.length) {
    paint(layers.tree, true, 1);
  } else {
    for (const L of layers.list) {
      if (!L.visible) continue;
      cctx.save();
      cctx.globalAlpha = L.opacity;
      cctx.globalCompositeOperation = BLEND_MAP[L.blendMode] || 'source-over';
      if (L._preview) {
        cctx.drawImage(L._preview.source, L._preview.left, L._preview.top, L._preview.width, L._preview.height);
      } else {
        cctx.drawImage(L.canvas, L.left || 0, L.top || 0);
      }
      cctx.restore();
    }
  }
  return clean;
}

$('saveAsPng').onclick = async () => {
  const a = state.adjust;
  const has = a.brightness!==100||a.contrast!==100||a.saturation!==100||a.blur!==0;

  // Clean composite — no selection outline, no handles
  const clean = buildCleanComposite();

  let out = clean;
  if (has) {
    const t = makeCanvas(clean.width, clean.height); const tc = t.getContext('2d');
    tc.filter = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%) blur(${a.blur}px)`;
    tc.drawImage(clean, 0, 0); out = t;
  }
  msg('Saving…');
  try {
    const blob = await canvasToBlob(out, 'image/png');
    const filename = 'vardiko-' + Date.now() + '.png';
    const result = await saveBlob(blob, filename);
    if (result === 'shared') msg('Shared!', 'ok');
    else if (result === 'cancelled') msg('Save cancelled');
    else msg('Saved as PNG', 'ok');
    closeAllSheets();
  } catch (err) {
    console.error(err); msg('Save failed: ' + err.message, 'err');
  }
};
$('saveAsPsd').onclick = $('exportPsdBtn').onclick = async () => {
  if (!state.hasContent) { msg('Nothing to save', 'err'); return; }
  if (typeof agPsd === 'undefined' || !agPsd.writePsd) { msg('PSD lib not loaded', 'err'); return; }
  try {
    // Walk our tree → ag-psd's nested children format.
    function buildPsdNodes(nodes) {
      const out = [];
      for (const n of nodes) {
        if (n.kind === 'group') {
          out.push({
            name: n.name,
            opened: !!n.expanded,
            opacity: n.opacity ?? 1,   // ag-psd expects 0–1, same as our internal scale
            hidden: !n.visible,
            children: buildPsdNodes(n.children)
          });
        } else if (n.kind === 'layer') {
          const L = layers.list[n.layerIndex];
          if (!L) continue;
          out.push({
            name: L.name, canvas: L.canvas,
            left: L.left || 0, top: L.top || 0,
            opacity: L.opacity,   // ag-psd expects 0–1, same as our internal scale
            hidden: !L.visible, blendMode: L.blendMode,
            locked: !!L.locked
          });
        }
      }
      return out;
    }
    const psd = {
      width: layers.docW, height: layers.docH,
      children: (layers.tree && layers.tree.length)
        ? buildPsdNodes(layers.tree)
        : layers.list.map(L => ({
            name: L.name, canvas: L.canvas, left: L.left||0, top: L.top||0,
            opacity: L.opacity, hidden: !L.visible, blendMode: L.blendMode, locked: !!L.locked
          })),
      canvas: buildCleanComposite()
    };
    const buf = agPsd.writePsd(psd);
    const blob = new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
    const filename = 'vardiko-' + Date.now() + '.psd';
    const result = await saveBlob(blob, filename);
    if (result === 'shared') msg('Shared!', 'ok');
    else if (result === 'cancelled') msg('Save cancelled');
    else msg('Saved as PSD', 'ok');
    closeAllSheets();
  } catch (err) { console.error(err); msg('PSD error: ' + err.message, 'err'); }
};

// ─── Sheet management ───────────────────────────────────────────────────
const backdrop = $('sheetBackdrop');
function openSheet(name) {
  closeAllSheets();
  const sheet = $('sheet-' + name);
  if (!sheet) return;
  sheet.classList.add('open');
  backdrop.classList.add('open');
  document.querySelectorAll('.dock-btn[data-sheet]').forEach(b => b.classList.toggle('active', b.dataset.sheet === name));
}
function closeAllSheets() {
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open'));
  backdrop.classList.remove('open');
  document.querySelectorAll('.dock-btn[data-sheet]').forEach(b => b.classList.remove('active'));
}
document.querySelectorAll('.dock-btn[data-sheet]').forEach(b => {
  b.addEventListener('click', () => openSheet(b.dataset.sheet));
});
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeAllSheets));
backdrop.addEventListener('click', closeAllSheets);

// Swipe-down on sheet handle to dismiss
document.querySelectorAll('.sheet-handle').forEach(h => {
  let y0 = 0;
  h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  h.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - y0;
    if (dy > 60) closeAllSheets();
  }, { passive: true });
});

// ─── Notes ──────────────────────────────────────────────────────────────
// Pre-baked snippets — tap any to copy it to the clipboard.
const NOTES = [
  '📌 გვერდის ოფიციალური პარტნიორია 𝙗𝙚𝙡𝙞𝙫𝙚.𝙜𝙚',
  '🚨 𝐎𝐅𝐅𝐈𝐂𝐈𝐀𝐋:',
  '🚨 𝐁𝐑𝐄𝐀𝐊𝐈𝐍𝐆 𝐍𝐄𝐖𝐒 :',
  '🚨 𝐓𝐑𝐀𝐍𝐒𝐅𝐄𝐑 𝐍𝐄𝐖𝐒 :',
  '🚨 𝗖𝗥𝗔𝗭𝗬 𝗙𝗔𝗖𝗧:'
];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    msg('Copied to clipboard', 'ok');
  } catch (err) {
    // Fallback for browsers without async clipboard / non-HTTPS contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); msg('Copied', 'ok'); }
    catch (_) { msg('Copy failed', 'err'); }
    document.body.removeChild(ta);
  }
}

function renderNotes() {
  const list = $('notesList');
  if (!list) return;
  list.innerHTML = '';
  for (const text of NOTES) {
    const row = document.createElement('div');
    row.className = 'note-row';
    row.onclick = () => copyText(text);
    row.addEventListener('touchstart', () => row.classList.add('press'), { passive: true });
    row.addEventListener('touchend', () => row.classList.remove('press'), { passive: true });
    row.addEventListener('touchcancel', () => row.classList.remove('press'), { passive: true });

    const body = document.createElement('div');
    body.className = 'note-body';
    body.textContent = text;

    const icon = document.createElement('div');
    icon.className = 'note-icon';
    icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

    row.appendChild(body);
    row.appendChild(icon);
    list.appendChild(row);
  }
}

renderNotes();

// Initial paint
renderAll();
