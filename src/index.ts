import { NimboConnectionError, NimboError, errorFromResponse, parseRetryAfter } from "./errors.js";
import type { KeyUsage, Nowcast, Palettes, RateLimit, Status, TileFrame, TilesIndex } from "./types.js";

export * from "./errors.js";
export type * from "./types.js";

export const VERSION = "0.1.1";
export const DEFAULT_BASE_URL = "https://nimboweather.com";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
// The monthly quota and "come back in 10 min" 503s are not retried: waiting a few seconds won't help.
const NO_RETRY_CODES = new Set(["monthly_quota_exceeded", "forecast_unavailable", "frames_unavailable"]);

export interface NimboOptions {
  /** Your key (nimbo_...). Defaults to process.env.NIMBO_API_KEY in Node. Keep it server-side. */
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Retries on 429, 5xx and network errors (default 2). */
  maxRetries?: number;
  /** Longest wait between retries in ms (default 30000); a longer Retry-After is not waited for. */
  maxRetryWaitMs?: number;
  /** A fetch implementation (default: globalThis.fetch). */
  fetch?: typeof fetch;
  /** Prefix for the User-Agent header (Node only; browsers do not let pages set it). */
  userAgent?: string;
  /** Used between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface NowcastOptions {
  /** Minutes ahead of the issue time, 5-180 (default 180). */
  horizon?: number;
  /** Minutes between entries: 1, 5, 10 or 15 (default 5). */
  step?: 1 | 5 | 10 | 15;
  signal?: AbortSignal;
}

export interface TileUrlOptions {
  /** Minutes after the issue time (one of the tiles index's offset_min). Default 5 (the first frame). */
  offsetMin?: number;
  layer?: string;
  palette?: string;
}

interface ProcessLike {
  env?: Record<string, string | undefined>;
  versions?: { node?: string };
}

function nodeProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

function envKey(): string | undefined {
  const env = nodeProcess()?.env;
  return env?.NIMBO_API_KEY || env?.NIMBO_KEY || undefined;
}

function rateLimitFrom(headers: Headers): RateLimit | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  return { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) };
}

/** Fills a tile URL template ({z}/{x}/{y}) and adds the key (tiles only take ?key=). */
export function fillTileTemplate(
  template: string,
  z: number,
  x: number,
  y: number,
  apiKey: string,
  palette?: string,
): string {
  const q = new URLSearchParams({ key: apiKey });
  if (palette) q.set("palette", palette);
  return `${template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y))}?${q}`;
}

/** URL of a frame's tile from /v1/tiles/index. */
export function frameTileUrl(
  frame: TileFrame,
  z: number,
  x: number,
  y: number,
  opts: { apiKey: string; layer?: string; palette?: string },
): string {
  const template = frame.tiles[opts.layer ?? "rain"];
  if (!template) throw new NimboError(`No layer ${opts.layer} in this frame.`);
  return fillTileTemplate(template, z, x, y, opts.apiKey, opts.palette);
}

export class Nimbo {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: NimboOptions = {}) {
    this.apiKey = options.apiKey ?? envKey();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 30_000;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new NimboError("No fetch available: use Node 18+ or pass options.fetch.");
    this.fetchImpl = f.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.headers = { Accept: "application/json" };
    if (nodeProcess()?.versions?.node) {
      const ua = `nimbo-weather-js/${VERSION}`;
      this.headers["User-Agent"] = options.userAgent ? `${options.userAgent} ${ua}` : ua;
    }
  }

  /** Rain nowcast for a point. */
  async nowcast(lat: number, lon: number, options: NowcastOptions = {}): Promise<Nowcast> {
    const params: Record<string, string> = { lat: String(lat), lon: String(lon) };
    if (options.horizon !== undefined) params.horizon = String(options.horizon);
    if (options.step !== undefined) params.step = String(options.step);
    const { body, rateLimit } = await this.get("/v1/nowcast", params, true, options.signal);
    return { ...body, rateLimit } as unknown as Nowcast;
  }

  /** Health and freshness of the service (public, no key). */
  async status(signal?: AbortSignal): Promise<Status> {
    return (await this.get("/v1/status", {}, false, signal)).body as Status;
  }

  /** Colour tables of the rain tiles (public, no key). */
  async palettes(signal?: AbortSignal): Promise<Palettes> {
    return (await this.get("/v1/palettes", {}, false, signal)).body as Palettes;
  }

  /** The current forecast's map frames, each with a URL template per layer. */
  async tilesIndex(signal?: AbortSignal): Promise<TilesIndex> {
    const { body, rateLimit } = await this.get("/v1/tiles/index", {}, true, signal);
    return { ...body, rateLimit } as unknown as TilesIndex;
  }

  /** The key's plan and this month's usage (not counted). */
  async keyUsage(signal?: AbortSignal): Promise<KeyUsage> {
    return (await this.get("/v1/keys/me", {}, true, signal)).body as KeyUsage;
  }

  /** URL of the current forecast's tile (a redirecting alias, for a single current frame). It carries the key. */
  tileUrl(z: number, x: number, y: number, options: TileUrlOptions = {}): string {
    const key = this.requireKey();
    const layer = options.layer ?? "rain";
    const template = `${this.baseUrl}/tiles/${encodeURIComponent(layer)}/latest/${options.offsetMin ?? 5}/{z}/{x}/{y}.webp`;
    return fillTileTemplate(template, z, x, y, key, options.palette);
  }

  private requireKey(): string {
    if (!this.apiKey)
      throw new NimboError("No API key: pass { apiKey } or set NIMBO_API_KEY (or NIMBO_KEY).", { code: "api_key_required" });
    return this.apiKey;
  }

  /** Milliseconds to wait before retry `attempt` (1-based), or null for no retry. */
  private retryWait(attempt: number, response: Response | null, code: string | undefined): number | null {
    if (attempt > this.maxRetries) return null;
    if (response) {
      if (!RETRY_STATUSES.has(response.status) || (code && NO_RETRY_CODES.has(code))) return null;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter !== undefined) {
        const ms = retryAfter * 1000;
        return ms <= this.maxRetryWaitMs ? ms : null;
      }
    }
    const backoff = Math.min(this.maxRetryWaitMs, 500 * 2 ** (attempt - 1));
    return backoff * (0.75 + Math.random() * 0.5);
  }

  private async get(
    path: string,
    params: Record<string, string>,
    keyed: boolean,
    signal?: AbortSignal,
  ): Promise<{ body: Record<string, unknown>; rateLimit: RateLimit | null }> {
    const headers = { ...this.headers };
    if (keyed) headers["X-API-Key"] = this.requireKey();
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        response = await this.fetchImpl(url, { method: "GET", headers, signal: ctrl.signal });
      } catch (e) {
        if (signal?.aborted) throw e; // the caller cancelled: no retry
        const wait = this.retryWait(attempt, null, undefined);
        if (wait === null) throw new NimboConnectionError(`Request failed: ${String(e)}`, { cause: e });
        await this.sleep(wait);
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new NimboError(`Unexpected answer (HTTP ${response.status}, not a JSON object).`, {
            status: response.status,
          });
        return { body: body as Record<string, unknown>, rateLimit: rateLimitFrom(response.headers) };
      }
      const err = errorFromResponse(response.status, body, response.headers.get("retry-after"));
      const wait = this.retryWait(attempt, response, err.code);
      if (wait === null) throw err;
      await this.sleep(wait);
    }
  }
}

export default Nimbo;
