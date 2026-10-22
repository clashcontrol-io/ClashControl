'use strict';
// Locks that the print/PDF report generators escape every interpolated
// user/IFC-derived string (title, snapshot src, severity, ...) with esc().
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const align = fs.readFileSync(path.join(__dirname, '..', 'addons', 'align.js'), 'utf8');

test('view PDF export escapes the title in <title> and the meta line', () => {
  assert.ok(src.includes("<title>'+esc(title)+'</title>"));
  assert.ok(src.includes("<div class=\"meta\">'+esc(title)+' &nbsp;"));
  assert.ok(!src.includes("<title>'+title+'</title>"));
  assert.ok(!src.includes("<div class=\"meta\">'+title+' &nbsp;"));
});

test('clash report escapes viewpoint snapshot src and run-history cells', () => {
  assert.ok(src.includes("src=\"'+esc(sn.img)+'\""));
  assert.ok(!src.includes("src=\"'+sn.img+'\""));
  assert.ok(src.includes("esc(r.total)"));
});

test('IDS validation report escapes severity (class attr and text)', () => {
  assert.ok(src.includes("'<td class=\"sev-' + esc(r.severity) + '\">'"));
  assert.ok(!src.includes("r.severity.toUpperCase() + '</td>'"));
});

test('align addon report escapes the snapshot src', () => {
  assert.ok(align.includes("_escapeHtml(vp.snapshot)"));
  assert.ok(!align.includes("'<img src=\"' + vp.snapshot"));
});

test('vercel.json CSP carries the safe hardening directives', () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const csp = v.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  for (const d of ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(csp.includes(d), d);
});
