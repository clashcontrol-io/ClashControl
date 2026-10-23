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

// A synthetic two-model federation result shaped like a real run's review
// set: `groupCount` MEP runs (model-1) each crossing many distinct structural
// / architectural elements (model-0), so the clash list's root-cause
// grouping ('element') yields exactly `groupCount` groups. Every clash is an
// open hard crossing without sizes, so it stays in the 'review' bucket; each
// carries a severity like a real run's output.
const RUN_TYPES = ['IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment'];
const HOST_TYPES = ['IfcWall', 'IfcBeam', 'IfcSlab', 'IfcColumn'];
function generateGroupedClashes(n, groupCount, opts) {
  opts = opts || {};
  const rand = mulberry32(opts.seed != null ? opts.seed : 7);
  const models = [
    { id: 'model-0', name: 'Model 1', discipline: 'structural' },
    { id: 'model-1', name: 'Model 2', discipline: 'mep' },
  ];
  const items = [];
  for (let i = 0; i < n; i++) {
    const g = i % groupCount;
    const storey = STOREYS[g % STOREYS.length];
    items.push({
      id: 'gc' + i,
      type: 'hard',
      status: 'open',
      distance: -(5 + Math.round(rand() * 120)) / 1000,
      elemA: 900000 + g, elemB: 100000 + i,
      elemAName: 'Run ' + (g + 1), elemBName: 'Host ' + (i + 1),
      elemAType: RUN_TYPES[g % RUN_TYPES.length],
      elemBType: HOST_TYPES[Math.floor(rand() * HOST_TYPES.length)],
      modelAId: 'model-1', modelBId: 'model-0',
      elemAStorey: storey, elemBStorey: storey,
      disciplines: ['mep', 'structural'],
      // detection stamps a severity on every clash (classification core)
      aiSeverity: ['critical', 'major', 'major', 'minor', 'minor'][Math.floor(rand() * 5)],
      point: [g * 3 + rand(), 1 + rand(), (i % 40) * 0.5],
    });
  }
  return { items, models };
}

module.exports = { generateConflicts, generateGroupedClashes, mulberry32 };
