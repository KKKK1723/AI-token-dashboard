export async function uploadUsage({ apiUrl, key, payload, timeoutMs = 30_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = new URL("v1/sync", apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "user-agent": `ai-token-dashboard/${payload.collectorVersion}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Sync API returned HTTP ${response.status}: ${body.error || "unknown error"}`);
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Sync API request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
