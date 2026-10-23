// Pressure-test invariants and the per-combo orchestrator.
//
//   I1  path parity        — every engine path (auto/js/wasm/engine/pool-*/native)
//                            returns the IDENTICAL ordered clash list, field for
//                            field, as the JS reference on the same loaded models
//   I2  smart == full      — a smart re-run after edits equals a full run (+ the
//                            profile says smart when nothing invalidated it, with
//                            exactly the edited elements recomputed)
//   I3  load order/subset  — order, duplicate loads, reloads, the main-thread
//                            loader and loading a subset don't change the
//                            (element-pair, type, opening) set vs the canonical
//                            federation restricted to that subset
//   I5  accuracy           — planted manifest outcomes per ruleset, and a seeded
//                            exact-oracle sample (≤150 pairs) at P = R = 1
//   I6  buckets            — the clash list's headline + "N pass through provided
//                            openings" + "N only touch" + denied == raw clashes
//   I7  display no-op      — tab/style/section/spaces/occlusion/locale/filter
//                            don't change the signature and keep smart re-runs smart
//   I8  cancel             — a cancelled run commits nothing, stops its workers,
//                            and the next run equals the baseline; an aborted load
//                            stops (no model appears afterwards)
//   I9  failure injection  — worker spawn failure, mid-run worker crash, missing
//                            WASM, every addon 404, localStorage quota, IDB write
//                            failure: same result as the baseline
//   I10 reconciliation     — status/assignee/id survive re-runs; denied stays gone
//   I11 project round-trip — save -> fresh page -> restore -> re-load files -> run:
//                            statuses, ids, issues intact
//   I12 BCF round-trip     — export (shown / all) -> import: topic count, GUIDs,
//                            components, Z-up camera
//   I15 health             — no page errors; workers back to 0; WebGL contexts and
//                            window/document listeners constant (checked in run.mjs)
//   I16 determinism        — the same run twice gives the same list; the combo's
//                            digest is stable across executions
// No timing asserts anywhere. Infra problems throw InfraError (retried by
// run.mjs); an invariant failure is recorded, never retried.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, InfraError, pageClassFor } from './harness.mjs';
import { rulesFor, EDIT_KINDS, DIMS } from './dims.mjs';
import { rngFor, pick, sample, digest } from './rng.mjs';

const require = createRequire(import.meta.url);
const { generateBuilding } = require(join(ROOT, 'tests/fixtures/generate-building-ifc.js'));
const KEYS = { A: 'architecture', S: 'structure', M: 'mep' };

// ── fixtures ──
export class Fixtures {
  constructor(h, opts = {}) {
    this.h = h; this.cache = new Map();
    this.externalFiles = opts.externalFiles || null; // [path] — reports name them by hash
  }
  async get(dims, extra = {}) {
    if (this.externalFiles) return this._external();
    const spec = { seed: dims['fixture.seed'], scale: dims['fixture.scale'], georef: dims['fixture.georef'] };
    if (extra.cases) spec.cases = extra.cases;
    if (extra.background === false) spec.background = false;
    if (extra.scale) spec.scale = extra.scale;
    const key = digest(spec);
    if (!this.cache.has(key)) {
      const g = generateBuilding(spec);
      const files = {};
      for (const L of ['A', 'S', 'M']) {
        const name = g.fileNames[KEYS[L]];
        const url = '/__gen/' + key + '/' + name;
        this.h.serve(url, Buffer.from(g.files[KEYS[L]]));
        files[L] = { url, name, model: name.replace(/\.ifc$/i, ''), letter: L };
      }
      this.cache.set(key, { key, spec, files, manifest: g.manifest, products: g.stats.products });
    }
    return this.cache.get(key);
  }
  async _external() {
    if (this.cache.has('external')) return this.cache.get('external');
    const files = {};
    const letters = ['A', 'S', 'M'];
    for (let i = 0; i < Math.min(3, this.externalFiles.length); i++) {
      const buf = await readFile(this.externalFiles[i]);
      const sha = createHash('sha256').update(buf).digest('hex');
      const name = 'ext-' + sha.slice(0, 8) + '.ifc';
      const url = '/__ext/' + sha.slice(0, 16) + '.ifc';
      this.h.serve(url, buf);
      files[letters[i]] = { url, name, model: name.replace(/\.ifc$/i, ''), letter: letters[i], sha256: sha };
    }
    const fx = { key: 'external', spec: { external: true }, files, manifest: null };
    this.cache.set('external', fx);
    return fx;
  }
}

export function filesFor(fx, dims) {
  const letters = dims['models.subset'].split('').filter((L) => fx.files[L]);
  const order = dims['models.order'].split('').map(Number).filter((i) => i < letters.length);
  // a permutation of 0..2 restricted to the subset length keeps its relative order
  const ordered = order.map((i) => letters[i]);
  for (const L of letters) if (!ordered.includes(L)) ordered.push(L);
  return ordered.map((L) => fx.files[L]);
}

