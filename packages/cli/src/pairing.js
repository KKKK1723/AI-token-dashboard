const PAIRING_PREFIX = "atd1";
const PAIRING_CODE = /^atdp_[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN = /^atdt_[A-Za-z0-9_-]{43}$/;

export function encodePairingBundle(apiUrl, code) {
  if (!PAIRING_CODE.test(code || "")) throw new Error("Pairing code is invalid.");
  const encodedUrl = Buffer.from(apiUrl, "utf8").toString("base64url");
  return `${PAIRING_PREFIX}.${encodedUrl}.${code}`;
}

export function decodePairingBundle(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw new Error("Pairing string is required.");
  }
  const [prefix, encodedUrl, code, extra] = value.split(".");
  if (prefix !== PAIRING_PREFIX || !encodedUrl || !code || extra != null) {
    throw new Error("Pairing string is invalid.");
  }
  let apiUrl;
  try {
    apiUrl = Buffer.from(encodedUrl, "base64url").toString("utf8");
  } catch {
    throw new Error("Pairing string contains an invalid Worker URL.");
  }
  if (Buffer.from(apiUrl, "utf8").toString("base64url") !== encodedUrl) {
    throw new Error("Pairing string contains an invalid Worker URL.");
  }
  if (!PAIRING_CODE.test(code)) throw new Error("Pairing code is invalid.");
  return { apiUrl, code };
}

export function validateDeviceToken(value) {
  if (!DEVICE_TOKEN.test(value || "")) {
    throw new Error("Worker returned an invalid device credential.");
  }
  return value;
}
