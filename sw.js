// Weight Check-in service worker: network-first for same-origin requests,
// cache fallback for offline.
const CACHE = 'weight-mates-v3';
const ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'vendor/supabase.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'js/app.js',
  'js/config.js',
  'js/cloud.js',
  'js/store.js',
  'js/chart.js',
  'js/util.js',
  'js/views/today.js',
  'js/views/history.js',
  'js/views/groups.js',
  'js/views/photos.js',
  'js/views/me.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || caches.match('index.html')))
  );
});