// ── in-page checks (installed once per page) ──
function installChecks(oracleSrc) {
  if (window.__ccC) return true;
  { const module = { exports: {} }; (0, eval)('(function(module, exports, require){' + oracleSrc + '\n})')(module, module.exports, () => { throw new Error('no require'); }); window.__ccOracle = module.exports; }
  const st = () => window._ccLatestState;
  // Element-pair view of a raw result (merged rows expanded to their partners),
  // keyed by sorted GlobalIds.
  function pairsOf(res) {
    const gid = new Map();
    for (const m of st().models) for (const el of m.elements) gid.set(m.id + ':' + el.expressId, { g: (el.props && el.props.globalId) || '', t: el.props && el.props.ifcType, m: m.name });
    const out = [];
    for (const c of res || []) {
      const ga = gid.get(c.modelAId + ':' + c.elemA), gb = gid.get(c.modelBId + ':' + c.elemB);
      const base = { type: c.type, opening: c.opening || null, dist: typeof c.distance === 'number' ? c.distance : null, clr: c.clearanceMm, merged: false, same: c.modelAId === c.modelBId, mA: ga && ga.m, mB: gb && gb.m };
      out.push(Object.assign({ a: c.globalIdA, b: c.globalIdB }, base));
      if (c._groupedElems && c._groupedElems.length) {
        for (const e of c._groupedElems) {
          const pa = gid.get(c.modelBId + ':' + e), pb = gid.get(c.modelAId + ':' + e);
          if (pa && pa.t === c.elemBType && pa.g !== c.globalIdB) out.push(Object.assign({ a: c.globalIdA, b: pa.g }, base, { merged: true, mB: pa.m }));
          if (pb && pb.t === c.elemAType && pb.g !== c.globalIdA) out.push(Object.assign({ a: pb.g, b: c.globalIdB }, base, { merged: true, mA: pb.m }));
        }
      }
    }
    return out.map((p) => Object.assign(p, { key: [p.a, p.b].sort().join('|') }));
  }
  const C = window.__ccC = {
    pairsOf(raw) { return pairsOf(raw || window.__ccH.lastRes); },
    // Expected app outcome for one pair from a ground-truth category (+ the
    // rules), per index.html _ccResolvePair / _processCandidate semantics.
    // Returns a '|'-separated set of acceptable outcomes.
    expect(cat, dM, eA, eB, rules, extra) {
      extra = extra || {};
      const tA = (eA.props && eA.props.ifcType) || '', tB = (eB.props && eB.props.ifcType) || '';
      const tk = tA < tB ? tA + ':' + tB : tB + ':' + tA;
      const tol = rules.toleranceByTypePair && rules.toleranceByTypePair[tk] !== undefined ? +rules.toleranceByTypePair[tk] : null;
      const gapMm = tol != null ? tol : (rules.maxGap || 0);
      const minGapMm = rules.minGap || 0;
      const wantsSoft = gapMm > 0;
      if (rules.duplicates) {
        const bA = eA.box, bB = eB.box;
        const sA = [bA.max.x - bA.min.x, bA.max.y - bA.min.y, bA.max.z - bA.min.z], sB = [bB.max.x - bB.min.x, bB.max.y - bB.min.y, bB.max.z - bB.min.z];
        const sd = Math.abs(sA[0] - sB[0]) + Math.abs(sA[1] - sB[1]) + Math.abs(sA[2] - sB[2]);
        const cd = Math.hypot((bA.min.x + bA.max.x - bB.min.x - bB.max.x) / 2, (bA.min.y + bA.max.y - bB.min.y - bB.max.y) / 2, (bA.min.z + bA.max.z - bB.min.z - bB.max.z) / 2);
        if (sd < 0.03 && cd < 0.02) return 'duplicate';
        if (Math.abs(sd - 0.03) < 1e-6 || Math.abs(cd - 0.02) < 1e-6) extra.dupBorder = true;
      }
      if (cat === 'contact') return wantsSoft && minGapMm <= 0 ? 'contact' : 'none';
      if (cat === 'crossing' || cat === 'contained') {
        const softish = wantsSoft && minGapMm <= 0 ? 'soft' : 'none';
        if (!rules.hard) return softish;
        if ((rules.minOverlapVolM3 || 0) > 0) {
          const ov = C.aabbOverlap(eA.box, eB.box);
          if (Math.abs(ov - rules.minOverlapVolM3) < 1e-9) return 'hard|' + softish;
          return ov >= rules.minOverlapVolM3 ? 'hard' : softish;
        }
        return 'hard';
      }
      // clearance / separate at distance dM (null = unknown)
      if (!wantsSoft) return 'none';
      if (dM == null) return 'soft|none';
      const mm = dM * 1000;
      if (Math.abs(mm - gapMm) < 0.01 || Math.abs(mm - minGapMm) < 0.01) return 'soft|none';
      return mm <= gapMm && mm >= minGapMm ? 'soft' : 'none';
    },
    aabbOverlap(a, b) {
      const dx = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x), dy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y), dz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
      return dx > 0 && dy > 0 && dz > 0 ? dx * dy * dz : 0;
    },
    elementsByGid() {
      const map = new Map();
      for (const m of st().models) for (const el of m.elements) { const g = el.props && el.props.globalId; if (g) map.set(g, { el, m }); }
      return map;
    },
    appByPair(raw) {
      const rank = { hard: 4, duplicate: 3, contact: 2, soft: 1 };
      const by = new Map();
      for (const p of pairsOf(raw || window.__ccH.lastRes)) { const o = by.get(p.key); if (!o || (rank[p.type] || 0) > (rank[o.type] || 0)) by.set(p.key, p); }
      return by;
    },
    // I5a: planted manifest cases (analytic intent) against the last run.
    planted(cases, rules) {
      const els = C.elementsByGid(), app = C.appByPair(), out = [];
      for (const c of cases) {
        const A = els.get(c.a.globalId), B = els.get(c.b.globalId);
        if (!A || !B) { out.push({ id: c.id, skipped: 'model not loaded' }); continue; }
        let exp;
        if (window._ccMatrixSkipsSameDiscipline && window._ccMatrixSkipsSameDiscipline(A.el, A.m, B.el, B.m, false, rules)) exp = 'none';
        else {
          const cat = c.category === 'separate' ? 'clearance' : c.category;
          const dM = c.category === 'clearance' || c.category === 'separate' ? (c.toleranceRelation === 'at' ? (rules.maxGap === 50 ? null : c.distanceM) : c.distanceM) : null;
          exp = C.expect(cat, dM, A.el, B.el, rules);
          if (c.category === 'clearance' && c.toleranceRelation === 'at' && dM == null && (rules.maxGap || 0) > 0) exp = exp.includes('soft') ? exp : exp + '|soft';
        }
        const hit = app.get([c.a.globalId, c.b.globalId].sort().join('|'));
        const got = hit ? hit.type : 'none';
        const ok = exp.split('|').includes(got);
        let openingOk = true;
        if (ok && hit && c.opening && (got === 'hard' || (got === 'soft' && c.opening === 'provided'))) openingOk = hit.opening === c.opening;
        out.push({ id: c.id, name: c.name, exp, got, ok: ok && openingOk, opening: hit ? hit.opening : null, wantOpening: c.opening || null, dist: hit ? (hit.type === 'soft' ? hit.clr : hit.dist) : null });
      }
      return out;
    },
    // I5b: seeded exact-oracle sample of cross-model candidate pairs.
    oracleSample(rules, maxPairs, seed, excludeGids) {
      const O = window.__ccOracle;
      const els = [];
      const skip = new Set(excludeGids || []);
      for (const m of st().models) for (const el of m.elements) {
        const p = el.props || {};
        if (p.ifcType === 'IfcOpeningElement' || (p.ifcType === 'IfcSpace' && !rules.includeSpaces)) continue;
        if (skip.has(p.globalId)) continue;
        const t = window._ccGetWorldTris(el);
        if (!t || !t.length) continue;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const v = t[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
        els.push({ el, m, mn, mx, gid: p.globalId || '', t });
      }
      els.sort((a, b) => a.mn[0] - b.mn[0]);
      let pad = 0.001 + Math.max(rules.maxGap || 0, ...Object.values(rules.toleranceByTypePair || {}).map(Number)) / 1000;
      if (!(pad > 0)) pad = 0.001;
      const pairs = [];
      for (let i = 0; i < els.length; i++) {
        const A = els[i];
        for (let j = i + 1; j < els.length && els[j].mn[0] <= A.mx[0] + pad; j++) {
          const B = els[j];
          if (A.m.id === B.m.id) continue;
          if (A.mn[1] > B.mx[1] + pad || B.mn[1] > A.mx[1] + pad || A.mn[2] > B.mx[2] + pad || B.mn[2] > A.mx[2] + pad) continue;
          if (window._ccMatrixSkipsSameDiscipline && window._ccMatrixSkipsSameDiscipline(A.el, A.m, B.el, B.m, false, rules)) continue;
          pairs.push([i, j]);
        }
      }
      let s = seed >>> 0;
      const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      for (let k = pairs.length - 1; k > 0; k--) { const r = Math.floor(rnd() * (k + 1)); [pairs[k], pairs[r]] = [pairs[r], pairs[k]]; }
      const chosen = pairs.slice(0, maxPairs);
      const SN = Math.pow(2, 30);
      const snap = (t) => { const o = new Float64Array(t.length); for (let i = 0; i < t.length; i++) o[i] = Math.round(t[i] * SN) / SN; return o; };
      const prepC = new Map();
      const prep = (e) => { let x = prepC.get(e); if (!x) { const st2 = snap(e.t); x = { raw: O.prepareMesh(e.t, { assumeClosed: true }), snapped: O.prepareMesh(st2, { assumeClosed: true }), st: st2 }; prepC.set(e, x); } return x; };
      const app = C.appByPair();
      const out = [];
      for (const [i, j] of chosen) {
        const A = els[i], B = els[j];
        const verdict = (which) => {
          const pa = prep(A), pb = prep(B);
          const o = O.classifyPair(pa[which], pb[which], { assumeClosed: true });
          let cat = o.category;
          if (cat === 'crossing' || cat === 'contained') {
            const st2 = pb.st;
            outer: for (let ax = 0; ax < 3; ax++) for (const sg of [1, -1]) {
              const t2 = Float64Array.from(st2); for (let q = ax; q < t2.length; q += 3) t2[q] += sg * 1e-4;
              const c2 = O.classifyPair(pa.snapped, t2, { assumeClosed: true }).category;
              if (c2 !== 'crossing' && c2 !== 'contained') { cat = 'contact'; break outer; }
            }
          }
          if ((cat === 'clearance' || cat === 'separate') && O.cmpDistToRational(o, 1, 10000) <= 0) cat = 'contact';
          if (cat === 'separate') cat = 'clearance';
          return { cat, d: o.distance };
        };
        let v1, v2;
        try { v1 = verdict('snapped'); v2 = verdict('raw'); } catch (e) { out.push({ error: String(e && e.message || e), a: A.gid, b: B.gid }); continue; }
        const e1 = C.expect(v1.cat, v1.d, A.el, B.el, rules), e2 = C.expect(v2.cat, v2.d, A.el, B.el, rules);
        const exp = [...new Set((e1 + '|' + e2).split('|'))].join('|');
        const hit = app.get([A.gid, B.gid].sort().join('|'));
        const got = hit ? hit.type : 'none';
        out.push({ a: A.gid, b: B.gid, nameA: A.el.props.name, nameB: B.el.props.name, cat: v1.cat, rawCat: v2.cat, dMm: v1.d * 1000, exp, got, ok: exp.split('|').includes(got) });
      }
      return { candidates: pairs.length, evaluated: out.length, results: out };
    },
    // I12: parse a BCF zip (base64) -> topics with GUID, title, components, camera.
    async parseBcf(b64) {
      const zip = await window.JSZip.loadAsync(b64, { base64: true });
      const topics = {};
      const tasks = [];
      zip.forEach((path, entry) => {
        const folder = path.split('/')[0];
        if (/markup\.bcf$/i.test(path)) tasks.push(entry.async('text').then((x) => { const doc = new DOMParser().parseFromString(x, 'text/xml'); const t = doc.querySelector('Topic'); (topics[folder] = topics[folder] || {}).guid = t && t.getAttribute('Guid'); topics[folder].title = (t && t.querySelector('Title') || {}).textContent; topics[folder].status = t && t.getAttribute('TopicStatus'); }));
        else if (/\.bcfv$/i.test(path)) tasks.push(entry.async('text').then((x) => {
          const doc = new DOMParser().parseFromString(x, 'text/xml');
          const comps = [...doc.querySelectorAll('Component')].map((c) => c.getAttribute('IfcGuid')).filter(Boolean);
          const cam = doc.querySelector('PerspectiveCamera') || doc.querySelector('OrthogonalCamera');
          const vec = (tag) => { const n = cam && cam.querySelector(tag); return n ? ['X', 'Y', 'Z'].map((k) => parseFloat(n.querySelector(k).textContent)) : null; };
          const T = topics[folder] = topics[folder] || {};
          T.components = comps; T.camera = cam ? { pos: vec('CameraViewPoint'), dir: vec('CameraDirection'), up: vec('CameraUpVector'), ortho: cam.tagName === 'OrthogonalCamera' } : null;
        }));
      });
      await Promise.all(tasks);
      return topics;
    },
    async bcfRoundTrip(which, version) {
      const s = st();
      let items;
      if (which === 'all') items = s.clashes.slice();
      else items = s.clashes.filter((c) => c.status !== 'denied' && !(s.rules.hideProvidedOpenings !== false && c.opening === 'provided') && !(s.rules.hideContacts !== false && c.type === 'contact'));
      items = items.slice(0, 60);
      if (!items.length) return { skipped: 'no clashes to export' };
      const P = window.__ccP;
      P.downloads.length = 0;
      window._ccExportBCF(items, version, s.viewpoints, s);
      for (let i = 0; i < 300 && !P.downloads.length; i++) await new Promise((r) => setTimeout(r, 20));
      if (!P.downloads.length) return { error: 'export produced no download' };
      const blob = P.downloads[P.downloads.length - 1].blob;
      const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      const topics = await C.parseBcf(b64);
      // stable GUIDs: exporting the same items again yields the same topic GUIDs
      P.downloads.length = 0;
      window._ccExportBCF(items, version, s.viewpoints, s);
      for (let i = 0; i < 300 && !P.downloads.length; i++) await new Promise((r) => setTimeout(r, 20));
      const b64b = P.downloads.length ? await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(P.downloads[P.downloads.length - 1].blob); }) : null;
      const topics2 = b64b ? await C.parseBcf(b64b) : {};
      const g1 = Object.values(topics).map((t) => String(t.guid).toLowerCase()).sort(), g2 = Object.values(topics2).map((t) => String(t.guid).toLowerCase()).sort();
      // import into a clean issue list
      for (const i of st().issues.slice()) window._ccDispatch({ t: 'DEL_ISSUE', id: i.id });
      for (const v of (st().viewpoints || []).slice()) window._ccDispatch({ t: 'DEL_VIEWPOINT', id: v.id });
      P.alerts.length = 0;
      window._ccImportBCF({ base64: b64 });
      for (let i = 0; i < 500 && st().issues.length < items.length && !P.alerts.length; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      const issues = st().issues.filter((x) => x.source === 'bcf_import');
      const vps = st().viewpoints || [];
      const problems = [];
      const byGuid = new Map(issues.map((x) => [String(x.bcfGuid).toLowerCase(), x]));
      const toIfc = (v) => [v.x, -v.z, v.y];
      const byId = new Map();
      for (const m of s.models) for (const el of m.elements) byId.set(m.id + ':' + el.expressId, el);
      for (const it of items) {
        const g = String(it.bcfGuid || '').toLowerCase();
        const T = Object.values(topics).find((t) => String(t.guid).toLowerCase() === g);
        if (!T) { problems.push('no topic for clash ' + it.id); continue; }
        const want = [it.globalIdA, it.globalIdB].filter(Boolean);
        if (!want.every((x) => (T.components || []).includes(x))) problems.push('topic ' + g + ' components ' + JSON.stringify(T.components) + ' miss ' + JSON.stringify(want));
        const iss = byGuid.get(g);
        if (!iss) { problems.push('topic ' + g + ' not imported'); continue; }
        if (!want.every((x) => (iss.globalIds || []).includes(x))) problems.push('imported issue ' + g + ' globalIds ' + JSON.stringify(iss.globalIds) + ' vs ' + JSON.stringify(want));
        const expStatus = it.status === 'resolved' || it.status === 'closed' ? 'resolved' : it.status === 'in_progress' ? 'in_progress' : 'open';
        if (iss.status !== expStatus) problems.push('topic ' + g + ' status ' + iss.status + ' vs clash ' + it.status);
        if (T.camera && T.camera.pos) {
          const vp = vps.find((v) => v.linkedId === iss.id);
          if (!vp || !vp.camera) problems.push('topic ' + g + ' camera not imported');
          else {
            const back = toIfc({ x: vp.camera.px, y: vp.camera.py, z: vp.camera.pz });
            if (back.some((x, k) => Math.abs(x - T.camera.pos[k]) > 1e-6 * Math.max(1, Math.abs(x)))) problems.push('topic ' + g + ' camera position does not round-trip: ' + JSON.stringify(back) + ' vs ' + JSON.stringify(T.camera.pos));
          }
          // Z-up: a synthesized viewpoint (no captured view) aims at the centre of
          // the two elements' union box (index.html _ccSynthesizeViewpoint); in the
          // exported IFC-space (Z-up) camera that centre, mapped scene->IFC, must lie
          // on the view ray. A missing/wrong Y-up -> Z-up conversion misses it.
          const hasVp = (s.viewpoints || []).some((v) => v.linkedId === it.id);
          const eA = byId.get(it.modelAId + ':' + it.elemA), eB = byId.get(it.modelBId + ':' + it.elemB);
          if (!hasVp && eA && eB && eA.box && eB.box && T.camera.dir && !T.camera.ortho) {
            const c = { x: (Math.min(eA.box.min.x, eB.box.min.x) + Math.max(eA.box.max.x, eB.box.max.x)) / 2, y: (Math.min(eA.box.min.y, eB.box.min.y) + Math.max(eA.box.max.y, eB.box.max.y)) / 2, z: (Math.min(eA.box.min.z, eB.box.min.z) + Math.max(eA.box.max.z, eB.box.max.z)) / 2 };
            const p = toIfc(c), o = T.camera.pos, dv = T.camera.dir;
            const L = Math.hypot(...dv), u = dv.map((x) => x / L);
            const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
            const t = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];
            const perp = Math.hypot(w[0] - t * u[0], w[1] - t * u[1], w[2] - t * u[2]);
            if (!(t > 0) || perp > 2e-3 + 1e-6 * Math.hypot(...p)) problems.push('topic ' + g + ' camera does not aim at the clash elements in Z-up IFC space (perp ' + perp.toExponential(2) + ' m, t ' + t.toFixed(2) + ')');
          }
          if (T.camera.up && T.camera.dir) {
            // Z-up: BCF vectors are IFC space, so a non-plan view's up vector points +Z
            // (a Y-up scene vector exported unconverted would be (x, y, 0)-ish).
            const up = T.camera.up, dv = T.camera.dir;
            const uz = up[2] / Math.hypot(...up), dz = Math.abs(dv[2]) / Math.hypot(...dv);
            if (dz < 0.95 && !(uz > 0.5)) problems.push('topic ' + g + ' camera up vector is not Z-up: ' + JSON.stringify(up) + ' (direction ' + JSON.stringify(dv) + ')');
            if (Math.abs((up[0] * dv[0] + up[1] * dv[1] + up[2] * dv[2]) / (Math.hypot(...up) * Math.hypot(...dv))) > 0.999) problems.push('topic ' + g + ' up vector parallel to the view direction');
          }
        }
      }
      return { items: items.length, topics: Object.keys(topics).length, imported: issues.length, stableGuids: JSON.stringify(g1) === JSON.stringify(g2), problems: problems.slice(0, 10), problemCount: problems.length, alerts: P.alerts.slice(0, 3) };
    },
  };
  return true;
}

