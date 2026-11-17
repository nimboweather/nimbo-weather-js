import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AuthenticationError,
  InvalidParameterError,
  Nimbo,
  NimboConnectionError,
  NimboError,
  OutOfCoverageError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  frameTileUrl,
} from "../dist/index.js";

const BASE = "https://nimboweather.com";
const KEY = "nimbo_test_key";
const NOWCAST = {
  lat: 52.37, lon: 4.9, issue_time: "2026-11-12T17:10:00Z", data_age_s: 420, stale: false, notice: null,
  coverage: "radar", radar_source: "opera",
  summary: { text: "Light rain starting in 23 min, for about 40 min", rain_now: false, rain_starts_at: "2026-11-12T17:40:00Z",
    rain_ends_at: "2026-11-12T18:20:00Z", minutes_until_rain: 23, max_intensity: "light", now_source: "radar" },
  minutely: [{ time: "2026-11-12T17:15:00Z", precip_mm_h: 0, precip_probability: 0.05, precip_probability_1mm_h: 0,
    precip_probability_5mm_h: 0, precip_type: "rain" }],
  observed_now: null, horizon_skill: [], horizon_skill_label: null, confidence_notes: [], grid: "EUROPE_2K",
  attribution: ["Radar credit line"],
};
const RL = { "X-RateLimit-Limit": "20000", "X-RateLimit-Remaining": "19990", "X-RateLimit-Reset": "1764547200" };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fake fetch answering from a list (a function or Response per call) and recording the calls. */
function mockFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), headers: new Headers(init.headers) });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a() : a.clone();
  };
  fn.calls = calls;
  return fn;
}

function client(fetch, extra = {}) {
  const waits = [];
  const c = new Nimbo({ apiKey: KEY, fetch, sleep: async (ms) => void waits.push(ms), ...extra });
  return { c, waits };
}

test("nowcast sends the key and parameters and returns the answer with the rate limit", async () => {
  const fetch = mockFetch(json(200, NOWCAST, RL));
  const { c } = client(fetch);
  const n = await c.nowcast(52.37, 4.9, { horizon: 60, step: 5 });
  const call = fetch.calls[0];
  assert.equal(call.url.pathname, "/v1/nowcast");
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { lat: "52.37", lon: "4.9", horizon: "60", step: "5" });
  assert.equal(call.headers.get("x-api-key"), KEY);
  assert.match(call.headers.get("user-agent"), /^nimbo-weather-js\//);
  assert.equal(n.summary.minutes_until_rain, 23);
  assert.deepEqual(n.rateLimit, { limit: 20000, remaining: 19990, reset: 1764547200 });
});

test("public endpoints send no key and work without one", async () => {
  const fetch = mockFetch(json(200, { time: "t", status: "ok", sources: {} }));
  const c = new Nimbo({ fetch, apiKey: undefined });
  assert.equal((await c.status()).status, "ok");
  assert.equal(fetch.calls[0].headers.get("x-api-key"), null);
});

test("a keyed call without a key fails before any request", async () => {
  const fetch = mockFetch(json(200, NOWCAST));
  const saved = process.env.NIMBO_API_KEY;
  delete process.env.NIMBO_API_KEY;
  try {
    await assert.rejects(new Nimbo({ fetch }).nowcast(1, 2), (e) => e instanceof NimboError && e.code === "api_key_required");
    assert.equal(fetch.calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.NIMBO_API_KEY = saved;
  }
});

test("the key is read from NIMBO_API_KEY", () => {
  process.env.NIMBO_API_KEY = "nimbo_env";
  try {
    assert.equal(new Nimbo({ fetch: mockFetch() }).apiKey, "nimbo_env");
  } finally {
    delete process.env.NIMBO_API_KEY;
  }
});

for (const [status, code, cls] of [
  [401, "invalid_api_key", AuthenticationError],
  [404, "out_of_coverage", OutOfCoverageError],
  [422, "invalid_parameter", InvalidParameterError],
  [429, "monthly_quota_exceeded", QuotaExceededError],
  [503, "forecast_unavailable", ServiceUnavailableError],
]) {
  test(`${status} ${code} is a ${cls.name} and is not retried`, async () => {
    const fetch = mockFetch(json(status, { error: code, message: "m", parameters: [{ name: "lat", problem: "p" }] },
      { "Retry-After": "1209600" }));
    const { c } = client(fetch);
    await assert.rejects(c.nowcast(0, 0), (e) => {
      assert.ok(e instanceof cls && e instanceof NimboError);
      assert.equal(e.name, cls.name);
      assert.equal(e.code, code);
      assert.equal(e.status, status);
      if (cls === InvalidParameterError) assert.deepEqual(e.parameters, [{ name: "lat", problem: "p" }]);
      if (cls === QuotaExceededError) assert.equal(e.retryAfter, 1209600);
      return true;
    });
    assert.equal(fetch.calls.length, 1);
  });
}

test("429 is retried after Retry-After, then gives up", async () => {
  const r = (s) => json(429, { error: "tile_rate_limited", message: "slow" }, { "Retry-After": s });
  const fetch = mockFetch(r("2"), r("3"), r("1"));
  const { c, waits } = client(fetch);
  await assert.rejects(c.tilesIndex(), (e) => e instanceof RateLimitError && e.retryAfter === 1);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(waits, [2000, 3000]);
});

test("a Retry-After longer than the cap is not waited for", async () => {
  const fetch = mockFetch(json(429, { error: "rate_limited", message: "x" }, { "Retry-After": "120" }));
  const { c, waits } = client(fetch);
  await assert.rejects(c.nowcast(0, 0), RateLimitError);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(waits, []);
});

test("network errors and 5xx are retried with backoff", async () => {
  const fetch = mockFetch(new TypeError("fetch failed"), () => new Response("bad gateway", { status: 502 }), json(200, NOWCAST));
  const { c, waits } = client(fetch);
  assert.equal((await c.nowcast(0, 0)).grid, "EUROPE_2K");
  assert.equal(fetch.calls.length, 3);
  assert.ok(waits[0] >= 375 && waits[0] <= 625 && waits[1] >= 750 && waits[1] <= 1250, String(waits));
});

test("retries exhausted", async () => {
  const { c } = client(mockFetch(new TypeError("fetch failed")), { maxRetries: 1 });
  await assert.rejects(c.nowcast(0, 0), NimboConnectionError);
  const { c: c2 } = client(mockFetch(() => new Response("oops", { status: 500 })), { maxRetries: 0 });
  await assert.rejects(c2.status(), (e) => e instanceof ServerError && e.status === 500 && e.code === undefined);
});

test("a caller abort is not retried", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const fetch = mockFetch(json(200, NOWCAST));
  const { c } = client(fetch);
  await assert.rejects(c.nowcast(0, 0, { signal: ctrl.signal }));
  assert.equal(fetch.calls.length, 0);
});

test("tile URLs", async () => {
  const { c } = client(mockFetch());
  assert.equal(c.tileUrl(5, 16, 11, { offsetMin: 30 }), `${BASE}/tiles/rain/latest/30/5/16/11.webp?key=${KEY}`);
  const frame = { time: "t", offset_min: 5, tiles: { rain: `${BASE}/tiles/rain/20261112T1710/20261112T1715/{z}/{x}/{y}.webp` } };
  assert.equal(frameTileUrl(frame, 5, 16, 11, { apiKey: KEY, palette: "default" }),
    `${BASE}/tiles/rain/20261112T1710/20261112T1715/5/16/11.webp?key=${KEY}&palette=default`);
});
