import { spawnSync } from "node:child_process";

const ENCRYPT_SCRIPT = [
  "$plain = [Console]::In.ReadToEnd()",
  "$secure = ConvertTo-SecureString $plain -AsPlainText -Force",
  "[Console]::Out.Write(($secure | ConvertFrom-SecureString))",
].join("; ");

const DECRYPT_SCRIPT = [
  "$encrypted = [Console]::In.ReadToEnd()",
  "$secure = ConvertTo-SecureString $encrypted",
  "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
].join("; ");

function runPowerShell(script, input) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`Windows credential protection failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function protectSecret(secret, platform = process.platform) {
  if (!secret) throw new Error("The sync key cannot be empty.");
  if (platform === "win32") {
    return { kind: "windows-dpapi", value: runPowerShell(ENCRYPT_SCRIPT, secret) };
  }
  return { kind: "file", value: secret };
}

export function revealSecret(protectedSecret, platform = process.platform) {
  if (!protectedSecret?.value) throw new Error("No sync key is configured.");
  if (protectedSecret.kind === "windows-dpapi") {
    if (platform !== "win32") {
      throw new Error("This sync key was protected for a different operating system.");
    }
    return runPowerShell(DECRYPT_SCRIPT, protectedSecret.value);
  }
  if (protectedSecret.kind === "file") return protectedSecret.value;
  throw new Error(`Unsupported credential storage: ${protectedSecret.kind}`);
}