// ── helpers ──
function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const A = a[i] ? JSON.parse(a[i]) : {}, B = b[i] ? JSON.parse(b[i]) : {};
      const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
      return { index: i, lenA: a.length, lenB: b.length, fields: keys.slice(0, 8).map((k) => k + ': ' + JSON.stringify(A[k]) + ' vs ' + JSON.stringify(B[k])).map((s) => s.slice(0, 300)) };
    }
  }
  return null;
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Adapters for features that may not exist yet (B5). An absent adapter makes
// its dim value run as the default and report "SKIPPED (absent)".
async function probeAdapters(P) {
  return P.ev(() => ({
    shardedLoad: typeof window._ccLoadShardedForTest === 'function',
    roleExclusion: typeof window._ccSetRoleExclusion === 'function',
    bucketFilter: typeof window._ccSetBucketFilter === 'function',
    bvhCap: typeof window._ccSetBvhCacheMax === 'function',
    bvhEvict: typeof window._ccEvictBvhCaches === 'function',
    autosaveGate: typeof window._ccSetAutosaveGate === 'function',
    statusUndo: false, // probed by behaviour in the undo-redo round-trip
  }));
}

// Node-side edit plan for a combo (deterministic from the combo seed).
export function planEdits(combo, count, modelCount) {
  const rnd = rngFor(combo.seed, 'edits');
  const kinds = [];
  for (let i = 0; i < count; i++) kinds.push(pick(rnd, EDIT_KINDS));
  return kinds.map((k, i) => ({ k, i, a: Math.floor(rnd() * 1e6), b: Math.floor(rnd() * 1e6), dy: [0.05, 0.2, -0.15, 0.5][Math.floor(rnd() * 4)], modelCount }));
}

