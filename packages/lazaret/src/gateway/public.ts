import type { ResolvedConfig } from "../config/define";
import type { LazaretLedger } from "../ledger/durable-object";
import type { LazaretMemory } from "../memory/store";
import type { BudgetStatus } from "../review/budget";
import { json } from "./http";

// The public, read-only face of a Lazaret deployment (M7), on when `live.enabled`:
//
//   GET /__lazaret/live?after=<seq>   WebSocket: the Ledger's event log, projected
//   GET /__lazaret/status             spend cap and inline-review health
//   GET /__lazaret/queue              the human review queue, projected
//   GET /__lazaret/memory             learned rules and their history
//
// Everything here goes through the projection in ledger/public.ts, or (memory) is
// built from rule fields that never held request data beyond the rule's own pattern.
// Acting on any of it still needs the operator token (operator.ts).

export const PUBLIC_KINDS = new Set(["live", "status", "queue", "memory"]);

export interface PublicDeps {
  config: ResolvedConfig;
  ledger: DurableObjectStub<LazaretLedger>;
  shard: string;
  budget: () => Promise<BudgetStatus>;
  memory: DurableObjectStub<LazaretMemory> | null;
}

const NO_STORE = { "cache-control": "no-store" };

export async function handlePublic(
  request: Request,
  kind: string,
  deps: PublicDeps,
): Promise<Response> {
  const { config, ledger } = deps;
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });

  switch (kind) {
    case "live": {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json(426, { error: "websocket_required" });
      }
      // The Ledger reads only these three parameters; nothing else crosses.
      const url = new URL(request.url);
      const inner = new URL("https://ledger.internal/live");
      inner.searchParams.set("after", String(Number(url.searchParams.get("after")) || 0));
      inner.searchParams.set("preview", String(config.live.bodyPreviewChars));
      inner.searchParams.set("shard", deps.shard);
      return ledger.fetch(inner, { headers: { upgrade: "websocket" } });
    }

    case "status": {
      const [budget, live] = await Promise.all([deps.budget(), ledger.liveStatus()]);
      return json(
        200,
        {
          shard: deps.shard,
          budget: {
            spentUsd: Math.round(budget.spentUsd * 10_000) / 10_000,
            capUsd: budget.capUsd,
            exhausted: budget.exhausted,
            resetsAt: budget.resetsAt,
          },
          inline: { ...live.inline, timeoutMs: config.review.inlineTimeoutMs },
          head: live.head,
        },
        NO_STORE,
      );
    }

    case "queue":
      return json(
        200,
        { shard: deps.shard, entries: await ledger.getPublicQueue(config.live.bodyPreviewChars) },
        NO_STORE,
      );

    case "memory": {
      if (!deps.memory) return json(200, { enabled: false, rules: [], events: [], stats: null });
      const [rules, events, stats] = await Promise.all([
        deps.memory.listRules(),
        deps.memory.getRuleEvents(0, 500),
        deps.memory.getStats(),
      ]);
      return json(
        200,
        {
          enabled: true,
          rules: rules.map((r) => ({
            id: r.id,
            status: r.status,
            category: r.category,
            description: r.description,
            rule: r.rule,
            support: r.support,
            cleanSamples: r.cleanSamples,
            liveTruePositives: r.liveTruePositives,
            liveFalsePositives: r.liveFalsePositives,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            lastHitAt: r.lastHitAt,
            reason: r.reason,
          })),
          events,
          stats,
        },
        NO_STORE,
      );
    }

    default:
      return json(404, { error: "not_found" });
  }
}
