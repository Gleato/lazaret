import {
  createCommitter,
  createGateway,
  defineLazaret,
  type EntryState,
  type LazaretLedger,
  type LedgerPort,
  type Reviewer,
  runReviewPipeline,
  type StepRunner,
  type VerdictRecord,
} from "@gleator/lazaret";
import { tidewaterConfig } from "@gleator/tidewater-lazaret/config";
import { scriptedReviewer } from "@gleator/tidewater-lazaret/scripted-reviewer";
import type { CallRecord, CaseRequest, CaseResult, EvalCase, Stage } from "./types";

// Runs the corpus through the real thing, inside workerd: Tidewater's Lazaret
// config, the real gateway and deterministic gate, a real Ledger Durable Object
// (batches seal exactly as in production: on size or risk spike), and the real
// review pipeline (chunking, escalation guard, taint, fail-closed). Only origin is
// a stub, since what's scored is whether a write *reached* it.

export type Mode = "gate-only" | "fake" | "live";

const SECRET = "eval-signing-secret-0123456789";

/** Stand-in reviewer for gate-only mode: allows everything, so only the gate stops anything. */
const allowAll: Reviewer = {
  async review({ prompt }) {
    return {
      kind: "output",
      model: "scripted",
      output: {
        verdicts: promptEntryIds(prompt).map((entry_id) => ({
          entry_id,
          verdict: "allow",
          category: "benign",
          confidence: 0.95,
          rationale: "gate-only mode",
        })),
      },
    };
  },
};

function promptEntries(prompt: string): { entry_id: string; route: string }[] {
  const start = prompt.indexOf("<batch_data>\n") + "<batch_data>\n".length;
  const data = JSON.parse(prompt.slice(start, prompt.lastIndexOf("\n</batch_data>"))) as {
    entries: { entry_id: string; route: string }[];
  };
  return data.entries;
}

const promptEntryIds = (prompt: string) => promptEntries(prompt).map((e) => e.entry_id);

export class BudgetExceeded extends Error {}

/** Wraps a reviewer to time every call and record tokens, with a hard spend cap. */
function instrument(inner: Reviewer, maxUsd: number, costOf: (c: CallRecord) => number) {
  const calls: CallRecord[] = [];
  const escalated = new Set<string>();
  // Counted when a call *starts*: an inline call that hits its deadline never resolves
  // in time to be recorded before the gateway answers 503.
  const started: Record<string, number> = {};
  // The model's own inline verdict per entry (before the gateway's confidence bar), so
  // the report can say *why* an inline write was refused. Keyed by entry id, which for
  // inline review is the gateway's request id.
  const inlineVerdicts = new Map<string, VerdictRecord>();
  let spent = 0;
  const reviewer: Reviewer = {
    async review(call) {
      if (spent >= maxUsd) throw new BudgetExceeded(`eval budget of $${maxUsd} reached`);
      const promptData = promptEntries(call.prompt);
      const ids = promptData.map((e) => e.entry_id);
      const route = promptData.length === 1 ? promptData[0]?.route : undefined;
      if (call.tier === "escalation") for (const id of ids) escalated.add(id);
      started[call.tier] = (started[call.tier] ?? 0) + 1;
      const at = Date.now();
      let outcome: Awaited<ReturnType<Reviewer["review"]>>;
      try {
        outcome = await inner.review(call);
      } catch (err) {
        // Timeouts (aborted by the inline deadline) and API errors are calls too.
        calls.push({
          tier: call.tier,
          model: "unknown",
          latencyMs: Date.now() - at,
          outcome: `error: ${(err as Error).name}`,
          entries: ids.length,
          route,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        throw err;
      }
      const record: CallRecord = {
        tier: call.tier,
        model: "model" in outcome ? outcome.model : "unknown",
        latencyMs: Date.now() - at,
        outcome: outcome.kind,
        entries: ids.length,
        route,
        inputTokens: outcome.usage?.inputTokens ?? 0,
        outputTokens: outcome.usage?.outputTokens ?? 0,
        cacheReadTokens: outcome.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: outcome.usage?.cacheWriteTokens ?? 0,
      };
      calls.push(record);
      spent += costOf(record);
      if (call.tier === "inline" && outcome.kind === "output") {
        const v = (outcome.output as { verdicts?: (VerdictRecord & { entry_id: string })[] })
          .verdicts?.[0];
        if (v && ids[0]) inlineVerdicts.set(ids[0], v);
      }
      return outcome;
    },
  };
  return { reviewer, calls, escalated, started, inlineVerdicts };
}

/** Workflow-like step runner: runs steps inline, retrying with the requested backoff. */
const stepRunner: StepRunner = {
  async do(_name, fn, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof BudgetExceeded || attempt >= (options?.retries ?? 0)) throw err;
        await new Promise((r) => setTimeout(r, Math.min(options?.retryDelayMs ?? 1000, 5000)));
      }
    }
  },
  async sleep(_name, ms) {
    await new Promise((r) => setTimeout(r, Math.min(ms, 5000)));
  },
};

