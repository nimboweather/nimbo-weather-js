/** Typed errors. Every API error is JSON `{"error": code, "message": text}`, sometimes with more fields (`body`). */

export interface NimboErrorInit {
  status?: number;
  code?: string;
  body?: Record<string, unknown>;
  retryAfter?: number;
  cause?: unknown;
}

export class NimboError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly body: Record<string, unknown>;
  /** Seconds, from the Retry-After header. */
  readonly retryAfter: number | undefined;

  constructor(message: string, init: NimboErrorInit = {}) {
    super(init.code ? `${init.code}: ${message}` : message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.body = init.body ?? {};
    this.retryAfter = init.retryAfter;
  }
}

/** The request got no answer (network error or timeout), after the retries. */
export class NimboConnectionError extends NimboError {}
/** 401: missing, invalid or revoked key. */
export class AuthenticationError extends NimboError {}
/** 422 invalid_parameter: fix the request (see `parameters`). */
export class InvalidParameterError extends NimboError {
  get parameters(): { name: string; problem: string }[] {
    const p = this.body.parameters;
    return Array.isArray(p) ? (p as { name: string; problem: string }[]) : [];
  }
}
/** 404: unknown layer, palette, tile or time. */
export class NotFoundError extends NimboError {}
/** 404 out_of_coverage: the point is outside the forecast area. Do not retry. */
export class OutOfCoverageError extends NotFoundError {}
/** 429: too many requests at once. Wait `retryAfter` seconds. */
export class RateLimitError extends NimboError {}
/** 429 monthly_quota_exceeded: the month's allowance is used up. */
export class QuotaExceededError extends RateLimitError {}
/** 503 forecast_unavailable / frames_unavailable: no recent forecast. Retry in about 10 minutes. */
export class ServiceUnavailableError extends NimboError {}
/** Any other 5xx. */
export class ServerError extends NimboError {}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

export function errorFromResponse(status: number, body: unknown, retryAfterHeader: string | null): NimboError {
  const data = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const code = typeof data.error === "string" ? data.error : undefined;
  const message = typeof data.message === "string" ? data.message : `HTTP ${status}`;
  const init: NimboErrorInit = { status, code, body: data, retryAfter: parseRetryAfter(retryAfterHeader) };
  if (status === 401) return new AuthenticationError(message, init);
  if (status === 422) return new InvalidParameterError(message, init);
  if (status === 404) return code === "out_of_coverage" ? new OutOfCoverageError(message, init) : new NotFoundError(message, init);
  if (status === 429)
    return code === "monthly_quota_exceeded" ? new QuotaExceededError(message, init) : new RateLimitError(message, init);
  if (status === 503 && (code === "forecast_unavailable" || code === "frames_unavailable"))
    return new ServiceUnavailableError(message, init);
  if (status >= 500) return new ServerError(message, init);
  return new NimboError(message, init);
}
