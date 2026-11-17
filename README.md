# nimbo-weather

JavaScript/TypeScript client for the [Nimbo Weather](https://nimboweather.com) rain nowcast API: minute-by-minute rain
for the next 3 hours anywhere in the European radar coverage, at 2 km.

- ESM, TypeScript types included, zero dependencies (uses `fetch`)
- Node 18+, Deno, Bun, edge runtimes and browsers
- Typed errors for every API error code
- Retries on rate limits and server errors, honouring `Retry-After`
- Map tile URL helpers

> **Keep your API key server-side.** A key in a web page or a mobile app can be copied. Call the API from your
> server (or a serverless function) and send your users the result. If a key leaks, regenerate it from your dashboard.

## Install

```sh
npm install nimbo-weather
```

## Quickstart

Get a free key (no card) at [nimboweather.com](https://nimboweather.com), then:

```js
import { Nimbo } from "nimbo-weather";

const nimbo = new Nimbo({ apiKey: process.env.NIMBO_KEY }); // NIMBO_API_KEY or NIMBO_KEY is also read by default
const forecast = await nimbo.nowcast(52.37, 4.9); // Amsterdam

console.log(forecast.summary?.text ?? "No radar coverage at this point");
for (const m of forecast.minutely.slice(0, 6)) console.log(m.time, m.precip_mm_h, m.precip_probability);
console.log(forecast.attribution); // show this with the data (Free plan)
```

## Methods

| Method | Endpoint | Key |
|---|---|---|
| `nowcast(lat, lon, { horizon, step, signal })` | `/v1/nowcast` | yes |
| `tilesIndex()` | `/v1/tiles/index` | yes |
| `keyUsage()` | `/v1/keys/me` (not counted) | yes |
| `status()` | `/v1/status` | no |
| `palettes()` | `/v1/palettes` | no |
| `tileUrl(z, x, y, { offsetMin = 5, layer, palette })` | builds a tile URL | in the URL |

`horizon` is 5 to 180 minutes (default 180), `step` is 1, 5, 10 or 15 minutes (default 5). Answers are the API's JSON
(snake_case fields, ISO times in UTC); `nowcast()` and `tilesIndex()` add `rateLimit` (your monthly allowance).

Options: `new Nimbo({ apiKey, baseUrl, timeoutMs = 10000, maxRetries = 2, maxRetryWaitMs = 30000, fetch, userAgent })`.

## Things to check in every answer

- `coverage === "no_radar"`: the point is in the forecast area but no radar sees it. `summary` and every value are `null`.
- `stale`: the forecast is late (more than 25 min old). `notice` explains an outage.
- `attribution`: on the Free plan, show it with the data ("Rain forecast: Nimbo Weather" and its link). Optional on
  paid plans.

## Errors

All errors extend `NimboError` (`status`, `code`, `message`, `body`, `retryAfter` in seconds).

| Error | When |
|---|---|
| `AuthenticationError` | 401: missing, invalid or revoked key |
| `OutOfCoverageError` | 404 `out_of_coverage`: outside the forecast area, do not retry |
| `NotFoundError` | 404: unknown layer, palette, tile or time |
| `InvalidParameterError` | 422: see `.parameters` |
| `QuotaExceededError` | 429 `monthly_quota_exceeded`: wait for the reset or upgrade |
| `RateLimitError` | 429: too many requests at once |
| `ServiceUnavailableError` | 503: no recent forecast, retry in about 10 minutes |
| `ServerError` | other 5xx |
| `NimboConnectionError` | network error or timeout |

429s and server errors are retried `maxRetries` times with exponential backoff, waiting `Retry-After` when the API
sends it and it is at most `maxRetryWaitMs`. The monthly quota and 503 `forecast_unavailable` are not retried.

## Map tiles

Tiles take the key in the query string only, so a tile URL contains your key: build them where the key is safe.

```js
import { frameTileUrl } from "nimbo-weather";

const apiKey = process.env.NIMBO_KEY;
const index = await nimbo.tilesIndex();
for (const frame of index.forecast) console.log(frame.offset_min, frameTileUrl(frame, 6, 33, 21, { apiKey }));
```

## Links

- API docs: https://nimboweather.com/api
- OpenAPI: https://nimboweather.com/openapi.json
- Questions: hello@nimboweather.com

MIT licence.
