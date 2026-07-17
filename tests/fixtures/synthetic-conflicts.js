'use strict';
// Deterministic synthetic clash-list fixtures for the UI measurement harness
// (REWRITE_UI_PLAN.md Phase 2/3). Seeded PRNG (mulberry32), not Math.random,
// so a given (n, seed) always reproduces byte-identical output across runs —
// needed for stable before/after regression comparison, not just "some data".
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STOREYS = ['Ground Floor', 'Level 1', 'Level 2', 'Level 3', 'Roof'];
const DISCIPLINES = ['structural', 'mep', 'architectural', 'civil', 'other'];
const TYPES = ['hard', 'soft'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const IFC_TYPES = ['IfcWall', 'IfcBeam', 'IfcColumn', 'IfcDuctSegment', 'IfcPipeSegment', 'IfcSlab'];

// n items, spread across `clusterCount` spatial clusters (so groupBy:'cluster'
// and groupBy:'nearby' both produce realistic multi-item groups instead of
// one row per group) and `modelCount` models.
function generateConflicts(n, opts) {
  opts = opts || {};
  const seed = opts.seed != null ? opts.seed : 1;
  const rand = mulberry32(seed);
  const clusterCount = opts.clusterCount || Math.max(1, Math.round(n / 12));
  const modelCount = opts.modelCount || 2;
  const models = [];
  for (let m = 0; m < modelCount; m++) {
    models.push({ id: 'model-' + m, name: 'Model ' + (m + 1), discipline: DISCIPLINES[m % DISCIPLINES.length] });
  }
  // Precompute cluster centers so items in the same cluster share a point
  // neighborhood (mirrors _ccSpatialClusterMap's union-find grouping).
  const centers = [];
  for (let c = 0; c < clusterCount; c++) {
    centers.push([rand() * 200 - 100, rand() * 30, rand() * 200 - 100]);
  }
  const items = [];
  for (let i = 0; i < n; i++) {
    const cluster = i % clusterCount;
    const center = centers[cluster];
    const mA = models[Math.floor(rand() * modelCount)];
    let mB = models[Math.floor(rand() * modelCount)];
    if (mB === mA && modelCount > 1) mB = models[(models.indexOf(mA) + 1) % modelCount];
    items.push({
      id: 'c' + i,
      type: TYPES[Math.floor(rand() * TYPES.length)],
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
      distance: -Math.round(rand() * 80),
      clearanceMm: Math.round(rand() * 100),
      elemA: 1000 + i, elemB: 2000 + i,
      modelAId: mA.id, modelBId: mB.id,
      elemAStorey: STOREYS[Math.floor(rand() * STOREYS.length)],
      elemBStorey: STOREYS[Math.floor(rand() * STOREYS.length)],
      elemAType: IFC_TYPES[Math.floor(rand() * IFC_TYPES.length)],
      elemBType: IFC_TYPES[Math.floor(rand() * IFC_TYPES.length)],
      disciplines: [mA.discipline, mB.discipline],
      priority: ['low', 'normal', 'high'][Math.floor(rand() * 3)],
      assignee: rand() > 0.5 ? 'alice' : null,
      point: [
        center[0] + (rand() * 4 - 2),
        center[1] + (rand() * 4 - 2),
        center[2] + (rand() * 4 - 2),
      ],
    });
  }
  return { items, models };
}

module.exports = { generateConflicts, mulberry32 };
