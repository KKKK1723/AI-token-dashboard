import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const MASTER_KEY = "master-sync-secret";
const TIMEZONE = "Asia/Shanghai";

function result(changes = 0, results = []) {
  return {
    success: true,
    meta: { changes },
    results,
  };
}

class MemoryStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = values;
  }

  bind(...values) {
    return new MemoryStatement(this.database, this.sql, values);
  }

  run() {
    return Promise.resolve(this.database.execute(this, "run"));
  }

  all() {
    return Promise.resolve(this.database.execute(this, "all"));
  }

  first() {
    return Promise.resolve(this.database.execute(this, "first"));
  }
}

class MemoryD1 {
  constructor() {
    this.pairingCodes = new Map();
    this.credentials = new Map();
    this.devices = new Map();
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    const snapshot = structuredClone({
      pairingCodes: this.pairingCodes,
      credentials: this.credentials,
      devices: this.devices,
    });
    try {
      return statements.map((statement) => this.execute(statement, "run"));
    } catch (error) {
      this.pairingCodes = snapshot.pairingCodes;
      this.credentials = snapshot.credentials;
      this.devices = snapshot.devices;
      throw error;
    }
  }

  execute(statement, mode) {
    const { sql, values } = statement;
    if (sql.startsWith("DELETE FROM pairing_codes WHERE expires_at")) {
      let changes = 0;
      for (const [hash, pairing] of this.pairingCodes) {
        if (pairing.expiresAt <= values[0]) {
          this.pairingCodes.delete(hash);
          changes += 1;
        }
      }
      return result(changes);
    }
    if (sql.startsWith("INSERT INTO pairing_codes")) {
      const [hash, createdAt, expiresAt] = values;
      if (this.pairingCodes.has(hash)) throw new Error("UNIQUE constraint failed");
      this.pairingCodes.set(hash, { createdAt, expiresAt });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO device_credentials")) {
      const [tokenHash, deviceName, createdAt, codeHash] = values;
      const pairing = this.pairingCodes.get(codeHash);
      if (!pairing || pairing.expiresAt <= createdAt) return result(0);
      if (this.credentials.has(tokenHash)) throw new Error("UNIQUE constraint failed");
      this.credentials.set(tokenHash, {
        deviceId: null,
        deviceName,
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
      });
      return result(1);
    }
    if (sql.startsWith("DELETE FROM pairing_codes WHERE code_hash")) {
      return result(this.pairingCodes.delete(values[0]) ? 1 : 0);
    }
    if (sql.startsWith("SELECT device_id FROM device_credentials")) {
      const credential = this.credentials.get(values[0]);
      const row = credential && !credential.revokedAt
        ? { device_id: credential.deviceId }
        : null;
      if (mode === "first") return row;
      return result(0, row ? [row] : []);
    }
    if (sql.startsWith("UPDATE device_credentials")) {
      const [deviceId, deviceName, lastUsedAt, tokenHash] = values;
      const credential = this.credentials.get(tokenHash);
      if (
        !credential ||
        credential.revokedAt ||
        (credential.deviceId && credential.deviceId !== deviceId)
      ) {
        return result(0);
      }
      credential.deviceId ||= deviceId;
      credential.deviceName = deviceName;
      credential.lastUsedAt = lastUsedAt;
      return result(1);
    }
    if (sql.startsWith("INSERT INTO devices")) {
      const [deviceId, deviceName, timezone, now, sequence, collectorVersion] = values;
      const existing = this.devices.get(deviceId);
      this.devices.set(deviceId, {
        deviceName,
        timezone,
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
        lastSequence: Math.max(existing?.lastSequence || 0, sequence),
        collectorVersion,
      });
      return result(1);
    }
    throw new Error(`Unsupported test SQL: ${sql}`);
  }
}

function environment(database) {
  return {
    DB: database,
    SYNC_KEY: MASTER_KEY,
    READ_KEY: "read-secret",
    DASHBOARD_TIMEZONE: TIMEZONE,
  };
}

function request(path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

async function createPairing(database) {
  const response = await worker.fetch(
    request("/v1/pairing-codes", { token: MASTER_KEY }),
    environment(database),
  );
  const value = await responseJson(response);
  assert.equal(value.status, 200);
  return value.body;
}

async function redeem(database, code, extra = {}) {
  return responseJson(await worker.fetch(
    request("/v1/pair", {
      body: { code, deviceName: "laptop", ...extra },
    }),
    environment(database),
  ));
}

function syncPayload(deviceId, sequence = 1) {
  return {
    schemaVersion: 1,
    deviceId,
    deviceName: "laptop",
    timezone: TIMEZONE,
    collectorVersion: "2.1.0",
    sequence,
    buckets: [],
  };
}

test("pairing code is single-use and only token hashes are persisted", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  assert.match(pairing.code, /^atdp_[A-Za-z0-9_-]{43}$/);
  assert.equal([...database.pairingCodes.keys()].some((key) => key === pairing.code), false);

  const first = await redeem(database, pairing.code);
  assert.equal(first.status, 200);
  assert.match(first.body.deviceToken, /^atdt_[A-Za-z0-9_-]{43}$/);
  assert.equal([...database.credentials.keys()].some((key) => key === first.body.deviceToken), false);

  const replay = await redeem(database, pairing.code);
  assert.equal(replay.status, 400);
  assert.match(replay.body.error, /already used/);
});

test("expired pairing code is rejected and consumed", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  for (const value of database.pairingCodes.values()) {
    value.expiresAt = "2000-01-01T00:00:00.000Z";
  }

  const expired = await redeem(database, pairing.code);
  assert.equal(expired.status, 400);
  assert.equal(database.pairingCodes.size, 0);
});

test("timezone mismatch does not consume the pairing code", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  const mismatch = await redeem(database, pairing.code, { timezone: "UTC" });
  assert.equal(mismatch.status, 400);
  assert.equal(database.pairingCodes.size, 1);

  const accepted = await redeem(database, pairing.code, { timezone: TIMEZONE });
  assert.equal(accepted.status, 200);
});

test("device credential binds once and rejects another device id", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  const paired = await redeem(database, pairing.code);
  const deviceToken = paired.body.deviceToken;
  const firstDevice = "019fa6c8-7519-7ba0-9145-b2bf35fec800";
  const otherDevice = "019fa6c8-7519-7ba0-9145-b2bf35fec801";

  const first = await responseJson(await worker.fetch(
    request("/v1/sync", { token: deviceToken, body: syncPayload(firstDevice) }),
    environment(database),
  ));
  assert.equal(first.status, 200);
  assert.equal([...database.credentials.values()][0].deviceId, firstDevice);

  const repeat = await responseJson(await worker.fetch(
    request("/v1/sync", { token: deviceToken, body: syncPayload(firstDevice, 2) }),
    environment(database),
  ));
  assert.equal(repeat.status, 200);

  const conflict = await responseJson(await worker.fetch(
    request("/v1/sync", { token: deviceToken, body: syncPayload(otherDevice) }),
    environment(database),
  ));
  assert.equal(conflict.status, 403);
  assert.match(conflict.body.error, /another device/);
});
