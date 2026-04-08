// ClashControl Service Worker — offline caching
// Updates automatically when index.html changes (cache name includes version)

var CACHE = 'clashcontrol-v4.10.11';

var PRECACHE = [
  './',
  'icon-192.png',
  'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      // Cache each resource individually — don't let one CDN failure block the entire SW install.
      // Failed resources will be cached on first use via the fetch handler's cache-on-response strategy.
      return Promise.all(PRECACHE.map(function(url) {
        return cache.add(url).catch(function(err) {
          console.warn('[SW] Failed to precache (will cache on first use):', url, err.message || err);
        });
      }));
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE; })
          .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Allow the page to force-activate a waiting service worker
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Never cache API calls — these must always go to the server
  if (url.indexOf('/api/') !== -1) return;

  var isNav = e.request.mode === 'navigate';
  var isHTML = url.indexOf('index.html') !== -1 || url.endsWith('/');

  // Network-first for HTML / navigation — always get the latest app version
  if (isNav || isHTML) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || new Response('ClashControl is offline. Please reconnect and reload.',
            {status:503, headers:{'Content-Type':'text/plain'}});
        });
      })
    );
    return;
  }

  // Cache-first for CDN / static assets
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
        if (e.request.method === 'GET' && response.status === 200) {
          if (url.indexOf('cdnjs.cloudflare.com') !== -1 ||
              url.indexOf('esm.sh') !== -1 ||
              url.indexOf('cdn.jsdelivr.net') !== -1) {
            var clone = response.clone();
            caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
          }
        }
        return response;
      });
    })
  );
});
