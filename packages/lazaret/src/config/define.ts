import { type CompiledRule, compileRule, type Rule } from "../gate/rules";
import { type CycleConfig, DEFAULT_CYCLE, validateCycleConfig } from "../ledger/triggers";
import { builtinMerge, type MergeFn, type OverlayConfig } from "../overlay/merge";
import { type CompiledPattern, compilePattern, templateParams } from "../routing/matcher";

// `defineLazaret` is the single place a deployment is described. It validates
// everything up front and reports *all* problems at once, so a bad config fails
// at deploy time with a useful message instead of misrouting traffic in production.

export type Policy = "PASS" | "INLINE_REVIEW" | "ESCROW" | "BLOCK";
const POLICIES: readonly Policy[] = ["PASS", "INLINE_REVIEW", "ESCROW", "BLOCK"];
const BUILTIN_MERGES = ["append-json-array", "patch-json-by-id", "merge-json-object"] as const;

export interface RouteConfig {
  /** "METHOD /path/:param/*", e.g. "PATCH /api/tickets/:id". */
  match: string;
  policy: Policy;
  /**
   * Resource keys this write touches, e.g. ["ticket:{id}"]. Drives taint propagation.
   * `{receipt}` is the write's own entry id, for creations whose origin id is the receipt.
   */
  resources?: string[];
  /**
   * Show this route's pending writes to their author when they read another route
   * (ESCROW routes only). Params the two patterns share must match, so a pending
   * edit to ticket 42 only decorates `GET /api/tickets/42`.
   */
  overlay?: OverlayConfig | OverlayConfig[];
  /**
   * Requests per minute one session or IP is expected to stay under on this route.
   * Going over adds risk (`behaviour.route_burst`); far over blocks at the edge. Use it
   * for writes that are normal when rare and abusive in bulk, e.g. minting API keys.
   */
  perMinute?: number;
}

export interface LazaretConfig {
  /** Base URL of the protected origin. */
  origin: string;
  routes: RouteConfig[];
  /**
   * Policy for requests no route matches. Defaults: reads PASS, writes ESCROW, so a
   * forgotten route is still quarantined rather than waved through.
   */
  fallback?: { read?: Policy; write?: Policy };
  cycle?: Partial<CycleConfig>;
  ledger?: {
    /** Durable Object namespace binding holding the Ledger. Default `LAZARET_LEDGER`. */
    binding?: string;
    /** Ledger instance name. One shard for now; per-tenant sharding comes later. */
    shard?: string;
  };
  /** How to identify a session. Checked in order: cookie, header, then IP + user agent. */
  session?: { cookie?: string; header?: string };
  gate?: {
    /**
     * Risk at or above which the gate blocks outright. Reads have no reviewer behind
     * them, so their threshold is stricter than the threshold for reviewed writes.
     */
    thresholds?: { pass?: number; review?: number };
    maxBodyBytes?: number;
    /** JSON keys treated as privilege-bearing (mass assignment). Replaces the default list. */
    sensitiveFields?: string[];
    rules?: Rule[];
  };
  review?: {
    /** Reviews sealed batches. */
    batchModel?: string;
    /** Second opinion when the batch reviewer allows something the gate scored as high risk. */
    escalationModel?: string;
    /**
     * Gate risk at or above which a batch reviewer's allow is checked by the escalation
     * model (default 0.7). Kept apart from `cycle.riskSpikeThreshold`, which decides when
     * to seal a batch early: sharing it (0.8) let a single strong signature at 0.75
     * (`sqli.tautology`, eval sqli-06) be allowed by one model alone.
     */
    escalateAtRisk?: number;
    /** Synchronous review for INLINE_REVIEW routes (login, payments). */
    inlineModel?: string;
    /** Hard deadline for inline review (default 3000 ms); on timeout the request fails closed. */
    inlineTimeoutMs?: number;
    /** Review attempts per batch before it is quarantined. */
    maxAttempts?: number;
    /** Env binding holding the Anthropic API key. */
    apiKeyBinding?: string;
    dailyBudgetUsd?: number;
    /**
     * Who is asking, from origin itself. Before inline review the gateway makes a signed
     * `GET path` to origin with the client's own headers and picks `fields` (output name →
     * dotted JSON path) from the answer, e.g. `{ role: "account.role" }`. The reviewer gets
     * them as facts, so it can judge authorisation (a support agent issuing a small credit)
     * instead of quarantining what it can't attribute.
     */
    actor?: { path: string; fields: Record<string, string>; timeoutMs?: number };
  };
  signing?: {
    /** Env binding holding the HMAC secret shared with origin. */
    secretBinding?: string;
  };
  memory?: {
    /** Durable Object namespace binding for the Memory. If absent, memory is off. */
    binding?: string;
    /** Memory instance name. */
    name?: string;
    /** How long the gateway caches active rules. */
    ruleCacheTtlMs?: number;
    /** Ask Claude to propose rules after batches with drops. */
    distill?: boolean;
    /** Model for rule distillation. Defaults to the batch model. */
    distillModel?: string;
  };
}

