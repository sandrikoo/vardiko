// ─── core.js — pure, DOM-free helpers ───────────────────────────────────
// Loaded as a plain <script> BEFORE app.js, so these become globals the rest
// of the app uses. The CommonJS export at the bottom lets test.cjs import them
// in Node (in the browser `module` is undefined, so the export is skipped).
// Everything here MUST stay pure: no DOM, no `state`/`layers` globals.

function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }

function isProtectedLayerName(name) { return /\b(shadow|light|glow|highlight|lighting|bg|background|texture|textures)\b/i.test(name || ''); }

function normalizeOpacity(v) { if (v == null) return 1; return v > 1 ? v / 255 : v; }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Find a leaf node by layerIndex; returns { parentArray, indexInParent } or null.
function findLeafContext(nodes, layerIndex) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'layer' && n.layerIndex === layerIndex) {
      return { parentArray: nodes, indexInParent: i };
    }
    if (n.kind === 'group') {
      const sub = findLeafContext(n.children, layerIndex);
      if (sub) return sub;
    }
  }
  return null;
}

// Collect leaves in panel display order (top-of-stack first). Each entry: { layerIndex, parentArray }.
// Collapsed groups are skipped (their children aren't displayed).
function collectDisplayedLeaves(nodes) {
  const out = [];
  function walk(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i];
      if (n.kind === 'group') {
        if (n.expanded) walk(n.children);
      } else if (n.kind === 'layer') {
        out.push({ layerIndex: n.layerIndex, parentArray: arr });
      }
    }
  }
  walk(nodes);
  return out;
}

// Ancestor chain to a leaf: list of nodes (groups + the layer) from root to leaf, or null.
function findPathToLayer(nodes, layerIndex) {
  for (const n of nodes) {
    if (n.kind === 'layer' && n.layerIndex === layerIndex) return [n];
    if (n.kind === 'group') {
      const sub = findPathToLayer(n.children, layerIndex);
      if (sub) return [n, ...sub];
    }
  }
  return null;
}

// Resize-handle math: given the drag direction, start bounds (sb), start pointer (sp),
// current pointer (p) and an aspect-lock flag, return the new {left,top,width,height}.
function computeResizeBounds(dir, sb, sp, p, lock) {
  let { left, top, width, height } = sb;
  let nL = left, nT = top, nR = left + width, nB = top + height;
  const dx = p.x - sp.x, dy = p.y - sp.y;
  if (dir.includes('w')) nL += dx;
  if (dir.includes('e')) nR += dx;
  if (dir.includes('n')) nT += dy;
  if (dir.includes('s')) nB += dy;
  const MIN = 4;
  if (nR - nL < MIN) { if (dir.includes('w')) nL = nR - MIN; else nR = nL + MIN; }
  if (nB - nT < MIN) { if (dir.includes('n')) nT = nB - MIN; else nB = nT + MIN; }
  let nw = nR - nL, nh = nB - nT;
  if (lock) {
    const ratio = sb.width / sb.height;
    if (['nw','ne','se','sw'].includes(dir)) {
      const rw = nw / sb.width, rh = nh / sb.height;
      const r = Math.abs(rw) > Math.abs(rh) ? rw : rh;
      nw = sb.width * r; nh = sb.height * r;
      if (dir.includes('w')) nL = nR - nw; else nR = nL + nw;
      if (dir.includes('n')) nT = nB - nh; else nB = nT + nh;
    } else if (dir === 'n' || dir === 's') {
      nw = nh * ratio; nL = left + (width - nw) / 2; nR = nL + nw;
    } else {
      nh = nw / ratio; nT = top + (height - nh) / 2; nB = nT + nh;
    }
  }
  return { left: nL, top: nT, width: Math.max(MIN, nR - nL), height: Math.max(MIN, nB - nT) };
}

// Node interop for tests — skipped in the browser, where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clamp, isProtectedLayerName, normalizeOpacity, escapeHtml,
    findLeafContext, collectDisplayedLeaves, findPathToLayer, computeResizeBounds
  };
}
