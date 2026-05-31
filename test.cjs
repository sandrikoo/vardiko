// Pure-logic tests for core.js.  Run:  node test.cjs
const assert = require('node:assert');
const {
  clamp, isProtectedLayerName, normalizeOpacity, escapeHtml,
  findLeafContext, collectDisplayedLeaves, findPathToLayer, computeResizeBounds
} = require('./core.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n      ' + e.message); }
}

test('clamp keeps values within bounds', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-3, 0, 10), 0);
  assert.strictEqual(clamp(99, 0, 10), 10);
});

test('normalizeOpacity: 0-1 passthrough, >1 treated as 0-255, null/undefined -> 1', () => {
  assert.strictEqual(normalizeOpacity(0.5), 0.5);
  assert.strictEqual(normalizeOpacity(1), 1);
  assert.strictEqual(normalizeOpacity(255), 1);
  assert.strictEqual(normalizeOpacity(128), 128 / 255);
  assert.strictEqual(normalizeOpacity(null), 1);
  assert.strictEqual(normalizeOpacity(undefined), 1);
});

test('isProtectedLayerName matches effect-layer names only', () => {
  assert.ok(isProtectedLayerName('Drop Shadow'));
  assert.ok(isProtectedLayerName('BG'));
  assert.ok(isProtectedLayerName('texture 2'));
  assert.ok(!isProtectedLayerName('Player Name'));
  assert.ok(!isProtectedLayerName(''));
  assert.ok(!isProtectedLayerName(null));
});

test('escapeHtml escapes the five HTML-sensitive characters', () => {
  assert.strictEqual(
    escapeHtml(`<a href="x">&'</a>`),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'
  );
});

// Small tree:  root[ groupA(expanded)[ leaf0 ], leaf1 ]
const tree = [
  { kind: 'group', name: 'A', expanded: true, children: [{ kind: 'layer', layerIndex: 0 }] },
  { kind: 'layer', layerIndex: 1 },
];

test('findLeafContext locates a leaf and its parent array', () => {
  const c0 = findLeafContext(tree, 0);
  assert.strictEqual(c0.parentArray, tree[0].children);
  assert.strictEqual(c0.indexInParent, 0);
  const c1 = findLeafContext(tree, 1);
  assert.strictEqual(c1.parentArray, tree);
  assert.strictEqual(c1.indexInParent, 1);
  assert.strictEqual(findLeafContext(tree, 99), null);
});

test('findPathToLayer returns the root-to-leaf node chain', () => {
  const p = findPathToLayer(tree, 0);
  assert.strictEqual(p.length, 2);
  assert.strictEqual(p[0], tree[0]);        // group A
  assert.strictEqual(p[1].layerIndex, 0);   // the leaf
  assert.strictEqual(findPathToLayer(tree, 1).length, 1);
  assert.strictEqual(findPathToLayer(tree, 99), null);
});

test('collectDisplayedLeaves: top-of-stack first, collapsed groups hidden', () => {
  assert.deepStrictEqual(collectDisplayedLeaves(tree).map(d => d.layerIndex), [1, 0]);
  const collapsed = [
    { kind: 'group', name: 'A', expanded: false, children: [{ kind: 'layer', layerIndex: 0 }] },
    { kind: 'layer', layerIndex: 1 },
  ];
  assert.deepStrictEqual(collectDisplayedLeaves(collapsed).map(d => d.layerIndex), [1]);
});

const SB = { left: 0, top: 0, width: 100, height: 50 };
test('computeResizeBounds: east edge grows width by dx', () => {
  const b = computeResizeBounds('e', SB, { x: 0, y: 0 }, { x: 20, y: 0 }, false);
  assert.deepStrictEqual(b, { left: 0, top: 0, width: 120, height: 50 });
});

test('computeResizeBounds: west edge moves left and shrinks width', () => {
  const b = computeResizeBounds('w', SB, { x: 0, y: 0 }, { x: 30, y: 0 }, false);
  assert.strictEqual(b.left, 30);
  assert.strictEqual(b.width, 70);
});

test('computeResizeBounds: MIN clamp prevents collapse/inversion', () => {
  const b = computeResizeBounds('e', SB, { x: 0, y: 0 }, { x: -200, y: 0 }, false);
  assert.strictEqual(b.width, 4);
});

test('computeResizeBounds: corner with aspect lock preserves the 2:1 ratio', () => {
  const b = computeResizeBounds('se', SB, { x: 0, y: 0 }, { x: 50, y: 0 }, true);
  assert.ok(Math.abs((b.width / b.height) - 2) < 1e-9);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
