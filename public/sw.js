self.addEventListener("push", event => {
  let data = {};
  try { data = event.data.json(); } catch (_) {}
  const title = data.title || "Galaxy Beauty Parlour";
  const options = {
    body: data.body || "नई Booking मिली है।",
    icon: "/images/icon-192.png",
    badge: "/images/icon-192.png",
    data: { url: data.url || "/admin" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url || "/admin";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ("focus" in client) { client.navigate(target); return client.focus(); }
    }
    return clients.openWindow(target);
  }));
});
