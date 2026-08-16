import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

import { exchangeGithubOAuth, getGithubOAuthConfig } from "./api.js";

const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

function base64Url(value) {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

function authorizeUrl({ authorizeUrl, clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

function callbackPage(success, message) {
  const title = success ? "Authorization complete" : "Authorization failed";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title></head>
<body style="font:16px system-ui,sans-serif;max-width:42rem;margin:12vh auto;padding:0 1rem;color:#1f2328">
<h1 style="font-size:1.5rem">${title}</h1><p>${message}</p></body></html>`;
}

async function localCallback(expectedState, timeoutMs = CALLBACK_TIMEOUT_MS) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let settled = false;
  let timer;
  const finish = (method, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle[method](value);
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    if (error || returnedState !== expectedState || !authorizationCode) {
      response.writeHead(400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(callbackPage(false, "Return to the terminal and retry setup."));
      finish(
        "reject",
        new Error(error ? `GitHub authorization failed: ${error}` : "Invalid OAuth callback."),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(callbackPage(true, "You can close this tab and return to the terminal."));
    finish("resolve", authorizationCode);
  });
  server.on("error", (error) => finish("reject", error));
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  timer = setTimeout(
    () => finish("reject", new Error("GitHub authorization timed out.")),
    timeoutMs,
  );
  return {
    code,
    redirectUri,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function authorizeGithubDevice({
  apiUrl,
  deviceId,
  deviceName,
  timezone,
  version,
  launchBrowser = openBrowser,
  timeoutMs = CALLBACK_TIMEOUT_MS,
}) {
  const oauth = await getGithubOAuthConfig({ apiUrl, version });
  if (
    typeof oauth.clientId !== "string" ||
    !oauth.clientId ||
    oauth.authorizeUrl !== "https://github.com/login/oauth/authorize"
  ) {
    throw new Error("Worker returned an invalid GitHub OAuth configuration.");
  }
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier, "ascii").digest(),
  );
  const callback = await localCallback(state, timeoutMs);
  try {
    const url = authorizeUrl({
      authorizeUrl: oauth.authorizeUrl,
      clientId: oauth.clientId,
      redirectUri: callback.redirectUri,
      state,
      codeChallenge,
    });
    console.log("Opening GitHub authorization in your browser...");
    console.log(url);
    launchBrowser(url);
    const code = await callback.code;
    return await exchangeGithubOAuth({
      apiUrl,
      code,
      codeVerifier,
      redirectUri: callback.redirectUri,
      deviceId,
      deviceName,
      timezone,
      version,
    });
  } finally {
    await callback.close();
  }
}

export const githubOAuthInternals = {
  authorizeUrl,
  base64Url,
  localCallback,
};
