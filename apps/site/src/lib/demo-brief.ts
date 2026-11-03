import type { LiveFrame } from "@gleator/lazaret/public";
import type { Exhibit } from "../projects/lazaret/data/attacks";
import {
  call,
  connectLive,
  type DemoResponse,
  type DemoStatus,
  getJson,
  getPass,
  hasPass,
  PASSWORD,
  PERSONAS,
  TURNSTILE_TEST_KEY,
  turnstileToken,
} from "./demo-client";
import { applyFrame, emptyView, type ViewState } from "./ledger-view";
import { progressOf, STEPS } from "./write-progress";

// The compact demo on the Projects sheet (src/home/lazaret/MiniDemo.astro).
// Same gateway, guard and ledger stream as the long page (lib/demo.ts), cut down to
// one choice, one Send, and one write followed to its end. Rules from the brief:
//   - nothing starts on its own: the status check waits until the demo is on screen,
//     the live stream opens on the first Send, and there is no recorded replay;
//   - if the demo can't take writes (budget spent, unreachable), it says so and the
//     Send button waits.
// Every string from the network goes in through textContent.

const FOLLOW_FOR_MS = 120_000;

type Persona = keyof typeof PERSONAS;

export function initMiniDemo(root: HTMLElement): void {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel) as T;
  const exhibits = JSON.parse(
    root.parentElement?.querySelector("[data-mini-exhibits]")?.textContent ?? "[]",
  ) as Exhibit[];
  const ui = {
    status: $("[data-status]"),
    dot: $("[data-dot]"),
    send: $<HTMLButtonElement>("[data-send]"),
    sendLabel: $("[data-send-label]"),
    turnstile: $("[data-turnstile]"),
    msg: $("[data-msg]"),
    watch: $("[data-watch]"),
    result: $("[data-result]"),
    track: $("[data-track]"),
    verdict: $("[data-verdict]"),
    agent: $("[data-agent]"),
  };
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="lz-case"]')];
  const siteKey = root.dataset.siteKey ?? TURNSTILE_TEST_KEY;

  let view: ViewState = emptyView();
  let stopSocket: (() => void) | null = null;
  let status: DemoStatus | null = null;
  let reachable: boolean | null = null;
  let busy = false;
  const tokens = new Map<Persona, string>();
  /** The write being followed, and when each step was first reached. */
  let following: {
    receipt: string;
    sentAt: number;
    reachedAt: (number | null)[];
    done: boolean;
  } | null = null;

  const chosen = () => exhibits.find((e) => e.id === radios.find((r) => r.checked)?.value);

  // ── Status ──────────────────────────────────────────────────────────────────
  function setStatus(text: string, state: "idle" | "live" | "paused" | "down"): void {
    ui.status.textContent = text;
    ui.dot.dataset.state = state;
  }

  function canSend(): boolean {
    return !busy && reachable !== false && !status?.budget.exhausted;
  }

  function sync(): void {
    ui.send.disabled = !canSend();
    for (const r of radios) r.disabled = busy;
  }

  async function checkStatus(): Promise<void> {
    try {
      status = await getJson<DemoStatus>("/__lazaret/status");
      reachable = true;
      if (status.budget.exhausted) {
        const at = new Date(status.budget.resetsAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
        setStatus(
          `Today’s review budget is spent. Sending opens again at ${at} (00:00 UTC).`,
          "paused",
        );
      } else {
        setStatus(`Live. The demo starts fresh in ${60 - new Date().getUTCMinutes()} min.`, "live");
      }
    } catch {
      reachable = false;
      setStatus("The demo can’t be reached right now. It retries every 30 seconds.", "down");
    }
    sync();
  }

  // Only once the demo is actually on screen: a closed folder makes no requests.
  let polling = false;
  new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting) || polling) return;
    polling = true;
    obs.disconnect();
    void checkStatus();
    setInterval(() => void checkStatus(), 30_000);
  }).observe(root);

  // ── Choosing ────────────────────────────────────────────────────────────────
  for (const r of radios) {
    r.addEventListener("change", () => {
      ui.watch.textContent = chosen()?.watch ?? "";
    });
  }

  // ── The live stream (opened on the first Send) ─────────────────────────────
  const onFrames = (frames: LiveFrame[]) => {
    let changed = false;
    for (const f of frames) {
      if (f.type === "RESET") view = emptyView();
      changed = applyFrame(view, f) || changed;
    }
    if (changed) drawProgress();
  };

  function openStream(): void {
    if (stopSocket) return;
    stopSocket = connectLive(
      onFrames,
      () => undefined,
      () => view.head,
    );
  }

  // ── Sending ─────────────────────────────────────────────────────────────────
  ui.send.addEventListener("click", () => void send());

  async function send(): Promise<void> {
    const ex = chosen();
    if (!ex || !canSend()) return;
    busy = true;
    sync();
    ui.msg.textContent = "";
    try {
      if (!hasPass() && !(await verifyHuman())) return;
      openStream();
      ui.sendLabel.textContent = "Sending…";
      await run(ex);
    } catch (err) {
      ui.msg.textContent = `Something went wrong: ${(err as Error).message}`;
    } finally {
      busy = false;
      ui.sendLabel.textContent = "Send another";
      sync();
    }
  }

  async function verifyHuman(): Promise<boolean> {
    ui.sendLabel.textContent = "Checking you’re human…";
    let token: string;
    try {
      token = await turnstileToken(siteKey, ui.turnstile);
    } catch {
      if (siteKey !== TURNSTILE_TEST_KEY) {
        ui.msg.textContent = "The bot check didn’t load. Reload the page to try again.";
        ui.sendLabel.textContent = "Send it";
        return false;
      }
      token = "offline-test-token"; // local dev with Cloudflare's always-pass key
    }
    const result = await getPass(token).catch(() => ({ ok: false, error: "network" }));
    ui.turnstile.replaceChildren();
    if (!result.ok) {
      ui.msg.textContent =
        result.error === "too_many_passes"
          ? "Too many checks from your network. Wait a minute and try again."
          : "The check didn’t go through. Try again.";
      ui.sendLabel.textContent = "Send it";
      return false;
    }
    // Sign both accounts in now: the credential-stuffing case teaches the gate to
    // refuse logins from this address for a while, and that shouldn't lock you out.
    await login("theo");
    await login("sam");
    return true;
  }

  async function login(persona: Persona): Promise<string | null> {
    const cached = tokens.get(persona);
    if (cached) return cached;
    const res = await call("POST", "/api/login", {
      body: JSON.stringify({ email: PERSONAS[persona], password: PASSWORD }),
    });
    const token = typeof res.json?.token === "string" ? res.json.token : null;
    if (token) tokens.set(persona, token);
    return token;
  }

  async function run(ex: Exhibit): Promise<void> {
    resetResult();
    const token = await login(ex.persona);
    if (!token) {
      ui.msg.textContent =
        "Tidewater refused the sign-in: a recent login burst from your network trips the gate for a few minutes.";
      return;
    }
    const receipts: string[] = [];
    // Times on the track count from the press of Send, so "Held" shows the gateway's
    // own round trip and each later step how long the write waited to get there.
    const sentAt = performance.now();
    let heldAt: number | null = null;
    const answers: DemoResponse[] = [];
    for (const step of ex.steps) {
      for (let n = 1; n <= (step.repeat ?? 1); n++) {
        const path = step.path.replace(
          /\{receipt:(\d+)\}/g,
          (_, i) => receipts[Number(i)] ?? "missing",
        );
        const res = await call(step.method, path, {
          token: path === "/api/login" ? undefined : token,
          body: step.bodyText?.replaceAll("{n}", String(n)),
        });
        answers.push(res);
        const receipt = res.headers.get("x-lazaret-receipt");
        if (res.status === 202 && receipt) {
          receipts.push(receipt);
          heldAt ??= performance.now() - sentAt;
        }
        if (res.status === 401 && res.json?.error === "demo_pass_required") {
          ui.msg.textContent = "Your demo pass expired. Press Send to run the check again.";
          return;
        }
        if (res.status === 429) {
          ui.msg.textContent =
            res.json?.error === "ip_budget_spent"
              ? "Your network has used today’s share of the demo. Come back tomorrow."
              : "Too many requests from your network. Wait a minute.";
          return;
        }
      }
    }
    ui.result.hidden = false;
    const first = receipts[0];
    if (first) {
      follow(first, sentAt, heldAt ?? 0);
      if (ex.agent) void agentAfter(first);
      return;
    }
    // No write was held: it was decided at the edge (a login burst, an inline call).
    showEdge(answers);
  }

  // ── Following one write ─────────────────────────────────────────────────────
  function resetResult(): void {
    following = null;
    ui.result.hidden = true;
    ui.track.hidden = false;
    delete ui.result.dataset.outcome;
    ui.verdict.textContent = "";
    ui.agent.hidden = true;
    for (const li of ui.track.querySelectorAll<HTMLElement>("li")) {
      delete li.dataset.reached;
      delete li.dataset.current;
      const time = li.querySelector("[data-step-time]");
      if (time) time.textContent = "";
      const name = li.querySelector("[data-step-name]");
      if (name) name.textContent = STEPS[Number(li.dataset.step)] ?? "";
    }
  }

  function follow(receipt: string, sentAt: number, heldAfter: number): void {
    following = {
      receipt,
      sentAt,
      reachedAt: [heldAfter, null, null, null],
      done: false,
    };
    ui.verdict.textContent =
      "Held in the ledger. Batches seal every 30 seconds, sooner on a risk spike.";
    drawProgress();
    setTimeout(() => {
      if (following?.receipt === receipt && !following.done) {
        ui.verdict.textContent =
          "Still in review. The reviewer may be busy; the write stays held until it has a verdict.";
      }
    }, FOLLOW_FOR_MS);
  }

  function drawProgress(): void {
    const f = following;
    if (!f) return;
    const entry = view.entries.get(f.receipt);
    const p = progressOf(entry, entry ? view.batches.get(entry.batchId) : undefined);
    const now = performance.now();
    for (let i = 0; i <= p.step; i++) f.reachedAt[i] ??= now - f.sentAt;
    for (const li of ui.track.querySelectorAll<HTMLElement>("li")) {
      const i = Number(li.dataset.step);
      const reached = i <= p.step;
      li.toggleAttribute("data-reached", reached);
      li.toggleAttribute("data-current", i === p.step && !p.outcome);
      const t = f.reachedAt[i];
      const time = li.querySelector("[data-step-time]");
      if (time) time.textContent = reached && t !== null && t !== undefined ? seconds(t) : "";
      if (i === 3) {
        const name = li.querySelector("[data-step-name]");
        if (name) name.textContent = p.finalLabel;
      }
    }
    if (!p.outcome || !entry) return;
    f.done = true;
    ui.result.dataset.outcome = p.outcome;
    const v = entry.verdict;
    const why = v ? ` ${v.rationale}` : "";
    ui.verdict.textContent =
      p.outcome === "delivered"
        ? `Delivered to Tidewater.${why}`
        : p.outcome === "dropped"
          ? entry.taintedBy
            ? "Dropped by taint: it depended on a write that was dropped."
            : `Dropped as ${words(v?.category ?? "unsafe")}, confidence ${v?.confidence.toFixed(2) ?? "n/a"}.${why}`
          : `Held for a human to decide.${why}`;
  }

  function showEdge(answers: DemoResponse[]): void {
    ui.track.hidden = true;
    const refused = answers.filter((a) => a.status === 403).length;
    const reachedOrigin = answers.length - refused;
    ui.result.dataset.outcome = refused ? "dropped" : "delivered";
    ui.verdict.textContent =
      answers.length > 1
        ? `${answers.length} logins sent. ${reachedOrigin} reached Tidewater, and ${refused} were refused at the edge once the gate saw the burst. No model call was needed for those.`
        : refused
          ? "Refused at the edge before it reached Tidewater."
          : "Allowed by the inline reviewer.";
  }

  async function agentAfter(receipt: string): Promise<void> {
    const deadline = Date.now() + FOLLOW_FOR_MS;
    while (Date.now() < deadline && !(following?.receipt === receipt && following.done)) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (following?.receipt !== receipt) return;
    const token = await login("sam");
    if (!token) return;
    const res = await call("GET", "/api/agent/simulate?scenario=refund-hijack", { token });
    const sim = res.json as {
      lazaret_off?: { hijacked_cents: number };
      lazaret_on?: { hijacked_cents: number; queue: string[] };
    } | null;
    if (!res.ok || !sim?.lazaret_off || !sim.lazaret_on) return;
    const money = (c: number) =>
      (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    $("[data-agent-off]").textContent = money(sim.lazaret_off.hijacked_cents);
    $("[data-agent-on]").textContent = money(sim.lazaret_on.hijacked_cents);
    $("[data-agent-note]").textContent =
      `What Tidewater’s AI agent would do next, simulated: once with the ticket written straight to the database, once with the real queue behind Lazaret (${sim.lazaret_on.queue.length} tickets, the attack not among them).`;
    ui.agent.hidden = false;
  }

  sync();
}

/** "prompt_injection" → "prompt injection": verdict categories read as words. */
function words(category: string): string {
  return category.replaceAll("_", " ");
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}
