import type { LiveFrame, PublicEntry, PublicObservation } from "@gleator/lazaret/public";
import type { Exhibit } from "../projects/lazaret/data/attacks";
import {
  call,
  connectLive,
  DEMO_ORIGIN,
  type DemoStatus,
  getJson,
  getPass,
  hasPass,
} from "./demo-client";
import { FLAG_MEANING, type FlagKind, flag, h } from "./dom";
import {
  applyFrame,
  type BatchView,
  batchesNewestFirst,
  type EntryView,
  emptyView,
  TRACK,
  trackIndex,
  type ViewState,
} from "./ledger-view";

// The live demo island (sections/Demo.astro). Four parts share one ledger view:
//   - the console sends canned corpus cases through the real gateway;
//   - the ledger draws the Ledger's public event stream (or a recording of one);
//   - the edge rail shows inline verdicts and gate blocks;
//   - the queue shows what waits for a human.
// Every string from the network is set with textContent (see dom.ts).

const PASSWORD = "tidewater-demo"; // the seeded demo accounts' published password
const PERSONAS = { theo: "theo@tidewater.test", sam: "sam@tidewater.test" } as const;
const STATUS_EVERY_MS = 15_000;
const TURNSTILE_TEST_KEY = "1x00000000000000000000AA";

type Tone = "ok" | "warn" | "bad";

interface Recording {
  recordedAt: string;
  source: string;
  frames: { t: number; frames: LiveFrame[] }[];
}

