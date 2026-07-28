async function requestJson({
  apiUrl,
  endpoint,
  key = null,
  body = null,
  timeoutMs = 30_000,
  userAgent = "ai-token-dashboard",
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(endpoint, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
    const headers = { "user-agent": userAgent };
    if (key) headers.authorization = `Bearer ${key}`;
    if (body != null) headers["content-type"] = "application/json";
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: body == null ? null : JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}: ${responseBody.error || "unknown error"}`);
    }
    return responseBody;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("API request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function uploadUsage({ apiUrl, key, payload, timeoutMs = 30_000 }) {
  return requestJson({
    apiUrl,
    endpoint: "v1/sync",
    key,
    body: payload,
    timeoutMs,
    userAgent: `ai-token-dashboard/${payload.collectorVersion}`,
  });
}

export function createPairingCode({ apiUrl, key, version, timeoutMs = 30_000 }) {
  return requestJson({
    apiUrl,
    endpoint: "v1/pairing-codes",
    key,
    timeoutMs,
    userAgent: `ai-token-dashboard/${version}`,
  });
}

export function redeemPairingCode({ apiUrl, code, deviceName, timezone, version, timeoutMs = 30_000 }) {
  return requestJson({
    apiUrl,
    endpoint: "v1/pair",
    body: { code, deviceName, timezone },
    timeoutMs,
    userAgent: `ai-token-dashboard/${version}`,
  });
}