export interface CompiledRoute {
  route: RouteConfig;
  pattern: CompiledPattern;
}

export interface CompiledOverlay {
  /** The write route whose pending entries feed this overlay. */
  writeRoute: string;
  writePattern: CompiledPattern;
  on: CompiledPattern;
  merge: MergeFn;
}

export interface ResolvedConfig {
  origin: URL;
  routes: CompiledRoute[];
  overlays: CompiledOverlay[];
  fallback: { read: Policy; write: Policy };
  cycle: CycleConfig;
  ledger: { binding: string; shard: string };
  session: { cookie?: string; header?: string };
  gate: {
    thresholds: { pass: number; review: number };
    maxBodyBytes: number;
    sensitiveFields: string[];
    rules: CompiledRule[];
  };
  review: {
    batchModel: string;
    escalationModel: string;
    escalateAtRisk: number;
    inlineModel: string;
    inlineTimeoutMs: number;
    maxAttempts: number;
    apiKeyBinding: string;
    dailyBudgetUsd: number;
    actor: { path: string; fields: Record<string, string>; timeoutMs: number } | null;
  };
  signing: { secretBinding: string };
  memory: {
    binding: string;
    name: string;
    ruleCacheTtlMs: number;
    distill: boolean;
    distillModel: string;
  };
}

export const DEFAULT_SENSITIVE_FIELDS = [
  "role",
  "roles",
  "admin",
  "is_admin",
  "isadmin",
  "permissions",
  "scopes",
  "balance",
  "credits",
  "verified",
  "email_verified",
  "owner_id",
  "tenant_id",
];

