import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, "admin script present");

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

function makeHarness() {
  const elements = new Map();
  const timers = new Map();
  const clearCalls = [];
  let nextTimerId = 0;

  function makeElement(id) {
    const attributes = new Map();
    let htmlValue = "";
    const element = {
      id,
      hidden: false,
      textContent: "",
      value: "",
      type: "password",
      checked: false,
      dataset: {},
      style: {},
      className: "",
      offsetParent: {},
      options: [],
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
      setCustomValidity() {},
      reportValidity() { return true; },
    };
    Object.defineProperty(element, "innerHTML", {
      get() { return htmlValue; },
      set(value) {
        htmlValue = String(value);
        const options = [...htmlValue.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((match) => {
          const valueMatch = match[1].match(/\bvalue="([^"]*)"/i);
          return { value: valueMatch?.[1] ?? "" };
        });
        element.options = options;
        if (options.length) element.value = options[0].value;
      },
    });
    return element;
  }

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
  document.body = makeElement("body");
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) document.getElementById(match[1]);

  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const window = {
    location: { origin: "http://admin.test" },
    isSecureContext: false,
    addEventListener() {},
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay, interval: false });
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
    Promise,
    console,
    fetch: () => Promise.reject(new Error("fetch not configured")),
  };
  const exports = `
    globalThis.__adminRaceTest = {
      adminApi,
      connect,
      logout,
      loadOverview,
      loadKeys,
      loadPool,
      loadLogFilters,
      loadLogs,
      loadStats,
      loadSyslog,
      showLogDetail,
      closeLogModal,
      logQuery,
      showView,
      syncLogTimer,
      stopLogTimer,
      setAdminKey(value) { adminKey = value; },
      getAdminKey() { return adminKey; },
      setCurrentView(value) { currentView = value; },
      setLogPage(value) { logPage = value; },
      setSyslogPage(value) { syslogPage = value; },
    };
  `;
  vm.runInNewContext(`${script}\n${exports}`, sandbox, { filename: "public/admin.html" });
  return { api: sandbox.__adminRaceTest, document, elements, localStorage, sandbox, timers, clearCalls };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  };
}

function installFetch(harness) {
  const calls = [];
  harness.sandbox.fetch = (path, options) => {
    const pending = deferred();
    const call = {
      path: String(path),
      options,
      ...pending,
      resolveJson(body) { pending.resolve(jsonResponse(body)); },
      rejectError(error = new Error("network down")) { pending.reject(error); },
    };
    calls.push(call);
    return pending.promise;
  };
  return calls;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function seedAdminKey(harness) {
  harness.api.setAdminKey("admin-secret");
}

function overview(version) {
  return {
    version,
    upstream: "ok",
    account: {},
    keys: { enabled: 1, total: 1 },
    tokens: { totals: { request_count: 1, total_tokens: 2, input_tokens: 1, output_tokens: 1 }, by_model: [] },
    calls_by_day: [],
  };
}

function keys(label) {
  return { keys: [{ id: label, name: label, key_prefix: label, enabled: true }] };
}

function pool(label) {
  return { strategy: "round_robin", cooldown_ms: 0, keys: [{ id: label, state: "healthy" }] };
}

function logs(label) {
  return {
    logs: [{ id: label, created_at: "2026-10-21T00:00:00.000Z", key_prefix: label, model: label, http_status: 200 }],
    total: 100,
    limit: 50,
  };
}

function filters(label) {
  return { models: [label], keys: [{ id: label, name: label, key_prefix: label }], statuses: [200] };
}

function stats(label) {
  return {
    tokens: { retention_days: 7, by_model: [{ model: label, request_count: 1, input_tokens: 1, output_tokens: 1, total_tokens: 2 }] },
    by_status: [{ http_status: 200, count: 1 }],
  };
}

function syslogs(label) {
  return {
    logs: [{ created_at: "2026-10-21T00:00:00.000Z", level: "info", message: label, fields: {} }],
    total: 100,
  };
}

function detail(label) {
  return {
    id: label,
    created_at: "2026-10-21T00:00:00.000Z",
    model: label,
    http_status: 200,
    duration_ms: 1,
    request_detail: "{}",
    response_detail: "{}",
  };
}

test("overview drops stale success and stale error after a newer read", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);

  const oldRead = harness.api.loadOverview();
  const freshRead = harness.api.loadOverview();
  assert.equal(calls.length, 2);

  calls[1].resolveJson(overview("fresh-overview"));
  await freshRead;
  await flush();
  calls[0].resolveJson(overview("stale-overview"));
  await oldRead;
  await flush();

  assert.equal(calls[0].options.signal.aborted, true);
  assert.match(harness.elements.get("overview-cards").innerHTML, /fresh-overview/);
  assert.equal(harness.elements.get("overview-error").hidden, true);

  const staleError = harness.api.loadOverview();
  const latestRead = harness.api.loadOverview();
  calls[3].resolveJson(overview("latest-overview"));
  await latestRead;
  calls[2].rejectError();
  await staleError;
  await flush();
  assert.equal(calls[2].options.signal.aborted, true);
  assert.match(harness.elements.get("overview-cards").innerHTML, /latest-overview/);
  assert.equal(harness.elements.get("overview-error").hidden, true);
});

