const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../renderer-contract');

class FakeRenderer {
  constructor(options) {
    this.options = options;
    this.domElement = {};
    this.shadowMap = {};
    this._dpr = null;
    this.disposed = false;
  }
  setPixelRatio(value) { this._dpr = value; }
  getPixelRatio() { return this._dpr; }
  setSize(width, height) { this.size = [width, height]; }
  dispose() { this.disposed = true; }
}

function fixture(Renderer = FakeRenderer) {
  const THREE = {
    WebGLRenderer: Renderer,
    SRGBColorSpace: 'srgb',
    ACESFilmicToneMapping: 'aces',
    PCFShadowMap: 'pcf',
  };
  return {
    THREE, pixelRatio:1.5, width:800, height:600,
    setSRGBOutput(renderer) { renderer.outputColorSpace = THREE.SRGBColorSpace; },
  };
}

test('candidate exactly recreates the established renderer contract', () => {
  const options = fixture();
  const renderer = contract.createCandidate(options);
  assert.deepEqual(renderer.options, { antialias:true, powerPreference:'high-performance' });
  assert.deepEqual(renderer.size, [800, 600]);
  const state = contract.snapshot(renderer, options.THREE, 1.5);
  assert.deepEqual(contract.validate(state), { equal:true, failures:[] });
});

test('contract names every renderer invariant that failed during past upgrades', () => {
  const options = fixture();
  const renderer = contract.createCandidate(options);
  renderer.outputColorSpace = 'wrong';
  renderer.shadowMap.autoUpdate = true;
  renderer.localClippingEnabled = true;
  renderer._dpr = 2;
  const result = contract.validate(contract.snapshot(renderer, options.THREE, 1.5));
  assert.equal(result.equal, false);
  assert.deepEqual(result.failures, ['pixel-ratio', 'initial-clipping', 'color-space', 'shadow-auto-update']);
});

test('candidate exception disposes partial renderer and returns legacy renderer', () => {
  let partial;
  class BrokenRenderer extends FakeRenderer {
    constructor(options) { super(options); partial = this; }
    setSize() { throw new Error('WebGL setup failed'); }
  }
  const events = [];
  const legacy = { legacy:true };
  const result = contract.createGuarded({
    ...fixture(BrokenRenderer),
    legacy: () => legacy,
    record: (event) => events.push(event),
  });
  assert.equal(result.path, 'fallback');
  assert.equal(result.renderer, legacy);
  assert.equal(partial.disposed, true);
  assert.equal(events[0].outcome, 'fallback');
});

test('semantic mismatch disposes candidate before legacy fallback', () => {
  class WrongDprRenderer extends FakeRenderer {
    getPixelRatio() { return 99; }
  }
  const legacy = { legacy:true };
  const result = contract.createGuarded({ ...fixture(WrongDprRenderer), legacy:() => legacy });
  assert.equal(result.path, 'fallback');
  assert.equal(result.renderer, legacy);
  assert.equal(result.comparison.equal, false);
});
