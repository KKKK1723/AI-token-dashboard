import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SYNC_TASK_NAME = "AI-token Dashboard Sync";
const COLLECT_TASK_NAME = "AI-token Dashboard Collect";
const WINDOWS_RUNNER_NAME = "run-hidden.vbs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function validateTime(at) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error("Schedule time must use HH:mm.");
}

export function windowsHiddenRunnerSource() {
  return [
    "Option Explicit",
    "Dim arguments, command, exitCode, index, shell",
    "Set arguments = WScript.Arguments",
    "If arguments.Count = 0 Then WScript.Quit 64",
    "command = QuoteArgument(arguments(0))",
    "For index = 1 To arguments.Count - 1",
    "  command = command & \" \" & QuoteArgument(arguments(index))",
    "Next",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "exitCode = shell.Run(command, 0, True)",
    "WScript.Quit exitCode",
    "",
    "Function QuoteArgument(value)",
    "  If InStr(value, Chr(34)) > 0 Then WScript.Quit 65",
    "  QuoteArgument = Chr(34) & value & Chr(34)",
    "End Function",
    "",
  ].join("\r\n");
}

export async function installSchedule({
  nodeExecutable,
  scriptPath,
  dataDirectory,
  at = "03:10",
  platform = process.platform,
  runCommand = run,
}) {
  validateTime(at);
  if (platform === "win32") {
    if (!dataDirectory) throw new Error("A data directory is required for the Windows schedule.");
    await fs.mkdir(dataDirectory, { recursive: true });
    const runnerPath = path.join(dataDirectory, WINDOWS_RUNNER_NAME);
    await fs.writeFile(runnerPath, windowsHiddenRunnerSource(), "utf8");
    const script = [
      "$time = [DateTime]::ParseExact($env:ATD_TIME, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)",
      "$runAt = (Get-Date).Date.AddHours($time.Hour).AddMinutes($time.Minute)",
      "$wscript = Join-Path $env:WINDIR 'System32\\wscript.exe'",
      "$syncArguments = '//B //NoLogo \"' + $env:ATD_RUNNER + '\" \"' + $env:ATD_NODE + '\" \"' + $env:ATD_SCRIPT + '\" sync'",
      "$collectArguments = '//B //NoLogo \"' + $env:ATD_RUNNER + '\" \"' + $env:ATD_NODE + '\" \"' + $env:ATD_SCRIPT + '\" collect'",
      "$syncAction = New-ScheduledTaskAction -Execute $wscript -Argument $syncArguments",
      "$collectAction = New-ScheduledTaskAction -Execute $wscript -Argument $collectArguments",
      "$syncTrigger = New-ScheduledTaskTrigger -Daily -At $runAt",
      "$collectTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)",
      "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)",
      "$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited",
      "Register-ScheduledTask -TaskName $env:ATD_SYNC_TASK -Action $syncAction -Trigger $syncTrigger -Settings $settings -Principal $principal -Description 'Upload local AI CLI usage once per day' -Force | Out-Null",
      "Register-ScheduledTask -TaskName $env:ATD_COLLECT_TASK -Action $collectAction -Trigger $collectTrigger -Settings $settings -Principal $principal -Description 'Collect local AI CLI usage every minute' -Force | Out-Null",
    ].join("; ");
    runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      env: {
        ...process.env,
        ATD_NODE: nodeExecutable,
        ATD_SCRIPT: scriptPath,
        ATD_RUNNER: runnerPath,
        ATD_TIME: at,
        ATD_SYNC_TASK: SYNC_TASK_NAME,
        ATD_COLLECT_TASK: COLLECT_TASK_NAME,
      },
    });
    return;
  }
  if (platform === "darwin") {
    const [hour, minute] = at.split(":").map(Number);
    const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
    const collectFile = path.join(launchAgents, "com.kkkk1723.ai-token-dashboard.collect.plist");
    const syncFile = path.join(launchAgents, "com.kkkk1723.ai-token-dashboard.sync.plist");
    const collectPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.kkkk1723.ai-token-dashboard.collect</string>
<key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(scriptPath)}</string><string>collect</string></array>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
</dict></plist>\n`;
    const syncPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.kkkk1723.ai-token-dashboard.sync</string>
<key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(scriptPath)}</string><string>sync</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
</dict></plist>\n`;
    await fs.mkdir(launchAgents, { recursive: true });
    await fs.writeFile(collectFile, collectPlist, { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(syncFile, syncPlist, { encoding: "utf8", mode: 0o600 });
    for (const file of [collectFile, syncFile]) {
      spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
      run("launchctl", ["load", file]);
    }
    return;
  }

  const systemd = path.join(os.homedir(), ".config", "systemd", "user");
  const collectService = path.join(systemd, "ai-token-dashboard-collect.service");
  const collectTimer = path.join(systemd, "ai-token-dashboard-collect.timer");
  const syncService = path.join(systemd, "ai-token-dashboard-sync.service");
  const syncTimer = path.join(systemd, "ai-token-dashboard-sync.timer");
  const quote = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  await fs.mkdir(systemd, { recursive: true });
  await fs.writeFile(collectService, `[Unit]\nDescription=Collect local AI CLI usage\n\n[Service]\nType=oneshot\nExecStart=${quote(nodeExecutable)} ${quote(scriptPath)} collect\n`, "utf8");
  await fs.writeFile(collectTimer, "[Unit]\nDescription=Collect local AI CLI usage every minute\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=1min\nAccuracySec=10s\n\n[Install]\nWantedBy=timers.target\n", "utf8");
  await fs.writeFile(syncService, `[Unit]\nDescription=Sync local AI CLI usage\n\n[Service]\nType=oneshot\nExecStart=${quote(nodeExecutable)} ${quote(scriptPath)} sync\n`, "utf8");
  await fs.writeFile(syncTimer, `[Unit]\nDescription=Daily AI token dashboard sync\n\n[Timer]\nOnCalendar=*-*-* ${at}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, "utf8");
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", "ai-token-dashboard-collect.timer", "ai-token-dashboard-sync.timer"]);
}

export async function removeSchedule(platform = process.platform) {
  if (platform === "win32") {
    const script = "$env:ATD_TASKS.Split('|') | ForEach-Object { Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue }";
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, ATD_TASKS: `${SYNC_TASK_NAME}|${COLLECT_TASK_NAME}` },
    });
    return;
  }
  if (platform === "darwin") {
    const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
    for (const name of [
      "com.kkkk1723.ai-token-dashboard.collect.plist",
      "com.kkkk1723.ai-token-dashboard.sync.plist",
    ]) {
      const file = path.join(launchAgents, name);
      spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
      await fs.unlink(file).catch(() => {});
    }
    return;
  }
  spawnSync("systemctl", ["--user", "disable", "--now", "ai-token-dashboard-collect.timer", "ai-token-dashboard-sync.timer"], { stdio: "ignore" });
  const systemd = path.join(os.homedir(), ".config", "systemd", "user");
  for (const name of [
    "ai-token-dashboard-collect.service",
    "ai-token-dashboard-collect.timer",
    "ai-token-dashboard-sync.service",
    "ai-token-dashboard-sync.timer",
  ]) {
    await fs.unlink(path.join(systemd, name)).catch(() => {});
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}
