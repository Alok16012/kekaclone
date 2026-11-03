/* erp service worker: app shell + offline page only.
 * Never caches app pages, /api, /files or anything personal: those always go to the network. */
const VERSION = "erp-sw-v2";
const SHELL = ["/offline", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // page navigations: network first, offline page as the fallback; nothing is stored
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline").then((r) => r || new Response("You're offline.", { status: 503, headers: { "content-type": "text/plain" } }))));
    return;
  }
  // immutable build assets and the shell: cache first
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
  // everything else (/api, /files, data, images): straight to the network
});

/* Web Push (plat2): the server sends { title, body, url }; tapping the notification opens (or focuses) that page. */
self.addEventListener("push", (event) => {
  let data = { title: "erp", body: "", url: "/home" };
  try { data = { ...data, ...event.data.json() }; } catch { if (event.data) data.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: data.url }, tag: data.url, renotify: false,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/home", self.location.origin).toString();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url === url && "focus" in c) return c.focus();
    const any = list.find((c) => "navigate" in c);
    return any ? any.navigate(url).then((c) => c && c.focus()) : self.clients.openWindow(url);
  }));
});

/* An expired or replaced subscription: the page re-subscribes the next time it opens Calendar & devices. */
self.addEventListener("pushsubscriptionchange", () => {});
