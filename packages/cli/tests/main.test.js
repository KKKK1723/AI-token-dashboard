import assert from "node:assert/strict";
import test from "node:test";

import { normalizeApiUrl } from "../src/main.js";
import { createEmptyState, validateState } from "../src/storage.js";

test("production sync URLs require HTTPS", () => {
  assert.equal(normalizeApiUrl("https://usage.example.test/"), "https://usage.example.test");
  assert.equal(normalizeApiUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(
    () => normalizeApiUrl("http://usage.example.test"),
    /must use HTTPS/,
  );
  assert.throws(
    () => normalizeApiUrl("https://user:secret@usage.example.test"),
    /cannot contain credentials/,
  );
});

test("legacy local state gains an empty pending sync slot", () => {
  const state = createEmptyState();
  delete state.pendingSync;
  assert.equal(validateState(state).pendingSync, null);
});

test("local pending sync sequence cannot regress confirmed data", () => {
  const state = createEmptyState();
  state.syncSequence = 4;
  state.pendingSync = { payload: { sequence: 4 } };
  assert.throws(() => validateState(state), /sequence is inconsistent/);
});
