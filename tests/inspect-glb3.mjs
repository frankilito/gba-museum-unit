/** Slot groove scan in WORLD (normalized) coords: apply node matrices. */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'public/models/gba.glb';
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = buf.slice(binStart, binStart + gltf.buffers[0].byteLength);

const accessorData = (idx) => {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const compSize = { 5126: 4, 5123: 2, 5125: 4 }[acc.componentType];
  const ncomp = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
  const stride = bv.byteStride ?? compSize * ncomp;
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const base = off + i * stride;
    const v = [];
    for (let c = 0; c < ncomp; c++) v.push(bin.readFloatLE(base + c * compSize));
    out.push(v);
  }
  return out;
};

const parentOf = {};
gltf.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parentOf[c] = i)));
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = (n) => {
  if (n.matrix) return n.matrix;
  const t = n.translation ?? [0, 0, 0];
  const s = n.scale ?? [1, 1, 1];
  const q = n.rotation ?? [0, 0, 0, 1];
  const [x, y, z, w] = q;
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]; m[1] = 2 * (x * y + z * w) * s[0]; m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1]; m[5] = (1 - 2 * (x * x + z * z)) * s[1]; m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2]; m[9] = 2 * (y * z - x * w) * s[2]; m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
};
const worldMat = (idx) => {
  const chain = [];
  let cur = idx;
  while (cur !== undefined) { chain.unshift(cur); cur = parentOf[cur]; }
  return chain.map((i) => trs(gltf.nodes[i])).reduce((a, b) => mul(a, b));
};
const tx = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

// print node matrices compactly
console.log('node matrices (world):');
gltf.nodes.forEach((n, i) => {
  if (n.mesh === undefined) return;
  const m = worldMat(i);
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]].map((v) => v.toFixed(4)).join(' ');
  console.log(`  ${n.name ?? '(unnamed)'}: [${row(0)} | ${row(1)} | ${row(2)}]`);
});

const worldPts = (name) => {
  const ni = gltf.nodes.findIndex((n) => n.name === name);
  const m = worldMat(ni);
  const out = [];
  for (const prim of gltf.meshes[gltf.nodes[ni].mesh].primitives) {
    for (const p of accessorData(prim.attributes.POSITION)) out.push(tx(m, p));
  }
  return out;
};

const shells = ['shellFront', 'shellMid', 'shellBack', 'bandDecals', 'screws', 'shoulderL', 'shoulderR', 'linkPortCover'];
const pts = shells.flatMap(worldPts);
const mm = (v) => (v * 1000).toFixed(1);

// The slot: near the top edge (glbY high), between the shoulders (|x| < 32mm)
console.log('\n== Y/Z profile near top edge, |glbX|<32mm (world mm)');
const strip = pts.filter((p) => Math.abs(p[0]) < 0.032 && p[1] > 0.02);
const bins = {};
for (const p of strip) {
  const yb = Math.round(p[1] * 1000 / 1.5) * 1.5;
  bins[yb] ??= [Infinity, -Infinity, 0];
  bins[yb][0] = Math.min(bins[yb][0], p[2] * 1000);
  bins[yb][1] = Math.max(bins[yb][1], p[2] * 1000);
  bins[yb][2]++;
}
for (const [y, [zmin, zmax, n]] of Object.entries(bins).sort((a, b) => +a[0] - +b[0])) {
  console.log(`  glbY=${y}mm: glbZ [${zmin.toFixed(1)}, ${zmax.toFixed(1)}]  n=${n}`);
}

// Wider context: full device outline at the top for |x|<70
console.log('\n== max glbY per X bin (device top silhouette, world mm)');
for (let x0 = -70; x0 < 70; x0 += 10) {
  const p = pts.filter((v) => v[0] * 1000 >= x0 && v[0] * 1000 < x0 + 10);
  const ys = p.map((v) => v[1] * 1000);
  console.log(`  x[${x0},${x0 + 10}]: maxY=${Math.max(...ys).toFixed(1)}  y>30 count=${ys.filter((y) => y > 30).length}`);
}

// Groove floor: verts in the slot region with glbY between 28 and 38 — where does Z bottom out?
const groove = pts.filter((p) => Math.abs(p[0]) < 0.031 && p[1] > 0.028 && p[1] < 0.042);
const zs = groove.map((p) => p[2] * 1000).sort((a, b) => a - b);
console.log('\ngroove glbZ percentiles: min', mm(zs[0] / 1000), 'p10', mm(zs[Math.floor(zs.length * 0.1)] / 1000), 'p50', mm(zs[Math.floor(zs.length * 0.5)] / 1000), 'p90', mm(zs[Math.floor(zs.length * 0.9)] / 1000), 'max', mm(zs[zs.length - 1] / 1000));
const ys = groove.map((p) => p[1] * 1000).sort((a, b) => a - b);
console.log('groove glbY percentiles: min', mm(ys[0] / 1000), 'p10', mm(ys[Math.floor(ys.length * 0.1)] / 1000), 'p50', mm(ys[Math.floor(ys.length * 0.5)] / 1000), 'max', mm(ys[ys.length - 1] / 1000));
