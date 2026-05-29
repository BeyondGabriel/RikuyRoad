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
--------------------------------------------------------------- */
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  /* Modelo TF.js — ajusta nombres de shard si hay más de uno */
  './model/model.json',
  './model/weights.bin',
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
   Cualquier request a estos dominios se guarda en cache al
   primer fetch exitoso y se sirve desde cache en los siguientes.
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
      /* Cachear assets locales uno a uno para no fallar en bloque
         si algún archivo todavía no existe (ej: model/weights.bin
         que el desarrollador añadirá luego). */
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
  /* Activar de inmediato sin esperar a que cierren pestañas viejas */
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
  /* Tomar control de todas las pestañas abiertas inmediatamente */
  self.clients.claim();
});

/* ================================================================
   FETCH — Cache-First con Network Fallback
   Flujo:
     1. ¿Está en cache? → Servir desde cache.
     2. No está → Fetch desde red → guardar en cache → devolver.
     3. Red falla → devolver respuesta de error offline.
================================================================ */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignorar requests non-GET (POST, etc.) */
  if (request.method !== 'GET') return;

  /* Ignorar chrome-extension y otras schemas no-http */
  if (!url.protocol.startsWith('http')) return;

  /* Ignorar requests a la cámara / media devices (no cacheables) */
  if (url.pathname.includes('mediadevices') || url.pathname.includes('getUserMedia')) return;

  event.respondWith(cacheFirst(request));
});

/* ----------------------------------------------------------------
   Estrategia Cache-First
---------------------------------------------------------------- */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  /* 1. Intentar cache */
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) {
    return cached;
  }

  /* 2. No en cache → ir a la red */
  try {
    const networkResponse = await fetch(request.clone());

    /* Solo cachear respuestas válidas (no errores 4xx/5xx, no opaque
       a menos que sea CDN conocido — las opaque responses de CDN son
       válidas para cachear aunque no podamos inspeccionar el status) */
    if (networkResponse && shouldCache(request, networkResponse)) {
      cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (err) {
    /* 3. Sin red y sin cache → respuesta offline */
    console.warn('[SW] Sin red para:', request.url);
    return offlineFallback(request);
  }
}

/* ----------------------------------------------------------------
   Decidir si una respuesta merece guardarse en cache
---------------------------------------------------------------- */
function shouldCache(request, response) {
  const url = new URL(request.url);

  /* Respuesta básica OK */
  if (response.status === 200) return true;

  /* Respuestas opaque (cross-origin sin CORS) de CDNs conocidos:
     no podemos ver el status pero asumimos que llegaron correctas */
  if (response.type === 'opaque') {
    return CDN_ORIGINS.some((origin) => request.url.startsWith(origin));
  }

  return false;
}

/* ----------------------------------------------------------------
   Fallback cuando no hay red ni cache
---------------------------------------------------------------- */
function offlineFallback(request) {
  const url = new URL(request.url);

  /* Si es una navegación HTML, devolver la app principal desde cache */
  if (request.destination === 'document') {
    return caches.match('./index.html');
  }

  /* Para scripts/estilos sin cache, respuesta de error genérica */
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
   La app puede enviar: postMessage({ type: 'CACHE_URLS', urls: [...] })
   para cachear recursos adicionales (ej: modelo descargado dinámicamente)
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