export class LazaretConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid Lazaret config:\n  - ${problems.join("\n  - ")}`);
    this.name = "LazaretConfigError";
  }
}

export function defineLazaret(config: LazaretConfig): ResolvedConfig {
  const problems: string[] = [];
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      problems.push((err as Error).message);
      return undefined;
    }
  };

  const origin = attempt(() => {
    const url = new URL(config.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("origin must be http(s)");
    return url;
  });
  if (!origin && !problems.length) problems.push("origin is required");

  const routes: CompiledRoute[] = [];
  const overlays: CompiledOverlay[] = [];
  for (const route of config.routes ?? []) {
    if (!POLICIES.includes(route.policy)) {
      problems.push(`route "${route.match}": unknown policy ${String(route.policy)}`);
      continue;
    }
    const pattern = attempt(() => compilePattern(route.match));
    if (!pattern) continue;
    if (pattern.params.includes("receipt")) {
      problems.push(`route "${route.match}": ":receipt" is reserved for the {receipt} placeholder`);
    }
    for (const template of route.resources ?? []) {
      for (const name of templateParams(template)) {
        if (!pattern.params.includes(name)) {
          problems.push(
            `route "${route.match}": resource "${template}" uses unknown param {${name}}`,
          );
        }
      }
    }
    if (
      route.perMinute !== undefined &&
      !(Number.isInteger(route.perMinute) && route.perMinute >= 1)
    ) {
      problems.push(`route "${route.match}": perMinute must be a positive integer`);
    }
    routes.push({ route, pattern });

    const overlayList = route.overlay === undefined ? [] : [route.overlay].flat();
    if (overlayList.length && route.policy !== "ESCROW") {
      problems.push(`route "${route.match}": overlay only applies to ESCROW routes`);
      continue;
    }
    for (const overlay of overlayList) {
      const on = attempt(() => compilePattern(overlay.on));
      if (!on) continue;
      if (on.methods === null || [...on.methods].some((m) => m !== "GET" && m !== "HEAD")) {
        problems.push(
          `route "${route.match}": overlay.on must be a GET route, got "${overlay.on}"`,
        );
        continue;
      }
      if (typeof overlay.merge !== "function" && !BUILTIN_MERGES.includes(overlay.merge)) {
        problems.push(`route "${route.match}": unknown overlay merge ${String(overlay.merge)}`);
        continue;
      }
      overlays.push({
        writeRoute: route.match,
        writePattern: pattern,
        on,
        merge:
          typeof overlay.merge === "function"
            ? overlay.merge
            : builtinMerge(overlay as OverlayConfig & { merge: (typeof BUILTIN_MERGES)[number] }),
      });
    }
  }

  const fallback = {
    read: config.fallback?.read ?? "PASS",
    write: config.fallback?.write ?? "ESCROW",
  };
  for (const p of [fallback.read, fallback.write]) {
    if (!POLICIES.includes(p)) problems.push(`fallback: unknown policy ${String(p)}`);
  }

  const cycle = attempt(() => validateCycleConfig({ ...DEFAULT_CYCLE, ...config.cycle }));

  const thresholds = { pass: 0.7, review: 0.95, ...config.gate?.thresholds };
  for (const [name, t] of Object.entries(thresholds)) {
    if (!(t > 0 && t <= 1)) problems.push(`gate.thresholds.${name} must be in (0, 1]`);
  }
  const maxBodyBytes = config.gate?.maxBodyBytes ?? 1_048_576;
  if (!(Number.isInteger(maxBodyBytes) && maxBodyBytes > 0)) {
    problems.push("gate.maxBodyBytes must be a positive integer");
  }

  // 3 s, not the original 1.5 s: the first live eval measured Haiku 5.5's time to first
  // token at ~1.2 s and its full inline verdict at ~1.3 s p50 / 1.5 s p95, so a 1.5 s
  // deadline failed closed on about a third of logins and credits (tasks/todo.md, M6).
  const inlineTimeoutMs = config.review?.inlineTimeoutMs ?? 3000;
  if (!(inlineTimeoutMs >= 100 && inlineTimeoutMs <= 30_000)) {
    problems.push("review.inlineTimeoutMs must be between 100 and 30000");
  }
  const escalateAtRisk = config.review?.escalateAtRisk ?? 0.7;
  if (!(escalateAtRisk > 0 && escalateAtRisk <= 1)) {
    problems.push("review.escalateAtRisk must be in (0, 1]");
  }
  const maxAttempts = config.review?.maxAttempts ?? 3;
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10)) {
    problems.push("review.maxAttempts must be an integer from 1 to 10");
  }

  const actorConfig = config.review?.actor;
  const actor = actorConfig
    ? { timeoutMs: 500, ...actorConfig, fields: { ...actorConfig.fields } }
    : null;
  if (actor) {
    if (!actor.path.startsWith("/")) problems.push("review.actor.path must start with /");
    if (!Object.keys(actor.fields).length) problems.push("review.actor.fields must not be empty");
    if (!(actor.timeoutMs >= 10 && actor.timeoutMs <= 5000)) {
      problems.push("review.actor.timeoutMs must be between 10 and 5000");
    }
  }

  const rules: CompiledRule[] = [];
  const ruleIds = new Set<string>();
  for (const rule of config.gate?.rules ?? []) {
    if (ruleIds.has(rule.id)) problems.push(`rule "${rule.id}": duplicate id`);
    ruleIds.add(rule.id);
    const compiled = attempt(() => compileRule(rule));
    if (compiled) rules.push(compiled);
  }

  if (problems.length || !origin || !cycle) throw new LazaretConfigError(problems);

  return {
    origin,
    routes,
    overlays,
    fallback,
    cycle,
    ledger: {
      binding: config.ledger?.binding ?? "LAZARET_LEDGER",
      shard: config.ledger?.shard ?? "default",
    },
    session: { ...config.session },
    gate: {
      thresholds,
      maxBodyBytes,
      sensitiveFields: (config.gate?.sensitiveFields ?? DEFAULT_SENSITIVE_FIELDS).map((f) =>
        f.toLowerCase(),
      ),
      rules,
    },
    review: {
      batchModel: config.review?.batchModel ?? "claude-sonnet-5-5",
      escalationModel: config.review?.escalationModel ?? "claude-opus-5-5",
      escalateAtRisk,
      inlineModel: config.review?.inlineModel ?? "claude-haiku-5-5",
      inlineTimeoutMs,
      maxAttempts,
      apiKeyBinding: config.review?.apiKeyBinding ?? "ANTHROPIC_API_KEY",
      dailyBudgetUsd: config.review?.dailyBudgetUsd ?? 5,
      actor,
    },
    signing: { secretBinding: config.signing?.secretBinding ?? "LAZARET_SIGNING_SECRET" },
    memory: {
      binding: config.memory?.binding ?? "LAZARET_MEMORY",
      name: config.memory?.name ?? "default",
      ruleCacheTtlMs: config.memory?.ruleCacheTtlMs ?? 60_000,
      distill: config.memory?.distill ?? true,
      distillModel: config.memory?.distillModel ?? config.review?.batchModel ?? "claude-sonnet-5-5",
    },
  };
}
