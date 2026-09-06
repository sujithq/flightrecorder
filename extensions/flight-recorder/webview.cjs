const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validateServerUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !loopbackHosts.has(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The recorder URL must be a loopback HTTP(S) origin without credentials, a path, query or fragment.");
  }
  return url;
}

function withRun(url, runId) {
  const result = new URL(url);
  if (runId !== undefined) {
    if (typeof runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new Error("Run ID must be a UUID.");
    }
    result.searchParams.set("run", runId);
  }
  return result;
}

function htmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function panelHtml(value, nonce) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
    throw new Error("The forwarded viewer URL must use HTTPS or loopback HTTP.");
  }
  if (url.username || url.password || !/^[a-zA-Z0-9+/=_-]+$/.test(nonce)) throw new Error("Invalid webview configuration.");
  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${htmlAttribute(url.origin)}; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
    <title>Agent Flight Recorder</title>
    <style nonce="${nonce}">html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;color-scheme:light}</style>
    </head><body><iframe title="Agent Flight Recorder" src="${htmlAttribute(url.href)}" sandbox="allow-scripts allow-same-origin allow-downloads" referrerpolicy="no-referrer"></iframe></body></html>`;
}

module.exports = { validateServerUrl, withRun, panelHtml };