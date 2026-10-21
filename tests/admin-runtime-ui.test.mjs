import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, "admin script present");

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }
}

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const next = force === undefined ? !values.has(name) : Boolean(force);
      if (next) values.add(name);
      else values.delete(name);
      return next;
    },
    contains(name) { return values.has(name); },
  };
}

function makeHarness() {
  const elements = new Map();
  const timers = new Map();
  const clearCalls = [];
  let nextTimerId = 0;

  const document = {
    activeElement: null,
    title: "",
    documentElement: { lang: "", classList: classList() },
    body: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) { return makeElement(`created-${tag}`); },
    execCommand() { return false; },
  };

  function makeElement(id) {
    const attributes = new Map();
    return {
      id,
      hidden: false,
      textContent: "",
      innerHTML: "",
      value: "",
      type: "password",
      checked: false,
      dataset: {},
      style: {},
      offsetParent: {},
      classList: classList(),
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      contains() { return true; },
      closest() { return null; },
      appendChild(child) { return child; },
      removeChild() {},
      remove() {},
      focus() { document.activeElement = this; },
      select() {},
      setSelectionRange() {},
    };
  }

  document.body = makeElement("body");
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const window = {
    location: { origin: "http://admin.test" },
    isSecureContext: false,
    addEventListener() {},
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      clearCalls.push(id);
      timers.delete(id);
    },
    setInterval(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay, interval: true });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
  };
  const sandbox = {
    window,
    document,
    navigator: { languages: ["en"], language: "en", clipboard: null },
    localStorage,
    sessionStorage,
    AbortController,
    Date,
    Error,
    Intl,
    Map,
    Set,
    URLSearchParams,
    console,
    fetch: () => Promise.reject(new Error("fetch not configured")),
  };
  const exports = `
    globalThis.__adminTest = {
      adminApi,
      connect,
      setAdminKey(value) { adminKey = value; },
      getAdminKey() { return adminKey; },
    };
  `;
  vm.runInNewContext(`${script}\n${exports}`, sandbox, { filename: "public/admin.html" });
  return { api: sandbox.__adminTest, document, elements, localStorage, sandbox, timers, clearCalls };
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  };
}

function triggerOnlyTimer(harness) {
  assert.equal(harness.timers.size, 1, "one request timer should be pending");
  const [id, timer] = [...harness.timers.entries()][0];
  assert.equal(timer.delay, 15_000);
  timer.callback();
  return id;
}

function seedStoredKey(harness) {
  harness.localStorage.setItem("cursor-api.admin", "stored-secret");
  harness.api.setAdminKey("stored-secret");
}

test("a hanging fetch aborts at 15 seconds, reports timeout, and keeps credentials", async () => {
  const harness = makeHarness();
  seedStoredKey(harness);
  const calls = [];
  harness.sandbox.fetch = (_path, options) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };

  const pending = harness.api.connect(true);
  const timerId = triggerOnlyTimer(harness);
  await pending;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(harness.clearCalls.includes(timerId), true);
  assert.match(harness.elements.get("login-error").textContent, /15 seconds/);
  assert.equal(harness.api.getAdminKey(), "stored-secret");
  assert.equal(harness.localStorage.getItem("cursor-api.admin"), "stored-secret");
});

test("a hanging response body is also aborted and clears its timer", async () => {
  const harness = makeHarness();
  harness.api.setAdminKey("admin-secret");
  let textStarted = false;
  let signal;
  harness.sandbox.fetch = (_path, options) => {
    signal = options.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text() {
        textStarted = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      },
    });
  };

  const pending = harness.api.adminApi("GET", "/admin/api/overview", null, "overview-error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(textStarted, true);
  const timerId = triggerOnlyTimer(harness);
  await pending;

  assert.equal(signal.aborted, true);
  assert.equal(harness.clearCalls.includes(timerId), true);
  assert.match(harness.elements.get("overview-error").textContent, /15 seconds/);
});

test("success and network failure both clear the request timer", async () => {
  const harness = makeHarness();
  harness.api.setAdminKey("admin-secret");
  harness.sandbox.fetch = async () => jsonResponse({});
  await harness.api.adminApi("GET", "/admin/api/overview", null, "overview-error");
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.clearCalls.length, 1);

  harness.sandbox.fetch = () => Promise.reject(new Error("Failed to fetch"));
  await harness.api.adminApi("GET", "/admin/api/overview", null, "overview-error");
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.clearCalls.length, 2);
});

test("a timed-out POST is attempted once without automatic replay", async () => {
  const harness = makeHarness();
  harness.api.setAdminKey("admin-secret");
  const calls = [];
  harness.sandbox.fetch = (_path, options) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };

  const pending = harness.api.adminApi("POST", "/admin/api/keys", { name: "one" }, "create-error");
  triggerOnlyTimer(harness);
  await pending;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, JSON.stringify({ name: "one" }));
});

test("silent connect keeps storage for transient failures and clears it on 401", async () => {
  const network = makeHarness();
  seedStoredKey(network);
  network.sandbox.fetch = () => Promise.reject(new Error("Failed to fetch"));
  await network.api.connect(true);
  assert.equal(network.api.getAdminKey(), "stored-secret");
  assert.equal(network.localStorage.getItem("cursor-api.admin"), "stored-secret");

  const timeout = makeHarness();
  seedStoredKey(timeout);
  timeout.sandbox.fetch = (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  const pending = timeout.api.connect(true);
  triggerOnlyTimer(timeout);
  await pending;
  assert.equal(timeout.api.getAdminKey(), "stored-secret");
  assert.equal(timeout.localStorage.getItem("cursor-api.admin"), "stored-secret");

  const auth = makeHarness();
  seedStoredKey(auth);
  auth.sandbox.fetch = async () => jsonResponse({ error: "Invalid API key" }, false, 401);
  await auth.api.connect(true);
  assert.equal(auth.api.getAdminKey(), "");
  assert.equal(auth.localStorage.getItem("cursor-api.admin"), null);
});
