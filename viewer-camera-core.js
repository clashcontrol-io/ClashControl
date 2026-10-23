// @ts-check
// Pure camera-navigation math for the orbit controls in index.html
// (makeOrbit). Plain {x,y,z} objects, no THREE, no DOM — index.html passes
// in camera/target/anchor positions and applies the result; node:test drives
// it directly (tests/orbit-math.test.js, tests/viewer-camera-core.test.js).
// See docs/INTERNALS.md §13.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccViewerCamera = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';


  // Rotates vector v by `angle` radians around the unit axis (ax,ay,az)
  // (Rodrigues' rotation formula).
  function _ccRotateAroundAxis(v, ax, ay, az, angle) {
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var dot = v.x*ax + v.y*ay + v.z*az;
    var crossX = ay*v.z - az*v.y, crossY = az*v.x - ax*v.z, crossZ = ax*v.y - ay*v.x;
    return {
      x: v.x*cos + crossX*sin + ax*dot*(1-cos),
      y: v.y*cos + crossY*sin + ay*dot*(1-cos),
      z: v.z*cos + crossZ*sin + az*dot*(1-cos)
    };
  }

  // Orbit-drag step: rotates the camera position around a fixed pivot point
  // AND the camera's actual current VIEW DIRECTION (its forward unit
  // vector — not the orbit `target`, which the caller may have set
  // somewhere the camera wasn't yet looking, e.g. a just-clicked element's
  // bbox centre) by the identical (yaw, pitch) rotation derived from a
  // (dx,dy) pixel delta, then applies a soft polar clamp so the view can
  // approach the pole smoothly instead of freezing dead.
  //
  // This is a rigid rotation of the camera (as a physical object: position
  // + orientation) about the pivot. For any fixed point P, its camera-local
  // (view-space) coordinates are provably unchanged by such a rotation
  // regardless of whether the camera was originally looking at P — so the
  // pivot stays exactly fixed on screen, AND the view direction changes
  // smoothly by exactly the drag's rotation, with no snap. The old code
  // instead rotated the orbit `target` and re-derived orientation via
  // camera.lookAt(target); when `target` had just been moved off the
  // camera's actual view ray (e.g. by a click-to-select pivot shift) that
  // lookAt() itself performed a hard reorientation — measured at ~18° for a
  // single 2px drag right after such a shift. Operating on the true current
  // forward vector instead of `target` fixes this at the source: the
  // caller reconstructs `target` afterwards from the corrected forward
  // vector, so it's always consistent with what lookAt() will reproduce.
  function _ccOrbitDragStep(camPos, forward, pivot, dx, dy, sens, minPhi, maxPhi) {
    sens = sens == null ? 0.007 : sens;
    minPhi = minPhi == null ? 0.05 : minPhi;
    maxPhi = maxPhi == null ? Math.PI - 0.05 : maxPhi;
    var yaw = -dx * sens, pitch = -dy * sens;
    var offset = { x: camPos.x-pivot.x, y: camPos.y-pivot.y, z: camPos.z-pivot.z };
    var fwd = { x: forward.x, y: forward.y, z: forward.z };
    function rotBoth(ax, ay, az, angle) {
      offset = _ccRotateAroundAxis(offset, ax, ay, az, angle);
      fwd = _ccRotateAroundAxis(fwd, ax, ay, az, angle);
    }
    // Yaw around world up.
    rotBoth(0, 1, 0, yaw);
    // Pitch around the current horizontal "right" axis (forward × up).
    var flen = Math.sqrt(fwd.x*fwd.x+fwd.y*fwd.y+fwd.z*fwd.z) || 1;
    var fx = fwd.x/flen, fy = fwd.y/flen, fz = fwd.z/flen;
    var rx = fy*0-fz*1, ry = fz*0-fx*0, rz = fx*1-fy*0; // forward × (0,1,0)
    var rlen = Math.sqrt(rx*rx+ry*ry+rz*rz);
    if (rlen < 1e-8) { rx=1; ry=0; rz=0; } else { rx/=rlen; ry/=rlen; rz/=rlen; }
    rotBoth(rx, ry, rz, pitch);
    // Soft polar clamp: phi = angle of the camera→target direction (-forward)
    // from +Y, matching the original sph.phi semantics, kept in [minPhi,maxPhi].
    var flen2 = Math.sqrt(fwd.x*fwd.x+fwd.y*fwd.y+fwd.z*fwd.z) || 1;
    var ny = fwd.y/flen2;
    var phi = Math.acos(Math.max(-1, Math.min(1, -ny)));
    if (phi < minPhi || phi > maxPhi) {
      var clamped = Math.max(minPhi, Math.min(maxPhi, phi));
      var horiz = Math.sqrt(Math.max(0, flen2*flen2 - fwd.y*fwd.y));
      var hx = horiz > 1e-6 ? fwd.x/horiz : 1, hz = horiz > 1e-6 ? fwd.z/horiz : 0;
      var newNy = -Math.cos(clamped);
      var newHoriz = Math.sqrt(Math.max(0, 1 - newNy*newNy));
      fwd = { x: hx*newHoriz, y: newNy, z: hz*newHoriz };
    } else {
      fwd = { x: fwd.x/flen2, y: fwd.y/flen2, z: fwd.z/flen2 };
    }
    return { camPos: { x: pivot.x+offset.x, y: pivot.y+offset.y, z: pivot.z+offset.z }, forward: fwd };
  }

  // Uniformly scales camPos & target toward/away from `anchor` by `factor`.
  // Because BOTH points move toward the same anchor by the same factor, the
  // anchor point itself never moves — dollying "along the ray through the
  // cursor" — and the operation is exactly reversible: applying `factor`
  // then `1/factor` returns both points to their exact starting values (up
  // to floating point), unlike the old camera-forward-advance approach
  // (whose in/out steps used different formulas and drifted).
  function _ccZoomDollyStep(camPos, tgt, anchor, factor) {
    return {
      camPos: { x: anchor.x+(camPos.x-anchor.x)*factor, y: anchor.y+(camPos.y-anchor.y)*factor, z: anchor.z+(camPos.z-anchor.z)*factor },
      tgt:    { x: anchor.x+(tgt.x-anchor.x)*factor,    y: anchor.y+(tgt.y-anchor.y)*factor,    z: anchor.z+(tgt.z-anchor.z)*factor }
    };
  }

  // World units per screen pixel at a given depth (perspective camera
  // vertical FOV), used so a pan drag keeps the grabbed point under the
  // cursor regardless of zoom level, instead of the old flat
  // `sph.r * 0.0008` approximation (which under/over-panned depending on
  // how far `r` was from the actual depth of the thing being panned).
  function _ccPanWorldPerPixel(depth, viewportHeightPx, vFovDeg) {
    var vFovRad = vFovDeg * Math.PI / 180;
    return 2 * depth * Math.tan(vFovRad / 2) / Math.max(1, viewportHeightPx);
  }
  function _dist(a, b) {
    var dx = a.x-b.x, dy = a.y-b.y, dz = a.z-b.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  // Bounded zoom-to-cursor dolly step. Wraps _ccZoomDollyStep (camera and
  // target scaled toward/away from `anchor`, so the anchor stays fixed on
  // screen) with the limits that keep the camera from getting stuck:
  //
  //  - Zooming OUT moves by `effDist * (factor-1)` where
  //    effDist = max(dist, 0.01*sceneDiag, 0.25 m) and dist = |camera-anchor|.
  //    The plain 4%-of-distance step had no floor: once the camera sat on a
  //    surface (or the fallback anchor sat right in front of it) every notch
  //    moved ~2 cm and zooming out looked broken. Far from surfaces
  //    (dist >= floor) the step is the exact multiplicative one, so in/out
  //    stays exactly reversible there.
  //  - Zooming IN toward a picked surface (opts.surface) stops at a standoff
  //    of max(10*near, 0.05 m) in front of it and never crosses it.
  //  - |camera-target| stays within [minR, maxR] (the orbit's own clamp, so a
  //    later orbit.apply() never yanks the camera).
  //
  // opts: {surface, sceneDiag, near, minR=0.5, maxR=5000}
  // Returns {camPos, tgt, factor, dist} — factor is the scale actually
  // applied about the anchor, dist the new camera-anchor distance.
  function dollyStep(camPos, tgt, anchor, factor, opts) {
    opts = opts || {};
    var minR = opts.minR != null ? opts.minR : 0.5;
    var maxR = opts.maxR != null ? opts.maxR : 5000;
    var d = _dist(camPos, anchor), r = _dist(camPos, tgt);
    var f = 1;
    if (factor > 1) {
      var floor = Math.max(0.01 * (opts.sceneDiag || 0), 0.25);
      var step = Math.max(d, floor) * (factor - 1);
      if (d < 1e-9) {
        // Camera exactly on the anchor: no direction to scale along, back
        // off along the view direction instead.
        var len = r || 1;
        var fx = (tgt.x-camPos.x)/len, fy = (tgt.y-camPos.y)/len, fz = (tgt.z-camPos.z)/len;
        return {
          camPos: { x: camPos.x-fx*step, y: camPos.y-fy*step, z: camPos.z-fz*step },
          tgt:    { x: tgt.x-fx*step,    y: tgt.y-fy*step,    z: tgt.z-fz*step },
          factor: 1, dist: step
        };
      }
      f = (d + step) / d;
      if (r * f > maxR) f = Math.max(1, maxR / Math.max(r, 1e-9));
    } else if (factor < 1 && factor > 0) {
      f = factor;
      if (opts.surface) {
        var standoff = Math.max(10 * (opts.near || 0), 0.05);
        if (d * f < standoff) f = d > standoff ? standoff / d : 1;
      }
      if (r * f < minR) f = Math.min(1, Math.max(f, minR / Math.max(r, 1e-9)));
    }
    var out = _ccZoomDollyStep(camPos, tgt, anchor, f);
    return { camPos: out.camPos, tgt: out.tgt, factor: f, dist: d * f };
  }

  return {
    rotateAroundAxis: _ccRotateAroundAxis,
    orbitDragStep: _ccOrbitDragStep,
    zoomDollyStep: _ccZoomDollyStep,
    panWorldPerPixel: _ccPanWorldPerPixel,
    dollyStep: dollyStep
  };
}));
