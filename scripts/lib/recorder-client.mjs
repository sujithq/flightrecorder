export function recorderOrigin(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Recorder URL must be an HTTPS or loopback HTTP origin without credentials, path, query or fragment.");
  }
  return url;
}

export function requireRunId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("A UUID run ID is required.");
  }
  return value;
}

export async function recorderJson(serverUrl, path, fetchImpl = fetch) {
  const origin = recorderOrigin(serverUrl);
  const url = new URL(path, origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith("/api/")) throw new Error("Invalid recorder API path.");
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Recorder returned HTTP ${response.status}.`);
  return response.status === 204 ? null : response.json();
}