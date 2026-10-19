// Service worker: rende l'app installabile e utilizzabile offline.
const CACHE = 'agenda-vocale-v3';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/agent.js', 'js/claude.js', 'js/dateparser.js', 'js/db.js', 'js/voice.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Prima la rete (così gli aggiornamenti arrivano subito), poi la cache se offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Le chiamate all'API di Claude non vanno mai messe in cache
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin && !['cdn.jsdelivr.net', 'esm.sh'].includes(url.hostname)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) =>
      clients.length ? clients[0].focus() : self.clients.openWindow('./')),
  );
});
