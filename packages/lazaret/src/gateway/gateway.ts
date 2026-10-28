import { originUrl } from "../commit/committer";
import { signRequest } from "../commit/sign";
import type { CompiledRoute, Policy, ResolvedConfig } from "../config/define";
import {
  type BehaviourSample,
  type BehaviourStore,
  headerSignals,
  MemoryBehaviourStore,
  scoreBehaviour,
  scoreRoute,
} from "../gate/behaviour";
import { decide, type MemoryGateRule } from "../gate/gate";
import { inspect } from "../gate/inspect";
import { compileRule } from "../gate/rules";
import type { GateSignal } from "../gate/signals";
import type { LazaretLedger } from "../ledger/durable-object";
import type { EntryInput } from "../ledger/types";
import { archiveRecord } from "../memory/sample";
import type { LazaretMemory } from "../memory/store";
import { overlayResponse } from "../overlay/apply";
import { AnthropicReviewer, type Reviewer } from "../review/client";
import { inlineReview } from "../review/inline";
import { fillTemplate, matchPattern } from "../routing/matcher";
import { encodePath, normalizePath, type PathAnomaly } from "../routing/normalize";
import { lookupActor } from "./actor";
import {
  BodyTooLarge,
  forwardableHeaders,
  isTextual,
  json,
  readBodyCapped,
  toBase64,
} from "./http";
import { deriveSessionId } from "./session";

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
// poll a receipt. The `/__lazaret/` prefix is reserved and never reaches origin.
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
  const behaviour = deps.behaviour ?? new MemoryBehaviourStore();
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

  const ledgerFor = (env: object) => {
    const ns = binding<DurableObjectNamespace<LazaretLedger>>(env, config.ledger.binding);
    if (!ns) throw new Error(`Lazaret: missing Durable Object binding ${config.ledger.binding}`);
    return ns.get(ns.idFromName(config.ledger.shard));
  };

  return {
    async scheduled(_controller: ScheduledController, env: object): Promise<void> {
      const { redispatched } = await ledgerFor(env).sweep();
      if (redispatched) console.log(JSON.stringify({ lazaret: "sweep", redispatched }));
    },

    async fetch(request: Request, env: object, ctx?: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID();
      const tag = (res: Response): Response => {
        const out = new Response(res.body, res);
        out.headers.set("x-lazaret-request-id", requestId);
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
      const { sessionId, ip } = await deriveSessionId(request, config);

      // The same sample object goes under both keys, so setting `status` after the
      // origin responds updates both views.
      const sample: BehaviourSample = { at: now(), method, path: norm.path, route: routeName };
      const perMinute = matched?.compiled.route.perMinute;
      const views = [
        behaviour.record(`s:${sessionId}`, sample),
        behaviour.record(`ip:${ip}`, sample),
      ];
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
        [...pathSignals, ...inspection.signals, ...behaviourSignals],
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
      if (decision.block) {
        // Lazaret's own refusals count as auth failures for per-route scoring (as
        // origin's 401s do), so a client that keeps getting refused keeps adding up.
        sample.status = 403;
        return reject(403, "forbidden");
      }

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

      const forward = async (): Promise<Response> => {
        const target = originUrl(config.origin, encodePath(norm.segments), url.search);
        const body = bytes && method !== "GET" && method !== "HEAD" ? bytes : null;
        const res = await toOrigin(requestId, method, target, body);
        sample.status = res.status;
        return tag(res);
      };

      const params = matched?.params ?? {};
      const entry: EntryInput = {
        sessionId,
        route: routeName,
        riskScore: decision.risk,
        signals: decision.signals,
        resources: (matched?.compiled.route.resources ?? []).map((t) => fillTemplate(t, params)),
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
          const apiKey = binding<string>(env, config.review.apiKeyBinding);
          const reviewer =
            deps.reviewer ?? (apiKey ? new AnthropicReviewer(apiKey, config.review) : null);
          if (!reviewer) return reject(503, "review_unavailable");
          // A few ms over a service binding, against the ~1.1 s the model takes to start.
          const actorConfig = config.review.actor;
          const actor = actorConfig
            ? await lookupActor(actorConfig, (signal) =>
                toOrigin(
                  crypto.randomUUID(),
                  "GET",
                  originUrl(config.origin, actorConfig.path, ""),
                  null,
                  signal,
                ),
              )
            : null;
          const result = await inlineReview(
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
          );
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
          // Fail closed: no verdict means no write.
          if (!("verdict" in result)) return reject(503, "review_unavailable");
          if (result.verdict.verdict !== "allow") {
            sample.status = 403;
            return reject(403, "forbidden");
          }
          return forward();
        }

        default:
          return reject(403, "forbidden");
      }
    },
  };
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
