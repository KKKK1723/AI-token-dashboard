import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Unable to read JSON file ${file}: ${error.message}`);
  }
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows ACLs are inherited from the user profile directory.
  }
}

export async function appendLog(file, message) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

export async function withFileLock(file, callback, { waitMs = 0, pollMs = 250 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  const deadline = Date.now() + waitMs;
  while (!handle) {
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 15 * 60_000) {
        await fs.unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Another dashboard collection or sync is already running.");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await callback();
  } finally {
    await handle.close();
    await fs.unlink(file).catch(() => {});
  }
}

export function createEmptyState() {
  return {
    schemaVersion: 1,
    syncSequence: 0,
    pendingSync: null,
    cutoffAt: null,
    fileCursors: {},
    records: {},
    seedBuckets: {},
  };
}

export function validateState(value) {
  if (!value || value.schemaVersion !== 1) {
    throw new Error("Unsupported or corrupt local state file.");
  }
  value.fileCursors ||= {};
  value.records ||= {};
  value.seedBuckets ||= {};
  value.syncSequence ||= 0;
  value.pendingSync ??= null;
  if (!Number.isSafeInteger(value.syncSequence) || value.syncSequence < 0) {
    throw new Error("Local sync sequence is invalid.");
  }
  if (
    value.pendingSync &&
    value.pendingSync.payload?.sequence !== value.syncSequence + 1
  ) {
    throw new Error("Local pending sync sequence is inconsistent.");
  }
  return value;
}
