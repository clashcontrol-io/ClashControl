// ClashControl Service Worker — offline caching
// Updates automatically when index.html changes (cache name includes version)

var CACHE = 'clashcontrol-v3.2.60';

var PRECACHE = [
  './',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(PRECACHE);
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
