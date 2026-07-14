#!/usr/bin/env node
/**
 * generate-sri.js — Generate SRI hashes for CDN dependencies
 *
 * Run: node scripts/generate-sri.js
 *
 * Reads the external classic scripts actually used by index.html, downloads
 * them, and computes SHA-384 hashes. With --check it verifies the committed
 * integrity attributes and exits non-zero on drift.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(["\\\'])(.*?)\\1', 'i').exec(tag);
  return m ? m[2] : null;
}

function parseExternalScripts(html) {
  const out = [];
  const tags = html.match(/<script\b[^>]*\bsrc\s*=\s*(["'])[\s\S]*?\1[^>]*><\/script>/gi) || [];
  tags.forEach((tag) => {
    const url = attr(tag, 'src');
    if (!url || !/^https:\/\//i.test(url)) return;
    out.push({ url, integrity: attr(tag, 'integrity'), crossorigin: attr(tag, 'crossorigin') });
  });
  return out;
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ClashControl-SRI-Check/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const deps = parseExternalScripts(html);
  if (!deps.length) throw new Error('No external classic scripts found in index.html');
  const checking = process.argv.includes('--check');
  console.log((checking ? 'Verifying' : 'Generating') + ' SRI hashes for ' + deps.length + ' CDN scripts...\n');
  let failed = false;
  for (const dep of deps) {
    const buf = await fetch(dep.url);
    const hash = 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
    if (checking) {
      const ok = dep.integrity === hash && dep.crossorigin === 'anonymous';
      console.log((ok ? 'OK  ' : 'FAIL') + ' ' + dep.url);
      if (!ok) {
        if (dep.integrity !== hash) console.error('  expected integrity="' + hash + '"');
        if (dep.crossorigin !== 'anonymous') console.error('  expected crossorigin="anonymous"');
        failed = true;
      }
    } else {
      console.log(`<!-- ${buf.length} bytes -->`);
      console.log(`<script src="${dep.url}" integrity="${hash}" crossorigin="anonymous"></script>\n`);
    }
  }
  if (failed) process.exitCode = 1;
  else if (checking) console.log('\nSRI verification passed.');
  else console.log('Copy the <script> tags above into index.html <head>.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err && err.stack || err); process.exitCode = 1; });
}

module.exports = { parseExternalScripts };
