const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Runs scripts/apply-contributed-pack.js against a throwaway copy of the
// locales/regulations dirs (the script always resolves paths relative to
// its own location via __dirname, so we copy the script itself alongside a
// scratch locales/regulations pair rather than touching the real repo dirs).
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-apply-pack-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'locales'));
  fs.mkdirSync(path.join(root, 'regulations'));
  ['apply-contributed-pack.js', 'validate-locale.js', 'validate-regulation.js'].forEach((f) => {
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', f), path.join(root, 'scripts', f));
  });
  fs.writeFileSync(path.join(root, 'locales', 'manifest.json'), '[]\n');
  fs.writeFileSync(path.join(root, 'regulations', 'manifest.json'), '[]\n');
  return root;
}

function run(root, args) {
  return execFileSync('node', [path.join(root, 'scripts', 'apply-contributed-pack.js'), ...args], { encoding: 'utf8' });
}

test('apply-contributed-pack creates a new locale pack + manifest entry', () => {
  const root = makeSandbox();
  const packPath = path.join(root, 'de.json');
  fs.writeFileSync(packPath, JSON.stringify({ lang: 'de', name: 'Deutsch', contributor: 'tester', strings: { 'toolbar.open': 'Öffnen' } }));

  const out = run(root, ['locale', packPath]);
  assert.match(out, /Applied locale pack "de"/);

  const written = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'de.json'), 'utf8'));
  assert.equal(written.lang, 'de');

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, [{ lang: 'de', file: 'de.json', name: 'Deutsch', contributor: 'tester' }]);
});

test('apply-contributed-pack refuses to overwrite an existing pack', () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'locales', 'manifest.json'), JSON.stringify([{ lang: 'de', file: 'de.json', name: 'Deutsch', contributor: 'original' }]));
  fs.writeFileSync(path.join(root, 'locales', 'de.json'), JSON.stringify({ lang: 'de', name: 'Deutsch', contributor: 'original', strings: {} }));

  const packPath = path.join(root, 'malicious-de.json');
  fs.writeFileSync(packPath, JSON.stringify({ lang: 'de', name: 'Deutsch (hijacked)', contributor: 'attacker', strings: { 'toolbar.open': 'gotcha' } }));

  assert.throws(() => run(root, ['locale', packPath]), /already exists/);

  // Original pack must be untouched.
  const stillOriginal = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'de.json'), 'utf8'));
  assert.equal(stillOriginal.contributor, 'original');
});

test('apply-contributed-pack rejects an invalid pack before writing anything', () => {
  const root = makeSandbox();
  const packPath = path.join(root, 'bad.json');
  fs.writeFileSync(packPath, JSON.stringify({ lang: 'de', name: 'Deutsch', contributor: 'x', strings: { greeting: '<script>alert(1)</script>' } }));

  assert.throws(() => run(root, ['locale', packPath]), /Validation failed/);
  assert.equal(fs.existsSync(path.join(root, 'locales', 'de.json')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, []);
});

test('apply-contributed-pack creates a new regulation pack, carrying verified:false through', () => {
  const root = makeSandbox();
  const packPath = path.join(root, 'jp.json');
  fs.writeFileSync(packPath, JSON.stringify({
    region: 'jp', name: 'Japan', contributor: 'tester', verified: false, source: 'cite',
    engines: { accessibility: { doorClearWidth: 0.8 } }
  }));

  const out = run(root, ['regulation', packPath]);
  assert.match(out, /Applied regulation pack "jp"/);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'regulations', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, [{ region: 'jp', file: 'jp.json', name: 'Japan', contributor: 'tester', verified: false }]);
});
