'use strict';

// Safe Smart Bridge update discovery. This module deliberately discovers and
// links releases only; it never downloads, replaces, or executes a binary.
const https = require('https');

const RELEASES_URL = 'https://api.github.com/repos/clashcontrol-io/ClashControl/releases?per_page=10';
const RELEASES_PAGE = 'https://github.com/clashcontrol-io/ClashControl/releases';

function versionParts(value) {
  const match = String(value || '').match(/(?:bridge-)?v?(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function isNewerVersion(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function selectBridgeRelease(releases, currentVersion) {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft && !release.prerelease &&
      /^bridge-v\d+\.\d+\.\d+$/.test(release.tag_name || '') &&
      isNewerVersion(release.tag_name, currentVersion))
    .sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? -1 : 1)[0] || null;
}

function fetchReleases(timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ClashControl-Smart-Bridge'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length <= 512 * 1024) body += chunk;
        if (body.length > 512 * 1024) req.destroy(new Error('Update response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('GitHub releases returned HTTP ' + res.statusCode));
        }
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('GitHub releases returned invalid JSON')); }
      });
    });
    req.setTimeout(timeoutMs || 3000, () => req.destroy(new Error('Update check timed out')));
    req.on('error', reject);
  });
}

async function getUpdateStatus(currentVersion) {
  const release = selectBridgeRelease(await fetchReleases(3000), currentVersion);
  return {
    update_available: !!release,
    current_version: currentVersion,
    version: release ? release.tag_name.replace(/^bridge-v/, '') : null,
    url: release ? (release.html_url || RELEASES_PAGE) : RELEASES_PAGE,
    automatic: false
  };
}

module.exports = {
  RELEASES_PAGE,
  versionParts,
  isNewerVersion,
  selectBridgeRelease,
  getUpdateStatus
};