/** Deterministic shuffle, so attacks and benign traffic share batches the same way every run. */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function hex(input: string): string {
  let h = 0x811c9dc5;
  for (const c of input) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function expand(req: CaseRequest): CaseRequest[] {
  if (!req.repeat) return [req];
  return Array.from({ length: req.repeat }, (_, i) => ({
    ...req,
    repeat: undefined,
    path: req.path.replaceAll("{n}", String(i + 1)),
    bodyText: req.bodyText?.replaceAll("{n}", String(i + 1)),
  }));
}

export interface HarnessOptions {
  mode: Mode;
  /** Required in live mode. */
  liveReviewer?: Reviewer;
  ledger: DurableObjectNamespace<LazaretLedger>;
  shard: string;
  maxUsd?: number;
  costOf?: (c: CallRecord) => number;
  seed?: number;
}

export async function runCorpus(corpus: EvalCase[], options: HarnessOptions) {
  const inner =
    options.mode === "live"
      ? options.liveReviewer
      : options.mode === "fake"
        ? scriptedReviewer
        : allowAll;
  if (!inner) throw new Error("live mode needs a reviewer");
  const { reviewer, calls, escalated, started, inlineVerdicts } = instrument(
    inner,
    options.maxUsd ?? 6,
    options.costOf ?? (() => 0),
  );

  const config = defineLazaret(
    tidewaterConfig({ ledger: { binding: "EVAL_LEDGER", shard: options.shard } }),
  );
  // Request ids that reached origin. "Delivered" means exactly this: a 401 from origin
  // for a wrong password still counts as delivered, a 403 from Lazaret does not.
  const reached = new Set<string>();
  const tokenOf = (c: EvalCase) => `Bearer tw_${hex(c.id).repeat(6)}`;
  const actors = new Map(
    corpus.map((c) => [tokenOf(c), { id: `acct_${c.id}`, role: c.actor ?? "customer" }]),
  );
  const origin = async (request: Request) => {
    const id = request.headers.get("x-lazaret-id");
    if (id) reached.add(id);
    const body = await request.text();
    const path = new URL(request.url).pathname;
    // Like Tidewater: only the seeded demo accounts can log in. A stuffing burst
    // therefore produces a run of 401s, which is what the gate's failure scoring sees.
    if (path === "/api/login") {
      const creds = JSON.parse(body || "{}") as { email?: unknown; password?: unknown };
      const ok =
        typeof creds.email === "string" &&
        /^(mara|theo|sam)@tidewater\.test$/.test(creds.email) &&
        creds.password === "tidewater-demo";
      return ok
        ? Response.json({ token: `tw_${"0".repeat(48)}` })
        : Response.json({ error: "invalid email or password" }, { status: 401 });
    }
    // The gateway's actor lookup before inline review (review.actor in the Tidewater config).
    if (request.method === "GET" && path === "/api/me") {
      const account = actors.get(request.headers.get("authorization") ?? "");
      return account
        ? Response.json({ account })
        : Response.json({ error: "login required" }, { status: 401 });
    }
    if (request.method === "GET") return Response.json({ tickets: [] });
    return Response.json({ ok: true }, { status: 201 });
  };
  const gateway = createGateway(config, { fetchOrigin: origin, reviewer });
  const env = { EVAL_LEDGER: options.ledger, LAZARET_SIGNING_SECRET: SECRET };
  const ledger = options.ledger.get(options.ledger.idFromName(options.shard));

  // The gateway's structured gate log is the only place it reports risk and signals
  // for requests it doesn't escrow (blocks, inline, pass). Tap it for the report.
  const gateLog = new Map<string, { risk: number; signals: string[]; route: string }>();
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    try {
      const line = typeof args[0] === "string" ? JSON.parse(args[0]) : null;
      if (line?.lazaret === "gate") gateLog.set(line.requestId, line);
      else if (!line?.lazaret) originalLog(...args);
    } catch {
      originalLog(...args);
    }
  };

  const outcomes: Record<string, unknown> = {};
  type Target = {
    c: EvalCase;
    status: number;
    requestId: string | null;
    receipt: string | null;
    inline: boolean;
  };
  const targets: Target[] = [];
  try {
    for (const c of shuffle(corpus, options.seed ?? 2026)) {
      const receipts: (string | null)[] = [];
      const steps = c.requests.flatMap(expand);
      for (const [i, step] of steps.entries()) {
        const inlineBefore = started.inline ?? 0;
        const path = step.path.replace(
          /\{receipt:(\d+)\}/g,
          (_, n) => receipts[Number(n)] ?? "missing",
        );
        const res = await gateway.fetch(
          new Request(`https://support.tidewater.test${path}`, {
            method: step.method,
            headers: {
              authorization: tokenOf(c),
              "cf-connecting-ip":
                c.ip ??
                `10.${parseInt(hex(c.id).slice(0, 2), 16)}.${parseInt(hex(c.id).slice(2, 4), 16)}.7`,
              "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15",
              ...(step.bodyText === undefined ? {} : { "content-type": "application/json" }),
              ...step.headers,
            },
            body: step.bodyText ?? null,
          }),
          env,
        );
        const json = (await res.json().catch(() => null)) as { receipt?: string } | null;
        receipts.push(res.status === 202 ? (json?.receipt ?? null) : null);
        if (i === steps.length - 1) {
          targets.push({
            c,
            status: res.status,
            requestId: res.headers.get("x-lazaret-request-id"),
            receipt: res.status === 202 ? (json?.receipt ?? null) : null,
            inline: (started.inline ?? 0) > inlineBefore,
          });
        }
      }
    }

    // Seal whatever is still open, then review every sealed batch in order.
    // Outcomes are kept so a quarantined batch shows up in the report with its reason.
    await ledger.seal();
    const committer = createCommitter({
      origin: config.origin,
      secret: SECRET,
      fetchOrigin: origin,
    });
    const state = await ledger.getState();
    for (const batch of Object.values(state.batches).sort(
      (a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)),
    )) {
      if (batch.status !== "SEALED") continue;
      outcomes[batch.id] = await runReviewPipeline(
        stepRunner,
        {
          ledger: ledger as unknown as LedgerPort,
          reviewer,
          committer,
          config,
          attemptBackoffMs: 500,
        },
        batch.id,
      );
    }
  } finally {
    console.log = originalLog;
  }

  const finalState = await ledger.getState();
  const entries = finalState.entries as Record<string, EntryState>;
  const batches = Object.values(finalState.batches).map((b) => ({
    id: b.id,
    entries: b.entryIds.length,
    sealReason: b.sealReason ?? null,
    status: b.status,
    reviewAttempts: b.reviewAttempts,
    quarantineReason: b.quarantineReason ?? null,
    lastError: b.lastError ?? null,
    outcome: outcomes[b.id] ?? null,
  }));
  const results: CaseResult[] = targets.map(({ c, status, requestId, receipt, inline }) => {
    const entry = receipt ? entries[receipt] : undefined;
    const gate = requestId ? gateLog.get(requestId) : undefined;
    let stage: Stage;
    let verdict: VerdictRecord | null = null;
    if (entry) {
      verdict = entry.verdict ?? null;
      const landed = entry.status === "COMMITTED";
      stage = landed
        ? "delivered"
        : verdict?.category === "tainted"
          ? "taint"
          : escalated.has(entry.id)
            ? "escalation"
            : "review";
    } else {
      if (inline && requestId) verdict = inlineVerdicts.get(requestId) ?? null;
      if (requestId && reached.has(requestId)) stage = "delivered";
      else if (inline) stage = status === 503 ? "inline_unavailable" : "inline";
      else stage = "gate";
    }
    return {
      id: c.id,
      label: c.label,
      class: c.class,
      route: entry?.route ?? gate?.route ?? null,
      status,
      stopped: stage !== "delivered",
      stage,
      gateRisk: entry?.riskScore ?? gate?.risk ?? null,
      signals: entry?.signals.map((s) => s.id) ?? gate?.signals ?? [],
      verdict: verdict && {
        verdict: verdict.verdict,
        category: verdict.category,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
      },
      ...(entry ? { escalated: escalated.has(entry.id) } : {}),
    };
  });
  return { results, calls, batches };
}
