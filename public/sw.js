// Service worker: recibe los Web Push que envía la Edge Function `notify-booking`
// y muestra la notificación del sistema. Funciona con la pestaña cerrada / el
// teléfono bloqueado (en iOS, solo si la app está instalada en la pantalla de
// inicio y se aceptó el permiso).

self.addEventListener("install", () => {
  // Activa esta versión del SW de inmediato, sin esperar a que se cierren las
  // pestañas viejas.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Nueva cita", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Nueva cita";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: "/badge.png",
    vibrate: [120, 60, 120],
    tag: data.tag || "booking", // colapsa avisos repetidos del mismo tipo
    renotify: true,
    data: { url: data.url || "/barbero" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/barbero";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Si ya hay una ventana de la app abierta, la enfoca; si no, abre una nueva.
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});
