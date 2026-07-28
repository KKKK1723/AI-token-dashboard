import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePairingBundle,
  encodePairingBundle,
  validateDeviceToken,
} from "../src/pairing.js";

const PAIRING_CODE = `atdp_${"a".repeat(43)}`;
const DEVICE_TOKEN = `atdt_${"b".repeat(43)}`;

test("pairing bundle round-trips the Worker URL and one-time code", () => {
  const value = encodePairingBundle("https://usage.example.test", PAIRING_CODE);
  assert.deepEqual(decodePairingBundle(value), {
    apiUrl: "https://usage.example.test",
    code: PAIRING_CODE,
  });
});

test("pairing bundle rejects malformed or non-canonical values", () => {
  assert.throws(() => decodePairingBundle("not-a-pairing-string"), /invalid/);
  assert.throws(
    () => encodePairingBundle("https://usage.example.test", "atdp_short"),
    /Pairing code is invalid/,
  );
  const encodedUrl = Buffer.from("https://usage.example.test", "utf8").toString("base64url");
  assert.throws(
    () => decodePairingBundle(`atd1.${encodedUrl}=.${PAIRING_CODE}`),
    /invalid Worker URL/,
  );
});

test("device credentials use the expected opaque token format", () => {
  assert.equal(validateDeviceToken(DEVICE_TOKEN), DEVICE_TOKEN);
  assert.throws(() => validateDeviceToken("atdt_short"), /invalid device credential/);
});
