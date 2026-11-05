import { createCommitter, originUrl } from "../commit/committer.ts";
import { signRequest } from "../commit/sign.ts";
import type { CompiledRoute, Policy, ResolvedConfig } from "../config/define.ts";
import {
  type BehaviourSample,
  type BehaviourStore,
  headerSignals,
  MemoryBehaviourStore,
  scoreBehaviour,
  scoreRoute,
} from "../gate/behaviour.ts";
import { DurableBehaviourStore } from "../gate/behaviour-durable.ts";
import { decide, type MemoryGateRule } from "../gate/gate.ts";
import { inspect } from "../gate/inspect.ts";
import { compileRule } from "../gate/rules.ts";
import type { GateSignal } from "../gate/signals.ts";
import type { LazaretLedger } from "../ledger/durable-object.ts";
import { HOLD_CAP_PER_HOUR, type LinkCounts, type LinkedWrite, linkKeys } from "../ledger/links.ts";
import type { ObservedInput } from "../ledger/public.ts";
import type { EntryInput } from "../ledger/types.ts";
import { archiveRecord } from "../memory/sample.ts";
import type { LazaretMemory } from "../memory/store.ts";
import { overlayResponse } from "../overlay/apply.ts";
import { meteredReviewer, tierModel } from "../review/budget.ts";
import { AnthropicReviewer, type Reviewer } from "../review/client.ts";
import { inlineReview } from "../review/inline.ts";
import { fillTemplate, matchPattern } from "../routing/matcher.ts";
import { encodePath, normalizePath, type PathAnomaly } from "../routing/normalize.ts";
import { type Actor, lookupActor } from "./actor.ts";
import {
  BodyTooLarge,
  forwardableHeaders,
  isTextual,
  json,
  readBodyCapped,
  toBase64,
} from "./http.ts";
import { handleOperator } from "./operator.ts";
import { handlePublic, PUBLIC_KINDS } from "./public.ts";
import { deriveSessionId } from "./session.ts";

// The Gateway is the Worker entrypoint. For every request it:
//   1. normalises the path and matches a route (or the read/write fallback)
//   2. short-circuits BLOCK routes before reading the body
//   3. inspects the request and scores behaviour → a GateDecision
//   4. applies the policy: PASS forwards to origin, ESCROW appends to the Ledger
//      and answers 202 with a receipt, INLINE_REVIEW asks the fast reviewer and
//      forwards only on a confident allow
//
// It forwards the *normalised* path, never the raw one, so origin acts on exactly
// what the route rules saw (see routing/normalize.ts). Every forwarded request is
// HMAC-signed, so origin can refuse anything that bypassed Lazaret.
//
// Reads on routes with an overlay get the session's own pending writes merged in
// (author-only, see overlay/apply.ts). `GET /__lazaret/receipts/:id` lets an author
// poll a receipt, and `/__lazaret/operator/` is the human review queue (operator.ts).
// With `live.enabled`, `/__lazaret/{live,status,queue,memory}` are the public,
// read-only view (public.ts). The `/__lazaret/` prefix is reserved and never reaches
// origin.
//
// Inline review is metered against the daily spend cap (review/budget.ts) and checked
// before each call: once the day's budget is spent, the reviewer counts as unavailable.
//
// `scheduled` is the cron entrypoint: it sweeps the Ledger for sealed batches
// whose review never started (see LazaretLedger.sweep).