test("key, pool, and detail reads keep only the latest response", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);

  harness.elements.get("keys-table").innerHTML = "existing-keys";
  const oldKeys = harness.api.loadKeys();
  const freshKeys = harness.api.loadKeys();
  calls[1].resolveJson(keys("fresh-key"));
  await freshKeys;
  calls[0].rejectError();
  await oldKeys;
  await flush();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.match(harness.elements.get("keys-table").innerHTML, /fresh-key/);
  assert.equal(harness.elements.get("keys-error").hidden, true);

  const oldPool = harness.api.loadPool();
  const freshPool = harness.api.loadPool();
  calls[3].resolveJson(pool("fresh-pool"));
  await freshPool;
  calls[2].rejectError();
  await oldPool;
  await flush();
  assert.equal(calls[2].options.signal.aborted, true);
  assert.match(harness.elements.get("pool-table").innerHTML, /fresh-pool/);
  assert.equal(harness.elements.get("pool-error").hidden, true);

  const oldDetail = harness.api.showLogDetail("old-detail");
  const freshDetail = harness.api.showLogDetail("fresh-detail");
  calls[5].resolveJson(detail("fresh-detail"));
  await freshDetail;
  calls[4].rejectError();
  await oldDetail;
  await flush();
  assert.equal(calls[4].options.signal.aborted, true);
  assert.match(harness.elements.get("log-modal-title").textContent, /fresh-detail/);
  assert.equal(harness.elements.get("logs-error").hidden, true);
});

test("filters, paged logs, stats, and system logs ignore stale responses", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);

  const oldFilters = harness.api.loadLogFilters(true);
  const freshFilters = harness.api.loadLogFilters(true);
  calls[1].resolveJson(filters("fresh-filter"));
  await freshFilters;
  calls[0].rejectError();
  await oldFilters;
  await flush();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.match(harness.elements.get("log-model").innerHTML, /fresh-filter/);
  assert.equal(harness.elements.get("logs-error").hidden, true);

  harness.api.setLogPage(1);
  const oldLogs = harness.api.loadLogs();
  harness.api.setLogPage(2);
  const freshLogs = harness.api.loadLogs();
  calls[3].resolveJson(logs("fresh-page"));
  await freshLogs;
  calls[2].rejectError();
  await oldLogs;
  await flush();
  assert.equal(calls[2].options.signal.aborted, true);
  assert.match(harness.elements.get("logs-view").innerHTML, /fresh-page/);
  assert.equal(harness.elements.get("logs-error").hidden, true);

  const oldStats = harness.api.loadStats();
  const freshStats = harness.api.loadStats();
  calls[5].resolveJson(stats("fresh-stats"));
  await freshStats;
  calls[4].rejectError();
  await oldStats;
  await flush();
  assert.equal(calls[4].options.signal.aborted, true);
  assert.match(harness.elements.get("stats-view").innerHTML, /fresh-stats/);
  assert.equal(harness.elements.get("logs-error").hidden, true);

  harness.api.setSyslogPage(1);
  const oldSyslog = harness.api.loadSyslog();
  harness.api.setSyslogPage(2);
  const freshSyslog = harness.api.loadSyslog();
  calls[7].resolveJson(syslogs("fresh-system-log"));
  await freshSyslog;
  calls[6].rejectError();
  await oldSyslog;
  await flush();
  assert.equal(calls[6].options.signal.aborted, true);
  assert.match(harness.elements.get("syslog-view").innerHTML, /fresh-system-log/);
  assert.equal(harness.elements.get("syslog-error").hidden, true);
});

test("filter options apply the selection that is current when the response arrives", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);
  harness.elements.get("log-model").value = "before-refresh";

  const pending = harness.api.loadLogFilters(true);
  harness.elements.get("log-model").value = "selected-while-loading";
  calls[0].resolveJson(filters("server-only-model"));
  await pending;
  await flush();

  assert.equal(harness.elements.get("log-model").value, "selected-while-loading");
  assert.match(harness.api.logQuery(), /(?:^|&)model=selected-while-loading(?:&|$)/);
});

test("closing a log detail keeps a late detail response from reopening the modal", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);
  const pending = harness.api.showLogDetail("late-detail");
  harness.api.closeLogModal();
  calls[0].resolveJson(detail("late-detail"));
  await pending;
  await flush();

  assert.equal(harness.elements.get("log-modal").classList.contains("hidden"), true);
  assert.equal(harness.elements.get("log-modal-body").innerHTML, "");
});

test("background polling skips an unfinished read while manual refresh replaces it", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);
  harness.api.setCurrentView("pool");
  harness.api.syncLogTimer();
  const interval = [...harness.timers.values()].find((timer) => timer.interval && timer.delay === 5000);
  assert.ok(interval, "pool polling timer is installed");

  interval.callback();
  interval.callback();
  assert.equal(calls.length, 1, "unfinished pool poll is not overlapped");

  const manual = harness.api.loadPool();
  assert.equal(calls.length, 2, "manual refresh starts a replacement read");
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolveJson(pool("manual-pool"));
  await manual;
  await flush();
  assert.match(harness.elements.get("pool-table").innerHTML, /manual-pool/);
});

