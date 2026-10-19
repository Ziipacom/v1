/* Push-only worker: no caching, media fetching, token storage or background posting. */
const categories = new Set(["calendar", "recordings", "campaigns"]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
self.addEventListener("push", (event) => {
  let payload;
  try {
    // The server sends the same {title, body, data} envelope for both providers.
    // Only its closed data schema is used; displayed text is fixed below.
    payload = event.data?.json()?.data;
  } catch {
    return;
  }
  if (
    payload?.kind !== "ziipa_notification" ||
    payload.route !== "Notifications" ||
    !categories.has(payload.category) ||
    !uuid.test(payload.delivery_id || "")
  )
    return;
  const messages = {
    calendar:
      "A Ziipa reminder is ready. Open your private calendar to review it.",
    recordings:
      "Your Ziipa recording workflow has an update. Open Studio to review it.",
    campaigns: "Your Ziipa campaign has an update. Open Studio to review it.",
  };
  event.waitUntil(
    self.registration.showNotification("Ziipa", {
      body: messages[payload.category],
      tag: `ziipa-${payload.delivery_id}`,
      data: { delivery_id: payload.delivery_id },
      silent: true,
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The click destination is a fixed same-origin route, never a payload URL.
  const path =
    new URL(self.registration.scope).pathname === "/studio/" ? "/portal" : "/";
  const destination = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) =>
          client.url === destination || client.url === destination + "/",
      );
      if (existing) return existing.focus();
      return self.clients.openWindow(destination);
    })(),
  );
});
