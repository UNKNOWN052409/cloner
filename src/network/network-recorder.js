// Network recorder (spec §11): every request/response on the page — url, method,
// status, resource type, size, timing. Bounded ring buffer per page.
export function attachNetworkRecorder(context, sink, { maxEntries = 500 } = {}) {
  const pageRecorders = new Set();
  return {
    attach(page) {
      if (pageRecorders.has(page)) return;
      pageRecorders.add(page);
      const entries = sink.entries;
      page.on("request", (req) => {
        if (entries.length >= maxEntries) return;
        entries.push({
          ts: new Date().toISOString(),
          phase: "request",
          method: req.method(),
          url: req.url().slice(0, 300),
          resourceType: req.resourceType(),
          headersSize: JSON.stringify(req.headers()).length,
        });
      });
      page.on("response", (res) => {
        if (entries.length >= maxEntries) return;
        const headers = res.headers();
        entries.push({
          ts: new Date().toISOString(),
          phase: "response",
          status: res.status(),
          url: res.url().slice(0, 300),
          resourceType: res.request().resourceType(),
          contentType: headers["content-type"] || null,
          contentLength: Number(headers["content-length"] || 0) || null,
        });
      });
      page.on("requestfailed", (req) => {
        if (entries.length >= maxEntries) return;
        entries.push({
          ts: new Date().toISOString(),
          phase: "failed",
          method: req.method(),
          url: req.url().slice(0, 300),
          failure: (req.failure() && req.failure().errorText) || "unknown",
        });
      });
    },
  };
}
