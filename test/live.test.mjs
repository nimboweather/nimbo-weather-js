// Opt-in smoke test against the real API: NIMBO_LIVE_KEY=nimbo_... npm run test:live
// NIMBO_LIVE_BASE_URL points it at another server. Uses 1 counted call (the nowcast).
import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthenticationError, DEFAULT_BASE_URL, Nimbo } from "../dist/index.js";

const apiKey = process.env.NIMBO_LIVE_KEY;
const baseUrl = process.env.NIMBO_LIVE_BASE_URL ?? DEFAULT_BASE_URL;
const [lat, lon] = (process.env.NIMBO_LIVE_POINT ?? "52.37,4.90").split(",").map(Number);

test("live smoke", { skip: !apiKey && "set NIMBO_LIVE_KEY to run the live smoke test" }, async () => {
  const nimbo = new Nimbo({ apiKey, baseUrl });
  assert.ok(["ok", "degraded", "stale"].includes((await nimbo.status()).status));
  assert.ok((await nimbo.palettes()).levels > 0);
  assert.ok((await nimbo.keyUsage()).monthly_quota > 0);
  const n = await nimbo.nowcast(lat, lon, { horizon: 60 });
  assert.ok(n.minutely.length > 0 && n.attribution.length > 0 && n.rateLimit);
  if (n.coverage === "radar") assert.ok(n.summary?.text);
  const idx = await nimbo.tilesIndex();
  assert.ok(idx.forecast.length > 0 && idx.forecast[0].tiles.rain);
  const tile = await fetch(nimbo.tileUrl(6, 30, 24, { offsetMin: idx.forecast[0].offset_min }), { redirect: "manual" });
  assert.equal(tile.status, 302);
  await assert.rejects(new Nimbo({ apiKey: "nimbo_not_a_real_key", baseUrl }).keyUsage(), AuthenticationError);
});
