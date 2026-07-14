'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf("var _CC_CONSENT_VERSION = '1';");
const endMarker = 'window._ccSetConsent = _ccSetConsent;';
const end = html.indexOf(endMarker, start) + endMarker.length;
assert.ok(start >= 0 && end > start, 'consent helper block not found');
const consentSource = html.slice(start, end);

function loadConsent(initial) {
  const data = new Map(Object.entries(initial || {}));
  const events = [];
  const localStorage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
  const window = { dispatchEvent(event) { events.push(event.type); } };
  function Event(type) { this.type = type; }
  new Function('window', 'localStorage', 'Event', consentSource)(window, localStorage, Event);
  return { window, data, events };
}

test('fresh and legacy auto-granted installs do not imply consent', () => {
  const fresh = loadConsent();
  assert.equal(fresh.window._ccConsentIsExplicit(), false);
  assert.equal(fresh.window._ccConsentOK(), false);
  assert.equal(fresh.data.has('cc_data_consent'), false);

  const legacy = loadConsent({ cc_data_consent: 'granted', cc_consent_banner_seen: '1' });
  assert.equal(legacy.window._ccConsentIsExplicit(), false);
  assert.equal(legacy.window._ccConsentOK(), false);
});

test('legacy opt-outs remain denied and become explicit', () => {
  const ctx = loadConsent({ cc_data_consent: 'denied' });
  assert.equal(ctx.window._ccConsentIsExplicit(), true);
  assert.equal(ctx.window._ccConsentOK(), false);
  assert.equal(ctx.data.get('cc_data_consent_explicit'), '1');
});

test('only an explicit allow enables sharing and changes remain reversible', () => {
  const ctx = loadConsent();
  assert.equal(ctx.window._ccSetConsent('granted'), true);
  assert.equal(ctx.window._ccConsentOK(), true);
  assert.equal(ctx.data.get('cc_data_consent_explicit'), '1');
  assert.equal(ctx.data.get('cc_consent_banner_seen'), '1');
  assert.deepEqual(ctx.events, ['cc-consent-change']);

  assert.equal(ctx.window._ccSetConsent('denied'), false);
  assert.equal(ctx.window._ccConsentOK(), false);
});

test('the banner is wired to explicit consent instead of a seeded default', () => {
  assert.match(html, /return !_ccConsentIsExplicit\(\);/);
  assert.doesNotMatch(html, /_ccSeedDefaultConsent/);
  assert.match(html, />Allow sharing<\/button>/);
  assert.match(html, /window\._ccLoadAnalytics/);
  assert.doesNotMatch(html, /<script data-goatcounter=/);
});

test('secondary pages use the same explicit analytics-consent gate', () => {
  const gate = fs.readFileSync(path.join(__dirname, '..', 'analytics-consent.js'), 'utf8');
  assert.match(gate, /cc_data_consent_explicit/);
  assert.match(gate, /cc_data_consent/);

  const pages = [
    'tour/index.html', 'developers/index.html', 'security/index.html',
    'free-bcf-viewer/index.html', 'free-ifc-viewer-online/index.html',
    'free-navisworks-alternative/index.html', 'free-solibri-alternative/index.html',
    'best-free-ifc-viewer/index.html', 'ids-validation-online/index.html',
    'ifc-clash-detection-online/index.html', 'data-quality-checker-online/index.html',
  ];
  for (const page of pages) {
    const source = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    assert.match(source, /analytics-consent\.js/, page);
    assert.doesNotMatch(source, /<script data-goatcounter=/, page);
  }
});
