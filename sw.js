/* ============================================================
   RikuyRoad — Service Worker  (sw.js)
   Estrategia: Cache-First para todos los recursos estáticos.
   Los modelos MediaPipe y TF.js se cachean en el primer install.
   ============================================================ */

const CACHE_NAME = 'rikuyroad-v1';

/* ---------------------------------------------------------------
   Recursos locales que deben estar disponibles 100% offline.
   Los archivos del modelo van en /model/ (se cachean aquí también).
   Los recursos de CDN externos se cachean dinámicamente en la
   primera solicitud (ver fetch handler más abajo).

   ⚠️  Si tu modelo exportado tiene varios shards (ej. group1-shard1of3.bin,
   group1-shard2of3.bin, …) añádelos aquí manualmente.
--------------------------------------------------------------- */
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  /* Modelo TF.js — añade todos los shards de tu modelo aquí */
  './model/model.json',
  './model/weights.bin',
  // './model/group1-shard1of3.bin',   // ejemplo
  // './model/group1-shard2of3.bin',
  // './model/group1-shard3of3.bin',
  './libs/tf.min.js',
  './libs/vision_bundle.mjs',
  './libs/wasm/vision_wasm_internal.js',
  './libs/wasm/vision_wasm_internal.wasm',
  './libs/wasm/vision_wasm_module_internal.js',
  './libs/wasm/vision_wasm_module_internal.wasm',
  './libs/wasm/vision_wasm_nosimd_internal.js',
  './libs/wasm/vision_wasm_nosimd_internal.wasm',
];

/* ---------------------------------------------------------------
   Dominios externos que también se deben cachear
   (MediaPipe, TensorFlow.js desde CDN).
--------------------------------------------------------------- */
const CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdn.jsdelivr.net/npm/@mediapipe',
  'https://storage.googleapis.com/mediapipe-models',
];

/* ================================================================
   INSTALL — pre-cachear todos los assets locales
================================================================ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] No se pudo cachear ${url}:`, err.message);
          })
        )
      );
      console.log('[SW] Install completo.', results.length, 'assets procesados.');
    })
  );
  self.skipWaiting();
});

/* ================================================================
   ACTIVATE — limpiar caches de versiones anteriores
================================================================ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] Eliminando cache antigua:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

/* ================================================================
   FETCH — Cache-First con Network Fallback
================================================================ */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  if (url.pathname.includes('mediadevices') || url.pathname.includes('getUserMedia')) return;

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) {
    return cached;
  }

  try {
    const networkResponse = await fetch(request.clone());

    if (networkResponse && shouldCache(request, networkResponse)) {
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (err) {
    console.warn('[SW] Sin red para:', request.url);
    return offlineFallback(request);
  }
}

function shouldCache(request, response) {
  const url = new URL(request.url);

  if (response.status === 200) return true;

  if (response.type === 'opaque') {
    return CDN_ORIGINS.some((origin) => request.url.startsWith(origin));
  }

  return false;
}

function offlineFallback(request) {
  const url = new URL(request.url);

  if (request.destination === 'document') {
    return caches.match('./index.html');
  }

  return new Response(
    JSON.stringify({ error: 'offline', url: request.url }),
    {
      status: 503,
      statusText: 'Service Unavailable (Offline)',
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/* ================================================================
   MENSAJE desde la app — forzar actualización del cache
================================================================ */
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'CACHE_URLS') {
    const urls = event.data.urls || [];
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => {
        return Promise.allSettled(
          urls.map((url) =>
            cache.add(url).catch((err) =>
              console.warn('[SW] No se pudo cachear (mensaje):', url, err.message)
            )
          )
        );
      })
    );
  }

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});