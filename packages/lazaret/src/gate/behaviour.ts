import type { GateSignal } from "./signals";

// Behavioural scoring: does this client act like a person or an automated agent?
// Content signatures can't see a credential-stuffing swarm whose every request
// looks benign, but behaviour can: inhuman rates, metronomic timing, path
// enumeration, and floods of failures.
//
// The scoring is a pure function of recent samples. Where samples live is
// pluggable. `MemoryBehaviourStore` is per-isolate and best-effort: Cloudflare
// usually routes one client to the same isolate, but not always, so it
// under-counts rather than over-counts. A Durable Object-backed store for
// cross-isolate and cross-IP (swarm) views can slot in behind the same interface.

export interface BehaviourSample {
  at: number;
  method: string;
  path: string;
  /** Filled in after origin responds, for routes where the gateway sees the response. */
  status?: number;
}

export interface BehaviourStore {
  /** Record a sample under `key` and return that key's samples in the window (including this one). */
  record(key: string, sample: BehaviourSample): BehaviourSample[];
}

export class MemoryBehaviourStore implements BehaviourStore {
  readonly #samples = new Map<string, BehaviourSample[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
    private readonly maxSamplesPerKey = 200,
  ) {}

  record(key: string, sample: BehaviourSample): BehaviourSample[] {
    const cutoff = sample.at - this.windowMs;
    const kept = (this.#samples.get(key) ?? []).filter((s) => s.at > cutoff);
    kept.push(sample);
    if (kept.length > this.maxSamplesPerKey) kept.splice(0, kept.length - this.maxSamplesPerKey);
    // Delete and reinsert so Map order doubles as an LRU.
    this.#samples.delete(key);
    this.#samples.set(key, kept);
    if (this.#samples.size > this.maxKeys) {
      const oldest = this.#samples.keys().next().value;
      if (oldest !== undefined) this.#samples.delete(oldest);
    }
    return kept;
  }
}

export function scoreBehaviour(samples: BehaviourSample[], now: number): GateSignal[] {
  const signals: GateSignal[] = [];
  const signal = (id: string, weight: number, evidence: string) =>
    signals.push({ source: "behaviour", id, category: "automation", weight, evidence });

  const last10s = samples.filter((s) => s.at > now - 10_000).length;
  if (last10s > 100) signal("behaviour.rate_extreme", 0.85, `${last10s} req/10s`);
  else if (last10s > 50) signal("behaviour.rate_high", 0.6, `${last10s} req/10s`);
  else if (last10s > 20) signal("behaviour.rate_elevated", 0.3, `${last10s} req/10s`);

  // Humans are bursty; scripts and naive agents fire on a fixed interval. A low
  // coefficient of variation in inter-arrival times is a strong automation tell.
  if (samples.length >= 8) {
    const gaps = samples.slice(1).map((s, i) => s.at - (samples[i]?.at ?? s.at));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean > 0) {
      const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
      if (sd / mean < 0.1) signal("behaviour.metronomic", 0.4, `cv=${(sd / mean).toFixed(3)}`);
    }
  }

  const distinctPaths = new Set(samples.map((s) => s.path)).size;
  if (distinctPaths >= 30) signal("behaviour.path_enumeration", 0.4, `${distinctPaths} paths/60s`);

  const withStatus = samples.filter((s) => s.status !== undefined);
  const failures = withStatus.filter((s) => (s.status ?? 0) >= 400).length;
  if (withStatus.length >= 10 && failures / withStatus.length > 0.5) {
    signal("behaviour.failure_flood", 0.5, `${failures}/${withStatus.length} failed`);
  }
  return signals;
}

const AUTOMATION_UA =
  /python-requests|curl\/|wget\/|go-http-client|headlesschrome|phantomjs|selenium|playwright|puppeteer/i;

/** Weak header-level hints. Many legitimate API clients use curl, so these stay small. */
export function headerSignals(headers: Record<string, string>): GateSignal[] {
  const ua = headers["user-agent"];
  if (!ua)
    return [
      { source: "behaviour", id: "headers.no_user_agent", category: "automation", weight: 0.15 },
    ];
  const m = AUTOMATION_UA.exec(ua);
  return m
    ? [
        {
          source: "behaviour",
          id: "headers.automation_ua",
          category: "automation",
          weight: 0.2,
          evidence: m[0],
        },
      ]
    : [];
}
