// ==========================================
// SERVICE WORKER - MECATRON SOLUTIONS
// ==========================================
const CACHE_NAME = 'mecatron-v1'; // YA NO LO VUELVES A TOCAR NUNCA
const urlsToCache = [
    '/',
    '/index.html',
    '/panel.html',
    '/servicios.html',
    '/ventas.html',
    '/manifest.json',
    '/favicon.ico'
];
// INSTALACIÓN
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('📦 Archivos guardados en caché');
                return cache.addAll(urlsToCache);
            })
            .then(() => self.skipWaiting()) // toma control inmediato
    );
});
// ACTIVACIÓN - borra cachés viejos y toma control
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('🗑 Caché antigua eliminada:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim()) // controla páginas abiertas ya
    );
});
// INTERCEPTAR PETICIONES - NUEVA ESTRATEGIA
self.addEventListener('fetch', event => {
    // Solo interceptar peticiones GET
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    // 1. Para navegaciones y HTML: NETWORK-FIRST
    // Esto hace que siempre busque la versión nueva en el servidor
    if (event.request.mode === 'navigate' || 
        event.request.destination === 'document' ||
        url.pathname.endsWith('.html') ||
        url.pathname === '/') {

        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Si hay red, guarda en cache y devuelve respuesta fresca
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                    return response;
                })
                .catch(() => {
                    // Si no hay red, usa lo que haya en cache
                    return caches.match(event.request);
                })
        );
        return;
    }
    // 2. Para todo lo demás: CSS, JS, imágenes, etc: CACHE-FIRST
    // Estos archivos cambian de nombre con hash cuando haces build, así que es seguro
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(event.request).then(response => {
                // Solo cachear respuestas exitosas y del mismo origen
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return response;
                }
                const responseToCache = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseToCache);
                });
                return response;
            });
        })
    );
});