export interface GatewayDeps {
  behaviour?: BehaviourStore;
  /** How to reach origin. Defaults to global fetch; pass a service binding's fetch for Worker origins. */
  fetchOrigin?: (request: Request) => Promise<Response>;
  /** Reviewer for INLINE_REVIEW routes. Defaults to Claude via the configured API key. */
  reviewer?: Reviewer;
  now?: () => number;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ANOMALY_WEIGHTS: Record<Exclude<PathAnomaly, "null_byte">, number> = {
  encoded_separator: 0.5,
  backslash: 0.4,
  double_encoding: 0.5,
  malformed_encoding: 0.3,
  empty_segment: 0.1,
  dot_segment: 0.6,
};

export function createGateway(config: ResolvedConfig, deps: GatewayDeps = {}) {
  const behaviour: BehaviourStore =
    deps.behaviour ??
    (config.behaviour.store === "durable"
      ? new DurableBehaviourStore(config.behaviour)
      : new MemoryBehaviourStore());
  const fetchOrigin = deps.fetchOrigin ?? ((r: Request) => fetch(r));
  const now = deps.now ?? Date.now;
  const binding = <T>(env: object, name: string) =>
    (env as Record<string, unknown>)[name] as T | undefined;
  const memoryFor = (env: object) => {
    const ns = binding<DurableObjectNamespace<LazaretMemory>>(env, config.memory.binding);
    return ns ? ns.get(ns.idFromName(config.memory.name)) : null;
  };

  // Learned rules, cached per isolate. Memory is advisory: if it can't be reached,
  // the gate keeps the last rules it had (or none) and requests carry on.
  let memoryCache: { at: number; rules: MemoryGateRule[] } | null = null;
  const memoryRules = async (env: object): Promise<MemoryGateRule[]> => {
    const memory = memoryFor(env);
    if (!memory) return [];
    const at = Date.now();
    if (memoryCache && at - memoryCache.at < config.memory.ruleCacheTtlMs) return memoryCache.rules;
    try {
      const specs = await memory.getActiveRules();
      const rules = specs.flatMap((spec): MemoryGateRule[] => {
        try {
          return [
            {
              id: spec.id,
              mode: spec.mode,
              weight: spec.weight,
              category: spec.category,
              compiled: compileRule(spec.rule),
            },
          ];
        } catch {
          return []; // a rule that no longer compiles is skipped, never fatal
        }
      });
      memoryCache = { at, rules };
    } catch (err) {
      console.error(JSON.stringify({ lazaret: "memory_unavailable", error: String(err) }));
      memoryCache = { at, rules: memoryCache?.rules ?? [] };
    }
    return memoryCache.rules;
  };

  // Linked history (M10) on escrowed writes needs the account behind each session. One
  // lookup per session per isolate: an escrowed write answers 202 at once, so it
  // shouldn't pay an origin round trip every time. Only real answers are cached, and
  // only briefly, so a timeout is retried and a session that ends is forgotten.
  const actorCache = new Map<string, { at: number; actor: Actor }>();
  const ACTOR_CACHE_MS = 5 * 60_000;
  const ACTOR_CACHE_MAX = 5_000;
  const cachedActor = async (
    sessionId: string,
    lookup: () => Promise<Actor | null>,
  ): Promise<Actor | null> => {
    const hit = actorCache.get(sessionId);
    if (hit && now() - hit.at < ACTOR_CACHE_MS) return hit.actor;
    const actor = await lookup();
    if (actor) {
      if (actorCache.size >= ACTOR_CACHE_MAX) {
        const oldest = actorCache.keys().next().value;
        if (oldest !== undefined) actorCache.delete(oldest);
      }
      actorCache.set(sessionId, { at: now(), actor });
    }
    return actor;
  };
  const actorIdOf = (actor: Actor | null): string | null => {
    const field = config.link?.actorField;
    if (!actor?.authenticated || !field) return null;
    const value = actor[field];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };

  const ledgerFor = (env: object) => {
    const ns = binding<DurableObjectNamespace<LazaretLedger>>(env, config.ledger.binding);
    if (!ns) throw new Error(`Lazaret: missing Durable Object binding ${config.ledger.binding}`);
    return ns.get(ns.idFromName(config.ledger.shardAt(now())));
  };
  // The spend counter lives in its own Ledger instance, so it survives shard rollover.
  const budgetFor = (env: object) => {
    const ns = binding<DurableObjectNamespace<LazaretLedger>>(env, config.ledger.binding);
    if (!ns) throw new Error(`Lazaret: missing Durable Object binding ${config.ledger.binding}`);
    return ns.get(ns.idFromName(config.review.budgetShard));
  };

  return {
    async scheduled(_controller: ScheduledController, env: object): Promise<void> {
      const { redispatched } = await ledgerFor(env).sweep();
      if (redispatched) console.log(JSON.stringify({ lazaret: "sweep", redispatched }));
    },

    async fetch(request: Request, env: object, ctx?: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID();
      // How long the behaviour lookups took (M8), as Server-Timing, so the cost of a
      // durable store is visible from outside (Workers' clock advances on I/O, which
      // these lookups are).
      let behaviourMs: number | null = null;
      // The linked-history lookup (M10, M11), also shown as Server-Timing.
      let linksMs: number | null = null;
      const tag = (res: Response): Response => {
        const out = new Response(res.body, res);
        out.headers.set("x-lazaret-request-id", requestId);
        if (behaviourMs !== null)
          out.headers.append("server-timing", `behaviour;dur=${behaviourMs}`);
        if (linksMs !== null) out.headers.append("server-timing", `links;dur=${linksMs}`);
        return out;
      };
      const reject = (status: number, error: string) => tag(json(status, { error, requestId }));

      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const isRead = READ_METHODS.has(method);
      const norm = normalizePath(url.pathname);
      if (norm.anomalies.includes("null_byte")) return reject(400, "bad_request");

      if (norm.segments[0]?.toLowerCase() === "__lazaret") {
        const [, kind, id] = norm.segments;
        if (config.live.enabled && kind && PUBLIC_KINDS.has(kind) && norm.segments.length === 2) {
          const res = await handlePublic(request, kind, {
            config,
            ledger: ledgerFor(env),
            shard: config.ledger.shardAt(now()),
            budget: async () => budgetFor(env).budgetStatus(config.review.dailyBudgetUsd),
            memory: memoryFor(env),
          });
          // A 101 carries the socket; its headers are immutable, so it isn't re-tagged.
          return res.status === 101 ? res : tag(res);
        }
        if (kind === "operator") {
          const secret = binding<string>(env, config.signing.secretBinding);
          return tag(
            await handleOperator(request, norm.segments, {
              config,
              env,
              ledger: ledgerFor(env),
              memory: memoryFor(env),
              committer: () => {
                if (!secret)
                  throw new Error(`Lazaret: missing secret ${config.signing.secretBinding}`);
                return createCommitter({ origin: config.origin, secret, fetchOrigin, now });
              },
              now,
              waitUntil: (p) => (ctx ? ctx.waitUntil(p) : void p),
            }),
          );
        }
        if (method !== "GET" || kind !== "receipts" || !id || norm.segments.length !== 3) {
          return reject(404, "not_found");
        }
        const { sessionId } = await deriveSessionId(request, config);
        const receipt = await ledgerFor(env).getReceipt(id, sessionId);
        return receipt
          ? tag(json(200, { receipt: id, ...receipt }, { "cache-control": "private, no-store" }))
          : reject(404, "not_found");
      }

      const matched = matchRoute(config.routes, method, norm.segments);
      const policy: Policy =
        matched?.compiled.route.policy ?? (isRead ? config.fallback.read : config.fallback.write);
      const routeName =
        matched?.compiled.route.match ?? (isRead ? "fallback:read" : "fallback:write");
      if (policy === "BLOCK") return reject(403, "forbidden");

      let bytes: Uint8Array | null;
      try {
        bytes = await readBodyCapped(request, config.gate.maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLarge) return reject(413, "payload_too_large");
        throw err;
      }
      const contentType = request.headers.get("content-type") ?? "";
      const textual = isTextual(contentType);
      const bodyText = bytes && textual ? new TextDecoder().decode(bytes) : null;
      const headers = forwardableHeaders(request.headers);
      const { sessionId, ip, anonymous } = await deriveSessionId(request, config);

      // The same sample object goes under both keys, so setting `status` after the
      // origin responds updates both views in the memory store; a durable store is
      // told through `settle` (setStatus below).
      const sample: BehaviourSample = { at: now(), method, path: norm.path, route: routeName };
      const perMinute = matched?.compiled.route.perMinute;
      const behaviourKeys = [`s:${sessionId}`, `ip:${ip}`];
      const lookupStarted = performance.now();
      const background = ctx ? (work: Promise<unknown>) => ctx.waitUntil(work) : undefined;
      const views = await Promise.all(
        behaviourKeys.map((key) => behaviour.record(key, sample, env, background)),
      );
      behaviourMs = Math.round(performance.now() - lookupStarted);
      const setStatus = (status: number) => {
        sample.status = status;
        const settling = behaviour.settle?.(behaviourKeys, sample, env);
        if (settling && ctx) ctx.waitUntil(settling);
      };
      const behaviourSignals = strongest([
        ...views.flatMap((v) => [
          ...scoreBehaviour(v, sample.at),
          ...scoreRoute(v, routeName, sample.at, perMinute),
        ]),
        ...headerSignals(headers),
      ]);

      const query = url.search.slice(1);
      const inspection = inspect({
        path: norm.path,
        query,
        contentType,
        bodyText,
        headers,
        sensitiveFields: config.gate.sensitiveFields,
      });
      const pathSignals: GateSignal[] = norm.anomalies.map((a) => ({
        source: "request",
        id: `path.${a}`,
        category: "evasion",
        weight: ANOMALY_WEIGHTS[a as Exclude<PathAnomaly, "null_byte">],
      }));

      // Every request Lazaret sends origin is signed with the client's own headers, so
      // origin authenticates the client as usual and knows the request came through here.
      const toOrigin = async (
        id: string,
        method: string,
        target: URL,
        body: Uint8Array | null,
        signal?: AbortSignal,
      ): Promise<Response> => {
        const secret = binding<string>(env, config.signing.secretBinding);
        if (!secret) throw new Error(`Lazaret: missing secret ${config.signing.secretBinding}`);
        const signature = await signRequest(
          {
            id,
            method,
            target: target.pathname + target.search,
            body,
            timestamp: Math.floor(now() / 1000),
          },
          secret,
        );
        return fetchOrigin(
          new Request(target, {
            method,
            headers: {
              ...headers,
              ...signature,
              "x-forwarded-for": ip,
              "x-forwarded-proto": url.protocol.slice(0, -1),
            },
            body,
            redirect: "manual",
            ...(signal ? { signal } : {}),
          }),
        );
      };

      const actorLookup = () => {
        const actorConfig = config.review.actor;
        return actorConfig
          ? lookupActor(actorConfig, (signal) =>
              toOrigin(
                crypto.randomUUID(),
                "GET",
                originUrl(config.origin, actorConfig.path, ""),
                null,
                signal,
              ),
            )
          : Promise.resolve(null);
      };

      const params = matched?.params ?? {};
      const resourceTemplates = matched?.compiled.route.resources ?? [];
      const resources = resourceTemplates.map((t) => fillTemplate(t, params));
      // Linked history and counts (M10, M11), worked out before the gate decides, so a
      // learned rule can read the counts as `linked.*` signals. Only for writes that get
      // reviewed. One Ledger round trip; advisory: if the Ledger can't answer, the write
      // goes ahead without counts or history, as it did before linking.
      const link = config.link;
      const linkable = link !== null && (policy === "ESCROW" || policy === "INLINE_REVIEW");
      // The actor: looked up fresh for inline review (the reviewer is told it as a fact),
      // cached per session for an escrowed write (it answers 202 at once).
      let actor: Actor | null = null;
      let actorKnown = false;
      if (linkable && link.by.includes("actor")) {
        actor =
          policy === "INLINE_REVIEW"
            ? await actorLookup()
            : await cachedActor(sessionId, actorLookup);
        actorKnown = true;
      }
      const links = linkable
        ? linkKeys(link.by, {
            // A write with no session (a login) falls back to IP + user agent, which isn't
            // a person: everyone behind one address would be one sender, and the first
            // production smoke of M11 saw repeat logins refused as credential attacks.
            sessionId: anonymous ? null : sessionId,
            actorId: actorIdOf(actor),
            resourceTemplates,
            resources,
          })
        : [];
      let linkHistory: LinkedWrite[] = [];
      let heldSender = 0;
      const linkSignals: GateSignal[] = [];
      if (linkable && links.length) {
        const started = performance.now();
        const found = await Promise.resolve(
          ledgerFor(env).getLinkContext(
            links,
            routeName,
            policy === "INLINE_REVIEW"
              ? { windowMs: link.windowMs, maxHistory: link.maxHistory }
              : undefined,
          ),
        ).catch((err: unknown) => {
          console.error(JSON.stringify({ lazaret: "links_unavailable", error: String(err) }));
          return null;
        });
        linksMs = Math.round(performance.now() - started);
        if (found) {
          linkHistory = found.history;
          heldSender = found.counts.heldSender;
          linkSignals.push(...countSignals(found.counts));
        }
      }

      const decision = decide(
        config,
        policy,
        {
          method,
          path: inspection.canonical.path,
          query: inspection.canonical.query,
          body: inspection.canonical.body,
          headers,
          json: inspection.json,
        },
        [...pathSignals, ...inspection.signals, ...behaviourSignals, ...linkSignals],
        await memoryRules(env),
      );

      console.log(
        JSON.stringify({
          lazaret: "gate",
          requestId,
          route: routeName,
          policy,
          risk: Number(decision.risk.toFixed(3)),
          blocked: decision.block,
          signals: decision.signals.map((s) => s.id),
        }),
      );
      // Telemetry for the public live view (fire-and-forget; never on the critical path).
      const observe = (
        o: Omit<ObservedInput, "route" | "method" | "sessionId" | "risk" | "signals">,
      ) => {
        if (!config.live.enabled) return;
        const sending = Promise.resolve(
          ledgerFor(env).observe({
            ...o,
            route: routeName,
            method,
            sessionId,
            risk: decision.risk,
            signals: decision.signals.map((s) => s.id),
          }),
        ).catch((err: unknown) =>
          console.error(JSON.stringify({ lazaret: "observe_failed", error: String(err) })),
        );
        if (ctx) ctx.waitUntil(sending);
      };

      if (decision.block) {
        // Lazaret's own refusals count as auth failures for per-route scoring (as
        // origin's 401s do), so a client that keeps getting refused keeps adding up.
        setStatus(403);
        observe({ kind: "gate_block", outcome: "deny" });
        return reject(403, "forbidden");
      }

      // A hold rule (M11) sends the write to a person without a model call, up to a cap
      // per sender per hour: past it, the write goes to the reviewer as before, so a
      // wrong rule can delay a customer's writes but not quietly swallow all of them.
      const hold = decision.hold && heldSender < HOLD_CAP_PER_HOUR ? decision.hold : undefined;
      if (decision.hold && !hold) {
        console.log(
          JSON.stringify({ lazaret: "hold_capped", requestId, rule: decision.hold.ruleId }),
        );
      }

      // Index an inline write once it's decided, so the next linked one sees it (M10).
      const rememberLinked = (
        verdict: "allow" | "drop" | "quarantine",
        category: string,
        held = false,
      ) => {
        if (!links.length) return;
        const recording = Promise.resolve(
          ledgerFor(env).recordLinked({
            entryId: requestId,
            keys: links,
            at: sample.at,
            route: routeName,
            method,
            path: norm.path,
            preview: bodyText,
            verdict,
            category,
            ...(held ? { held: true } : {}),
          }),
        ).catch((err: unknown) =>
          console.error(JSON.stringify({ lazaret: "links_record_failed", error: String(err) })),
        );
        if (ctx) ctx.waitUntil(recording);
      };

      const forward = async (): Promise<Response> => {
        const target = originUrl(config.origin, encodePath(norm.segments), url.search);
        const body = bytes && method !== "GET" && method !== "HEAD" ? bytes : null;
        const res = await toOrigin(requestId, method, target, body);
        setStatus(res.status);
        return tag(res);
      };

      const entry: EntryInput = {
        sessionId,
        route: routeName,
        riskScore: decision.risk,
        signals: decision.signals,
        resources,
        params,
        request: {
          method,
          path: norm.path,
          query,
          headers,
          body: bytes ? (textual ? (bodyText ?? "") : toBase64(bytes)) : null,
          bodyEncoding: textual ? "utf8" : "base64",
        },
      };

      switch (policy) {
        case "PASS": {
          const res = await forward();
          if (method !== "GET" || !config.overlays.length) return res;
          return overlayResponse(res, config.overlays, norm.segments, async (routes) =>
            ledgerFor(env).getPendingForSession(sessionId, routes),
          );
        }

        case "ESCROW": {
          if (links.length) entry.links = links;
          if (hold) entry.hold = hold;
          const receipt = await ledgerFor(env).append(entry);
          return tag(
            json(
              202,
              { status: "escrowed", receipt: receipt.entryId, batchId: receipt.batchId },
              {
                "x-lazaret-receipt": receipt.entryId,
              },
            ),
          );
        }

        case "INLINE_REVIEW": {
          // Held by a rule (M11): an inline write can't wait in a queue, so it's refused
          // with no model call, as inline review refuses anything it can't clear.
          if (hold) {
            setStatus(403);
            observe({ kind: "inline", outcome: "deny", category: hold.category });
            rememberLinked("quarantine", hold.category, true);
            console.log(
              JSON.stringify({
                lazaret: "inline_held",
                requestId,
                route: routeName,
                rule: hold.ruleId,
              }),
            );
            return reject(403, "held_for_review");
          }
          const apiKey = binding<string>(env, config.review.apiKeyBinding);
          const base =
            deps.reviewer ?? (apiKey ? new AnthropicReviewer(apiKey, config.review) : null);
          if (!base) return reject(503, "review_unavailable");
          const budget = budgetFor(env);
          const reviewer = meteredReviewer(
            base,
            (usd) => budget.chargeSpend(usd),
            (tier) => tierModel(config.review, tier),
          );
          // One round trip to the budget object (a few ms) before a ~1.2 s model call.
          // If the budget object itself can't be reached, review goes ahead: the cap
          // guards spend, and failing every login on its account would be worse.
          const spent = await Promise.resolve(budget.budgetStatus(config.review.dailyBudgetUsd))
            .then((b) => b.exhausted)
            .catch((err: unknown) => {
              console.error(JSON.stringify({ lazaret: "budget_unavailable", error: String(err) }));
              return false;
            });
          // A few ms over a service binding, against the ~1.1 s the model takes to start.
          // Not cached: the reviewer is told the actor as a fact, so it's always fresh here.
          // Already looked up above when linking needed it.
          if (!actorKnown) actor = await actorLookup();
          const history = spent ? [] : linkHistory;
          const started = Date.now();
          const result = spent
            ? ({ unavailable: "daily review budget spent", cause: "budget" } as const)
            : await inlineReview(
                {
                  ...entry,
                  id: requestId,
                  batchId: "inline",
                  status: "PENDING",
                  receivedAt: sample.at,
                },
                reviewer,
                config,
                actor,
                history.length && link
                  ? { byEntry: { [requestId]: history }, previewChars: link.previewChars }
                  : undefined,
              );
          const latencyMs = spent ? undefined : Date.now() - started;
          // Inline verdicts feed the Memory like batch verdicts do (off the critical path).
          const memory = memoryFor(env);
          if (memory && "verdict" in result) {
            const record = archiveRecord(
              {
                ...entry,
                id: requestId,
                batchId: "inline",
                status: "PENDING",
                receivedAt: sample.at,
                verdict: result.verdict,
              },
              "inline",
              sample.at,
            );
            const archiving = Promise.resolve(memory.archive([record])).catch((err: unknown) =>
              console.error(
                JSON.stringify({ lazaret: "memory_archive_failed", error: String(err) }),
              ),
            );
            if (ctx) ctx.waitUntil(archiving);
            else await archiving;
          }
          console.log(
            JSON.stringify({
              lazaret: "inline_review",
              requestId,
              route: routeName,
              ...(actor ? { actor } : {}),
              ...("verdict" in result
                ? { verdict: result.verdict.verdict, category: result.verdict.category }
                : { unavailable: result.unavailable }),
            }),
          );
          if (!("verdict" in result)) {
            // The reviewer couldn't be reached. A route may opt into the gate's judgment
            // for that case (onReviewUnavailable: "gate"), and only a spotless one counts:
            // the gate found nothing at all (no content, path, header, behaviour or rule
            // signal). The outcome is still decided by code, never by a model, and it's
            // logged so a rising rate is visible: an API slowdown sends every login here.
            const reachable = result.cause === "declined" || result.cause === "unusable";
            if (
              !reachable &&
              matched?.compiled.route.onReviewUnavailable === "gate" &&
              // Count signals (M11) are measurements, not evidence: weight 0, so a login
              // after earlier logins is still spotless.
              decision.signals.every((s) => s.weight === 0)
            ) {
              console.log(
                JSON.stringify({
                  lazaret: "inline_degraded",
                  requestId,
                  route: routeName,
                  cause: result.cause,
                  risk: Number(decision.risk.toFixed(3)),
                }),
              );
              observe({ kind: "inline", outcome: "degraded", cause: result.cause, latencyMs });
              rememberLinked("allow", "unreviewed");
              const res = await forward();
              res.headers.set("x-lazaret-review", "degraded");
              return res;
            }
            // Fail closed: no verdict means no write.
            observe({ kind: "inline", outcome: "unavailable", cause: result.cause, latencyMs });
            const refused = reject(503, "review_unavailable");
            if (result.cause === "budget") refused.headers.set("x-lazaret-review", "budget");
            return refused;
          }
          rememberLinked(result.verdict.verdict, result.verdict.category);
          if (result.verdict.verdict !== "allow") {
            setStatus(403);
            observe({
              kind: "inline",
              outcome: "deny",
              category: result.verdict.category,
              latencyMs,
            });
            return reject(403, "forbidden");
          }
          observe({
            kind: "inline",
            outcome: "allow",
            category: result.verdict.category,
            latencyMs,
          });
          return forward();
        }

        default:
          return reject(403, "forbidden");
      }
    },
  };
}

/**
 * The hour's linked counts as zero-weight gate signals (M11). Zero weight: they never
 * move risk on their own. They are there for rules (learned or written) to read, as
 * `signal:linked.sender_route_1h gte 2`, and for the reviewer, as facts. Only non-zero
 * counts are emitted, so an unlinked write's signals look exactly as they did before.
 */
function countSignals(counts: LinkCounts): GateSignal[] {
  const out: GateSignal[] = [];
  if (counts.senderRoute > 0)
    out.push({
      source: "behaviour",
      id: "linked.sender_route_1h",
      category: "linked",
      weight: 0,
      value: counts.senderRoute,
      evidence: `${counts.senderRoute} earlier on this route from this sender in the last hour`,
    });
  if (counts.resourceRoute > 0)
    out.push({
      source: "behaviour",
      id: "linked.resource_route_1h",
      category: "linked",
      weight: 0,
      value: counts.resourceRoute,
      evidence: `${counts.resourceRoute} earlier on this route acting on the same resource in the last hour`,
    });
  return out;
}

function matchRoute(
  routes: CompiledRoute[],
  method: string,
  segments: string[],
): { compiled: CompiledRoute; params: Record<string, string> } | null {
  for (const compiled of routes) {
    const params = matchPattern(compiled.pattern, method, segments);
    if (params) return { compiled, params };
  }
  return null;
}

/** Session and IP views can both fire the same signal; keep the stronger one. */
function strongest(signals: GateSignal[]): GateSignal[] {
  const byId = new Map<string, GateSignal>();
  for (const s of signals) {
    const prev = byId.get(s.id);
    if (!prev || s.weight > prev.weight) byId.set(s.id, s);
  }
  return [...byId.values()];
}
