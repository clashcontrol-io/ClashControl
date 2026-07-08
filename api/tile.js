// Tile proxy — fetches map tiles server-side and returns them with the
// right caching + CORP headers so the browser doesn't get sandboxed by
// per-provider quirks (referer policies, occasional throttling pages,
// missing CORS headers on edge nodes).
//
// Usage: /api/tile?z=18&x=134987&y=86432&provider=osm
//        /api/tile?z=18&x=134987&y=86432&provider=maptiler
//
// Set MAPTILER_KEY in the Vercel env to use the MapTiler satellite
// tileset; otherwise the proxy serves OpenStreetMap. OSM tiles are fine
// for dev / demo but production traffic should use MapTiler (OSM's tile
// policy doesn't permit app traffic at scale).

export const config = { runtime: 'edge' };

const PROVIDERS = {
  osm: (z, x, y) => {
    const sub = 'abc'[(Number(x) + Number(y)) % 3];
    return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
  },
  maptiler: (z, x, y, key) =>
    `https://api.maptiler.com/maps/satellite/${z}/${x}/${y}.jpg?key=${encodeURIComponent(key)}`,
};

export default async function handler(req) {
  const url = new URL(req.url);
  const z = url.searchParams.get('z');
  const x = url.searchParams.get('x');
  const y = url.searchParams.get('y');
  const reqProvider = url.searchParams.get('provider') || 'auto';

  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return new Response('bad coords', { status: 400 });
  }
  const zi = Number(z);
  if (zi < 0 || zi > 22) return new Response('bad zoom', { status: 400 });
  // Tile indices are bounded by the zoom level — out-of-range is a caller
  // bug, answer 400 ourselves instead of burning an upstream 4xx → 502.
  const maxIdx = Math.pow(2, zi);
  if (Number(x) >= maxIdx || Number(y) >= maxIdx) return new Response('bad coords', { status: 400 });

  // Hotlink guard: when the browser identifies the calling page, it must be
  // ours (or a preview). Requests with neither header stay allowed — same-
  // origin GETs and curl send none — so this only stops third-party sites
  // embedding the proxy and burning the MAPTILER_KEY quota.
  const ALLOWED_PAGE = /^https:\/\/(www\.)?clashcontrol\.io$|^https:\/\/[a-z0-9-]+\.vercel\.app$|^https?:\/\/localhost(:\d+)?$|^https?:\/\/127\.0\.0\.1(:\d+)?$/;
  const pageOrigin = req.headers.get('origin') || (() => {
    try { const r = req.headers.get('referer'); return r ? new URL(r).origin : null; } catch (_) { return null; }
  })();
  if (pageOrigin && !ALLOWED_PAGE.test(pageOrigin)) {
    return new Response('forbidden', { status: 403 });
  }

  const key = process.env.MAPTILER_KEY;
  const provider = reqProvider === 'auto' ? (key ? 'maptiler' : 'osm') : reqProvider;
  if (provider === 'maptiler' && !key) {
    return new Response('MAPTILER_KEY not configured', { status: 500 });
  }
  if (!PROVIDERS[provider]) return new Response('unknown provider', { status: 400 });

  const tileUrl = PROVIDERS[provider](z, x, y, key);
  try {
    const res = await fetch(tileUrl, {
      headers: { 'User-Agent': 'ClashControl/1.0 (+https://www.clashcontrol.io)' },
    });
    if (!res.ok) return new Response('upstream ' + res.status, { status: 502 });
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'image/png',
        // Cache aggressively — tiles change rarely. CDN keeps it for a day,
        // browser keeps it for an hour.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response('fetch failed: ' + (err && err.message || err), { status: 502 });
  }
}
