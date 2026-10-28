import type { CompiledRoute, Policy, ResolvedConfig } from "../config/define";
import {
  type BehaviourSample,
  type BehaviourStore,
  headerSignals,
  MemoryBehaviourStore,
  scoreBehaviour,
} from "../gate/behaviour";
import { decide } from "../gate/gate";
import { inspect } from "../gate/inspect";
import type { GateSignal } from "../gate/signals";
import type { LazaretLedger } from "../ledger/durable-object";
import { fillTemplate, matchPattern } from "../routing/matcher";
import { encodePath, normalizePath, type PathAnomaly } from "../routing/normalize";
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
//      and answers 202 with a receipt, INLINE_REVIEW waits for the reviewer (M3)
//
// It forwards the *normalised* path, never the raw one, so origin acts on exactly
// what the route rules saw (see routing/normalize.ts).

export interface GatewayDeps {
  behaviour?: BehaviourStore;
  /** How to reach origin. Defaults to global fetch; pass a service binding's fetch for Worker origins. */
  fetchOrigin?: (request: Request) => Promise<Response>;
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

  return {
    async fetch(request: Request, env: object): Promise<Response> {
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
      const sample: BehaviourSample = { at: now(), method, path: norm.path };
      const behaviourSignals = strongest([
        ...scoreBehaviour(behaviour.record(`s:${sessionId}`, sample), sample.at),
        ...scoreBehaviour(behaviour.record(`ip:${ip}`, sample), sample.at),
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
      if (decision.block) return reject(403, "forbidden");

      switch (policy) {
        case "PASS": {
          const target = new URL(config.origin);
          target.pathname = target.pathname.replace(/\/$/, "") + encodePath(norm.segments);
          target.search = url.search;
          const res = await fetchOrigin(
            new Request(target, {
              method,
              headers: {
                ...headers,
                "x-forwarded-for": ip,
                "x-forwarded-proto": url.protocol.slice(0, -1),
              },
              body: bytes && method !== "GET" && method !== "HEAD" ? bytes : null,
              redirect: "manual",
            }),
          );
          sample.status = res.status;
          return tag(res);
        }

        case "ESCROW": {
          const ns = (env as Record<string, unknown>)[config.ledger.binding] as
            | DurableObjectNamespace<LazaretLedger>
            | undefined;
          if (!ns)
            throw new Error(`Lazaret: missing Durable Object binding ${config.ledger.binding}`);
          const ledger = ns.get(ns.idFromName(config.ledger.shard));
          const params = matched?.params ?? {};
          const receipt = await ledger.append({
            sessionId,
            route: routeName,
            riskScore: decision.risk,
            signals: decision.signals,
            resources: (matched?.compiled.route.resources ?? []).map((t) =>
              fillTemplate(t, params),
            ),
            request: {
              method,
              path: norm.path,
              query,
              headers,
              body: bytes ? (textual ? (bodyText ?? "") : toBase64(bytes)) : null,
              bodyEncoding: textual ? "utf8" : "base64",
            },
          });
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

        case "INLINE_REVIEW":
          // TODO(M3): synchronous review with the fast model and a hard timeout.
          // Until the reviewer exists, fail closed rather than wave writes through.
          return reject(503, "review_unavailable");

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
