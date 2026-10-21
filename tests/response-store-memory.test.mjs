import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  clearStoredResponses,
  getStoredResponse,
  RESPONSE_TTL_MS,
  storeResponse,
} from "../dist/response-store.js";

const MAX_STORED_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STORED_RESPONSE_BYTES_PER_KEY = 8 * 1024 * 1024;

function serializedBytes(body) {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

function bodyAtMostBytes(id, unit, maxBytes) {
  const unitBytes = Buffer.byteLength(unit, "utf8");
  let count = Math.floor(maxBytes / unitBytes);
  let body = { id, data: unit.repeat(count) };
  while (serializedBytes(body) > maxBytes) {
    count -= 1;
    body = { id, data: unit.repeat(count) };
  }
  while (serializedBytes({ id, data: unit.repeat(count + 1) }) <= maxBytes) {
    count += 1;
    body = { id, data: unit.repeat(count) };
  }
  return body;
}

function bodyAboveBytes(id, unit, minBytes) {
  const under = bodyAtMostBytes(id, unit, minBytes);
  const count = under.data.length / unit.length + 1;
  const body = { id, data: unit.repeat(count) };
  assert.ok(serializedBytes(body) > minBytes);
  return body;
}

function populateExpiredEntries() {
  for (let index = 0; index < 1000; index += 1) {
    storeResponse(`expired-${String(index)}`, { id: "expired" }, 0);
  }
}

afterEach(() => {
  clearStoredResponses();
});

test("enforces the serialized payload byte cap per client key", () => {
  const chunk = Math.floor(MAX_STORED_RESPONSE_BYTES_PER_KEY * 0.42);
  const first = bodyAtMostBytes("per-key-old", "a", chunk);
  const second = bodyAtMostBytes("per-key-middle", "b", chunk);
  const third = bodyAtMostBytes("per-key-new", "c", chunk);

  storeResponse("client", first, 1000);
  storeResponse("client", second, 1000);
  assert.deepEqual(getStoredResponse("client", first.id, 1001), first);

  storeResponse("client", third, 1000);
  assert.equal(getStoredResponse("client", first.id, 1001), undefined);
  assert.deepEqual(getStoredResponse("client", second.id, 1001), second);
  assert.deepEqual(getStoredResponse("client", third.id, 1001), third);
});

test("evicts the oldest entry from the largest key under the global byte cap", () => {
  const largeChunk = Math.floor(MAX_STORED_RESPONSE_BYTES_PER_KEY * 0.46);
  const smallChunk = Math.floor(MAX_STORED_RESPONSE_BYTES * 0.205);
  const largeFirst = bodyAtMostBytes("large-old", "l", largeChunk);
  const largeSecond = bodyAtMostBytes("large-new", "m", largeChunk);

  storeResponse("largest", largeFirst, 1000);
  storeResponse("largest", largeSecond, 1000);
  for (let index = 0; index < 4; index += 1) {
    const body = bodyAtMostBytes(`small-${String(index)}`, "s", smallChunk);
    storeResponse(`small-${String(index)}`, body, 1000);
  }

  assert.equal(getStoredResponse("largest", largeFirst.id, 1001), undefined);
  assert.deepEqual(getStoredResponse("largest", largeSecond.id, 1001), largeSecond);
  for (let index = 0; index < 4; index += 1) {
    assert.ok(getStoredResponse(`small-${String(index)}`, `small-${String(index)}`, 1001));
  }
});

test("skips a single UTF-8 payload larger than the per-key byte cap and removes an old id", () => {
  const oversized = bodyAboveBytes("too-large", "🙂", MAX_STORED_RESPONSE_BYTES_PER_KEY);
  assert.ok(oversized.data.length < MAX_STORED_RESPONSE_BYTES_PER_KEY);

  storeResponse("client", { id: "too-large", data: "old" }, 999);
  storeResponse("client", oversized, 1000);
  assert.equal(getStoredResponse("client", oversized.id, 1001), undefined);
});

test("serializes and parses stored bodies, preserving multi-byte JSON values", () => {
  const body = { id: "utf8", data: "你好，🙂", nested: { ok: true } };
  storeResponse("client", body, 1000);
  body.nested.ok = false;

  const stored = getStoredResponse("client", "utf8", 1001);
  assert.deepEqual(stored, { id: "utf8", data: "你好，🙂", nested: { ok: true } });
  assert.notStrictEqual(stored, body);
});

test("replacing an id removes old byte usage and clear resets the byte budget", () => {
  const large = bodyAtMostBytes("same", "a", Math.floor(MAX_STORED_RESPONSE_BYTES_PER_KEY * 0.62));
  const replacement = { id: "same", data: "small" };
  const second = bodyAtMostBytes("second", "b", Math.floor(MAX_STORED_RESPONSE_BYTES_PER_KEY * 0.62));

  storeResponse("client", large, 1000);
  storeResponse("client", replacement, 1001);
  storeResponse("client", second, 1002);
  assert.deepEqual(getStoredResponse("client", "same", 1003), replacement);
  assert.deepEqual(getStoredResponse("client", "second", 1003), second);

  clearStoredResponses();
  const afterClear = bodyAtMostBytes("after-clear", "c", Math.floor(MAX_STORED_RESPONSE_BYTES_PER_KEY * 0.9));
  storeResponse("client", afterClear, 1004);
  assert.deepEqual(getStoredResponse("client", "after-clear", 1005), afterClear);
});

test("cleans expired entries globally before count admission on writes", () => {
  const now = RESPONSE_TTL_MS + 1;
  populateExpiredEntries();

  storeResponse("fresh", { id: "fresh-1" }, now);
  storeResponse("fresh", { id: "fresh-2" }, now);
  assert.deepEqual(getStoredResponse("fresh", "fresh-1", now), { id: "fresh-1" });
  assert.deepEqual(getStoredResponse("fresh", "fresh-2", now), { id: "fresh-2" });
});

test("cleans expired entries globally before count admission on reads", () => {
  const now = RESPONSE_TTL_MS + 1;
  populateExpiredEntries();
  assert.equal(getStoredResponse("missing", "missing", now), undefined);

  storeResponse("fresh", { id: "fresh-1" }, now);
  storeResponse("fresh", { id: "fresh-2" }, now);
  assert.deepEqual(getStoredResponse("fresh", "fresh-1", now), { id: "fresh-1" });
  assert.deepEqual(getStoredResponse("fresh", "fresh-2", now), { id: "fresh-2" });
});
