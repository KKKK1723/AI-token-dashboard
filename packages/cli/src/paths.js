import os from "node:os";
import path from "node:path";

export function defaultDataDirectory({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (env.AI_TOKEN_DASHBOARD_HOME) {
    return path.resolve(env.AI_TOKEN_DASHBOARD_HOME);
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ai-token-dashboard");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "ai-token-dashboard");
  }
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "ai-token-dashboard");
}

export function dashboardPaths(options = {}) {
  const directory = defaultDataDirectory(options);
  return {
    directory,
    config: path.join(directory, "config.json"),
    state: path.join(directory, "state.json"),
    lock: path.join(directory, "sync.lock"),
    log: path.join(directory, "sync.log"),
  };
}

export function defaultClaudeDirectory(home = os.homedir(), env = process.env) {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"));
}

export function defaultCodexDirectory(home = os.homedir(), env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
}
