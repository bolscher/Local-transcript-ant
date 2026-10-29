// Service worker: bewaart de app en de modelbestanden op het apparaat, zodat
// de pagina na het eerste bezoek zonder internet werkt. VERSION en FILES vult
// build.mjs in.
const VERSION = "cff0e2322b5a";
const FILES = ["./","assets/VozWeb.wasm","assets/WhoWeb.wasm","assets/app.js","assets/browser-RS32O7JX.js","assets/browser-TV4OWBTM.js","assets/chunk-FSRPMVAS.js","assets/chunk-JFM6FQFX.js","assets/chunk-JIOQNPIJ.js","assets/chunk-TEGRM36J.js","assets/dist-2WIAM7WU.js","assets/dist-V22Z66T6.js","assets/dist-WC747LBL.js","assets/ort.webgpu.bundle.min-KFQ34SC6.js","assets/src-MDQUGUV2.js","assets/voz-worker.js","icon.svg","index.html","litert/litert_wasm_compat_internal.js","litert/litert_wasm_compat_internal.wasm","litert/litert_wasm_internal.js","litert/litert_wasm_internal.wasm","litert/litert_wasm_jspi_internal.js","litert/litert_wasm_jspi_internal.wasm","litert/litert_wasm_threaded_internal.js","litert/litert_wasm_threaded_internal.wasm","manifest.webmanifest","ort/ort-wasm-simd-threaded.asyncify.mjs","ort/ort-wasm-simd-threaded.asyncify.wasm"];
const APP_CACHE = `lt-app-${VERSION}`;
const MODEL_CACHE = "lt-models-v1";

// Modelbestanden van Hugging Face. De adressen bevatten een vaste versie of
// commit, dus een bewaard antwoord blijft geldig.
const isModel = (url) => url.hostname === "huggingface.co" && url.pathname.includes("/desert-ant-labs/");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("lt-app-") && key !== APP_CACHE) await caches.delete(key);
      // Voz bewaarde zijn bestanden eerder zelf; nu doet deze worker dat.
      if (key.startsWith("desert-ant-voz")) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(caches.match("./", { cacheName: APP_CACHE }).then((hit) => hit ?? fetch(request)));
    } else {
      event.respondWith(caches.match(request, { cacheName: APP_CACHE, ignoreSearch: true }).then((hit) => hit ?? fetch(request)));
    }
    return;
  }

  if (isModel(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(MODEL_CACHE);
      const hit = await cache.match(request.url);
      if (hit) return hit;
      const response = await fetch(request);
      // Opslaan terwijl de pagina het antwoord al leest; wachten zou het hele
      // bestand (tot 334 MB) eerst in het geheugen zetten.
      if (response.ok) event.waitUntil(cache.put(request.url, response.clone()).catch(() => {}));
      return response;
    })());
  }
});
