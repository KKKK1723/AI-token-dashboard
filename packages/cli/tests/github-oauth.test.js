import assert from "node:assert/strict";
import test from "node:test";

import { githubOAuthInternals } from "../src/github-oauth.js";

test("GitHub authorization URL contains a loopback redirect and PKCE challenge", () => {
  const value = new URL(
    githubOAuthInternals.authorizeUrl({
      authorizeUrl: "https://github.com/login/oauth/authorize",
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
      state: "state-value",
      codeChallenge: "challenge-value",
    }),
  );
  assert.equal(value.origin, "https://github.com");
  assert.equal(value.searchParams.get("client_id"), "client-id");
  assert.equal(
    value.searchParams.get("redirect_uri"),
    "http://127.0.0.1:49152/oauth/callback",
  );
  assert.equal(value.searchParams.get("state"), "state-value");
  assert.equal(value.searchParams.get("code_challenge_method"), "S256");
  assert.equal(value.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(value.searchParams.get("prompt"), "select_account");
});

test("local OAuth callback accepts only the matching state", async () => {
  const callback = await githubOAuthInternals.localCallback("expected-state", 5_000);
  try {
    const url = new URL(callback.redirectUri);
    url.searchParams.set("code", "temporary-code");
    url.searchParams.set("state", "expected-state");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await callback.code, "temporary-code");
  } finally {
    await callback.close();
  }
});
