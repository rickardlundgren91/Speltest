// ABC2 service worker: the game works offline after the first visit.
// Game files are network-first (new versions show up at once, cache is the offline fallback);
// images and fonts are served from cache and refreshed in the background.
const CACHE = 'abc2-v2';
const CORE = ['./', 'index.html', 'manifest.json', 'gamedata.js', 'game.js', 'herotest.js', 'three.min.js', 'models3d.js',
  'heroes3d.js', 'render3d.js', 'recorder.js', 'net.js', 'peerjs.min.js', 'img/icon-192.png', 'img/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function put(req, res) {
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
  return res;
}

// network first; on a slow network fall back to the cached copy after 4 s
function networkFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then(cached => new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const t = cached ? setTimeout(() => finish(cached), 4000) : 0;
    fetch(req, { cache: 'no-cache' }).then(r => { clearTimeout(t); finish(put(req, r)); }) // no-cache: ask the server every time instead of the browser's 10-minute HTTP cache (GitHub Pages), so an installed app gets new versions at once
      .catch(() => { clearTimeout(t); finish(cached || Response.error()); });
  }));
}

function cacheFirst(req) {
  return caches.match(req).then(cached => {
    const net = fetch(req).then(r => put(req, r)).catch(() => cached);
    return cached || net;
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('.png') || url.pathname.endsWith('.jpg') || url.pathname.endsWith('.webp')) e.respondWith(cacheFirst(req));
    else e.respondWith(networkFirst(req));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req));
  }
});
