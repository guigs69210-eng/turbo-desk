/* Cache de la coquille de l'app seulement (code public). Aucune donnée, aucun appel GitHub n'est mis en cache. */
const V = 'td-v4';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'calc.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // réseau d'abord (toujours la dernière version), cache si hors ligne
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(V).then((x) => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
