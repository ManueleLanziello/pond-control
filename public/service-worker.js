self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  const apiPath = new URL('api/', self.registration.scope).pathname;
  const isStaticGet = event.request.method === 'GET'
    && requestUrl.origin === self.location.origin
    && !requestUrl.pathname.startsWith(apiPath);

  if (isStaticGet) event.respondWith(fetch(event.request));
});