export function startDemo(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const exhibits = JSON.parse($("exhibits-data").textContent ?? "[]") as Exhibit[];
  const ui = {
    status: $("status"),
    statusText: $("status-text"),
    statusExtra: $("status-extra"),
    dot: $("status").querySelector(".dot") as HTMLElement,
    start: $<HTMLButtonElement>("start"),
    check: $("check"),
    checkMsg: $("check-msg"),
    turnstile: $("turnstile"),
    exhibits: $("exhibits"),
    log: $("log"),
    ledger: $("ledger"),
    ledgerEmpty: $("ledger-empty"),
    legend: $("legend"),
    rail: $("rail"),
    queue: $("queue"),
    agent: $("agent"),
  };
  ($("tidewater-link") as HTMLAnchorElement).href = `${DEMO_ORIGIN}/`;

  let view: ViewState = emptyView();
  /** Receipts this page sent, so their rows are marked and their log lines updated. */
  const mine = new Map<string, HTMLElement>();
  let live: "connecting" | "open" | "closed" = "connecting";
  let replaying = false;
  let lastStatus: DemoStatus | null = null;
  let failures = 0;

  // ── Legend ────────────────────────────────────────────────────────────────────
  for (const kind of ["none", "C", "B", "Q"] as FlagKind[]) {
    ui.legend.append(h("li", {}, flag(kind, 14), FLAG_MEANING[kind].split(" (")[0] ?? ""));
  }

  // ── Rendering (batched to one paint per frame) ────────────────────────────────
  let scheduled = false;
  const render = () => {
    if (scheduled) return;
    scheduled = true;
    const paint = () => {
      if (!scheduled) return;
      scheduled = false;
      drawLedger();
      drawRail();
      updateReceipts();
    };
    // rAF never fires in a background tab, so a timer backs it up: a visitor who
    // switches back finds the ledger current, not frozen at the moment they left.
    requestAnimationFrame(paint);
    setTimeout(paint, 250);
  };

  const onFrames = (frames: LiveFrame[]) => {
    let changed = false;
    let queueChanged = false;
    for (const f of frames) {
      if (f.type === "RESET") view = emptyView();
      changed = applyFrame(view, f) || changed;
      if (
        f.type === "BATCH_QUARANTINED" ||
        f.type === "ENTRY_RESOLVED" ||
        (f.type === "ENTRY_VERDICT" && f.verdict.verdict === "quarantine")
      )
        queueChanged = true;
    }
    if (changed) render();
    if (queueChanged && !replaying) void refreshQueue();
  };

  function drawLedger(): void {
    const batches = batchesNewestFirst(view);
    ui.ledgerEmpty.hidden = batches.length > 0;
    ui.ledger.replaceChildren(...batches.map(drawBatch));
  }

  function drawBatch(b: BatchView): HTMLElement {
    const at = trackIndex(b.status);
    const side = b.status === "QUARANTINED" || b.status === "REVIEW_FAILED";
    const track = h(
      "ol",
      { class: "track", "aria-label": `State: ${statusWords(b.status)}` },
      ...TRACK.map((step, i) =>
        h(
          "li",
          {
            class: i < at ? "done" : i === at ? (side ? "side" : "now") : "",
            "aria-current": i === at ? "step" : undefined,
          },
          i === at && side ? statusWords(b.status) : stepWords(step),
        ),
      ),
    );
    return h(
      "li",
      { class: "batch", "data-status": b.status },
      h(
        "div",
        { class: "batch-head" },
        h("span", { class: "batch-name" }, `Batch ${b.id.split("-").pop()}`),
        track,
        b.sealReason ? h("span", { class: "batch-note" }, sealWords(b.sealReason)) : null,
        b.note ? h("span", { class: "batch-note" }, b.note) : null,
      ),
      h(
        "ul",
        { class: "entries" },
        ...b.entryIds.flatMap((id) => {
          const e = view.entries.get(id);
          return e ? [drawEntry(e)] : [];
        }),
      ),
    );
  }

  function drawEntry(e: EntryView): HTMLElement {
    // A plain bar rather than <meter>, whose browser colours (green/amber) would say
    // "good/bad" in a palette the rest of the page doesn't use.
    const meter = h(
      "span",
      { class: `riskbar${e.risk >= 0.8 ? " high" : ""}`, "aria-hidden": "true" },
      h("span", { style: `width: ${Math.round(e.risk * 100)}%` }),
    );
    return h(
      "li",
      { class: `entry${mine.has(e.id) ? " mine" : ""}`, "data-entry": e.id },
      flag(entryFlag(e)),
      h(
        "span",
        { class: "entry-line" },
        `${e.method} ${e.path}`,
        mine.has(e.id) ? h("span", { class: "visually-hidden" }, " (sent from this page)") : null,
      ),
      h(
        "span",
        { class: "risk", title: e.signals.join(", ") || "no gate signals" },
        "risk ",
        meter,
        ` ${e.risk.toFixed(2)}`,
      ),
      e.body ? h("span", { class: "entry-body" }, e.body + (e.bodyTruncated ? " …" : "")) : null,
      e.verdict
        ? h(
            "span",
            { class: "entry-verdict" },
            h("strong", {}, `${verdictWords(e)}: `),
            `${e.verdict.category}, confidence ${e.verdict.confidence.toFixed(2)}. ${e.verdict.rationale}`,
          )
        : null,
      e.taintedBy
        ? h(
            "span",
            { class: "taint" },
            `Fell with ${e.taintedBy.slice(0, 8)}, the write it depends on.`,
          )
        : null,
    );
  }

  function drawRail(): void {
    const items = [...view.observations].reverse().slice(0, 14);
    if (!items.length) {
      ui.rail.replaceChildren(h("li", { class: "empty" }, "Nothing decided at the edge yet."));
      return;
    }
    ui.rail.replaceChildren(...items.map(drawObservation));
  }

  function drawObservation(o: PublicObservation): HTMLElement {
    const kind: FlagKind =
      o.outcome === "allow" || o.outcome === "degraded" ? "C" : o.outcome === "deny" ? "B" : "Q";
    const what =
      o.kind === "gate_block"
        ? "Blocked by the gate, no model call"
        : o.outcome === "allow"
          ? "Allowed by the inline reviewer"
          : o.outcome === "deny"
            ? "Refused by the inline reviewer"
            : o.outcome === "degraded"
              ? `Reviewer unavailable (${o.cause ?? "unknown"}); allowed on gate rules`
              : `Reviewer unavailable (${o.cause ?? "unknown"}); refused`;
    const bits = [
      what,
      o.category ? `category ${o.category}` : null,
      o.latencyMs !== null ? duration(o.latencyMs) : null,
      `risk ${o.risk.toFixed(2)}`,
    ].filter(Boolean);
    return h(
      "li",
      {},
      flag(kind, 16),
      h("span", { class: "mono" }, `${o.method} ${o.route.replace(/^[A-Z]+ /, "")}`),
      h("span", { class: "meta" }, `${bits.join(". ")}. ${clock(o.at)}`),
    );
  }

  async function refreshQueue(): Promise<void> {
    try {
      const { entries } = await getJson<{ entries: PublicEntry[] }>("/__lazaret/queue");
      if (!entries.length) {
        ui.queue.replaceChildren(
          h("li", { class: "empty" }, "Nobody is waiting. Nothing is held this hour."),
        );
        return;
      }
      ui.queue.replaceChildren(
        ...entries.map((e) =>
          h(
            "li",
            {},
            flag("Q", 16),
            h("span", { class: "mono" }, `${e.method} ${e.path}`),
            e.body ? h("span", { class: "body" }, e.body + (e.bodyTruncated ? " …" : "")) : null,
            h(
              "span",
              { class: "meta" },
              e.verdict
                ? `${e.verdict.category === "review_declined" ? "The model declined to judge it" : `Held as ${e.verdict.category}`}. ${e.verdict.rationale}`
                : "Held with its batch.",
            ),
          ),
        ),
      );
    } catch {
      ui.queue.replaceChildren(
        h("li", { class: "empty" }, "The queue can't be reached right now."),
      );
    }
  }

  function updateReceipts(): void {
    for (const [receipt, line] of mine) {
      const e = view.entries.get(receipt);
      if (!e) continue;
      const [text, tone] =
        e.status === "COMMITTED"
          ? ["delivered to Tidewater", "c"]
          : e.status === "DROPPED"
            ? [`dropped${e.taintedBy ? " by taint" : ""}: ${e.verdict?.category ?? ""}`, "b"]
            : e.status === "QUARANTINED"
              ? ["held for a human", "q"]
              : e.status === "APPROVED"
                ? ["approved, committing", "c"]
                : ["waiting in the ledger", ""];
      line.textContent = `  ${text}`;
      line.className = tone;
    }
  }

  // ── Status line ───────────────────────────────────────────────────────────────
  function setStatus(text: string, tone: Tone, extra = ""): void {
    ui.statusText.textContent = text;
    ui.statusExtra.textContent = extra;
    ui.status.dataset.tone = tone;
    ui.dot.dataset.state = replaying ? "replay" : live;
  }

  function showStatus(): void {
    if (replaying) return;
    const s = lastStatus;
    const reset = `The demo starts fresh in ${minutesToHour()} min.`;
    if (live !== "open" && !s) {
      setStatus("Connecting to the ledger…", "warn");
      return;
    }
    if (!s) {
      setStatus("Live.", "ok", reset);
      return;
    }
    const p50 =
      s.inline.p50LatencyMs !== null
        ? `Inline review p50 ${(s.inline.p50LatencyMs / 1000).toFixed(1)} s over the last 5 minutes.`
        : "";
    if (s.inline.degraded + s.inline.unavailable > 0) {
      setStatus(
        "Inline reviewer is slow: logins fall back to gate rules, credits wait.",
        "warn",
        `${p50} ${reset}`,
      );
      return;
    }
    setStatus(
      live === "open" ? "Live. Reviewer online." : "Reconnecting…",
      live === "open" ? "ok" : "warn",
      `${p50} ${reset}`,
    );
  }

  async function pollStatus(): Promise<void> {
    try {
      lastStatus = await getJson<DemoStatus>("/__lazaret/status");
      failures = 0;
      if (lastStatus.budget.exhausted) {
        void startReplay(
          `Today's review budget is spent, so this is a recorded run. Live writes wait until ${utcMidnight(lastStatus.budget.resetsAt)}.`,
        );
        return;
      }
      if (replaying) stopReplay();
    } catch {
      failures += 1;
      lastStatus = null;
      if (failures >= 2) {
        void startReplay("The live demo can't be reached right now, so this is a recorded run.");
        return;
      }
    }
    showStatus();
  }

  // ── Recorded replay (budget spent, or demo unreachable) ───────────────────────
  let replayTimers: ReturnType<typeof setTimeout>[] = [];
  let stopSocket: (() => void) | null = null;

  async function startReplay(reason: string): Promise<void> {
    if (replaying) return;
    let rec: Recording;
    try {
      const res = await fetch("/recording.json");
      rec = (await res.json()) as Recording;
    } catch {
      setStatus("The live demo is offline and no recording is available.", "bad");
      return;
    }
    replaying = true;
    stopSocket?.();
    setConsoleEnabled(false);
    setStatus(reason, "warn", `Recorded ${rec.recordedAt} (${rec.source}).`);
    const play = () => {
      view = emptyView();
      render();
      const last = rec.frames.at(-1)?.t ?? 0;
      replayTimers = rec.frames.map((f) => setTimeout(() => onFrames(f.frames), f.t));
      replayTimers.push(setTimeout(play, last + 6_000));
    };
    play();
  }

  function stopReplay(): void {
    for (const t of replayTimers) clearTimeout(t);
    replayTimers = [];
    replaying = false;
    view = emptyView();
    render();
    setConsoleEnabled(true);
    stopSocket = openSocket();
  }

  function openSocket() {
    return connectLive(
      onFrames,
      (state) => {
        live = state;
        showStatus();
      },
      () => view.head,
    );
  }

  // ── Console ───────────────────────────────────────────────────────────────────
  const tokens = new Map<keyof typeof PERSONAS, string>();
  let busy = false;

  function setConsoleEnabled(on: boolean): void {
    for (const b of ui.exhibits.querySelectorAll("button")) b.disabled = !on || busy || !hasPass();
    ui.start.disabled = !on;
  }

  for (const ex of exhibits) {
    const button = h(
      "button",
      { type: "button", disabled: true },
      h("span", { class: `ex-kind ${ex.kind}` }, ex.kind === "attack" ? "Attack" : "Honest"),
      h("span", { class: "ex-title" }, ex.title),
      h("span", { class: "ex-watch" }, ex.watch),
    );
    button.addEventListener("click", () => void run(ex));
    ui.exhibits.append(h("li", {}, button));
  }

  function log(text: string, cls = "", suffix?: HTMLElement): HTMLElement {
    ui.log.querySelector(".term-empty")?.remove();
    const p = h("p", { class: cls }, text);
    if (suffix) p.append(suffix);
    ui.log.append(p);
    ui.log.scrollTop = ui.log.scrollHeight;
    return p;
  }

  ui.start.addEventListener("click", () => void verifyHuman());

  async function verifyHuman(): Promise<void> {
    ui.start.disabled = true;
    ui.checkMsg.textContent = "";
    const siteKey = (window as unknown as { __TURNSTILE_SITE_KEY__: string })
      .__TURNSTILE_SITE_KEY__;
    let token: string;
    try {
      token = await turnstileToken(siteKey, ui.turnstile);
    } catch {
      // Offline local dev with Cloudflare's always-pass test key: the guard accepts any
      // token for the test secret, so carry on without the widget.
      if (siteKey !== TURNSTILE_TEST_KEY) {
        ui.checkMsg.textContent = "The bot check didn't load. Reload the page to try again.";
        ui.start.disabled = false;
        return;
      }
      token = "offline-test-token";
    }
    const result = await getPass(token).catch(() => ({ ok: false, error: "network" }));
    if (!result.ok) {
      ui.checkMsg.textContent =
        result.error === "too_many_passes"
          ? "Too many checks from your network. Wait a minute and try again."
          : "The check didn't go through. Try again.";
      ui.start.disabled = false;
      return;
    }
    ui.check.hidden = true;
    // Sign both demo accounts in now, before any attack runs. A credential-stuffing
    // burst teaches the gate to refuse logins from this address for a while (that's
    // the point of it), and it shouldn't lock the visitor out of the other exhibits.
    busy = true;
    setConsoleEnabled(true);
    await login("theo");
    await login("sam");
    busy = false;
    setConsoleEnabled(true);
  }

  async function login(persona: keyof typeof PERSONAS): Promise<string | null> {
    const cached = tokens.get(persona);
    if (cached) return cached;
    log(`→ POST /api/login  as ${PERSONAS[persona]}`, "req");
    const res = await call("POST", "/api/login", {
      body: JSON.stringify({ email: PERSONAS[persona], password: PASSWORD }),
    });
    describe(res, true);
    if (res.status === 403) {
      log(
        "  The gate refuses logins from an address that just sent a burst of failed ones. Try again in a few minutes.",
        "q",
      );
    }
    const token = typeof res.json?.token === "string" ? res.json.token : null;
    if (token) tokens.set(persona, token);
    return token;
  }

  async function run(ex: Exhibit): Promise<void> {
    if (busy) return;
    busy = true;
    setConsoleEnabled(true);
    try {
      log(`# ${ex.title} (corpus case ${ex.id})`, "req");
      const token = await login(ex.persona);
      if (!token) return;
      const receipts: string[] = [];
      for (const step of ex.steps) {
        for (let n = 1; n <= (step.repeat ?? 1); n++) {
          const path = step.path.replace(
            /\{receipt:(\d+)\}/g,
            (_, i) => receipts[Number(i)] ?? "missing",
          );
          const body = step.bodyText?.replaceAll("{n}", String(n));
          log(`→ ${step.method} ${path}`, "req");
          // A burst's logins go unauthenticated, like a real stuffing run.
          const res = await call(step.method, path, {
            token: path === "/api/login" ? undefined : token,
            body,
          });
          const receipt = describe(res, path === "/api/login");
          if (receipt) receipts.push(receipt);
          if (res.status === 401 && res.json?.error === "demo_pass_required") {
            ui.check.hidden = false;
            ui.start.disabled = false;
            return;
          }
          if (res.status === 429) return;
        }
      }
      if (ex.agent && receipts[0]) await agentReplay(receipts[0]);
    } catch (err) {
      log(`! ${(err as Error).message}`, "b");
    } finally {
      busy = false;
      setConsoleEnabled(!replaying);
    }
  }

  /** Log a response in plain words. Returns the receipt of an escrowed write. */
  function describe(res: Awaited<ReturnType<typeof call>>, inline: boolean): string | null {
    const ms = `(${res.ms} ms)`;
    const receipt = res.headers.get("x-lazaret-receipt");
    if (res.status === 202 && receipt) {
      const suffix = h("span", {});
      mine.set(receipt, suffix);
      log(`← 202 held in escrow, receipt ${receipt.slice(0, 8)} ${ms}`, "", suffix);
      updateReceipts();
      render();
      return receipt;
    }
    const degraded = res.headers.get("x-lazaret-review");
    const error = typeof res.json?.error === "string" ? res.json.error : "";
    if (res.ok && degraded === "degraded") {
      log(`← ${res.status} reviewer unavailable, allowed on gate rules ${ms}`, "q");
    } else if (res.ok) {
      log(`← ${res.status} ${inline ? "allowed by the inline reviewer" : "OK"} ${ms}`, "c");
    } else if (res.status === 403) {
      log(`← 403 refused before it reached Tidewater ${ms}`, "b");
    } else if (res.status === 503 && degraded === "budget") {
      log(`← 503 today's review budget is spent, so this waits ${ms}`, "q");
    } else if (res.status === 503) {
      log(`← 503 reviewer unavailable, so it fails closed ${ms}`, "q");
    } else if (res.status === 401 && error === "demo_pass_required") {
      log("← 401 your demo pass expired. Run the check again.", "q");
    } else if (res.status === 401) {
      log(`← 401 wrong password (Tidewater answered) ${ms}`, "");
    } else if (res.status === 429) {
      log(
        error === "ip_budget_spent"
          ? "← 429 your network has used today's share of the demo. Come back tomorrow."
          : "← 429 too many requests from your network. Wait a minute.",
        "q",
      );
    } else {
      log(`← ${res.status} ${error || "error"} ${ms}`, "b");
    }
    return null;
  }

  async function agentReplay(receipt: string): Promise<void> {
    log("# Waiting for the reviewer, then asking what Tidewater's agent would do…", "req");
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const s = view.entries.get(receipt)?.status;
      if (s === "DROPPED" || s === "QUARANTINED" || s === "COMMITTED") break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const token = await login("sam");
    if (!token) return;
    const res = await call("GET", "/api/agent/simulate?scenario=refund-hijack", { token });
    const sim = res.json as {
      lazaret_off?: { hijacked_cents: number; proposals: { reason: string; hijacked: boolean }[] };
      lazaret_on?: { hijacked_cents: number; queue: string[] };
    } | null;
    if (!res.ok || !sim?.lazaret_off || !sim.lazaret_on) {
      log(`← ${res.status} the simulation isn't available`, "b");
      return;
    }
    const money = (c: number) =>
      (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    ui.agent.hidden = false;
    $("agent-off").textContent = `${money(sim.lazaret_off.hijacked_cents)} hijacked`;
    $("agent-off-note").textContent =
      sim.lazaret_off.proposals.find((p) => p.hijacked)?.reason ??
      "The agent followed the planted note.";
    $("agent-on").textContent = `${money(sim.lazaret_on.hijacked_cents)} hijacked`;
    $("agent-on-note").textContent =
      `The agent read ${sim.lazaret_on.queue.length} tickets. The attack was never among them.`;
    log("← simulated: see the comparison below the queue", "c");
  }

  // ── Start ─────────────────────────────────────────────────────────────────────
  drawRail();
  void refreshQueue();
  stopSocket = openSocket();
  void pollStatus();
  setInterval(() => {
    void pollStatus();
    if (!replaying) void refreshQueue();
  }, STATUS_EVERY_MS);
}

// ── Words ───────────────────────────────────────────────────────────────────────

function stepWords(step: string): string {
  return (
    {
      OPEN: "Open",
      SEALED: "Sealed",
      REVIEWING: "Review",
      COMMITTING: "Commit",
      SETTLED: "Settled",
    }[step] ?? step
  );
}

function statusWords(status: string): string {
  return (
    {
      OPEN: "Open",
      SEALED: "Sealed",
      REVIEWING: "In review",
      REVIEW_FAILED: "Retrying",
      COMMITTING: "Committing",
      SETTLED: "Settled",
      QUARANTINED: "Held",
    }[status] ?? status
  );
}

function sealWords(reason: string): string {
  return (
    {
      timer: "Sealed on the 30 s timer",
      size: "Sealed when full",
      risk: "Sealed early: risk spike",
      manual: "Sealed by hand",
    }[reason] ?? reason
  );
}

function entryFlag(e: EntryView): FlagKind {
  if (e.status === "DROPPED") return "B";
  if (e.status === "QUARANTINED") return "Q";
  if (e.status === "COMMITTED" || e.status === "APPROVED") return "C";
  return "none";
}

function verdictWords(e: EntryView): string {
  if (e.resolution === "release") return "Released by a human";
  if (e.resolution === "drop") return "Dropped by a human";
  if (e.taintedBy) return "Dropped by taint";
  return { allow: "Allowed", drop: "Dropped", quarantine: "Held" }[e.verdict?.verdict ?? "allow"];
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function minutesToHour(): number {
  const now = new Date();
  return 60 - now.getUTCMinutes();
}

function utcMidnight(at: number): string {
  return `${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} your time (00:00 UTC)`;
}

/** Render Turnstile on demand and resolve with its token. Rejects if it can't load. */
function turnstileToken(siteKey: string, container: HTMLElement): Promise<string> {
  type Turnstile = { render(el: HTMLElement, opts: Record<string, unknown>): void };
  const w = window as unknown as { turnstile?: Turnstile };
  const load = (): Promise<Turnstile> =>
    w.turnstile
      ? Promise.resolve(w.turnstile)
      : new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
          s.async = true;
          s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("no turnstile")));
          s.onerror = () => reject(new Error("turnstile failed to load"));
          setTimeout(() => reject(new Error("turnstile timed out")), 8_000);
          document.head.append(s);
        });
  return load().then(
    (t) =>
      new Promise<string>((resolve, reject) => {
        t.render(container, {
          sitekey: siteKey,
          callback: (token: string) => resolve(token),
          "error-callback": () => reject(new Error("turnstile error")),
        });
      }),
  );
}
