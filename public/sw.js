// ==========================================
// SERVICE WORKER - MECATRON SOLUTIONS
// ==========================================

const CACHE_NAME = 'mecatron-v1';
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
            .then(() => self.skipWaiting())
    );
});

// ACTIVACIÓN
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('🗑️ Caché antigua eliminada:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});

// INTERCEPTAR PETICIONES
self.addEventListener('fetch', event => {
    // Solo interceptar peticiones GET
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
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