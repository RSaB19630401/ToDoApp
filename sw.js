/* ToDoApp Service Worker – Network-first für die App-Hülle, /api wird nie gecacht. */
var CACHE = 'todoapp-shell-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/cdn-cgi/') === 0) return;

  e.respondWith(
    fetch(req).then(function (res) {
      // Nur echte App-Dateien speichern – keine Weiterleitungen zur Access-Anmeldung
      if (res.ok && !res.redirected && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode !== 'navigate') return Response.error();
        return caches.match('/').then(function (home) { return home || Response.error(); });
      });
    })
  );
});
