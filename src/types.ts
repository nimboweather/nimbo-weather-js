/** Response types of the Nimbo Weather API (v1). Times are ISO 8601 strings in UTC. Answers may carry more fields
 * than these: new fields can be added at any time. */

export interface RateLimit {
  /** Calls included in the plan this month. */
  limit: number;
  /** Calls left this month. */
  remaining: number;
  /** Unix time (s) when the allowance resets, UTC. */
  reset: number;
}

export type Intensity = "light" | "moderate" | "heavy" | "violent";

export interface Summary {
  /** The next hours in a sentence (English), e.g. "Light rain starting in 25 min, for about 40 min". */
  text: string;
  rain_now: boolean | null;
  rain_starts_at: string | null;
  /** null when the rain lasts past the horizon. */
  rain_ends_at: string | null;
  /** From the request time; 0 when it rains now. */
  minutes_until_rain: number | null;
  max_intensity: Intensity | null;
  now_source: "radar" | "forecast" | null;
}

export interface MinutelyEntry {
  time: string;
  /** Rain rate in mm/h; null without radar. */
  precip_mm_h: number | null;
  /** P(rate >= 0.2 mm/h), 0-1. */
  precip_probability: number | null;
  precip_probability_1mm_h: number | null;
  precip_probability_5mm_h: number | null;
  precip_type: "rain";
}

export interface SkillAtLead {
  lead_min: number;
  csi_1mmh: number;
}

export interface ConfidenceNote {
  field: string;
  beyond_lead_min: number;
  note: string;
}

export interface Nowcast {
  lat: number;
  lon: number;
  issue_time: string;
  data_age_s: number;
  /** true when the forecast is late (more than 25 min old). */
  stale: boolean;
  /** A sentence during an outage, else null. */
  notice: string | null;
  /** no_radar: inside the forecast area but no radar sees the point; summary and values are null. */
  coverage: "radar" | "no_radar";
  radar_source: string | null;
  summary: Summary | null;
  minutely: MinutelyEntry[];
  observed_now: { time: string; precip_mm_h: number } | null;
  horizon_skill: SkillAtLead[];
  horizon_skill_label: string | null;
  confidence_notes: ConfidenceNote[];
  grid: string;
  /** Credit lines to show with the data. */
  attribution: string[];
  /** From the X-RateLimit-* headers (added by this client). */
  rateLimit: RateLimit | null;
  [extra: string]: unknown;
}

export interface SourceState {
  status: "ok" | "stale" | "missing";
  last_nominal_time?: string | null;
  last_write_time?: string | null;
  age_s?: number | null;
}

export interface Status {
  time: string;
  status: "ok" | "degraded" | "stale";
  sources: Record<string, SourceState>;
  [extra: string]: unknown;
}

export interface Palettes {
  levels: number;
  rate_min: number;
  rate_max: number;
  nodata: number;
  /** palette -> RGBA per level (index 0 = no rain). */
  palettes: Record<string, number[][]>;
  [extra: string]: unknown;
}

export interface TileFrame {
  time: string;
  offset_min: number;
  /** URL template per layer: fill {z}/{x}/{y}, add ?key=. */
  tiles: Record<string, string>;
}

export interface TilesIndex {
  generated: string;
  issue_time: string;
  data_age_s: number;
  stale: boolean;
  notice: string | null;
  tile_size: number;
  min_zoom: number;
  max_zoom: number;
  layers: Record<string, string>;
  palettes: string[];
  past: TileFrame[];
  forecast: TileFrame[];
  latest: string;
  grid: string;
  attribution: string[];
  rateLimit: RateLimit | null;
  [extra: string]: unknown;
}

export interface KeyUsage {
  key_prefix: string;
  plan: string;
  monthly_quota: number;
  created: string;
  used_this_month: number;
  /** Unix time (s) the monthly count resets. */
  resets: number;
  [extra: string]: unknown;
}

export interface ErrorBody {
  error: string;
  message: string;
  [extra: string]: unknown;
}
