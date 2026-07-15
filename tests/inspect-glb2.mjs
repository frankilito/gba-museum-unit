/**
 * Deep geometry analysis of gba.glb (read-only):
 *  - screen mesh connected components (find inner LCD rectangle)
 *  - slot groove scan: Y/Z profile of shell verts near the top edge
 * Usage: node inspect-glb2.mjs <glb>
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'public/models/gba.glb';
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8; // skip JSON chunk + BIN chunk header
const bin = buf.slice(binStart, binStart + gltf.buffers[0].byteLength);

const accessorData = (idx) => {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const compSize = { 5126: 4, 5123: 2, 5125: 4, 5121: 1 }[acc.componentType];
  const ncomp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const stride = bv.byteStride ?? compSize * ncomp;
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const base = off + i * stride;
    const v = [];
    for (let c = 0; c < ncomp; c++) {
      const p = base + c * compSize;
      if (acc.componentType === 5126) v.push(bin.readFloatLE(p));
      else if (acc.componentType === 5123) v.push(bin.readUInt16LE(p));
      else if (acc.componentType === 5125) v.push(bin.readUInt32LE(p));
      else v.push(bin.readUInt8(p));
    }
    out.push(v);
  }
  return out;
};

const meshOf = (name) => {
  const node = gltf.nodes.find((n) => n.name === name);
  return node ? gltf.meshes[node.mesh] : null;
};

// ---------- screen mesh connected components ----------
const screen = meshOf('screen');
{
  const prim = screen.primitives[0];
  const pos = accessorData(prim.attributes.POSITION);
  const idx = prim.indices !== undefined ? accessorData(prim.indices).map((v) => v[0]) : pos.map((_, i) => i);
  // union-find over triangles
  const parent = pos.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const [ra, rb, rc] = [find(a), find(b), find(c)];
    parent[ra] = rc;
    parent[rb] = rc;
  }
  const comps = new Map();
  pos.forEach((p, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(p);
  });
  console.log('== screen components:', comps.size);
  for (const [, pts] of comps) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
    console.log(
      `  ${pts.length} verts  min=[${min.map((v) => (v * 1000).toFixed(2)).join(', ')}] max=[${max.map((v) => (v * 1000).toFixed(2)).join(', ')}]  (mm)`,
    );
  }
  // also: unique Z planes in the screen mesh
  const zs = [...new Set(pos.map((p) => p[2].toFixed(5)))].sort();
  console.log('  distinct Z planes:', zs.join(', '));
}

// ---------- slot scan: shell geometry near the top edge ----------
const scanShell = (name) => {
  const mesh = meshOf(name);
  const out = [];
  for (const prim of mesh.primitives) {
    out.push(...accessorData(prim.attributes.POSITION));
  }
  return out;
};
const shellPts = [...scanShell('shellFront'), ...scanShell('shellMid'), ...scanShell('shellBack'), ...scanShell('bandDecals')];

// Profile along the top edge: for strips of X, the max glbY at each glbZ (depth)
// The cartridge groove: region near top edge (glbY high) where the shell recedes.
console.log('\n== top-edge profile (glb coords, mm). Y = device up, Z = depth (+front)');
const XSTRIPS = [
  [-72, -40],
  [-40, -25],
  [-25, -8],
  [-8, 8],
  [8, 25],
  [25, 40],
  [40, 72],
];
for (const [x0, x1] of XSTRIPS) {
  const pts = shellPts.filter((p) => p[0] * 1000 >= x0 && p[0] * 1000 < x1);
  // for Y bins, min/max Z
  const bins = {};
  for (const p of pts) {
    const yb = Math.round(p[1] * 1000 / 2) * 2;
    bins[yb] ??= [Infinity, -Infinity, 0];
    bins[yb][0] = Math.min(bins[yb][0], p[2] * 1000);
    bins[yb][1] = Math.max(bins[yb][1], p[2] * 1000);
    bins[yb][2]++;
  }
  const rows = Object.entries(bins)
    .map(([y, [zmin, zmax, n]]) => `y${y}:z[${zmin.toFixed(1)},${zmax.toFixed(1)}]n${n}`)
    .filter((_, i, a) => i % 1 === 0);
  console.log(`  x[${x0},${x1}]: ${rows.join('  ')}`);
}

// Where is the highest shell Y overall, and the groove floor?
const topPts = shellPts.filter((p) => p[1] * 1000 > 34);
const zOfTop = topPts.map((p) => p[2] * 1000);
console.log('\nverts with glbY>34mm:', topPts.length, 'Z range:', Math.min(...zOfTop).toFixed(1), '..', Math.max(...zOfTop).toFixed(1));
const groove = shellPts.filter((p) => p[1] * 1000 > 30 && Math.abs(p[0]) < 0.03);
const gy = groove.map((p) => p[1] * 1000);
const gz = groove.map((p) => p[2] * 1000);
if (groove.length) {
  console.log('groove area (|x|<30mm, y>30): Y', Math.min(...gy).toFixed(1), '..', Math.max(...gy).toFixed(1), ' Z', Math.min(...gz).toFixed(1), '..', Math.max(...gz).toFixed(1));
}
