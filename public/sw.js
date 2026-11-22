/* ToDoApp Service Worker – Network-first für die App-Hülle, /api nie gecacht, Push-Benachrichtigungen. */
var CACHE = 'todoapp-shell-v2';

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

/* ---------- Push ---------- */

self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'ToDoApp', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'ToDoApp', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    lang: 'de',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/';
  var m = target.match(/[?&]task=([^&]+)/);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          if (m) c.postMessage({ type: 'open-task', id: decodeURIComponent(m[1]) });
          else if (target.indexOf('view=today') >= 0) c.postMessage({ type: 'view-today' });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
