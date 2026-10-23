// @ts-check
// Viewer gizmos shared by the section plane, the section box and the
// floor-plan cut arrow in index.html: screen-constant sizing, DESIGN.md token
// colours with idle / hover / active states, the handle builders, and the
// section-outline math (model box ∩ plane). THREE is passed in (create /
// build*), never read from a global, so node:test drives it with the real
// three.cjs (tests/viewer-gizmo-core.test.js). See docs/INTERNALS.md §21.24.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccViewerGizmo = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // World length of `px` screen pixels at worldPos (default 1 px). Perspective
  // uses the depth along the view direction (what projection divides by), so
  // a handle keeps its pixel size anywhere on screen; ortho uses the frustum.
  function pxScale(camera, worldPos, viewportHeightPx, px) {
    var h = viewportHeightPx > 0 ? viewportHeightPx : 1, n = px == null ? 1 : px;
    if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / (camera.zoom || 1) / h * n;
    var c = camera.position, dx = worldPos.x - c.x, dy = worldPos.y - c.y, dz = worldPos.z - c.z;
    var e = camera.matrixWorld && camera.matrixWorld.elements, depth;
    if (e) depth = -(dx * e[8] + dy * e[9] + dz * e[10]) / (Math.hypot(e[8], e[9], e[10]) || 1);
    else depth = Math.sqrt(dx * dx + dy * dy + dz * dz);
    depth = Math.max(depth, camera.near || 1e-3);
    return 2 * depth * Math.tan((camera.fov || 50) * Math.PI / 360) / (camera.zoom || 1) / h * n;
  }

  // Cached CSS custom-property reader. getValue(name) -> raw value.
  function makeTokenReader(getValue) {
    /** @type {Object<string,string>} */
    var cache = {};
    /** @param {string} name @param {string=} fallback */
    function read(name, fallback) {
      if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
      var v = '';
      try { v = String(getValue(name) || '').trim(); } catch (e) { v = ''; }
      return (cache[name] = v || fallback || '');
    }
    read.invalidate = function() { cache = {}; };
    return read;
  }

  // Colour roles per gizmo part: token per state + opacity. Accent only on
  // hover / drag; idle parts are neutral (DESIGN.md: calm, never decorative).
  var STYLES = {
    tab:     { fill: { idle: '--bg-secondary', hover: '--accent-bg', active: '--accent' }, fillOpacity: 1,
               stroke: { idle: '--text-muted', hover: '--accent', active: '--accent' } },
    handle:  { fill: { idle: '--text-secondary', hover: '--accent', active: '--accent' }, fillOpacity: 0.95 },
    outline: { fill: { idle: '--accent' }, fillOpacity: 0.04,
               stroke: { idle: '--text-faint', hover: '--accent', active: '--accent' } },
    edge:    { stroke: { idle: '--text-faint' } },
    cut:     { stroke: { idle: '--text-primary' } }
  };

  function _each(obj, fn) {
    if (typeof obj.traverse === 'function') obj.traverse(fn); else fn(obj);
  }

  // Paints obj (and its children) for `state`: meshes get the style's fill,
  // lines its stroke. Invisible pick proxies (material.visible false) are skipped.
  function paint(read, obj, state) {
    var spec = STYLES[(obj.userData && obj.userData.ccGizmo && obj.userData.ccGizmo.style) || 'handle'];
    _each(obj, function(o) {
      var m = o.material;
      if (!m || m.visible === false || !m.color) return;
      var role = o.isLine ? spec.stroke : spec.fill;
      var c = role && read(role[state] || role.idle);
      if (!c) return; // token missing: keep the current colour
      m.color.set(c);
      if (!o.isLine && spec.fillOpacity != null) m.opacity = spec.fillOpacity;
      m.needsUpdate = true;
    });
  }

  // ── Builders (geometry in PIXELS: tracked objects are scaled by world/px) ──
  function _mat(THREE, extra) {
    var m = new THREE.MeshBasicMaterial(Object.assign({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }, extra || {}));
    m.clippingPlanes = [];
    return m;
  }
  function _lineMat(THREE) {
    var m = new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
    m.clippingPlanes = [];
    return m;
  }
  function _proxy(THREE, geo) { return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false })); }

  // Flat square tab facing the camera (billboard): fill + 1 px stroke.
  function buildTab(THREE, sizePx) {
    var s = sizePx || 12;
    var tab = new THREE.Mesh(new THREE.PlaneGeometry(s, s), _mat(THREE));
    var h = s / 2, pts = [new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0), new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0)];
    var stroke = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), _lineMat(THREE));
    stroke.renderOrder = 1001;
    tab.add(stroke);
    tab.renderOrder = 1000;
    tab.userData.ccGizmo = { style: 'tab', billboard: true, sizePx: s };
    return tab;
  }

  // Quarter arc in the XZ plane (+X .. -Z quadrant) around the origin; the
  // returned object is the (invisible, fat) pick proxy with the visible arc
  // as its child, so hovering anywhere near the arc grabs it.
  function buildArc(THREE, radiusPx) {
    var r = radiusPx || 28, sweep = Math.PI / 2;
    var proxyGeo = new THREE.TorusGeometry(r, 7, 6, 24, sweep); proxyGeo.rotateX(-Math.PI / 2);
    var arcGeo = new THREE.TorusGeometry(r, 1.25, 6, 32, sweep); arcGeo.rotateX(-Math.PI / 2);
    var proxy = _proxy(THREE, proxyGeo);
    var arc = new THREE.Mesh(arcGeo, _mat(THREE));
    arc.renderOrder = 1000;
    proxy.add(arc);
    proxy.userData.ccGizmo = { style: 'handle', radiusPx: r };
    return proxy;
  }

  // Arrow along local +Z from the origin (shaft + cone) with a small ring at
  // its base (local XY plane). Returns {group, move:[pick meshes], ring}.
  function buildArrow(THREE, lengthPx, opts) {
    var len = lengthPx || 44, tipLen = 11, tipR = 5.5, shaftLen = len - tipLen;
    var group = new THREE.Group();
    var shaftGeo = new THREE.CylinderGeometry(1.5, 1.5, shaftLen, 8, 1, true); shaftGeo.rotateX(Math.PI / 2); shaftGeo.translate(0, 0, shaftLen / 2);
    var tipGeo = new THREE.ConeGeometry(tipR, tipLen, 16); tipGeo.rotateX(Math.PI / 2); tipGeo.translate(0, 0, shaftLen + tipLen / 2);
    var proxyGeo = new THREE.CylinderGeometry(8, 8, len, 8); proxyGeo.rotateX(Math.PI / 2); proxyGeo.translate(0, 0, len / 2);
    var move = _proxy(THREE, proxyGeo);
    move.add(new THREE.Mesh(shaftGeo, _mat(THREE)), new THREE.Mesh(tipGeo, _mat(THREE)));
    move.children.forEach(function(c) { c.renderOrder = 1000; });
    move.userData.ccGizmo = { style: 'handle' };
    group.add(move);
    var ring = null;
    if (!opts || opts.ring !== false) {
      var rr = 11;
      ring = _proxy(THREE, new THREE.TorusGeometry(rr, 5, 6, 32));
      var ringVis = new THREE.Mesh(new THREE.TorusGeometry(rr, 1.25, 6, 48), _mat(THREE));
      ringVis.renderOrder = 1000;
      ring.add(ringVis);
      ring.userData.ccGizmo = { style: 'handle' };
      group.add(ring);
    }
    group.userData.ccGizmo = { spanPx: len };
    return { group: group, move: move, ring: ring };
  }

  // ── Section outline: the model box cut by a plane ─────────────────────────
  function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function _norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  // In-plane basis (u, v) with u × v = n. u is horizontal for any non-
  // horizontal plane; for a horizontal plane u follows `fallbackU` (the
  // building grid's x axis), so axis planes and picked planes share one rule.
  function planeBasis(n, fallbackU) {
    n = _norm(n);
    var u;
    if (Math.abs(n[1]) < 0.99) u = _norm([n[2], 0, -n[0]]); // up × n
    else {
      var f = fallbackU || [1, 0, 0], k = _dot(f, n);
      u = _norm([f[0] - n[0] * k, f[1] - n[1] * k, f[2] - n[2] * k]);
    }
    return { u: u, v: _cross(n, u), n: n };
  }

  // 8 corners of an oriented box given as axes {x,y,z} + min/max along them
  // (the shape of index.html's _ccPlanFrame). Corner i: bit0 x, bit1 y, bit2 z.
  function boxCorners(axes, min, max) {
    var out = [];
    for (var i = 0; i < 8; i++) {
      var X = i & 1 ? max.x : min.x, Y = i & 2 ? max.y : min.y, Z = i & 4 ? max.z : min.z;
      out.push([axes.x[0] * X + axes.y[0] * Y + axes.z[0] * Z, axes.x[1] * X + axes.y[1] * Y + axes.z[1] * Z, axes.x[2] * X + axes.y[2] * Y + axes.z[2] * Z]);
    }
    return out;
  }

  // Outline rectangle of the plane (n, p) through the box: the box ∩ plane
  // polygon's extents along (u, v), centred on it, with a small margin. The
  // margin grows with the distance from the cut to the furthest corner (so
  // geometry above/below still reads inside it in perspective), 4 % per side
  // minimum, capped so the whole outline is at most `maxScale` × the cut.
  function planeOutline(corners, n, p, basis, maxScale) {
    var d = corners.map(function(c) { return (c[0] - p[0]) * n[0] + (c[1] - p[1]) * n[1] + (c[2] - p[2]) * n[2]; });
    var gap = 0, pts = [];
    d.forEach(function(x) { gap = Math.max(gap, Math.abs(x)); });
    for (var i = 0; i < 8; i++) {
      if (Math.abs(d[i]) < 1e-9) pts.push(corners[i]);
      for (var bit = 1; bit < 8; bit <<= 1) {
        var j = i | bit;
        if (j === i || !(d[i] * d[j] < 0)) continue;
        var t = d[i] / (d[i] - d[j]), a = corners[i], b = corners[j];
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    if (pts.length < 3) pts = corners; // plane outside the box: its projection
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    pts.forEach(function(q) {
      var r = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], a = _dot(r, basis.u), b = _dot(r, basis.v);
      if (a < lo[0]) lo[0] = a; if (a > hi[0]) hi[0] = a;
      if (b < lo[1]) lo[1] = b; if (b > hi[1]) hi[1] = b;
    });
    var ext = [hi[0] - lo[0], hi[1] - lo[1]], big = Math.max(ext[0], ext[1], 1e-6);
    var e = [Math.max(ext[0], 0.01 * big), Math.max(ext[1], 0.01 * big)];
    var fMax = ((maxScale || 1.2) - 1) / 2;
    var f = Math.min(fMax, Math.max(0.04, 2 * gap / Math.min(e[0], e[1])));
    var mu = (lo[0] + hi[0]) / 2, mv = (lo[1] + hi[1]) / 2, u = basis.u, v = basis.v;
    return {
      center: [p[0] + u[0] * mu + v[0] * mv, p[1] + u[1] * mu + v[1] * mv, p[2] + u[2] * mu + v[2] * mv],
      halfW: e[0] * (0.5 + f), halfH: e[1] * (0.5 + f), extent: ext, gap: gap
    };
  }

  // ── Live registry ──────────────────────────────────────────────────────
  // opts: {THREE, read?(token reader), document?, onChange?()}. Tracked
  // objects are rescaled to their pixel size (and billboarded) by update(),
  // repainted on theme change, and dropped once they leave the scene.
  function create(opts) {
    opts = opts || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var read = opts.read || makeTokenReader(function(name) {
      return doc && typeof getComputedStyle === 'function' ? getComputedStyle(doc.documentElement).getPropertyValue(name) : '';
    });
    /** @type {any[]} */
    var live = [];
    var tmp = { x: 0, y: 0, z: 0 };
    function inScene(o) { while (o.parent) o = o.parent; return !!o.isScene; }
    function setState(obj, state) {
      if (!obj) return;
      obj.userData.ccGizmoState = state;
      paint(read, obj, state);
      if (opts.onChange) opts.onChange();
    }
    function track(obj, style) {
      obj.userData.ccGizmo = Object.assign({}, obj.userData.ccGizmo || {}, style ? { style: style } : {});
      if (live.indexOf(obj) < 0) live.push(obj);
      paint(read, obj, obj.userData.ccGizmoState || 'idle');
      return obj;
    }
    function update(camera, viewportHeightPx) {
      if (!live.length) return;
      live = live.filter(inScene);
      live.forEach(function(o) {
        var g = o.userData.ccGizmo;
        if (g.fixed) return; // painted, not scaled (outlines, box edges)
        if (o.getWorldPosition && opts.THREE) {
          var w = o.getWorldPosition(new opts.THREE.Vector3());
          tmp.x = w.x; tmp.y = w.y; tmp.z = w.z;
        } else { tmp.x = o.position.x; tmp.y = o.position.y; tmp.z = o.position.z; }
        var s = pxScale(camera, tmp, viewportHeightPx, 1);
        if (s > 0 && isFinite(s)) o.scale.setScalar(s);
        if (g.billboard) o.quaternion.copy(camera.quaternion);
      });
    }
    function refreshTheme() {
      read.invalidate();
      live = live.filter(inScene);
      live.forEach(function(o) { paint(read, o, o.userData.ccGizmoState || 'idle'); });
      if (opts.onChange) opts.onChange();
    }
    if (opts.observeTheme && doc && typeof MutationObserver === 'function') {
      new MutationObserver(refreshTheme).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    return {
      track: track, update: update, setState: setState, refreshTheme: refreshTheme,
      color: function(token) { return read(token); },
      size: function() { return live.length; },
      pxScale: pxScale
    };
  }

  return Object.freeze({
    pxScale: pxScale, makeTokenReader: makeTokenReader, STYLES: STYLES, paint: paint,
    buildTab: buildTab, buildArc: buildArc, buildArrow: buildArrow,
    planeBasis: planeBasis, boxCorners: boxCorners, planeOutline: planeOutline,
    create: create
  });
}));
