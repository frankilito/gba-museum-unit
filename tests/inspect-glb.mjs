/**
 * Inspect gba.glb structure: node names/transforms, per-mesh bounds (world),
 * materials, screen mesh UV range. Read-only analysis.
 * Usage: node inspect-glb.mjs <path-to-glb>
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'public/models/gba.glb';
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));

const meshPrimAccessorBounds = (meshIdx) => {
  const mesh = gltf.meshes[meshIdx];
  const out = [];
  for (const prim of mesh.primitives) {
    const acc = gltf.accessors[prim.attributes.POSITION];
    out.push({ min: acc.min, max: acc.max, material: prim.material, count: acc.count });
  }
  return out;
};

const nodeWorldMatrix = (idx) => {
  // build TRS matrix for node and multiply by parent chain
  const chain = [];
  let cur = idx;
  const parentOf = {};
  gltf.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parentOf[c] = i)));
  while (cur !== undefined) {
    chain.unshift(cur);
    cur = parentOf[cur];
  }
  // mat4 helpers (column-major)
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const mul = (a, b) => {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  };
  const trs = (n) => {
    if (n.matrix) return n.matrix;
    const t = n.translation ?? [0, 0, 0];
    const s = n.scale ?? [1, 1, 1];
    const q = n.rotation ?? [0, 0, 0, 1];
    const [x, y, z, w] = q;
    const m = ident.slice();
    m[0] = (1 - 2 * (y * y + z * z)) * s[0];
    m[1] = 2 * (x * y + z * w) * s[0];
    m[2] = 2 * (x * z - y * w) * s[0];
    m[4] = 2 * (x * y - z * w) * s[1];
    m[5] = (1 - 2 * (x * x + z * z)) * s[1];
    m[6] = 2 * (y * z + x * w) * s[1];
    m[8] = 2 * (x * z + y * w) * s[2];
    m[9] = 2 * (y * z - x * w) * s[2];
    m[10] = (1 - 2 * (x * x + y * y)) * s[2];
    m[12] = t[0];
    m[13] = t[1];
    m[14] = t[2];
    return m;
  };
  return chain.map((i) => trs(gltf.nodes[i])).reduce((a, b) => mul(a, b), ident);
};

const transformPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

console.log('== GLB:', path);
console.log('meshes:', gltf.meshes?.length, 'nodes:', gltf.nodes?.length, 'materials:', gltf.materials?.length, 'images:', gltf.images?.length);
console.log('materials:');
(gltf.materials ?? []).forEach((m, i) => {
  const pbr = m.pbrMetallicRoughness ?? {};
  console.log(`  [${i}] ${m.name}: baseColorTex=${pbr.baseColorTexture?.index ?? '-'} mrTex=${pbr.metallicRoughnessTexture?.index ?? '-'} normalTex=${m.normalTexture?.index ?? '-'} emissiveTex=${m.emissiveTexture?.index ?? '-'} alpha=${m.alphaMode ?? 'OPAQUE'}`);
});
console.log('textures:', (gltf.textures ?? []).map((t, i) => `[${i}] img=${t.source}`).join(' '));
console.log('images:');
(gltf.images ?? []).forEach((im, i) => console.log(`  [${i}] ${im.name ?? ''} ${im.mimeType} bytes=${im.bufferView !== undefined ? gltf.bufferViews[im.bufferView].byteLength : '?'}`));

console.log('\nnodes with meshes:');
gltf.nodes.forEach((n, i) => {
  if (n.mesh === undefined) return;
  const wm = nodeWorldMatrix(i);
  const bounds = meshPrimAccessorBounds(n.mesh);
  const wmin = [Infinity, Infinity, Infinity];
  const wmax = [-Infinity, -Infinity, -Infinity];
  for (const b of bounds) {
    for (const cx of [b.min[0], b.max[0]])
      for (const cy of [b.min[1], b.max[1]])
        for (const cz of [b.min[2], b.max[2]]) {
          const p = transformPoint(wm, [cx, cy, cz]);
          for (let k = 0; k < 3; k++) {
            wmin[k] = Math.min(wmin[k], p[k]);
            wmax[k] = Math.max(wmax[k], p[k]);
          }
        }
  }
  const t = n.translation ?? [0, 0, 0];
  const r = n.rotation;
  console.log(
    `  "${n.name}" node#${i} mesh=${n.mesh} primMats=[${bounds.map((b) => b.material).join(',')}] verts=${bounds.reduce((s, b) => s + b.count, 0)}`,
  );
  console.log(`    localT=[${t.map((v) => v.toFixed(4)).join(', ')}]${r ? ` rot=[${r.map((v) => v.toFixed(3)).join(', ')}]` : ''}`);
  console.log(`    worldBBox min=[${wmin.map((v) => v.toFixed(4)).join(', ')}] max=[${wmax.map((v) => v.toFixed(4)).join(', ')}]`);
  console.log(`    worldSize=[${wmax.map((v, k) => (v - wmin[k]).toFixed(4)).join(', ')}]`);
});

// screen mesh UV range
const screenNode = gltf.nodes.find((n) => n.name === 'screen');
if (screenNode) {
  const mesh = gltf.meshes[screenNode.mesh];
  for (const prim of mesh.primitives) {
    const uvAcc = prim.attributes.TEXCOORD_0 !== undefined ? gltf.accessors[prim.attributes.TEXCOORD_0] : null;
    console.log('\nscreen UV accessor:', uvAcc ? { min: uvAcc.min, max: uvAcc.max, count: uvAcc.count } : 'none');
  }
}