test("request-log polling does not overlap either the list or statistics read", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);
  harness.api.setCurrentView("logs");
  harness.elements.get("log-auto").checked = true;
  harness.api.syncLogTimer();
  const interval = [...harness.timers.values()].find((timer) => timer.interval && timer.delay === 5000);
  assert.ok(interval, "request-log polling timer is installed");

  interval.callback();
  interval.callback();
  assert.equal(calls.filter((call) => call.path.startsWith("/admin/api/logs?")).length, 1);
  assert.equal(calls.filter((call) => call.path === "/admin/api/stats").length, 1);
});

test("a failed read preserves data, exposes retry, and does not leave first load stuck", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);

  harness.elements.get("keys-table").innerHTML = "previous-key-data";
  const failed = harness.api.loadKeys();
  calls[0].rejectError(new Error("gateway unavailable"));
  await failed;
  await flush();
  assert.equal(harness.elements.get("keys-table").innerHTML, "previous-key-data");
  assert.equal(harness.elements.get("keys-error").hidden, false);
  assert.match(harness.elements.get("keys-error").textContent, /gateway unavailable/);

  const retried = harness.api.loadKeys();
  calls[1].resolveJson(keys("retried-key"));
  await retried;
  await flush();
  assert.match(harness.elements.get("keys-table").innerHTML, /retried-key/);
  assert.equal(harness.elements.get("keys-error").hidden, true);

  harness.elements.get("pool-table").innerHTML = '<span class="loading">Loading</span>';
  const firstFailure = harness.api.loadPool();
  calls[2].rejectError(new Error("first pool failure"));
  await firstFailure;
  await flush();
  assert.equal(harness.elements.get("pool-error").hidden, false);
  assert.equal(harness.elements.get("pool-table").innerHTML.includes("loading"), false);
});

test("switching view or logging out prevents stale reads from changing the page or reconnecting", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);

  harness.elements.get("pool-table").innerHTML = "before-switch";
  const poolRead = harness.api.loadPool();
  harness.api.showView("overview");
  calls[0].resolveJson(pool("after-switch"));
  await poolRead;
  await flush();
  assert.equal(harness.elements.get("pool-table").innerHTML, "before-switch");

  const connect = harness.api.connect(true);
  const connectCall = calls.find((call) => call.path === "/admin/api/overview" && call !== calls[1]);
  assert.ok(connectCall, "login overview request is pending");
  harness.api.logout();
  connectCall.resolveJson(overview("after-logout"));
  await connect;
  await flush();
  assert.equal(harness.elements.get("app").classList.contains("hidden"), true);
  assert.equal(harness.elements.get("login").classList.contains("hidden"), false);
  assert.equal(harness.api.getAdminKey(), "");
  assert.equal(harness.localStorage.getItem("cursor-api.admin"), null);
});

test("read cancellation never cancels, replays, or deduplicates writes", async () => {
  const harness = makeHarness();
  seedAdminKey(harness);
  const calls = installFetch(harness);
  const writePromises = [
    harness.api.adminApi("POST", "/admin/api/keys", { name: "one" }, "keys-error"),
    harness.api.adminApi("PATCH", "/admin/api/keys/one", { name: "two" }, "keys-error"),
    harness.api.adminApi("DELETE", "/admin/api/keys/one", null, "keys-error"),
  ];
  const read = harness.api.loadKeys();
  const latestRead = harness.api.loadKeys();
  assert.equal(calls.length, 5);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[1].options.signal.aborted, false);
  assert.equal(calls[2].options.signal.aborted, false);
  assert.equal(calls[3].options.signal.aborted, true);

  calls[0].resolveJson({});
  calls[1].resolveJson({});
  calls[2].resolveJson({});
  calls[4].resolveJson(keys("latest-write-view"));
  calls[3].rejectError();
  await Promise.all([...writePromises, read, latestRead]);
  await flush();

  assert.equal(calls.length, 5, "writes are attempted exactly once");
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[1].options.signal.aborted, false);
  assert.equal(calls[2].options.signal.aborted, false);
  assert.match(harness.elements.get("keys-table").innerHTML, /latest-write-view/);
});

test("a completed read cannot render after a newer refresh begins", async () => {
  const violations = [];
  for (let turns = 0; turns < 15; turns++) {
    const harness = makeHarness(); seedAdminKey(harness); const calls = installFetch(harness);
    harness.elements.get("keys-table").innerHTML="initial";
    const older = harness.api.loadKeys(); calls[0].resolveJson(keys("older-key"));
    for(let n=0;n<turns;n++) await Promise.resolve();
    const before = harness.elements.get("keys-table").innerHTML;
    const newer = harness.api.loadKeys();
    await older;
    const after = harness.elements.get("keys-table").innerHTML;
    if(!before.includes("older-key") && after.includes("older-key")) violations.push(turns);
    calls[1].resolveJson(keys("newer-key")); await newer;
  }
  assert.deepEqual(violations, [], "old read rendered after new refresh began");
});
