#!/usr/bin/env node
/**
 * generate-sri.js — Generate SRI hashes for CDN dependencies
 *
 * Run: node scripts/generate-sri.js
 *
 * Downloads each CDN script and computes its SHA-384 hash.
 * Outputs ready-to-paste <script> tags with integrity attributes.
 */

const https = require('https');
const crypto = require('crypto');

const deps = [
  { name: 'React', url: 'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js' },
  { name: 'ReactDOM', url: 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js' },
  { name: 'Three.js', url: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js' },
  { name: 'GLTFLoader', url: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js' },
  { name: 'JSZip', url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js' },
  { name: 'pdf.js', url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' },
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Generating SRI hashes for CDN dependencies...\n');
  for (const dep of deps) {
    const buf = await fetch(dep.url);
    const hash = 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
    console.log(`<!-- ${dep.name} (${buf.length} bytes) -->`);
    console.log(`<script src="${dep.url}" integrity="${hash}" crossorigin="anonymous"></script>\n`);
  }
  console.log('Copy the <script> tags above into index.html <head>.');
})();
