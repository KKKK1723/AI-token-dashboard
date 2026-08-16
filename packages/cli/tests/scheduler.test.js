import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installSchedule, windowsHiddenRunnerSource } from "../src/scheduler.js";

test("Windows schedules run the CLI through a hidden WScript host", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atd-scheduler-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];

  await installSchedule({
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    scriptPath: "C:\\Users\\test user\\ai-token-dashboard.js",
    dataDirectory: directory,
    at: "03:10",
    platform: "win32",
    runCommand: (...args) => calls.push(args),
  });

  const runnerPath = path.join(directory, "run-hidden.vbs");
  assert.equal(await fs.readFile(runnerPath, "utf8"), windowsHiddenRunnerSource());
  assert.match(windowsHiddenRunnerSource(), /shell\.Run\(command, 0, True\)/);
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, "powershell.exe");
  assert.match(args.at(-1), /New-ScheduledTaskAction -Execute \$wscript/);
  assert.match(args.at(-1), /\/\/B \/\/NoLogo/);
  assert.match(args.at(-1), /New-TimeSpan -Minutes 10/);
  assert.doesNotMatch(args.at(-1), /-Execute \$env:ATD_NODE/);
  assert.equal(options.env.ATD_RUNNER, runnerPath);
});
