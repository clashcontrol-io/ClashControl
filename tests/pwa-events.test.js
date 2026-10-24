'use strict';
// addons/pwa.js announces install-prompt and update changes as events the
// core listens to (install banner, avatar menu, update banner) — the core
// does not poll for them (tests/browser/event-driven-ui.mjs checks the UI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'pwa.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadAddon() {
  const events = [], listeners = {}, dispatched = [];
  let addon = null;
  const window = {
    _ccRegisterAddon(a) { addon = a; },
    dispatchEvent(e) { events.push(e.type); },
    addEventListener(t, fn) { listeners[t] = fn; },
    removeEventListener(t) { delete listeners[t]; },
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  const navigator = {};
  vm.runInNewContext(src, { window, CustomEvent, navigator, console, setInterval, clearInterval });
  addon.init((a) => dispatched.push(a), () => ({}));
  return { window, events, listeners, dispatched };
}

test('a stored, used or installed prompt is announced as cc-install-available', async () => {
  const h = loadAddon();
  let resolveChoice;
  const prompt = { preventDefault() {}, prompt() {}, userChoice: new Promise((r) => { resolveChoice = r; }) };
  h.listeners.beforeinstallprompt(prompt);
  assert.equal(h.window._ccPwaInstallPrompt(), prompt);
  assert.deepEqual(h.events, ['cc-install-available']);
  assert.equal(JSON.stringify(h.dispatched.at(-1)), JSON.stringify({ t: 'UPD_PWA', u: { installAvailable: true } }));
  h.window._ccPwaPromptInstall();
  resolveChoice({ outcome: 'accepted' });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.window._ccPwaInstallPrompt(), null);
  assert.deepEqual(h.events, ['cc-install-available', 'cc-install-available']);
  h.listeners.beforeinstallprompt(prompt);
  h.listeners.appinstalled();
  assert.equal(h.window._ccPwaInstallPrompt(), null);
  assert.equal(h.events.length, 4);
});

test('a waiting service worker sets _ccUpdateAvailable and announces cc-update-available', () => {
  assert.match(src, /window\._ccUpdateAvailable = true;\s*\n\s*_announce\('cc-update-available'\);/);
});

test('the core listens instead of polling for install, selection and panel width', () => {
  assert.doesNotMatch(html, /setInterval\(refresh, 2000\)/);
  assert.doesNotMatch(html, /setInterval\(sync, 400\)/);
  assert.match(html, /window\.addEventListener\('cc-install-available', refresh\)/);
  assert.match(html, /window\.addEventListener\('cc-selected-el-changed', onSelChanged\)/);
  assert.match(html, /window\.dispatchEvent\(new CustomEvent\('cc-selected-el-changed'\)\)/);
});
