import { verifyLazaretRequest } from "@gleator/lazaret/origin";
import { ClaudeSupportAgent } from "./agent/claude";
import type { SupportAgent } from "./agent/types";
import { type Ctx, routes } from "./handlers";
import { HttpError, json } from "./http";
import { matchRoute } from "./router";

// Tidewater Support's Worker entry point. The integration with Lazaret is the
// first lines of `fetch`: refuse anything that isn't signed by Lazaret, and pass
// the signed request id to handlers so writes can be deduped. That is the whole
// "put Lazaret in front of your API" change on the origin side.

export interface Env {
  DB: D1Database;
  LAZARET_SIGNING_SECRET: string;
  /** Optional: enables the AI support agent (`POST /api/agent/run`). */
  ANTHROPIC_API_KEY?: string;
}

export interface TidewaterDeps {
  /** Override the support agent (tests use a scripted one). */
  agent?: (env: Env) => SupportAgent | null;
  now?: () => number;
}

export function createTidewater(deps: TidewaterDeps = {}) {
  const agentFor =
    deps.agent ??
    ((env: Env) => (env.ANTHROPIC_API_KEY ? new ClaudeSupportAgent(env.ANTHROPIC_API_KEY) : null));
  const now = deps.now ?? Date.now;

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const check = await verifyLazaretRequest(request, env.LAZARET_SIGNING_SECRET);
      // No detail on purpose: an attacker probing origin directly learns nothing.
      if (!check.ok) return json(403, { error: "requests must come through Lazaret" });

      const url = new URL(request.url);
      const found = matchRoute(routes, request.method, url.pathname);
      if (!found) return json(404, { error: "not found" });
      if ("allowed" in found)
        return json(405, { error: "method not allowed" }, { allow: found.allowed.join(", ") });

      const ctx: Ctx = {
        db: env.DB,
        request,
        lazaretId: check.id,
        body: check.body,
        path: url.pathname,
        now: now(),
        agent: () => agentFor(env),
      };
      try {
        return await found.route.handler(ctx, found.params);
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message });
        console.error(JSON.stringify({ tidewater: "error", message: (err as Error).message }));
        return json(500, { error: "internal error" });
      }
    },
  };
}

export default createTidewater() satisfies ExportedHandler<Env>;