// ── the combo executor ──
// env: { fixtures, oracleSrc, canon: Map, log, edits?: [] override, extraGen?: {...} }
export async function executeCombo(h, combo, env) {
  const t0 = Date.now();
  const dims = Object.assign({}, combo.dims);
  const checks = [];
  const notes = [];
  const ck = (inv, ok, detail) => { checks.push({ inv, ok: !!ok, detail: ok ? undefined : detail }); return !!ok; };
  const skip = (inv, why) => checks.push({ inv, skipped: why });
  const rnd = rngFor(combo.seed, 'combo');
  const trace = (what) => { if (env.trace || process.env.CC_PRESSURE_TRACE) console.log('    [trace ' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + combo.id + ' ' + what); };
  const P = await h.page(pageClassFor(dims));
  const adapters = await probeAdapters(P);
  for (const d of DIMS) {
    const feat = d.adapter && d.adapter[dims[d.name]];
    if (feat && !adapters[feat]) { skip(d.name + '=' + dims[d.name], 'SKIPPED (absent): ' + feat); dims[d.name] = d.def; }
  }
  await P.ev(() => window.__ccH.reset());
  await h.clearErrors(P);
  await P.ev(installChecks, env.oracleSrc);
  const fx = await env.fixtures.get(dims, env.extraGen || {});
  const files = filesFor(fx, dims);
  if (!files.length) throw new InfraError('no fixture files for subset ' + dims['models.subset']);
  const fallback = dims['load.path'] === 'fallback';
  const rules = rulesFor(dims);
  const result = { id: combo.id, checks, notes, fixture: fx.key, files: files.map((f) => f.sha256 ? f.name + ' sha256:' + f.sha256 : f.name) };

  trace('abort-load');
  // ── I8: abort-load ──
  if (dims.cancel === 'abort-load') {
    const when = pick(rnd, ['start', 'first-model']);
    const r = await P.ev(({ files, fallback, when }) => window.__ccH.load(files, { fallback, abort: when }), { files, fallback, when });
    ck('I8.abort-load', !r.loading && !r.grewAfterAbort, 'after aborting the load (' + when + '): loading=' + r.loading + ', models kept appearing=' + r.grewAfterAbort + ' (' + r.settledModels + '; msg ' + JSON.stringify(r.loadMsg) + '; live workers ' + JSON.stringify(r.workers) + ')');
    await P.ev(() => window.__ccH.reset());
  }

  trace('load');
  // ── load ──
  const loadFiles = files.slice();
  if (dims['models.extra'] === 'dup-load') loadFiles.push(files[Math.floor(rnd() * files.length)]);
  const lr = await P.ev(({ files, fallback }) => window.__ccH.load(files, { fallback }), { files: loadFiles, fallback });
  if (lr.timeout) { ck('I3.load', false, 'load never completed: ' + JSON.stringify(lr)); return finish(); }
  ck('I3.load', lr.models.length === files.length && lr.models.every((m) => m.elements > 0),
    'loaded models ' + JSON.stringify(lr.models.map((m) => m.name + ':' + m.elements)) + ' for files ' + JSON.stringify(files.map((f) => f.name)));
  if (dims['models.extra'] === 'reload') {
    const rr = await P.ev((n) => window.__ccH.reloadModel(n), files[0].model);
    if (rr.skipped) skip('I3.reload', rr.skipped);
    else ck('I3.reload', rr.reloaded && rr.sameId && rr.elements === rr.before && rr.models === files.length, 'reload in full: ' + JSON.stringify(rr));
  }
  await P.ev((u) => window._ccDispatch({ t: 'UPD_RULES', u }), rules);

  trace('reference runs');
  // ── reference (JS, full) ×2 ──
  await P.ev(() => window.__ccH.setMode('js'));
  const ref = await P.ev((r) => window.__ccH.run(r, { full: true }), rules);
  if (ref.err || ref.outcome !== 'complete') { ck('I16.reference', false, 'reference run failed: ' + (ref.err || ref.outcome)); return finish(); }
  const refPairs = await P.ev(() => window.__ccC.pairsOf());
  result.refCount = ref.n;
  result.digest = digest(await P.ev((rows) => window.__ccH.normalized(rows), ref.clashes));
  const ref2 = await P.ev((r) => window.__ccH.run(r, { full: true }), rules);
  ck('I16.repeat', sameList(ref.clashes, ref2.clashes), 'the same full JS run twice differs: ' + JSON.stringify(firstDiff(ref2.clashes, ref.clashes)));

  trace('planted + oracle');
  // ── I5: planted manifest + oracle sample ──
  if (fx.manifest && fx.manifest.cases.length) {
    const pl = await P.ev(({ cases, rules }) => window.__ccC.planted(cases, rules), { cases: fx.manifest.cases, rules });
    const bad = pl.filter((x) => !x.skipped && !x.ok);
    ck('I5.planted', bad.length === 0, bad.length + ' planted case(s) wrong: ' + JSON.stringify(bad.slice(0, 6)));
    result.planted = { checked: pl.filter((x) => !x.skipped).length, bad: bad.length };
  } else skip('I5.planted', 'no manifest (external files)');
  if (env.oracle !== false) {
    const os = await P.ev(({ rules, n, seed }) => window.__ccC.oracleSample(rules, n, seed), { rules, n: env.oracleMax || 150, seed: combo.seed });
    const err = os.results.filter((x) => x.error), bad = os.results.filter((x) => !x.error && !x.ok);
    ck('I5.oracle', err.length === 0 && bad.length === 0, (err.length ? err.length + ' oracle errors e.g. ' + err[0].error + '; ' : '') + bad.length + '/' + os.evaluated + ' sampled pairs disagree with the exact oracle: ' + JSON.stringify(bad.slice(0, 6)));
    result.oracle = { candidates: os.candidates, evaluated: os.evaluated, bad: bad.length };
  }

  trace('engine path');
  // ── engine path X ──
  let mode = dims['engine.path'];
  if (mode === 'native') {
    const e = await h.ensureNative(P);
    if (e) { skip('engine.path=native', 'SKIPPED (absent): native mock unavailable on this page (' + e + ')'); mode = 'auto'; }
  }
  if (P.cls !== 'default' && mode !== 'js' && mode !== 'auto' && mode !== 'pool-js') notes.push('engine ' + mode + ' on page class ' + P.cls + ' (no WASM): path falls back');
  await P.ev((m) => window.__ccH.setMode(m), mode);
  const failure = dims.failure;
  const inject = async (on) => P.ev(({ f, on }) => {
    const Pp = window.__ccP;
    if (f === 'ls-quota') Pp.inject.ls = on;
    else if (f === 'idb-quota') Pp.inject.idb = on;
    else if (f === 'spawn') window.Worker = on ? function () { throw new Error('pressure: injected spawn failure'); } : Pp.Worker;
    else if (f === 'mid-crash') {
      if (on) {
        let n = 0;
        const W = Pp.Worker;
        window.Worker = function (u, o) {
          const w = new W(u, o);
          const post = w.postMessage.bind(w);
          w.postMessage = function (m, x) { if (m && m.t === 'job' && ++n === 3) setTimeout(() => w.dispatchEvent(new ErrorEvent('error', { message: 'pressure: injected mid-run crash' }))); return post(m, x); };
          return w;
        };
      } else window.Worker = Pp.Worker;
    }
    return Pp.consoleErrors.length;
  }, { f: failure, on });
  const cancel = ['first', 'mid', 'last'].includes(dims.cancel) ? dims.cancel : null;
  const runX = async (r, full, withFaults) => {
    if (withFaults) await inject(true);
    let res;
    try { res = await P.ev(({ r, full, cancel }) => window.__ccH.run(r, { full, cancel }), { r, full, cancel: withFaults ? cancel : null }); }
    finally { if (withFaults) await inject(false); }
    if (withFaults && cancel) {
      if (!res.fired) notes.push('cancel=' + cancel + ' not exercised (' + res.events + ' progress events)');
      else if (res.outcome === 'cancelled') {
        const settle = await P.ev(async () => { for (let i = 0; i < 100 && window.__ccP.liveWorkers().length; i++) await new Promise((r) => setTimeout(r, 20)); return { live: window.__ccP.liveWorkers().length, liveWho: window.__ccP.liveWorkers().slice(0, 2), detecting: !!window._ccLatestState.detecting, active: window._ccDetectionActive() }; });
        ck('I8.cancel', res.stateUnchanged && !settle.detecting && !settle.active && settle.live === 0,
          'cancelled run (' + JSON.stringify(res.fired) + '): state unchanged=' + res.stateUnchanged + ' detecting=' + settle.detecting + ' active=' + settle.active + ' live workers=' + settle.live + ' ' + JSON.stringify(settle.liveWho) + ' pool=' + JSON.stringify(res.pool && { used: res.pool.used, reason: res.pool.reason }));
        res = await P.ev(({ r, full }) => window.__ccH.run(r, { full }), { r, full });
        res.afterCancel = true;
      } else ck('I8.cancel', res.outcome === 'complete', 'run with a late cancel ended ' + res.outcome);
    }
    return res;
  };
  const display = { tab: dims['display.tab'], hideProvided: dims['display.hideProvided'], hideContacts: dims['display.hideContacts'], style: dims['display.style'], section: dims['display.section'], showSpaces: dims['display.showSpaces'], occlusion: dims['display.occlusion'], locale: dims['display.locale'], filter: dims['display.filter'] };
  const tag = 'engine=' + mode + ' failure=' + failure + (cancel ? ' cancel=' + cancel : '');
  let lastRun = ref, curRules = Object.assign({}, rules);
  if (dims['run.kind'] === 'full') {
    await P.ev((dv) => window.__ccH.display(dv), display);
    const main = await runX(rules, true, true);
    if (main.err || main.outcome !== 'complete') ck('I9.complete', false, tag + ': run ended ' + (main.err || main.outcome));
    else {
      ck(failure === 'none' ? 'I1.path' : 'I9.failure', sameList(main.clashes, ref.clashes), tag + ' differs from the JS reference: ' + JSON.stringify(firstDiff(main.clashes, ref.clashes)));
      ck('I7.display', true);
      pathEvidence(main, mode, ck, notes);
    }
    lastRun = main;
  } else {
    const r1 = await runX(rules, true, false);
    ck('I1.path', r1.outcome === 'complete' && sameList(r1.clashes, ref.clashes), 'engine=' + mode + ' differs from the JS reference: ' + (r1.err || r1.outcome) + ' ' + JSON.stringify(firstDiff(r1.clashes, ref.clashes)));
    pathEvidence(r1, mode, ck, notes);
    await P.ev((dv) => window.__ccH.display(dv), display);
    trace('edits');
    // edits
    const plan = env.edits || planEdits(combo, dims['edits.count'], files.length);
    const applied = [];
    const moved = new Set();
    let invalidates = false;
    const statusEdits = [], denied = [];
    const parkedDigest = new Map();
    for (const e of plan) {
      const models = await P.ev(() => window.__ccH.models());
      if (!models.length && !['restore'].includes(e.k)) { applied.push(e.k + ':no-models'); continue; }
      const mi = models.length ? e.a % models.length : 0;
      let r = null;
      if (e.k === 'move') { r = await P.ev(({ mi, b, dy }) => window.__ccH.editMove(mi, b, dy), { mi, b: e.b, dy: e.dy }); moved.add(r.model + ':' + r.expressId); }
      else if (e.k === 'openings') { r = await P.ev(({ mi, b }) => window.__ccH.editOpenings(mi, b), { mi, b: e.b }); moved.add(r.model + ':' + r.expressId); }
      else if (e.k === 'delete-model') { if (models.length > 1) { r = await P.ev((i) => window.__ccH.deleteModel(i), mi); invalidates = true; } else r = 'kept last model'; }
      else if (e.k === 'park') {
        if (models.length > 1) {
          const nm = models[mi].name;
          // in-memory geometry edits are not persisted, so only untouched models are compared
          const untouched = ![...moved].some((k) => k.startsWith(nm + ':'));
          if (untouched) await P.ev((n) => window.__ccH.snapModel(n), nm);
          r = await P.ev((i) => window.__ccH.park(i), mi); invalidates = true;
          if (r && r.parked && untouched) parkedDigest.set(r.name, true);
        } else r = 'kept last model';
      } else if (e.k === 'restore') {
        r = await P.ev(() => window.__ccH.restore());
        if (r) {
          invalidates = true;
          if (parkedDigest.get(r.name) && r.restored) {
            const cmp = await P.ev((n) => window.__ccH.compareModel(n), r.name);
            ck('I3.park-restore', !cmp.error && cmp.elements === cmp.before && cmp.badCount === 0, 'model ' + r.name + ' after park -> restore: ' + JSON.stringify(cmp));
            notes.push('park->restore max vertex shift ' + (cmp.worstAbsM * 1000).toFixed(4) + ' mm (geometry-cache quantization)');
          }
        }
      } else if (e.k === 'replace') {
        const f = files.find((x) => x.model === models[mi].name);
        if (f) { r = await P.ev((ff) => window.__ccH.load([ff], {}), f); invalidates = true; }
      } else if (e.k === 'rule-change') {
        const gaps = [0, 30, 50, 100].filter((g) => g !== curRules.maxGap);
        curRules.maxGap = gaps[e.b % gaps.length];
        await P.ev((u) => window._ccDispatch({ t: 'UPD_RULES', u }), { maxGap: curRules.maxGap });
        r = { maxGap: curRules.maxGap }; invalidates = true;
      } else if (e.k === 'deny') { r = await P.ev((i) => window.__ccH.editClash(i, 'denied'), e.b); if (r) { r.seq = applied.length; denied.push(r); } }
      else if (e.k === 'status') {
        const s = ['in_progress', 'resolved'][e.b % 2];
        r = await P.ev(({ i, s }) => window.__ccH.editClash(i, s, 'pressure-' + (i % 7)), { i: e.b, s });
        if (r) { r.seq = applied.length; statusEdits.push(r); }
      }
      applied.push(e.k); trace('edit ' + e.k + ' done');
    }
    result.edits = applied;
    trace('smart run');
    const S = await runX(curRules, false, true);
    const smartPairs = await P.ev(() => window.__ccC.pairsOf());
    const stateAfterS = await P.ev(() => window._ccLatestState.clashes.map((c) => ({ id: c.id, status: c.status, assignee: c.assignee, a: c.globalIdA, b: c.globalIdB, delta: c._delta })));
    await P.ev(() => window.__ccH.setMode('js'));
    const Fjs = await P.ev((r) => window.__ccH.run(r, { full: true }), curRules);
    await P.ev((m) => window.__ccH.setMode(m), mode);
    trace('full runs');
    const F = await runX(curRules, true, false); // last: leaves the smart-run baseline on engine X
    if (S.err || S.outcome !== 'complete') ck('I2.smart', false, tag + ': smart run ended ' + (S.err || S.outcome));
    else {
      ck('I2.smart', sameList(S.clashes, F.clashes), 'smart re-run after edits [' + applied.join(',') + '] (' + tag + ') != full run: ' + JSON.stringify(firstDiff(S.clashes, F.clashes)));
      ck('I1.path-after-edits', sameList(F.clashes, Fjs.clashes), 'after edits, engine=' + mode + ' full != JS full: ' + JSON.stringify(firstDiff(F.clashes, Fjs.clashes)));
      if (!invalidates) {
        // A cancel that lands inside a small (single-chunk, synchronous) run
        // cannot stop it: that run completes and commits its baseline, so the
        // re-run after it legitimately sees 0 changed elements.
        const changedOk = S.prof.changed === moved.size || (S.afterCancel && S.prof.changed === 0);
        ck('I2.profile', S.prof.smart && changedOk && (moved.size || S.prof.hard === 0),
          'after edits [' + applied.join(',') + '] + display changes the re-run should be smart with ' + moved.size + ' changed element(s): ' + JSON.stringify(S.prof));
        ck('I7.keeps-smart', S.prof.smart, 'display-only changes made the re-run full');
      }
      // I10: statuses carried / denied stays gone
      const rawPairs = new Set(smartPairs.map((p) => p.key));
      const bad = [];
      const lastEdit = new Map();
      for (const e of statusEdits.concat(denied).sort((x, y) => x.seq - y.seq)) lastEdit.set(e.id, e); // later edits win
      for (const e of statusEdits.filter((x) => lastEdit.get(x.id) === x)) {
        const c = stateAfterS.find((x) => x.id === e.id);
        const pairKey = [e.globalIdA, e.globalIdB].sort().join('|');
        if (c && c.delta === 'persisting') { if (c.status !== e.status || c.assignee !== e.assignee) bad.push('clash ' + e.id + ' was ' + e.status + '/' + e.assignee + ', now ' + c.status + '/' + c.assignee); }
        else if (c && c.status === 'auto_resolved') { if (rawPairs.has(pairKey) && !invalidates) bad.push('clash ' + e.id + ' auto-resolved although its pair is still reported'); }
        else if (!c && rawPairs.has(pairKey) && !invalidates && e.status === 'in_progress') bad.push('in-progress clash ' + e.id + ' vanished although its pair is still reported');
      }
      for (const e of denied.filter((x) => lastEdit.get(x.id) === x)) {
        const back = stateAfterS.filter((x) => [x.a, x.b].sort().join('|') === [e.globalIdA, e.globalIdB].sort().join('|') && x.status !== 'denied');
        if (back.length) bad.push('denied pair came back as ' + JSON.stringify(back.slice(0, 2)));
      }
      if (statusEdits.length || denied.length) ck('I10.reconcile', bad.length === 0, bad.slice(0, 5).join('; '));
    }
    lastRun = F;
  }

  trace('list counts');
  // ── I6: the list's counts add up ──
  const lc = await P.ev(() => window.__ccH.listCounts());
  // Triage review buckets (ClashControl.review.summary) replaced the separate
  // notices: every clash on a visible model sits in exactly one bucket, and
  // clashes touching a hidden/parked model are the only ones outside them.
  const rv = await P.ev(() => {
    const R = window.ClashControl && window.ClashControl.review;
    const st = window._ccLatestState;
    if (!R || typeof R.summary !== 'function' || !st) return null;
    const sum = R.summary();
    const vis = {};
    (st.models || []).forEach((m) => { if (m.visible !== false) vis[m.id] = true; });
    const off = (st.clashes || []).filter((c) => (c.modelAId && !vis[c.modelAId]) || (c.modelBId && !vis[c.modelBId])).length;
    return { total: sum.total, buckets: sum.buckets, raw: (st.clashes || []).length, off };
  });
  if (rv) {
    const bsum = Object.values(rv.buckets || {}).reduce((a, b) => a + (b || 0), 0);
    ck('I6.buckets', bsum === rv.total && rv.total + rv.off === rv.raw,
      'review buckets ' + JSON.stringify(rv.buckets) + ' sum ' + bsum + ' vs total ' + rv.total + '; total ' + rv.total + ' + off-model ' + rv.off + ' != raw ' + rv.raw);
  } else {
    // every hidden bucket is counted: headline (what the list shows) + provided
    // openings + provisions + classify-only groups + contacts + denied == raw
    const sum = (lc.headline || 0) + (lc.hideProvided ? lc.provided : 0) + lc.provision + lc.groups + (lc.hideContacts ? lc.contact : 0) + lc.denied;
    ck('I6.buckets', sum === lc.raw,
      'list headline ' + lc.headline + ' + provided ' + lc.provided + ' + provisions ' + lc.provision + ' + groups ' + lc.groups + ' + contacts ' + lc.contact + ' + denied ' + lc.denied + ' = ' + sum + ' != ' + lc.raw + ' raw clashes (' + JSON.stringify(lc) + ')');
  }

  trace('round-trip');
  // ── B4 round-trips ──
  const rt = dims.roundtrip;
  if (rt === 'bcf-shown' || rt === 'bcf-all') {
    const r = await P.ev(({ which, v }) => window.__ccC.bcfRoundTrip(which, v), { which: rt === 'bcf-all' ? 'all' : 'shown', v: pick(rnd, ['2.1', '3.0']) });
    if (r.skipped) skip('I12.bcf', r.skipped);
    else ck('I12.bcf', !r.error && r.topics === r.items && r.imported === r.items && r.stableGuids && r.problemCount === 0, 'BCF ' + rt + ': ' + JSON.stringify(r));
  } else if (rt === 'project') {
    await projectRoundTrip(h, P, files, ck, skip, result);
  } else if (rt === 'undo-redo') {
    await undoRedo(P, curRules, lastRun, ck, skip);
  }

  trace('I3 canonical');
  // ── I3: subset / order / extras vs the canonical federation ──
  const canonical = dims['models.subset'] === 'ASM' && dims['models.order'] === '012' && dims['models.extra'] === 'none' && !fallback && dims.cancel !== 'abort-load';
  const ckey = fx.key + '|' + digest(rules) + '|' + P.cls;
  if (canonical) env.canon.set(ckey, refPairs.map(stripPair));
  else if (env.i3 !== false) {
    if (!env.canon.has(ckey)) {
      await P.ev(() => window.__ccH.reset());
      const all = ['A', 'S', 'M'].filter((L) => fx.files[L]).map((L) => fx.files[L]);
      const cl = await P.ev((fs) => window.__ccH.load(fs, {}), all);
      if (cl.timeout) throw new InfraError('canonical load timed out');
      await P.ev((u) => window._ccDispatch({ t: 'UPD_RULES', u }), rules);
      await P.ev(() => window.__ccH.setMode('js'));
      const cr = await P.ev((r) => window.__ccH.run(r, { full: true }), rules);
      if (cr.outcome !== 'complete') throw new InfraError('canonical run ' + cr.outcome);
      env.canon.set(ckey, (await P.ev(() => window.__ccC.pairsOf())).map(stripPair));
    }
    const canon = env.canon.get(ckey);
    const names = new Set(files.map((f) => f.model));
    const single = names.size === 1;
    const keyOf = (p) => p.key + '|' + p.type + '|' + (p.opening || '');
    const want = new Set(canon.filter((p) => names.has(p.mA) && names.has(p.mB)).map(keyOf));
    const got = new Set(refPairs.map(stripPair).filter((p) => !(single && p.same && rules.selfClashModels === 'none')).map(keyOf));
    const missing = [...want].filter((k) => !got.has(k)), extra = [...got].filter((k) => !want.has(k));
    ck('I3.subset-order', missing.length === 0 && extra.length === 0, 'vs the canonical federation (restricted to ' + [...names].join(',') + '): missing ' + missing.length + ' ' + JSON.stringify(missing.slice(0, 4)) + ', extra ' + extra.length + ' ' + JSON.stringify(extra.slice(0, 4)));
  }

  // ── I15: errors + workers ──
  return finish();

  async function finish() {
    const errs = await h.errors(P);
    const injected = new Set(['spawn', 'mid-crash', 'idb-quota', 'ls-quota', 'no-wasm', 'addon-404']);
    const consoleBad = injected.has(dims.failure) ? [] : errs.consoleErrors;
    const hard = errs.errors.concat(errs.rejections, errs.node);
    ck('I15.errors', hard.length === 0 && consoleBad.length === 0, 'page errors ' + JSON.stringify(hard.slice(0, 4)) + ' console errors ' + JSON.stringify(consoleBad.slice(0, 4)));
    if (injected.has(dims.failure) && errs.consoleErrors.length) notes.push('console errors under injected ' + dims.failure + ': ' + errs.consoleErrors.slice(0, 2).join(' | ').slice(0, 300));
    const live = await P.ev(async () => { for (let i = 0; i < 150 && window.__ccP.liveWorkers().length; i++) await new Promise((r) => setTimeout(r, 20)); return window.__ccP.liveWorkers(); });
    ck('I15.workers', live.length === 0, live.length + ' worker(s) still alive after the combo: ' + JSON.stringify(live.slice(0, 3)));
    result.ms = Date.now() - t0;
    result.status = checks.some((c) => c.ok === false) ? 'FAIL' : 'PASS';
    return result;
  }
}

