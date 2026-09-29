// Every visible region sits inside a landmark (axe "region" rule — was 8
// nodes in light+dark before): the crawler-only block is removed on mount,
// the desktop topbar is a <header> (banner), the viewer toolbar and the
// bottom banners are labelled regions, and <main> carries the page's h1.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('crawler-only content is removed once the app mounts', () => {
  assert.match(html, /<div id="cc-crawler-content" style="position:absolute;/);
  assert.match(html, /var _crawlerEl = document\.getElementById\('cc-crawler-content'\);\s*\n\s*if \(_crawlerEl && _crawlerEl\.parentNode\) _crawlerEl\.parentNode\.removeChild\(_crawlerEl\);\s*\n\s*var rootEl = document\.getElementById\('root'\);/);
});

test('desktop topbar is a <header> landmark', () => {
  assert.match(html, /return html`<header class="cc-desktop-topbar">/);
  assert.ok(!html.includes('return html`<div class="cc-desktop-topbar">'));
});

test('toolbar and bottom banners are labelled regions', () => {
  assert.match(html, /class="cc-top-toolbar" role="region" aria-label=/);
  const banners = html.match(/class="cc-bottom-banner"[^>]{0,40}/g) || [];
  assert.ok(banners.length >= 4, 'expected the 4 bottom banners');
  const bannerOpeners = html.match(/<div[^>]*class="cc-bottom-banner"[^>]*?style=/g) || [];
  for (const b of bannerOpeners) assert.match(b, /role="region"/, b.slice(0, 120));
});

test('<main> holds the single h1', () => {
  assert.match(html, /<main class="cc-content-row"[^>]*>\s*\n[^\n]*\n\s*<h1 style=/);
});
