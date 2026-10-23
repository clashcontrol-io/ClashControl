// Shared page-side helper for loader equivalence checks
// (ifc-worker-fallback-differential.mjs, progressive-load.mjs).
//
// deepModelDigest runs INSIDE the page (pass it to page.evaluate). For every
// loaded model, in element order, it records the exact bytes of each mesh's
// position / index / normal arrays, the mesh matrix, the element's props
// (JSON) and its world-space signed volume and surface area computed in
// float64 from those triangles. Two loads are "the same model" when every
// row matches exactly — stronger than modelFingerprint (bounds + mesh count).
export function deepModelDigest(nameFilter) {
  function fnv(h, u8) { for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }
  function hArr(h, a) { if (!a) return fnv(h, new Uint8Array([0])); return fnv(h, new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
  const enc = new TextEncoder();
  const out = {};
  for (const m of window._ccLatestState.models) {
    if (nameFilter && m.name.indexOf(nameFilter) !== 0) continue;
    const rows = [];
    for (const el of m.elements) {
      let g = 2166136261, vol = 0, area = 0, tris = 0;
      for (const me of el.meshes) {
        const geo = me.geometry, p = geo.attributes.position.array, ix = geo.index ? geo.index.array : null;
        g = hArr(g, p); g = hArr(g, ix); g = hArr(g, geo.attributes.normal && geo.attributes.normal.array);
        const e = me.matrix.elements; g = hArr(g, new Float64Array(e));
        const n = ix ? ix.length : p.length / 3;
        const W = (k) => { const x = p[k * 3], y = p[k * 3 + 1], z = p[k * 3 + 2];
          return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
        for (let t = 0; t + 2 < n; t += 3) {
          const a = W(ix ? ix[t] : t), b = W(ix ? ix[t + 1] : t + 1), c = W(ix ? ix[t + 2] : t + 2);
          vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
          area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2; tris++;
        }
      }
      const pj = JSON.stringify(el.props);
      rows.push([el.expressId, el.meshes.length, tris, g.toString(16), fnv(2166136261, enc.encode(pj)).toString(16), vol, area]);
    }
    out[m.name] = { elements: rows.length, meshes: m.meshes.length, rows };
  }
  return out;
}

// Compare two digests; returns a list of human-readable differences (empty = identical).
export function diffDigests(a, b, max = 8) {
  const diffs = [];
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const n of names) {
    if (!a[n] || !b[n]) { diffs.push(n + ': present in only one load'); continue; }
    if (a[n].elements !== b[n].elements) diffs.push(n + ': element count ' + a[n].elements + ' vs ' + b[n].elements);
    const ra = a[n].rows, rb = b[n].rows;
    for (let i = 0; i < Math.min(ra.length, rb.length) && diffs.length < max; i++) {
      if (JSON.stringify(ra[i]) !== JSON.stringify(rb[i])) diffs.push(n + ' row ' + i + ': ' + JSON.stringify(ra[i]) + ' vs ' + JSON.stringify(rb[i]));
    }
  }
  return diffs;
}