function stripPair(p) { return { key: p.key, type: p.type, opening: p.opening, mA: p.mA, mB: p.mB, same: p.same }; }

// The path actually ran (otherwise I1 would compare JS with JS).
function pathEvidence(r, mode, ck, notes) {
  if (r.prof.cand > 80 && (mode === 'pool-wasm' || mode === 'pool-js' || mode === 'native')) {
    const pl = r.pool;
    if (!pl || !pl.used) notes.push('engine ' + mode + ': pool not used (' + JSON.stringify(pl && { used: pl.used, reason: pl.reason }) + ')');
  }
  if (mode === 'engine' && r.engineQueries === 0 && r.prof.hard > 0) notes.push('engine path served no Engine queries');
  if ((mode === 'js' || mode === 'wasm' || mode === 'engine') && r.pool && r.pool.used) ck('I1.path-evidence', false, 'pool ran although disabled for ' + mode);
}

// I11: save -> a FRESH page -> restore -> re-load the same files -> run.
async function projectRoundTrip(h, P, files, ck, skip, result) {
  const saved = await P.ev(() => {
    const s = window._ccLatestState;
    const data = window._ccProjectCodec.serializeProject(s, 'pressure', new Date(0).toISOString());
    data.__parked = (s.parkedModels || []).map((m) => m.id);
    return JSON.stringify(data);
  });
  const before = JSON.parse(saved);
  const lostParked = before.__parked.filter((id) => !before.models.some((m) => m.id === id));
  delete before.__parked;
  ck('I11.parked', lostParked.length === 0, 'saved project omits parked model(s) ' + JSON.stringify(lostParked));
  // the user re-adds the project's own files (a model deleted before saving is not part of it)
  const savedNames = new Set(before.models.map((m) => m.name));
  files = files.filter((f) => savedNames.has(f.model));
  if (!files.length) { skip('I11.project', 'no models left in the project'); return; }
  const ctx = await h.browser.newContext();
  try {
    const { offlineDepsEnabled, routeOfflineDeps } = await import('../browser/_offline-deps.mjs');
    if (offlineDepsEnabled()) await routeOfflineDeps(ctx, ROOT);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(h.url('/'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.ClashControl && window._ccDispatch && window._ccLatestState, null, { timeout: 90_000 });
    const r = await page.evaluate(async ({ saved, files }) => {
      const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
      const data = JSON.parse(saved);
      const actions = { ADD_MODEL: 'ADD_MODEL', UPD_RULES: 'UPD_RULES', SET_CLASHES: 'SET_CLASHES', LOAD_PROJECT_STATE: 'LOAD_PROJECT_STATE', ADD_ISSUE: 'ADD_ISSUE', ADD_VIEWPOINT: 'ADD_VIEWPOINT', ADD_MEASUREMENT: 'ADD_MEASUREMENT', ADD_SELSET: 'ADD_SELSET', ADD_SEARCHSET: 'ADD_SEARCHSET', ADD_ASSIGN_RULE: 'ADD_ASSIGN_RULE', MERGE_CHANGELOG: 'MERGE_CHANGELOG', MERGE_COMMENTS: 'MERGE_COMMENTS' };
      window._ccProjectCodec.validateProject(data);
      window._ccProjectCodec.restoreProject(data, window._ccDispatch, actions);
      await sleep(100);
      const st = () => window._ccLatestState;
      const afterRestore = { models: st().models.map((m) => m.id), clashes: st().clashes.length, issues: st().issues.length };
      const bufs = await Promise.all(files.map(async (f) => new File([await (await fetch(f.url)).arrayBuffer()], f.name)));
      window.ClashControl.loadFiles(bufs);
      for (let i = 0; i < 6000; i++) { if (window._ccModelLoading === false && st().models.length && st().models.every((m) => (m.elements || []).length)) break; await sleep(25); }
      const ids = st().models.map((m) => m.id);
      const res = await window.ClashControl.runDetection({ fullRerun: true });
      await sleep(50);
      return { afterRestore, ids, outcome: res && res._ccOutcome, raw: (res || []).map((c) => [c.globalIdA, c.globalIdB].sort().join('|')),
        clashes: st().clashes.map((c) => ({ id: c.id, status: c.status, assignee: c.assignee, key: [c.globalIdA, c.globalIdB].sort().join('|'), delta: c._delta })),
        issues: st().issues.map((i) => i.id) };
    }, { saved, files });
    const bad = [];
    if (JSON.stringify(r.afterRestore.models) !== JSON.stringify(before.models.map((m) => m.id))) bad.push('restored model ids ' + JSON.stringify(r.afterRestore.models));
    if (JSON.stringify(r.ids.slice().sort()) !== JSON.stringify(before.models.map((m) => m.id).sort())) bad.push('re-loaded files did not take the saved model ids: ' + JSON.stringify(r.ids));
    if (r.afterRestore.clashes !== before.clashes.length) bad.push('restored ' + r.afterRestore.clashes + ' of ' + before.clashes.length + ' clashes');
    if (r.outcome !== 'complete') bad.push('run after restore ' + r.outcome);
    const raw = new Set(r.raw);
    const now = new Map(r.clashes.map((c) => [c.id, c]));
    for (const c of before.clashes) {
      const key = [c.globalIdA, c.globalIdB].sort().join('|');
      if (!raw.has(key) || c.status === 'denied') continue;
      const n = now.get(c.id);
      const want = c.status === 'auto_resolved' ? 'open' : c.status;
      if (!n) { if (c.status === 'open' || c.status === 'in_progress') bad.push('clash ' + c.id + ' (' + c.status + ') lost after restore + re-run'); continue; }
      if (n.status !== want || (n.assignee || '') !== (c.assignee || '')) bad.push('clash ' + c.id + ' status ' + c.status + '/' + c.assignee + ' -> ' + n.status + '/' + n.assignee);
    }
    if (before.issues.length !== r.issues.length) bad.push('issues ' + before.issues.length + ' -> ' + r.issues.length);
    if (errs.length) bad.push('page errors in the fresh page: ' + errs.slice(0, 3).join(' | '));
    ck('I11.project', bad.length === 0, bad.slice(0, 6).join('; '));
    result.project = { clashes: before.clashes.length, issues: before.issues.length };
  } finally { try { await ctx.close(); } catch (_) {} }
}

// Undo/redo: section plane + section box + temp-hide, undone and redone; the
// clash list must not move and the next re-run stays smart. Status edits are
// probed: if UPD_CLASH status changes are not on the undo stack, that adapter
// is absent (reported, not failed).
async function undoRedo(P, rules, lastRun, ck, skip) {
  const r = await P.ev(async () => {
    const d = window._ccDispatch, st = () => window._ccLatestState;
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const snap = () => JSON.stringify({ a: st().sectionAxis, p: st().sectionAxis ? st().sectionPos : null, b: st().sectionBox || null });
    window._ccUndoStack.length = 0; window._ccRedoStack.length = 0;
    const s0 = snap();
    // status edit probe
    const c = st().clashes[0];
    let statusUndo = null;
    if (c) {
      const n0 = window._ccUndoStack.length;
      d({ t: 'UPD_CLASH', id: c.id, u: { status: 'in_progress' } });
      await sleep(30);
      statusUndo = window._ccUndoStack.length > n0;
      if (statusUndo) { window._ccUndo(); await sleep(30); }
      else d({ t: 'UPD_CLASH', id: c.id, u: { status: c.status } });
    }
    const n0 = window._ccUndoStack.length;
    d({ t: 'SECTION', axis: 'x', pos: 0.4 }); await sleep(800); // past the coalesce window
    const spec = window._ccModelSectionBoxSpec && window._ccModelSectionBoxSpec();
    if (spec) { d({ t: 'SECTION_BOX', v: spec }); await sleep(800); }
    const el = st().models[0] && st().models[0].elements[0];
    if (el && window._ccTempHide) { window._ccTempHide([{ expressId: el.expressId, modelId: st().models[0].id }]); await sleep(50); }
    const pushed = window._ccUndoStack.length - n0;
    const s1 = snap();
    let undone = 0; while (window._ccUndo()) { undone++; await sleep(30); }
    const sU = snap();
    let redone = 0; while (window._ccRedo()) { redone++; await sleep(30); }
    const sR = snap();
    while (window._ccUndo()) await sleep(10);
    if (window._ccTempUnhide) window._ccTempUnhide();
    window._ccUndoStack.length = 0; window._ccRedoStack.length = 0;
    return { pushed, undone, redone, back: sU === s0, again: sR === s1, statusUndo, statusOk: c ? st().clashes.find((x) => x.id === c.id).status === c.status : true };
  });
  ck('I12.undo-redo', r.pushed >= 2 && r.undone === r.pushed && r.redone === r.pushed && r.back && r.again && r.statusOk, 'undo/redo of section/box/hide: ' + JSON.stringify(r));
  if (r.statusUndo === false) skip('I12.undo-status', 'SKIPPED (absent): clash status edits are not on the undo stack');
  const after = await P.ev((rr) => window.__ccH.run(rr, { full: false }), rules);
  ck('I12.undo-no-op', after.outcome === 'complete' && after.prof.smart && after.prof.changed === 0 && sameList(after.clashes, lastRun.clashes), 'after undo/redo the re-run should be smart and unchanged: ' + JSON.stringify(after.prof) + ' ' + JSON.stringify(firstDiff(after.clashes, lastRun.clashes)));
}

export async function loadOracleSrc() { return readFile(join(ROOT, 'tests/_oracle-exact.js'), 'utf8'); }
