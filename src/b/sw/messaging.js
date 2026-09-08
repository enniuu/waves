async function broadcastMeta() {
  try {
    await new Promise((r) => setTimeout(r, 0));
    while (metaPending) {
      const pendingMeta = metaPending;
      metaPending = null;
      const clients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });
      for (let i = 0; i < clients.length; i++) {
        const client = clients[i];
        if (pendingMeta.sourceId && client.id === pendingMeta.sourceId) continue;
        try {
          client.postMessage(pendingMeta.payload);
        } catch (e) {}
      }
    }
  } finally {
    metaFlush = null;
  }
}

self.addEventListener("message", (event) => {
  const message = event?.data;
  if (!message) return;

  if (
    message.type === "mochi-base" &&
    typeof message.base === "string" &&
    message.base.startsWith("http")
  ) {
    self.__MOCHI_BASE__ = message.base.replace(/\/+$/, "") + "/";
    return;
  }

  if (message.type === "open-new-tab" && message.url) {
    const sanitizedUrl = typeof message.url === "string" ? message.url : null;
    if (!sanitizedUrl) return;
    const payload = {
      type: "open-new-tab",
      url: sanitizedUrl,
      decodedUrl:
        typeof message.decodedUrl === "string" ? message.decodedUrl : sanitizedUrl,
      openerUrl: typeof message.openerUrl === "string" ? message.openerUrl : null,
      tabId: message.tabId || null,
      isTopFrame: !!message.isTopFrame,
      cause: message.cause || null,
      active: message.active !== false,
    };
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({
          includeUncontrolled: true,
          type: "window",
        });
        for (const client of clients) client.postMessage(payload);
      })(),
    );
    return;
  }

  if (message.type === "page-meta") {
    const payload = {
      type: "page-meta",
      url: message.url || message.href || null,
      decodedUrl: message.decodedUrl || message.url || message.href || null,
      title: typeof message.title === "string" ? message.title : "",
      favicon: message.favicon || message.rawFavicon || null,
      rawFavicon: message.rawFavicon || message.favicon || null,
      tabId: message.tabId || null,
      isTopFrame: !!message.isTopFrame,
      clientId: event.source && "id" in event.source ? event.source.id : null,
      collectedAt: Date.now(),
      encoded: !!message.encoded,
    };
    const sourceId =
      event.source && "id" in event.source ? event.source.id : null;
    if (event.source && typeof event.source.postMessage === "function") {
      try {
        event.source.postMessage(payload);
      } catch (e) {}
    }
    metaPending = { payload, sourceId };
    if (!metaFlush) {
      metaFlush = broadcastMeta();
      event.waitUntil(metaFlush);
    }
    return;
  }

  if (message.type === "lyra-prefetch" && typeof message.url === "string") {
    event.waitUntil(prefetchProxiedNavFromClient(message.url));
  }
});
